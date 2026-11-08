# -*- coding: utf-8 -*-
r"""persona-os · Audio Cover 实时翻唱微服务（SVC/RVC，端口 :8005）

职责：把「抓取指定输入设备音频 → 变声 → 推给指定输出设备」的实时音频闭环做成独立 HTTP 微服务，
供 TS 侧（dsh-audio-cover 插件 / 直播引擎）拉起与调度。

架构（**生产者-消费者**，音频回调里绝不做重活）：
    sounddevice 回调 ──put──> input_queue ──> 推理线程（独立） ──put──> output_queue ──get──> 回调写 outdata
    · 队列 maxsize=5，满了丢**最旧**的帧（保低延迟，宁可丢也不要卡）
    · 输出队列空时输出静音并计 underrun，绝不阻塞回调
    · 推理线程内异常（含 torch.cuda.OutOfMemoryError）一律捕获 → 回退 bypass + 写 last_error

三种引擎模式：
    mode=bypass      直通，不经过队列（调试用）
    mode=tone        440Hz 正弦（只验输出链路）
    mode=rvc         RVC 变声：真实 RVC 库未安装时自动降级为 **mock 变调**（按 pitch 重采样，
                     只证明队列/重采样/延迟链路通，音色不变），/health 里 engine 会写明

接口：
    GET  /health                        状态：running / mode / engine / frames / dropped / underrun / last_error
    GET  /devices                       列出音频输入/输出设备
    POST /start                         {input_device, output_device, pitch, mode, samplerate, blocksize, gain}
    POST /stop                          停止并释放音频流
    POST /load_model                    {model_path, index_path} 校验文件并加载（无真实 RVC 库时进 mock 引擎）

环境变量：
    AUDIO_COVER_PORT     监听端口（默认 8005）
    AUDIO_COVER_HOST     监听地址（默认 127.0.0.1）
    RVC_MODEL_DIR        可选：把模型目录加进 sys.path，便于放本地 rvc 实现
"""
from __future__ import annotations

import os
import queue
import threading
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from rvc_client import RvcWorkerClient
import voice_fx

try:  # sounddevice 缺失时服务仍可启动，只是 /start 会明确报错
    import sounddevice as sd
except Exception as _e:  # pragma: no cover - 环境相关
    sd = None
    _SD_IMPORT_ERROR = str(_e)
else:
    _SD_IMPORT_ERROR = ""

LOG_TAG = "[audio-cover]"

