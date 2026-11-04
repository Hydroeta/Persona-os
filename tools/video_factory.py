# -*- coding: utf-8 -*-
"""图文短视频一键成片工厂（Spec Tasks 8-12）。

流水线：
  decompose(文案)        → LLM 拆 4-5 个分镜（每镜 narration + image_prompt）
  generate_scene_images  → 串行调 painter.generate_image_sync（dream 场景，免费额度）生图
  generate_voiceover     → 调本地 IndexTTS2 拿整段 wav
  compose                → ffmpeg 把分镜图按配音节奏切分 + xfade 转场 + 混音，出 9:16 MP4
  make_video             → 顶层编排（串 T8→T11）+ 任务状态机（pending/running/success/failed）

设计约束（来自 spec）：
  - 不装 moviepy，合成走 ffmpeg 子进程直出。
  - 全异常吞掉返回 {"ok":..,"msg":..}，绝不崩 console（NFR-2 优雅降级）。
  - 单条成本 ≤0.01 元：生图走 cogview-3-flash 免费、配音本地、仅拆解说走 LLM（NFR-1）。
  - 任务可观测：job_id/status/progress/error/output_path 落盘 data/video_factory/jobs/（NFR-5）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # persona-os 根
DATA = ROOT / "data" / "video_factory"
JOBS_DIR = DATA / "jobs"
FFMPEG = r"C:\Users\user\.local\bin\ffmpeg.exe"
OHWHALE = ROOT / "ohwhale-deploy"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_SCENE = "dream"        # painter 离线批处理场景：0 冷却、不占互动配额、走 GLM 免费额度
_LLM_SCENE = "other"    # llm_client 场景（拆解说，极少 token）
_MAX_CONCURRENCY = 2    # 同时跑的成片任务上限（避免资源争抢）

_lock = threading.Lock()
_sem = threading.Semaphore(_MAX_CONCURRENCY)
_jobs: dict[str, dict] = {}   # job_id → job（内存镜像，落盘在 JOBS_DIR）


# ============================================================
# 配置 / 路径辅助
# ============================================================
def _indextts_url() -> str:
    try:
        cfg = json.loads((OHWHALE / "config.json").read_text("utf-8"))
        return cfg.get("services", {}).get("indextts_url", "http://127.0.0.1:9881/tts")
    except Exception:
        return "http://127.0.0.1:9881/tts"


def _default_ref_audio() -> str:
    """默认参考音：ohwhale-deploy/config.json paths.voice_ref 解析为绝对路径。"""
    try:
        cfg = json.loads((OHWHALE / "config.json").read_text("utf-8"))
        rel = cfg.get("paths", {}).get("voice_ref", "models/indextts2/refs/mortis.wav")
        p = (OHWHALE / rel).resolve()
        return str(p)
    except Exception:
        return ""


def _job_dir(job_id: str) -> Path:
    d = JOBS_DIR / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _save_job(job: dict) -> None:
    try:
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        (JOBS_DIR / f"{job['job_id']}.json").write_text(
            json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _load_job(job_id: str) -> dict | None:
    try:
        p = JOBS_DIR / f"{job_id}.json"
        if p.is_file():
            return json.loads(p.read_text("utf-8"))
    except Exception:
        pass
    return None


# ============================================================
# Task 8: 分镜拆解
# ============================================================
def _extract_json(text: str):
    """从 LLM 回复里抠出第一个 JSON 数组/对象。失败返回 None。"""
    if not text:
        return None
    # 优先数组
    s = text.find("[")
    e = text.rfind("]")
    if 0 <= s < e:
        try:
            return json.loads(text[s:e + 1])
        except Exception:
            pass
    s = text.find("{")
    e = text.rfind("}")
    if 0 <= s < e:
        try:
            return json.loads(text[s:e + 1])
        except Exception:
            pass
    return None


_DECOMPOSE_PROMPT = """你是短视频分镜师。把下面文案拆成 {n} 个分镜，每镜输出一个 JSON 对象：
{{"index": 1, "narration": "这一镜的旁白文案（中文，15-40字）", "image_prompt": "英文生图提示词，描述画面主体/风格/构图/光影"}}
严格只输出 JSON 数组（[{{...}},...]），不要任何解释、markdown 代码块或前后文字。
文案：
{text}"""


def decompose(text: str, scene_count: int = 5) -> list[dict]:
    """调 LLM 把文案拆成 4-5 个分镜。返回 [{index, narration, image_prompt}, ...]。

    LLM 失败/输出不合规时抛带中文说明的异常（调用方捕获转成 job.error）。
    """
    text = (text or "").strip()
    if len(text) < 20:
        raise ValueError("文案太短，至少 20 字才能拆分镜")
    n = max(4, min(5, int(scene_count)))
    prompt = _DECOMPOSE_PROMPT.format(n=n, text=text)
    try:
        import llm_client
    except Exception as e:
        raise RuntimeError(f"LLM 模块不可用: {type(e).__name__}") from e
    try:
        reply = llm_client.chat(
            [{"role": "user", "content": prompt}],
            scene=_LLM_SCENE, max_tokens=1200, temperature=0.7,
        )
    except Exception as e:
        raise RuntimeError(f"LLM 分镜调用失败: {type(e).__name__}: {e}") from e

    parsed = _extract_json(reply)
    if not isinstance(parsed, list) or len(parsed) < 4:
        raise RuntimeError(f"LLM 分镜输出不合规（需 4-5 镜数组）: {reply[:160]!r}")

    out = []
    for i, raw in enumerate(parsed[:n], 1):
        if not isinstance(raw, dict):
            raise RuntimeError(f"第 {i} 镜不是对象: {raw!r}")
        img = str(raw.get("image_prompt") or "").strip()
        if not img:
            raise RuntimeError(f"第 {i} 镜缺 image_prompt: {raw!r}")
        # 清洗：去掉可能的换行/超长
        img = re.sub(r"\s+", " ", img)[:500]
        out.append({
            "index": i,
            "narration": str(raw.get("narration") or "").strip(),
            "image_prompt": img,
        })
    return out


# ============================================================
# Task 9: 批量生图
# ============================================================
def generate_scene_images(scenes: list[dict], job_id: str,
                          style: str = "") -> list[dict]:
    """串行调 painter 为每镜生图，落盘到 <job>/images/。

    某镜失败不影响其余镜（TR-9.3：部分失败而非崩溃）。返回每镜 {index,path,ok,error}。
    """
    try:
        import painter
    except Exception as e:
        raise RuntimeError(f"painter 模块不可用: {type(e).__name__}") from e

    img_dir = _job_dir(job_id) / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for s in scenes:
        idx = int(s.get("index", 0))
        prompt = str(s.get("image_prompt") or "")
        if not prompt:
            results.append({"index": idx, "path": "", "ok": False, "error": "缺 image_prompt"})
            continue
        try:
            path, msg = painter.generate_image_sync(prompt, style=style, scene=_SCENE)
        except Exception as e:
            path, msg = None, f"生图异常: {type(e).__name__}: {e}"
        if path and os.path.isfile(path):
            dest = img_dir / f"scene_{idx:02d}.jpg"
            try:
                shutil.copy2(path, dest)
                results.append({"index": idx, "path": str(dest), "ok": True})
            except Exception as e:
                results.append({"index": idx, "path": path, "ok": False,
                                "error": f"落盘失败: {e}"})
        else:
            results.append({"index": idx, "path": "", "ok": False, "error": msg or "生图失败"})
    return results


# ============================================================
# Task 10: 配音
# ============================================================
def generate_voiceover(text: str, job_id: str, ref_audio: str | None = None) -> str:
    """调本地 IndexTTS2 合成整段 wav，落盘到 <job>/voiceover.wav，返回路径。

    ref_audio 缺省用 config 的 voice_ref；服务未启动/合成失败抛中文异常（调用方转 job.error）。
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("配音文案为空")
    ref = ref_audio or _default_ref_audio()
    if not ref or not os.path.isfile(ref):
        raise RuntimeError(f"参考音频不存在: {ref or '(空)'}")

    url = _indextts_url() + "?" + urllib.parse.urlencode(
        {"text": text, "ref_audio_path": ref})
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
    except Exception as e:
        raise RuntimeError(f"IndexTTS 调用失败（服务未启动？）: {type(e).__name__}: {e}") from e
    if len(data) < 1024:
        raise RuntimeError(f"IndexTTS 返回音频过小（{len(data)}B），疑似合成失败")
    out = _job_dir(job_id) / "voiceover.wav"
    out.write_bytes(data)
    return str(out)


