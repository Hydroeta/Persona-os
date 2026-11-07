# -*- coding: utf-8 -*-
r"""persona-os · Audio Cover 实时翻唱微服务（SVC/RVC，端口 :8005）

职责：把「抓取指定输入设备音频 → 变声 → 推给指定输出设备」的实时音频闭环做成独立 HTTP 微服务，
供 TS 侧（dsh-audio-cover 插件 / 直播引擎）拉起与调度。

现阶段只做**音频流闭环**（不跑 RVC 推理）：
  - `mode=bypass`：直通（输入原样推到输出），用来验证设备与路由是否打通
  - `mode=tone`  ：不读输入设备，直接输出 440Hz 正弦波，用来单独验证输出链路
RVC 推理接口（`/load_model`）已预留，接入时只需替换 `Engine._process()` 里的处理逻辑。

接口：
    GET  /health                        健康检查 + 当前状态
    GET  /devices                       列出音频输入/输出设备（排查设备名用）
    POST /start                         {"input_device","output_device","pitch","mode","samplerate","blocksize"}
                                        设备被占用/名字不存在 → 409 + {"ok":false,"error":"..."}
    POST /stop                          停止并释放音频流
    POST /load_model                    {"model_path","index_path"} 预留：校验文件存在并记录

运行（复用带 fastapi/uvicorn 的环境；绝对路径，任意 cwd 可跑）：
    & "%USERPROFILE%\Desktop\persona-os\.venv\Scripts\python.exe" "%PROJECT_ROOT%\core-services\audio-cover\main.py"

环境变量：
    AUDIO_COVER_PORT    监听端口（默认 8005）
    AUDIO_COVER_HOST    监听地址（默认 127.0.0.1）
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:  # sounddevice 缺失时服务仍可启动，只是 /start 会明确报错
    import sounddevice as sd
except Exception as _e:  # pragma: no cover - 环境相关
    sd = None
    _SD_IMPORT_ERROR = str(_e)
else:
    _SD_IMPORT_ERROR = ""

LOG_TAG = "[audio-cover]"

app = FastAPI(title="persona-os audio-cover", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Engine:
    """全双工音频流：输入 → 处理 → 输出。线程安全由 _lock 保证。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stream = None
        self._mode = "bypass"
        self._pitch = 0
        self._gain = 1.0
        self._tone_hz = 440.0
        self._tone_phase = 0.0
        self._frames = 0
        self._started_at = 0.0
        self._model: dict = {}
        self._last_error = ""

    # ---- 音频回调（运行在 PortAudio 线程）----
    def _tone_callback(self, outdata, frames, _time_info, status) -> None:
        """OutputStream 专用回调：只写不读，用来单独验证输出链路。"""
        try:
            n = np.arange(frames, dtype=np.float32)
            step = 2.0 * np.pi * self._tone_hz / float(self._samplerate)
            wave = np.sin(self._tone_phase + n * step) * 0.2
            self._tone_phase = (self._tone_phase + frames * step) % (2.0 * np.pi)
            if outdata.shape[1] == 1:
                outdata[:, 0] = wave
            else:
                outdata[:] = wave.reshape(-1, 1)
            self._frames += frames
            if status:
                self._last_error = str(status)
        except Exception as exc:
            outdata.fill(0)
            self._last_error = f"{type(exc).__name__}: {exc}"

    def _process(self, indata, outdata, frames, _time_info, status) -> None:
        try:
            if self._mode == "tone":
                n = np.arange(frames, dtype=np.float32)
                step = 2.0 * np.pi * self._tone_hz / float(self._samplerate)
                wave = np.sin(self._tone_phase + n * step) * 0.2
                self._tone_phase = (self._tone_phase + frames * step) % (2.0 * np.pi)
                outdata[:] = wave.reshape(-1, 1)
            else:  # bypass：直通（RVC 接入点）
                out = indata * self._gain
                if outdata.shape[1] == 1 and out.shape[1] > 1:
                    out = out.mean(axis=1, keepdims=True)
                elif outdata.shape[1] > 1 and out.shape[1] == 1:
                    out = np.repeat(out, outdata.shape[1], axis=1)
                outdata[:] = out
            self._frames += frames
            if status:
                self._last_error = str(status)
        except Exception as exc:  # 回调里绝不能抛，否则 PortAudio 直接断流
            outdata.fill(0)
            self._last_error = f"{type(exc).__name__}: {exc}"

    def start(self, input_device, output_device, pitch: int, mode: str,
              samplerate: int, blocksize: int, gain: float) -> dict:
        if sd is None:
            raise RuntimeError(f"sounddevice 不可用：{_SD_IMPORT_ERROR}")
        with self._lock:
            if self._stream is not None:
                raise RuntimeError("音频流已在运行，先 POST /stop")
            self._mode = mode if mode in ("bypass", "tone") else "bypass"
            self._pitch = int(pitch or 0)
            self._gain = float(gain if gain is not None else 1.0)
            self._samplerate = int(samplerate or 48000)
            self._frames = 0
            self._tone_phase = 0.0
            self._last_error = ""

            in_dev = self._resolve(input_device, "input") if self._mode == "bypass" else None
            out_dev = self._resolve(output_device, "output")

            kwargs = dict(
                samplerate=self._samplerate,
                blocksize=int(blocksize or 1024),
                channels=None if self._mode == "tone" else (2, 2),
                dtype="float32",
                callback=self._process,
            )
            if in_dev is not None:
                kwargs["device"] = (in_dev, out_dev)
            else:
                kwargs["device"] = out_dev
            try:
                if self._mode == "tone":
                    # OutputStream 的 callback 签名是 (outdata, frames, time, status)，没有 indata
                    self._stream = sd.OutputStream(
                        samplerate=self._samplerate,
                        blocksize=int(blocksize or 1024),
                        channels=1,
                        dtype="float32",
                        device=out_dev,
                        callback=self._tone_callback,
                    )
                else:
                    self._stream = sd.Stream(**kwargs)
                self._stream.start()
            except Exception as exc:
                self._stream = None
                raise RuntimeError(f"打开音频流失败：{type(exc).__name__}: {exc}")
            self._started_at = time.time()
            return self.info()

    def stop(self) -> dict:
        with self._lock:
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                finally:
                    self._stream = None
            return self.info()

    def _resolve(self, name, kind: str):
        """设备名 → 索引；支持 None（系统默认）与索引号。"""
        if name in (None, "", "default"):
            return None
        if isinstance(name, int) or str(name).isdigit():
            return int(name)
        devices = sd.query_devices()
        for idx, dev in enumerate(devices):
            if dev["name"] == name and dev.get("max_" + ("input" if kind == "input" else "output") + "_channels", 0) > 0:
                return idx
        # 模糊匹配（设备名常带驱动前后缀）
        for idx, dev in enumerate(devices):
            if kind[0].upper() in (name or "").upper() and name in dev["name"]:
                return idx
        for idx, dev in enumerate(devices):
            if name.lower() in dev["name"].lower():
                return idx
        raise RuntimeError(f"找不到{kind}设备：{name}（用 GET /devices 查可用名字）")

    def info(self) -> dict:
        running = self._stream is not None
        return {
            "ok": True,
            "running": running,
            "mode": self._mode,
            "pitch": self._pitch,
            "samplerate": getattr(self, "_samplerate", None),
            "frames": self._frames,
            "seconds": round(time.time() - self._started_at, 1) if running else 0,
            "model": self._model or None,
            "backend": "sounddevice" if sd is not None else f"unavailable: {_SD_IMPORT_ERROR}",
            "last_error": self._last_error or None,
        }