app = FastAPI(title="persona-os audio-cover", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# 队列长度：5 块 × 1024 帧 ≈ 107ms 缓冲，够推理线程喘气又不至于听感延迟过大
QUEUE_MAX = 5


def _resample(x: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """线性插值重采样（骨架用；真实 RVC 库内部自带重采样，接入后可跳过）。"""
    if src_sr == dst_sr or x.size == 0:
        return x
    n_out = max(1, int(round(x.size * dst_sr / src_sr)))
    idx = np.linspace(0, x.size - 1, n_out)
    return np.interp(idx, np.arange(x.size), x.astype(np.float32)).astype(np.float32)


def _pitch_shift_mock(x: np.ndarray, sr: int, pitch: int) -> np.ndarray:
    """mock 变调：整体重采样再拉回原长度（会改变音高与共振峰，仅用于验证链路）。"""
    if pitch == 0 or x.size == 0:
        return x
    ratio = 2.0 ** (pitch / 12.0)
    shifted = _resample(x, sr, int(sr * ratio))
    return _resample(shifted, int(sr * ratio), sr)[: x.size] if shifted.size >= x.size else _resample(shifted, int(sr * ratio), sr)


class Engine:
    """全双工音频流 + 独立推理线程。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stream = None
        self._mode = "bypass"
        self._engine = "bypass"          # bypass / mock-rvc / rvc
        self._pitch = 0
        self._gain = 1.0
        self._tone_hz = 440.0
        self._tone_phase = 0.0
        self._samplerate = 48000
        self._blocksize = 1024
        self._frames = 0
        self._dropped = 0                # 输入队列满，主动丢弃的旧帧
        self._underrun = 0               # 输出队列空，回调输出静音的块数
        self._started_at = 0.0
        self._model: dict = {}
        self._last_error = ""
        self._in_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=QUEUE_MAX)
        self._out_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=QUEUE_MAX)
        self._worker: Optional[threading.Thread] = None
        self._worker_stop = threading.Event()
        self._rvc_worker: Optional[RvcWorkerClient] = None
        self._infer_ms = 0.0

    # ------------------------------------------------------------------
    # 音频回调（PortAudio 线程，只做收发）
    # ------------------------------------------------------------------
    def _tone_callback(self, outdata, frames, _time_info, status) -> None:
        try:
            n = np.arange(frames, dtype=np.float32)
            step = 2.0 * np.pi * self._tone_hz / float(self._samplerate)
            wave = np.sin(self._tone_phase + n * step) * 0.2
            self._tone_phase = (self._tone_phase + frames * step) % (2.0 * np.pi)
            outdata[:] = wave.reshape(-1, 1) if outdata.shape[1] > 1 else wave.reshape(-1, 1)
            self._frames += frames
            if status:
                self._last_error = str(status)
        except Exception as exc:
            outdata.fill(0)
            self._last_error = f"{type(exc).__name__}: {exc}"

    def _stream_callback(self, indata, outdata, frames, _time_info, status) -> None:
        """只做两件事：把输入塞进队列、从输出队列取现成结果。绝不在这里推理。"""
        try:
            mono = indata.mean(axis=1) if indata.shape[1] > 1 else indata[:, 0].copy()
            if self._mode == "rvc":
                try:
                    self._in_q.put_nowait(mono.copy())
                except queue.Full:
                    # 丢最旧的一帧，保低延迟
                    try:
                        self._in_q.get_nowait()
                        self._dropped += 1
                    except queue.Empty:
                        pass
                    try:
                        self._in_q.put_nowait(mono.copy())
                    except queue.Full:
                        self._dropped += 1
                try:
                    block = self._out_q.get_nowait()
                    if outdata.shape[1] > 1:
                        outdata[:] = np.repeat(block.reshape(-1, 1), outdata.shape[1], axis=1)
                    else:
                        outdata[:, 0] = block
                except queue.Empty:
                    outdata.fill(0)          # 欠载：给静音，不阻塞
                    self._underrun += 1
            else:  # bypass
                out = mono * self._gain
                if outdata.shape[1] > 1:
                    outdata[:] = np.repeat(out.reshape(-1, 1), outdata.shape[1], axis=1)
                else:
                    outdata[:, 0] = out
            self._frames += frames
            if status:
                self._last_error = str(status)
        except Exception as exc:  # 回调里绝不能抛
            outdata.fill(0)
            self._last_error = f"{type(exc).__name__}: {exc}"

    # ------------------------------------------------------------------
    # 推理线程（消费者）
    # ------------------------------------------------------------------
    def _infer_loop(self) -> None:
        while not self._worker_stop.is_set():
            try:
                block = self._in_q.get(timeout=0.2)
            except queue.Empty:
                continue
            t0 = time.perf_counter()
            try:
                out = self._process_block(block)
            except MemoryError as exc:                      # 常见于显存/内存爆掉
                self._fallback(f"推理内存不足，已回退 bypass：{exc}")
                out = block
            except Exception as exc:
                # torch.cuda.OutOfMemoryError 等（无 torch 时按名字判断）
                name = type(exc).__name__
                if "OutOfMemory" in name or "CUDA" in name:
                    self._fallback(f"{name}：{exc}，已回退 bypass")
                else:
                    self._last_error = f"推理异常（继续 mock）：{name}: {exc}"
                out = block
            self._infer_ms = (time.perf_counter() - t0) * 1000.0
            try:
                self._out_q.put_nowait(out.astype(np.float32))
            except queue.Full:
                try:
                    self._out_q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self._out_q.put_nowait(out.astype(np.float32))
                except queue.Full:
                    self._dropped += 1

    def _process_block(self, block: np.ndarray) -> np.ndarray:
        """真正的变声处理：真实 RVC 走常驻 worker（svc 环境），否则 mock 变调。"""
        if self._engine == "rvc" and self._rvc_worker is not None and self._rvc_worker.state == "ready":
            x16 = _resample(block, self._samplerate, 16000)
            pcm16 = np.clip(x16 * 32767.0, -32768, 32767).astype(np.int16)
            try:
                out16 = self._rvc_worker.process(pcm16)
            except Exception as exc:
                # 超时/崩溃：重启 worker（后台），本块回退直通，音频不断
                self._last_error = f"RVC worker 失败，已回退直通：{type(exc).__name__}: {exc}"
                threading.Thread(target=self._rvc_worker.restart, daemon=True).start()
                return block
            tgt = self._rvc_worker.tgt_sr or 40000
            y = np.asarray(out16, dtype=np.float32) / 32768.0
            if tgt != 16000:
                y = _resample(y, tgt, self._samplerate)
            else:
                y = _resample(y, 16000, self._samplerate)
            if y.size < block.size:
                y = np.pad(y, (0, block.size - y.size))
            return y[: block.size]
        # mock-rvc：用变调证明队列与重采样链路
        return _pitch_shift_mock(block, self._samplerate, self._pitch)

    def _fallback(self, msg: str) -> None:
        self._last_error = msg
        self._engine = "mock-rvc"

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def start(self, input_device, output_device, pitch: int, mode: str,
              samplerate: int, blocksize: int, gain: float) -> dict:
        if sd is None:
            raise RuntimeError(f"sounddevice 不可用：{_SD_IMPORT_ERROR}")
        with self._lock:
            if self._stream is not None:
                raise RuntimeError("音频流已在运行，先 POST /stop")
            self._mode = mode if mode in ("bypass", "tone", "rvc") else "bypass"
            self._engine = "mock-rvc" if self._mode == "rvc" else self._mode
            self._pitch = int(pitch or 0)
            self._gain = float(gain if gain is not None else 1.0)
            self._samplerate = int(samplerate or 48000)
            self._blocksize = int(blocksize or 1024)
            self._frames = self._dropped = self._underrun = 0
            self._tone_phase = 0.0
            self._last_error = ""
            self._in_q = queue.Queue(maxsize=QUEUE_MAX)
            self._out_q = queue.Queue(maxsize=QUEUE_MAX)

            in_dev = self._resolve(input_device, "input") if self._mode != "tone" else None
            out_dev = self._resolve(output_device, "output")

            try:
                if self._mode == "tone":
                    self._stream = sd.OutputStream(
                        samplerate=self._samplerate, blocksize=self._blocksize, channels=1,
                        dtype="float32", device=out_dev, callback=self._tone_callback,
                    )
                else:
                    self._stream = sd.Stream(
                        samplerate=self._samplerate, blocksize=self._blocksize, channels=(2, 2),
                        dtype="float32",
                        device=(in_dev, out_dev) if in_dev is not None else out_dev,
                        callback=self._stream_callback,
                    )
                self._stream.start()
            except Exception as exc:
                self._stream = None
                raise RuntimeError(f"打开音频流失败：{type(exc).__name__}: {exc}")

            if self._mode == "rvc":
                self._worker_stop.clear()
                self._worker = threading.Thread(target=self._infer_loop, name="rvc-infer", daemon=True)
                self._worker.start()

            self._started_at = time.time()
            return self.info()

    def stop(self) -> dict:
        with self._lock:
            self._worker_stop.set()
            if self._worker is not None and self._worker.is_alive():
                self._worker.join(timeout=1.0)
            self._worker = None
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                finally:
                    self._stream = None
            return self.info()

    def _resolve(self, name, kind: str):
        if name in (None, "", "default"):
            return None
        if isinstance(name, int) or str(name).isdigit():
            return int(name)
        devices = sd.query_devices()
        for idx, dev in enumerate(devices):
            key = "max_input_channels" if kind == "input" else "max_output_channels"
            if dev["name"] == name and dev.get(key, 0) > 0:
                return idx
        for idx, dev in enumerate(devices):
            if name.lower() in dev["name"].lower():
                return idx
        raise RuntimeError(f"找不到{kind}设备：{name}（用 GET /devices 查可用名字）")

    def info(self) -> dict:
        running = self._stream is not None
        queued = self._in_q.qsize() if self._in_q else 0
        return {
            "ok": True,
            "running": running,
            "mode": self._mode,
            "engine": self._engine,
            "pitch": self._pitch,
            "samplerate": self._samplerate if running else None,
            "blocksize": self._blocksize if running else None,
            "frames": self._frames,
            "seconds": round(time.time() - self._started_at, 1) if running else 0,
            "queued": queued,
            "dropped": self._dropped,
            "underrun": self._underrun,
            "infer_ms": round(self._infer_ms, 1),
            "model": self._model or None,
            "worker": self._rvc_worker.info() if self._rvc_worker else None,
            "backend": "sounddevice" if sd is not None else f"unavailable: {_SD_IMPORT_ERROR}",
            "last_error": self._last_error or None,
        }


ENGINE = Engine()


class StartBody(BaseModel):
    input_device: Optional[str] = Field(default=None, description="输入设备名/索引；tone 模式可空")
    output_device: Optional[str] = Field(default=None, description="输出设备名/索引")
    pitch: int = Field(default=0, description="变调半音")
    mode: str = Field(default="bypass", description="bypass 直通 / tone 正弦 / rvc 变声")
    samplerate: int = Field(default=48000)
    blocksize: int = Field(default=1024)
    gain: float = Field(default=1.0)


class ModelBody(BaseModel):
    model_path: str
    index_path: Optional[str] = None


class FxPlanBody(BaseModel):
    text: str
    energy: Optional[float] = Field(default=None, description="当前精力 0~1，越低越容易触发哈欠")


class FxApplyBody(BaseModel):
    voice_path: str = Field(description="待处理的语音 wav 路径")
    effect: str = Field(description="气口类型：sigh / giggle / yawn")
    out_path: Optional[str] = Field(default=None, description="输出路径，缺省为 <voice>_<effect>.wav")
    ms: int = Field(default=30, description="交叉淡化毫秒数")
    gain: float = Field(default=0.9)


@app.get("/health")
def health():
    return ENGINE.info()


@app.get("/devices")
def devices():
    if sd is None:
        raise HTTPException(status_code=503, detail=f"sounddevice 不可用：{_SD_IMPORT_ERROR}")
    items = []
    for idx, dev in enumerate(sd.query_devices()):
        items.append({
            "index": idx,
            "name": dev["name"],
            "hostapi": sd.query_hostapis(dev["hostapi"])["name"],
            "in": dev["max_input_channels"],
            "out": dev["max_output_channels"],
            "default_samplerate": dev["default_samplerate"],
        })
    return {"ok": True, "count": len(items), "devices": items}


@app.post("/start")
def start(body: StartBody):
    try:
        return ENGINE.start(body.input_device, body.output_device, body.pitch, body.mode,
                            body.samplerate, body.blocksize, body.gain)
    except RuntimeError as exc:
        msg = str(exc)
        code = 409 if ("busy" in msg.lower() or "占用" in msg or "unavailable" in msg.lower()) else 400
        raise HTTPException(status_code=code, detail=msg)


@app.post("/stop")
def stop():
    return ENGINE.stop()



@app.post("/voice_fx/plan")
def voice_fx_plan(body: FxPlanBody):
    """按文本（和可选精力值）判断该配哪种气口，不落盘。"""
    return {"ok": True, **voice_fx.plan(body.text, body.energy)}


@app.post("/voice_fx/apply")
def voice_fx_apply(body: FxApplyBody):
    """把气口插到语音前面，做交叉淡化后写文件。"""
    path = os.path.abspath(os.path.expanduser(body.voice_path))
    if not os.path.isfile(path):
        raise HTTPException(status_code=400, detail=f"语音文件不存在：{path}")
    try:
        out = os.path.abspath(os.path.expanduser(body.out_path)) if body.out_path else None
        return voice_fx.prepend(path, body.effect, out, ms=int(body.ms), gain=float(body.gain))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}")


@app.get("/voice_fx/assets")
def voice_fx_assets():
    """列出已就位的气口素材（不存在时自动生成占位音）。"""
    voice_fx.ensure_placeholders()
    items = []
    for k in voice_fx.FX_KINDS:
        p = voice_fx.FX_DIR / f"{k}.wav"
        items.append({"effect": k, "path": str(p), "exists": p.is_file(),
                      "bytes": p.stat().st_size if p.is_file() else 0})
    return {"ok": True, "dir": str(voice_fx.FX_DIR), "items": items}


@app.post("/load_model")
def load_model(body: ModelBody):
    """加载模型：走 svc 环境里的常驻 worker（rvc_worker.py）。

    失败（worker 起不来 / 加载超时 / 模型不兼容）一律降级为 mock 变调，
    音频链路继续可用，错误写进 /health 的 last_error 与 worker.last_error。
    """
    path = os.path.abspath(os.path.expanduser(body.model_path))
    if not os.path.isfile(path):
        raise HTTPException(status_code=400, detail=f"模型文件不存在：{path}")
    index = None
    if body.index_path:
        index = os.path.abspath(os.path.expanduser(body.index_path))
        if not os.path.isfile(index):
            raise HTTPException(status_code=400, detail=f"index 文件不存在：{index}")

    if ENGINE._rvc_worker is None:
        ENGINE._rvc_worker = RvcWorkerClient()

    cli = ENGINE._rvc_worker
    if not cli.available():
        ENGINE._engine = "mock-rvc"
        ENGINE._model = {"model_path": path, "index_path": index, "loaded_at": time.time()}
        return {"ok": False, "engine": "mock-rvc",
                "note": f"找不到 worker 的 python 或脚本（{cli.python} / {cli.script}）",
                "model": ENGINE._model}

    rsp = cli.load(path, index or "", pitch=ENGINE._pitch)
    ENGINE._model = {"model_path": path, "index_path": index, "loaded_at": time.time()}
    if rsp.get("ok") and not rsp.get("mock"):
        ENGINE._engine = "rvc"
    else:
        ENGINE._engine = "mock-rvc"
        ENGINE._last_error = rsp.get("error") or rsp.get("note") or "worker 降级 mock"
    return {"ok": bool(rsp.get("ok")), "engine": ENGINE._engine,
            "worker": cli.info(), "model": ENGINE._model,
            "note": rsp.get("note") or rsp.get("error") or ""}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("AUDIO_COVER_HOST", "127.0.0.1")
    port = int(os.environ.get("AUDIO_COVER_PORT", "8005"))
    print(f"{LOG_TAG} listening on http://{host}:{port}  (sounddevice={'ok' if sd else 'missing'})", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="info")