# ============================================================
# Task 11: ffmpeg 合成
# ============================================================
def _probe_duration(path) -> float | None:
    """探测音视频时长（秒）。复用 recorder.probe_duration，失败返回 None。"""
    try:
        import recorder
        return recorder.probe_duration(path)
    except Exception:
        return None


def _compose_filter(n: int, seg: float, xf: float) -> tuple[str, str]:
    """构造 xfade 转场滤镜链；返回 (filter_complex 字符串, 最终视频标签)。"""
    parts = []
    labels = []
    for k in range(n):
        v = f"v{k}"
        parts.append(
            f"[{k}:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            f"crop=1080:1920,setsar=1,setpts=PTS-STARTPTS,fps=30[{v}]"
        )
        labels.append(v)
    if n == 1:
        return ";".join(parts), labels[0]
    cur = labels[0]
    for k in range(1, n):
        nxt = labels[k]
        merged = f"x{k}"
        offset = k * (seg - xf)
        parts.append(
            f"[{cur}][{nxt}]xfade=transition=fade:duration={xf:.3f}:offset={offset:.3f}[{merged}]"
        )
        cur = merged
    return ";".join(parts), cur


def compose(images: list[str], voiceover: str, job_id: str,
            bgm: str | None = None, transition_ms: int = 500) -> str:
    """把分镜图按配音节奏拼接 + xfade 转场 + 混音，出 9:16 (1080x1920) MP4。

    不依赖 moviepy。返回 out.mp4 绝对路径；参数无效时抛中文异常。
    """
    imgs = [p for p in images if p and os.path.isfile(p)]
    if len(imgs) < 1:
        raise ValueError("没有可用的分镜图片")
    if not voiceover or not os.path.isfile(voiceover):
        raise ValueError(f"配音文件不存在: {voiceover}")

    dur = _probe_duration(voiceover)
    if not dur or dur <= 0:
        raise RuntimeError("无法探测配音时长")

    n = len(imgs)
    xf = max(0.1, min(1.0, transition_ms / 1000.0))
    if n == 1:
        seg = dur
    else:
        seg = (dur + (n - 1) * xf) / n   # 使总时长 ≈ 配音时长
    if seg <= 0:
        raise RuntimeError("分镜时长计算异常")

    vf, vlabel = _compose_filter(n, seg, xf)
    out = _job_dir(job_id) / "out.mp4"

    cmd = [FFMPEG, "-y"]
    for p in imgs:
        cmd += ["-loop", "1", "-t", f"{seg:.3f}", "-i", p]
    cmd += ["-i", voiceover]
    has_bgm = bool(bgm and os.path.isfile(bgm))
    if has_bgm:
        cmd += ["-i", bgm]

    # 音频处理：voiceover 索引 n；bgm 索引 n+1
    af = ""
    if has_bgm:
        af = (f"[{n}:a]volume=1.0[va];"
              f"[{n + 1}:a]volume=0.35[ba];"
              f"[va][ba]amix=inputs=2:duration=first:dropout_transition=0[aout]")
        cmd += ["-filter_complex", f"{vf};{af}",
                "-map", f"[{vlabel}]", "-map", "[aout]"]
    else:
        cmd += ["-filter_complex", vf,
                "-map", f"[{vlabel}]", "-map", f"{n}:a"]

    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-r", "30", "-c:a", "aac", "-b:a", "192k", "-shortest",
            "-movflags", "+faststart", str(out)]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=600, creationflags=_NO_WINDOW)
    except FileNotFoundError as e:
        raise RuntimeError(f"ffmpeg 未找到: {e}") from e
    except Exception as e:
        raise RuntimeError(f"ffmpeg 执行失败: {type(e).__name__}: {e}") from e
    if r.returncode != 0 or not out.is_file() or out.stat().st_size < 1024:
        tail = (r.stderr or "")[-600:]
        raise RuntimeError(f"ffmpeg 合成失败 (rc={r.returncode}): {tail}")
    return str(out)