ENGINE = Engine()


class StartBody(BaseModel):
    input_device: Optional[str] = Field(default=None, description="输入设备名/索引；tone 模式可空")
    output_device: Optional[str] = Field(default=None, description="输出设备名/索引")
    pitch: int = Field(default=0, description="变调半音（RVC 接入后生效）")
    mode: str = Field(default="bypass", description="bypass 直通 / tone 正弦测试")
    samplerate: int = Field(default=48000)
    blocksize: int = Field(default=1024)
    gain: float = Field(default=1.0)


class ModelBody(BaseModel):
    model_path: str
    index_path: Optional[str] = None


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
        code = 409 if ("已被占用" in msg or "busy" in msg.lower() or "unavailable" in msg.lower()) else 400
        raise HTTPException(status_code=code, detail=msg)


@app.post("/stop")
def stop():
    return ENGINE.stop()


@app.post("/load_model")
def load_model(body: ModelBody):
    path = os.path.abspath(os.path.expanduser(body.model_path))
    if not os.path.isfile(path):
        raise HTTPException(status_code=400, detail=f"模型文件不存在：{path}")
    index = None
    if body.index_path:
        index = os.path.abspath(os.path.expanduser(body.index_path))
        if not os.path.isfile(index):
            raise HTTPException(status_code=400, detail=f"index 文件不存在：{index}")
    ENGINE._model = {"model_path": path, "index_path": index, "loaded_at": time.time()}
    return {"ok": True, "model": ENGINE._model,
            "note": "已记录模型路径；RVC 推理尚未接入，当前仍为直通/tone 模式"}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("AUDIO_COVER_HOST", "127.0.0.1")
    port = int(os.environ.get("AUDIO_COVER_PORT", "8005"))
    print(f"{LOG_TAG} listening on http://{host}:{port}  (sounddevice={'ok' if sd else 'missing'})", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="info")
