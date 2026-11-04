# -*- coding: utf-8 -*-
"""直播高光自动切片（Task 6）。

读取 T5 高光标记（data/highlights/<session>.jsonl）与 T4 分段录像
（data/recordings/<session>/seg_*.mp4），用 ffmpeg 按每个高光的时间戳 ±窗口
切片，输出 MP4 到 data/clips/<session>/，并写 clips.json 清单。

分段时间轴：用每个 seg 文件的创建时间（Windows st_ctime = 分段起始写入时刻）
作为该分段的墙钟起点，跨 console 重启依然准确（不依赖 recorder 内存状态）。
跨分段边界的高光：分别抽取各分段的相关片段再 concat。

所有异常吞掉返回 {ok:False,msg}，绝不影响调用方（NFR-6）。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIPS_DIR = ROOT / "data" / "clips"
CONFIG_FILE = ROOT / "config" / "clipper.json"

DEFAULTS = {
    "auto_on_live_end": True,   # 下播（live_end 事件）自动切片
    "default_before_sec": None,  # None=用每条高光自带的 before_sec
    "default_after_sec": None,
    "crf": 23,
    "preset": "veryfast",
}

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_lock = threading.Lock()
_started = False
_cfg: dict = {}
_cfg_mtime: float = 0.0


def _config() -> dict:
    global _cfg, _cfg_mtime
    try:
        mtime = CONFIG_FILE.stat().st_mtime if CONFIG_FILE.is_file() else 0.0
    except Exception:
        mtime = 0.0
    if _cfg and mtime == _cfg_mtime:
        return _cfg
    cfg = dict(DEFAULTS)
    if mtime:
        try:
            user = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                cfg.update(user)
        except Exception:
            pass
    with _lock:
        _cfg, _cfg_mtime = cfg, mtime
    return cfg


def reload_config() -> dict:
    global _cfg_mtime
    _cfg_mtime = 0.0
    return _config()


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _segments(session: str) -> list[tuple[Path, float, float]]:
    """返回 [(path, start_epoch, duration_sec)] 按起始时间升序。

    时间轴来源优先级：
      1. manifest.json（recorder.stop 写入，started_at + i*segment_sec，准确连续）
      2. recorder 内存状态（同进程内刚录完，status() 还有 started_at/segment_sec）
      3. 文件创建时间 st_ctime（跨重启且无 manifest 时的最后兜底，可能不精确）
    """
    try:
        import recorder
    except Exception:
        return []
    d = recorder.REC_DIR / session
    if not d.is_dir():
        return []
    # 1. manifest
    mf = d / "manifest.json"
    if mf.is_file():
        try:
            man = json.loads(mf.read_text(encoding="utf-8"))
            out: list[tuple[Path, float, float]] = []
            for s in man.get("segments", []):
                p = d / s["name"]
                if p.is_file():
                    out.append((p, float(s["start"]), float(s.get("duration", 0))))
            if out:
                return out
        except Exception:
            pass
    # 2. recorder 内存状态
    try:
        st = recorder.status()
        if st.get("session") == session and st.get("started_at"):
            sa = float(st["started_at"])
            ss = float(st.get("segment_sec") or 0)
            out = []
            for i, p in enumerate(sorted(d.glob("seg_*.mp4"))):
                dur = recorder.probe_duration(p)
                out.append((p, sa + i * ss, float(dur) if dur else 0.0))
            if out:
                return out
    except Exception:
        pass
    # 3. ctime 兜底
    out = []
    for p in sorted(d.glob("seg_*.mp4")):
        try:
            out.append((p, float(p.stat().st_ctime),
                        float(recorder.probe_duration(p) or 0.0)))
        except Exception:
            continue
    return out


def _locate(ts: float, segs: list) -> tuple[int | None, float]:
    """定位 ts 落在哪个分段，返回 (seg_index, offset_in_seg)。"""
    for i, (_p, start, dur) in enumerate(segs):
        end = start + (dur if dur > 0 else 1e9)
        if start <= ts < end:
            return i, ts - start
    if segs and ts < segs[0][1]:
        return 0, 0.0
    return None, 0.0


def _extract_one(src: Path, ss: float, dur: float, dst: Path) -> bool:
    """从 src 的 ss 秒处抽取 dur 秒（重编码，帧准确）。"""
    try:
        cfg = _config()
        cmd = [_ffmpeg(), "-y", "-ss", f"{ss:.3f}", "-i", str(src),
               "-t", f"{dur:.3f}", "-c:v", "libx264",
               "-preset", str(cfg.get("preset", "veryfast")),
               "-crf", str(cfg.get("crf", 23)), "-pix_fmt", "yuv420p",
               "-an", str(dst)]
        r = subprocess.run(cmd, capture_output=True, timeout=180,
                           creationflags=_NO_WINDOW)
        return r.returncode == 0 and dst.exists() and dst.stat().st_size > 0
    except Exception:
        return False


def _extract_pieces(pieces: list[tuple[Path, float, float]], dst: Path) -> bool:
    """pieces=[(src, ss, dur), ...]；单段直抽，多段抽临时文件后 concat 重编码。"""
    if not pieces:
        return False
    if len(pieces) == 1:
        return _extract_one(pieces[0][0], pieces[0][1], pieces[0][2], dst)
    tmpdir = dst.parent / ("_tmp_" + dst.stem)
    try:
        tmpdir.mkdir(parents=True, exist_ok=True)
        temps: list[Path] = []
        for i, (p, ss, dur) in enumerate(pieces):
            t = tmpdir / f"p{i}.mp4"
            if not _extract_one(p, ss, dur, t):
                return False
            temps.append(t)
        # concat 重编码（避免 -c copy 的时间戳/编码不匹配问题）
        listfile = tmpdir / "list.txt"
        listfile.write_text(
            "\n".join("file '%s'" % tp.as_posix() for tp in temps),
            encoding="utf-8")
        cmd = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0",
               "-i", str(listfile), "-c:v", "libx264",
               "-preset", str(_config().get("preset", "veryfast")),
               "-crf", str(_config().get("crf", 23)), "-pix_fmt", "yuv420p",
               "-an", str(dst)]
        r = subprocess.run(cmd, capture_output=True, timeout=240,
                           creationflags=_NO_WINDOW)
        return r.returncode == 0 and dst.exists() and dst.stat().st_size > 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def extract(session: str, before: float | None = None,
            after: float | None = None) -> dict:
    """为某 session 的所有高光切片。返回 {ok, session, clips, count}。"""
    if not session:
        return {"ok": False, "msg": "缺少 session", "clips": [], "count": 0}
    # 若该 session 仍在录制，先停（让最后分段关闭，便于 probe 时长）
    try:
        import recorder
        st = recorder.status()
        if st.get("running") and st.get("session") == session:
            recorder.stop()
            time.sleep(1.5)
    except Exception:
        pass
    try:
        import highlights
    except Exception:
        return {"ok": False, "msg": "highlights 模块不可用", "clips": [], "count": 0}

    marks = highlights.query(session)
    if not marks:
        return {"ok": False, "msg": "该 session 无高光标记", "clips": [], "count": 0}
    segs = _segments(session)
    if not segs:
        return {"ok": False, "msg": "该 session 无对应分段录像",
                "clips": [], "count": 0}

    cfg = _config()
    out_dir = CLIPS_DIR / session
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"ok": False, "msg": f"输出目录创建失败: {e}", "clips": [], "count": 0}

    produced = []
    for idx, m in enumerate(marks):
        try:
            b = before if before is not None else (
                cfg.get("default_before_sec")
                if cfg.get("default_before_sec") is not None
                else m.get("before_sec", 5.0))
            a = after if after is not None else (
                cfg.get("default_after_sec")
                if cfg.get("default_after_sec") is not None
                else m.get("after_sec", 10.0))
            b = float(b or 0.0); a = float(a or 0.0)
            win = b + a
            if win <= 0:
                continue
            ts = float(m.get("ts", 0))
            si, off = _locate(ts, segs)
            if si is None:
                continue
            # 收集覆盖 [ts-b, ts+a] 的分段片段
            pieces: list[tuple[Path, float, float]] = []
            remaining = win
            cur = si
            cur_off = max(0.0, off - b)
            while remaining > 1e-3 and cur < len(segs):
                p, start, dur = segs[cur]
                avail = (dur - cur_off) if dur > 0 else remaining
                take = min(remaining, avail) if dur > 0 else remaining
                if take > 1e-3:
                    pieces.append((p, cur_off, take))
                remaining -= take
                cur += 1
                cur_off = 0.0
            if not pieces:
                continue
            fname = "clip_%03d_%s.mp4" % (idx, str(m.get("type", "h"))[:16])
            dst = out_dir / fname
            if _extract_pieces(pieces, dst):
                produced.append({
                    "file": fname,
                    "highlight_idx": idx,
                    "type": m.get("type", ""),
                    "reason": m.get("reason", ""),
                    "ts": ts,
                    "before_sec": round(b, 2),
                    "after_sec": round(a, 2),
                    "window_sec": round(win, 2),
                    "segments_spanned": len(pieces),
                })
        except Exception as e:
            try:
                print(f"[clipper] 切片失败 idx={idx}: {e!r}")
            except Exception:
                pass
            continue

    # 写清单
    try:
        (out_dir / "clips.json").write_text(
            json.dumps({"session": session, "clips": produced},
                       ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True, "session": session, "clips": produced,
            "count": len(produced)}


def list_clips(session: str) -> dict:
    """列出某 session 已产出的切片。"""
    d = CLIPS_DIR / session
    files: list[str] = []
    manifest = None
    if d.is_dir():
        files = sorted(p.name for p in d.glob("clip_*.mp4"))
        mf = d / "clips.json"
        if mf.is_file():
            try:
                manifest = json.loads(mf.read_text(encoding="utf-8"))
            except Exception:
                manifest = None
    return {"session": session, "files": files, "count": len(files),
            "manifest": manifest}


def list_sessions() -> list[str]:
    try:
        if not CLIPS_DIR.is_dir():
            return []
        return sorted((p.name for p in CLIPS_DIR.iterdir() if p.is_dir()),
                      reverse=True)
    except Exception:
        return []


def _on_event(ev: dict) -> None:
    """事件总线回调：下播自动切片。"""
    try:
        if not isinstance(ev, dict) or ev.get("type") != "live_end":
            return
        if not _config().get("auto_on_live_end", True):
            return
        sess = ev.get("session")
        if not sess:
            return
        threading.Thread(target=lambda: extract(sess), daemon=True).start()
    except Exception:
        pass


def start() -> bool:
    """订阅事件总线，下播自动切片。幂等。"""
    global _started
    if _started:
        return True
    try:
        import event_bus
    except Exception:
        print("[clipper] event_bus 不可用，自动切片未启用")
        return False
    try:
        _config()
        event_bus.subscribe(_on_event)
        _started = True
        print("[clipper] 已订阅事件总线，下播自动切片已启用")
        return True
    except Exception as e:
        try:
            print(f"[clipper] start failed: {e!r}")
        except Exception:
            pass
        return False
