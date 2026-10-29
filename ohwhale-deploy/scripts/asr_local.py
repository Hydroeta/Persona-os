# -*- coding: utf-8 -*-
"""本地 ASR 适配器（sherpa-onnx 流式 paraformer）——不需要任何云端密钥

为什么单独一层：通话链路不能因为换 ASR 就改得面目全非。call_loop 只问三件事：
    available()            能不能用本地
    Stream()               开一个"边说边识别"的会话（feed / finish）
    transcribe(pcm_bytes)  整段识别（合并多段音频时用）

装了 sherpa-onnx 且模型在位才生效；否则 available() 返回 False，
call_loop 照旧走 DashScope，行为完全不变。

安装（哦鲸鲸自己的 venv 里执行，别装进 GPT-SoVITS 的 .venv-tts）：
    pip install sherpa-onnx -i https://mirrors.aliyun.com/pypi/simple/
模型（约 230 MB，走 HF 镜像）：
    models/asr/sherpa-onnx-streaming-paraformer-bilingual-zh-en/
        encoder.int8.onnx / decoder.int8.onnx / tokens.txt

config.json：
    audio.asr_backend        auto（默认）/ sherpa / dashscope
    audio.asr_local_model_dir  模型目录
    audio.asr_local_device   cpu（默认）/ cuda
    audio.asr_local_threads  解码线程数，默认 2

CLI：
    python scripts/asr_local.py --check     # 只看可用性（不加载模型）
"""
from __future__ import annotations

import importlib.util
import os
import threading

import numpy as np

RATE = 16000
_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")
_LOCK = threading.RLock()
_REC = None


def _setting(key, default=None):
    try:
        from ohwhale.config import get
        return get("audio." + key, default)
    except Exception:  # noqa: BLE001
        return default


def backend() -> str:
    return str(_setting("asr_backend", "auto")).lower()


def model_dir() -> str:
    rel = str(_setting("asr_local_model_dir",
                       "models/asr/sherpa-onnx-streaming-paraformer-bilingual-zh-en"))
    if os.path.isabs(rel):
        return rel
    try:
        from ohwhale.config import project_path
        return project_path(rel)
    except Exception:  # noqa: BLE001
        return rel


def available() -> bool:
    """只查包和模型在不在，不加载模型。"""
    if backend() == "dashscope":
        return False
    try:
        if importlib.util.find_spec("sherpa_onnx") is None:
            return False
    except Exception:  # noqa: BLE001
        return False
    d = model_dir()
    return all(os.path.exists(os.path.join(d, f)) for f in _FILES)


def _recognizer():
    global _REC
    if _REC is not None:
        return _REC
    with _LOCK:
        if _REC is not None:
            return _REC
        import sherpa_onnx
        d = model_dir()
        try:
            threads = max(1, int(_setting("asr_local_threads", 2)))
        except (TypeError, ValueError):
            threads = 2
        _REC = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=os.path.join(d, "tokens.txt"),
            encoder=os.path.join(d, "encoder.int8.onnx"),
            decoder=os.path.join(d, "decoder.int8.onnx"),
            num_threads=threads,
            sample_rate=RATE,
            feature_dim=80,
            # 端点检测只用来切"这句完了"，断句仍由 Ear 的 VAD 决定
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            provider=str(_setting("asr_local_device", "cpu")),
        )
        return _REC


def _text(result) -> str:
    return str(getattr(result, "text", result) or "").strip()


def _as_16k(audio, sample_rate: int) -> np.ndarray:
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if sample_rate and sample_rate != RATE and len(a):
        n = max(1, int(len(a) * RATE / sample_rate))
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


class Stream:
    """一句话的流式识别会话：边说边喂，finish() 拿最终文本。"""

    def __init__(self):
        self.text = ""
        self.ok = False
        try:
            self._rec = _recognizer()
            self._stream = self._rec.create_stream()
            self.ok = True
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"本地 ASR 不可用：{exc}") from exc

    def feed(self, frame) -> None:
        if not self.ok:
            return
        try:
            self._stream.accept_waveform(
                RATE, np.asarray(frame, dtype=np.float32).reshape(-1))
            while self._rec.is_ready(self._stream):
                self._rec.decode_stream(self._stream)
            self.text = _text(self._rec.get_result(self._stream))
        except Exception:  # noqa: BLE001
            self.ok = False

    def finish(self) -> str:
        if not self.ok:
            return ""
        try:
            self._stream.input_finished()
            while self._rec.is_ready(self._stream):
                self._rec.decode_stream(self._stream)
            self.text = (_text(self._rec.get_result(self._stream))
                         or self.text)
        except Exception:  # noqa: BLE001
            pass
        return (self.text or "").strip()


def transcribe(pcm_bytes: bytes, sample_rate: int = RATE) -> str:
    """整段识别。模型缺失时抛 RuntimeError，调用方应回退云端。"""
    if not available():
        raise RuntimeError("本地 ASR 未安装或模型缺失")
    audio = _as_16k(np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0,
                    sample_rate)
    if not len(audio):
        return ""
    step = int(RATE * 0.6)
    with _LOCK:
        rec = _recognizer()
        stream = rec.create_stream()
        for i in range(0, len(audio), step):
            stream.accept_waveform(RATE, audio[i:i + step])
            while rec.is_ready(stream):
                rec.decode_stream(stream)
        stream.input_finished()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return _text(rec.get_result(stream))


def warmup() -> float:
    """提前把模型读进内存，别把加载时间算进第一轮首音延迟。"""
    import time
    t = time.time()
    _recognizer()
    return time.time() - t


def check() -> dict:
    out = {
        "available": available(),
        "backend": backend(),
        "model_dir": model_dir(),
        "device": str(_setting("asr_local_device", "cpu")),
    }
    if not out["available"]:
        out["files_present"] = [f for f in _FILES
                                if os.path.exists(os.path.join(model_dir(), f))]
        out["hint"] = "pip install sherpa-onnx；缺模型就去 hf-mirror 下三个文件"
    return out


if __name__ == "__main__":
    import json
    import sys
    if "--check" in sys.argv:
        print(json.dumps(check(), ensure_ascii=False, indent=2))
    else:
        print(f"模型加载 {warmup():.2f}s，可用性 {check()}")
