# -*- coding: utf-8 -*-
"""直播分段录制器：ffmpeg 子进程分段录制桌面，独立进程不影响直播互动。

- 默认 gdigrab 录主显示器，10 分钟一段，落盘 data/recordings/<session>/seg_*.mp4
- 由 console HTTP API 手动启停（POST /api/recorder/start|stop）
- 会话 id 复用 live_events 的 session（与直播事件同源，便于 T5/T6 关联）
- 所有异常吞掉返回明确错误，绝不影响调用方（NFR-6 / TR-4.4）
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REC_DIR = ROOT / "data" / "recordings"
CONFIG_FILE = ROOT / "config" / "recorder.json"

DEFAULTS = {
    "segment_sec": 600,
    "source": "desktop",          # gdigrab 源：desktop 或窗口标题
    "framerate": 15,
    "preset": "ultrafast",
    "video_bitrate": "2500k",
}

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_session: str | None = None
_segment_sec: int = 0
_source: str | None = None
_started_at: float = 0.0
_log_path: Path | None = None


def _load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        user = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(user, dict):
            cfg.update(user)
    except Exception:
        pass
    return cfg


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe() -> str | None:
    return shutil.which("ffprobe")


def _ensure_session() -> str:
    try:
        import live_events
        return live_events._ensure_session()
    except Exception:
        return time.strftime("%Y%m%d-%H%M%S")


def status() -> dict:
    with _lock:
        running = _proc is not None and _proc.poll() is None
        files: list[str] = []
        if _session:
            d = REC_DIR / _session
            if d.exists():
                files = sorted(p.name for p in d.glob("seg_*.mp4"))
        return {
            "running": running,
            "session": _session,
            "segment_sec": _segment_sec,
            "source": _source,
            "started_at": _started_at,
            "elapsed_sec": round(time.time() - _started_at, 1) if _started_at else 0,
            "files": files,
            "file_count": len(files),
        }


def start(segment_sec: int | None = None, source: str | None = None,
          session: str | None = None) -> dict:
    """启动分段录制。已在录制则返回错误。任何失败都返回 {ok:False,msg}，不抛异常。"""
    global _proc, _session, _segment_sec, _source, _started_at, _log_path
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return {"ok": False, "msg": "录制已在进行中", "status": status()}
        cfg = _load_config()
        seg = int(segment_sec) if segment_sec else int(cfg.get("segment_sec", 600))
        src = source or cfg.get("source", "desktop")
        sess = session or _ensure_session()
        out_dir = REC_DIR / sess
        out_dir.mkdir(parents=True, exist_ok=True)
        out_pat = str(out_dir / "seg_%03d.mp4")
        _log_path = out_dir / "ffmpeg.log"
        cmd = [
            _ffmpeg(), "-y",
            "-f", "gdigrab",
            "-framerate", str(cfg.get("framerate", 15)),
            "-i", src,
            "-c:v", "libx264",
            "-g", str(cfg.get("framerate", 15)),   # 每秒关键帧，使 segment 能按时切分
            "-preset", str(cfg.get("preset", "ultrafast")),
            "-b:v", str(cfg.get("video_bitrate", "2500k")),
            "-pix_fmt", "yuv420p",
            "-an",                                  # 暂不录音频，避免 dshow 设备枚举问题
            "-f", "segment",
            "-segment_time", str(seg),
            "-reset_timestamps", "1",
            "-segment_format", "mp4",
            out_pat,
        ]
        try:
            logf = open(_log_path, "w", encoding="utf-8")
            _proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=logf, stderr=subprocess.STDOUT,
                creationflags=_NO_WINDOW,
            )
        except FileNotFoundError as e:
            return {"ok": False, "msg": f"ffmpeg 未找到: {e}"}
        except Exception as e:
            return {"ok": False, "msg": f"ffmpeg 启动失败: {type(e).__name__}: {e}"}
        _session = sess
        _segment_sec = seg
        _source = src
        _started_at = time.time()
    # 确认进程没立刻崩（坏源/缺编码器会秒退）
    time.sleep(1.5)
    if _proc.poll() is not None:
        rc = _proc.returncode
        err = ""
        try:
            err = _log_path.read_text(encoding="utf-8", errors="ignore")[-800:]
        except Exception:
            pass
        with _lock:
            _proc = None
        return {"ok": False, "msg": f"ffmpeg 启动后退出 rc={rc}", "log_tail": err}
    return {"ok": True, "msg": "录制已启动", "status": status()}


def stop() -> dict:
    """停止录制：先写 'q' 优雅退出，超时则 terminate/kill。确保无残留进程（TR-4.3）。"""
    global _proc
    with _lock:
        proc = _proc
        _proc = None
    if proc is None or proc.poll() is not None:
        return {"ok": True, "msg": "录制未在运行", "status": status()}
    try:
        proc.stdin.write(b"q\n")
        proc.stdin.flush()
    except Exception:
        pass
    try:
        proc.wait(timeout=8)
    except Exception:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                pass
    _write_manifest()  # 写精确时间轴清单，供 clipper 切片定位分段
    return {"ok": True, "msg": "录制已停止", "status": status()}


def _write_manifest() -> None:
    """写 data/recordings/<session>/manifest.json：每段的连续时间轴（start=duration 秒）。

    用 recorder 权威的 started_at + i*segment_sec 计算（segment muxer 按此时钟切分），
    比文件 st_ctime 准确且跨 console 重启可用（clipper 优先读它定位高光所在分段）。
    """
    try:
        if not _session or not _started_at:
            return
        d = REC_DIR / _session
        if not d.is_dir():
            return
        names = sorted(p.name for p in d.glob("seg_*.mp4"))
        seg_list = []
        for i, name in enumerate(names):
            start = _started_at + i * (_segment_sec or 0)
            dur = probe_duration(d / name)
            seg_list.append({"name": name, "start": round(start, 3),
                             "duration": round(float(dur), 3) if dur else 0.0})
        (d / "manifest.json").write_text(json.dumps({
            "session": _session,
            "started_at": round(_started_at, 3),
            "segment_sec": _segment_sec,
            "segments": seg_list,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        try:
            print(f"[recorder] manifest 写入失败: {e!r}")
        except Exception:
            pass


def probe_duration(path: str | Path) -> float | None:
    """探测视频时长（秒）。优先 ffprobe（解析其 JSON 输出），回退 ffmpeg -i 正则。"""
    p = str(path)
    fp = _ffprobe()
    if fp:
        try:
            r = subprocess.run(
                [fp, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", p],
                capture_output=True, text=True, timeout=15, creationflags=_NO_WINDOW,
            )
            if r.returncode == 0 and r.stdout.strip():
                out = r.stdout.strip()
                try:
                    return float(json.loads(out)["format"]["duration"])
                except Exception:
                    m = re.search(r"duration[\"=:\s]+([0-9.]+)", out)
                    if m:
                        return float(m.group(1))
        except Exception:
            pass
    # 回退：ffmpeg -i 解析 stderr 的 Duration 行
    try:
        r = subprocess.run([_ffmpeg(), "-i", p], capture_output=True, text=True,
                           timeout=15, creationflags=_NO_WINDOW)
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", r.stderr)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return None