# ============================================================
# Task 12: 编排入口 + 任务状态机
# ============================================================
def make_video(text: str, opts: dict | None = None) -> str:
    """异步启动一个成片任务，立即返回 job_id。任务在后台线程执行。"""
    opts = opts or {}
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "status": "pending",          # pending / running / success / failed
        "progress": 0,                # 0-100
        "error": None,
        "output_path": None,
        "text": (text or "")[:2000],
        "opts": {k: opts[k] for k in ("style", "ref_audio", "bgm", "scene_count")
                 if k in opts},
        "created": time.time(),
        "updated": time.time(),
    }
    with _lock:
        _jobs[job_id] = job
    _save_job(job)
    t = threading.Thread(target=_run_job, args=(job_id, text, opts),
                         daemon=True, name=f"vf-{job_id}")
    t.start()
    return job_id


def _update(job_id: str, **kw) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(kw)
        job["updated"] = time.time()
        _save_job(job)


def _run_job(job_id: str, text: str, opts: dict) -> None:
    acquired = _sem.acquire(timeout=0.1)
    if not acquired:
        _update(job_id, status="failed", error="任务排队已满，请稍后再试", progress=0)
        return
    try:
        _update(job_id, status="running", progress=3)

        # T8 分镜
        scenes = decompose(text, opts.get("scene_count", 5))
        _update(job_id, progress=20, scenes=scenes)

        # T9 生图
        style = str(opts.get("style") or "")
        results = generate_scene_images(scenes, job_id, style=style)
        ok_imgs = [r["path"] for r in results if r.get("ok") and r.get("path")]
        if len(ok_imgs) < 1:
            raise RuntimeError("所有分镜生图失败：" + "；".join(
                f"镜{r['index']}:{r.get('error')}" for r in results if not r.get("ok")))
        _update(job_id, progress=55, images=results)

        # T10 配音：用各镜 narration 拼接（缺则用原文）
        vo_text = " ".join(s.get("narration", "") for s in scenes
                           if s.get("narration")).strip() or text
        voice = generate_voiceover(vo_text, job_id, opts.get("ref_audio"))
        _update(job_id, progress=80, voiceover=voice)

        # T11 合成
        out = compose(ok_imgs, voice, job_id, bgm=opts.get("bgm"))
        _update(job_id, status="success", progress=100, output_path=out)
    except Exception as e:
        _update(job_id, status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        if acquired:
            _sem.release()


def get_job(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
    if job:
        return job
    return _load_job(job_id) or {"job_id": job_id, "status": "not_found"}


def list_jobs(limit: int = 50) -> list[dict]:
    """最近的任务（内存优先 + 磁盘兜底），按 created 倒序。"""
    seen: dict[str, dict] = {}
    with _lock:
        for jid, job in _jobs.items():
            seen[jid] = job
    try:
        if JOBS_DIR.is_dir():
            for p in sorted(JOBS_DIR.glob("*.json"), reverse=True)[:limit]:
                try:
                    j = json.loads(p.read_text("utf-8"))
                    seen.setdefault(j.get("job_id") or p.stem, j)
                except Exception:
                    pass
    except Exception:
        pass
    jobs = sorted(seen.values(), key=lambda j: j.get("created", 0), reverse=True)
    return jobs[:limit]


def status() -> dict:
    return {
        "jobs_dir": str(JOBS_DIR),
        "max_concurrency": _MAX_CONCURRENCY,
        "running": sum(1 for j in _jobs.values() if j.get("status") == "running"),
        "indextts_url": _indextts_url(),
        "default_ref_audio": _default_ref_audio(),
        "ffmpeg_exists": os.path.isfile(FFMPEG),
    }
