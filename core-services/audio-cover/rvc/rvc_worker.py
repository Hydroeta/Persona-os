# -*- coding: utf-8 -*-
r"""rvc_worker.py —— 常驻 RVC 实时推理进程（IPC 桥接）

为什么单独一个进程：
  RVC 依赖（torch / faiss / fairseq 系）装在 svc\env，而 audio-cover 跑在另一套 venv 里。
  用子进程 + 管道通信，既避免依赖冲突，又不用每个音频块都起一次进程（那必然爆延迟）。

协议（stdin / stdout 双向，二进制安全）：
    每条消息 = [4 字节大端长度][payload]
    payload 第 1 字节是类型：
        b'J' -> 之后是 UTF-8 JSON（控制指令 / 状态回执）
        b'A' -> 之后是 int16 LE 单声道 PCM

  客户端 -> worker：
        {"cmd":"load","model_path":"...","index_path":"...","pitch":0,"f0method":"rmvpe"}
        {"cmd":"ping"} / {"cmd":"info"}
        A 消息：音频块（16kHz 单声道 int16）
  worker -> 客户端：
        {"event":"ready","tgt_sr":40000,...}   加载成功（tgt_sr 是输出采样率）
        {"event":"pong"} / {"event":"info",...}
        {"event":"error","error":"..."}
        A 消息：转换后的音频块（tgt_sr 单声道 int16，长度对应输入块）

降级：模型加载失败或推理异常时，worker 进入 mock 模式（简单变调），保证协议与链路可验证。
"""
from __future__ import annotations

import json
import os
import struct
import sys
import traceback

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

TAG_J = b"J"
TAG_A = b"A"


# ---------------------------------------------------------------------------
# 管道读写
# ---------------------------------------------------------------------------
def read_exact(n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            raise EOFError("stdin closed")
        buf += chunk
    return buf


def recv() -> tuple[bytes, bytes]:
    head = read_exact(4)
    (length,) = struct.unpack(">I", head)
    payload = read_exact(length) if length else b""
    return payload[:1], payload[1:]


def send(tag: bytes, data: bytes) -> None:
    payload = tag + data
    sys.stdout.buffer.write(struct.pack(">I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def send_json(obj: dict) -> None:
    send(TAG_J, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def send_audio(pcm: np.ndarray) -> None:
    send(TAG_A, pcm.astype(np.int16).tobytes())


# ---------------------------------------------------------------------------
# 引擎
# ---------------------------------------------------------------------------
class Engine:
    def __init__(self) -> None:
        self.rvc = None
        self.tgt_sr = 40000
        self.pitch = 0
        self.f0method = "rmvpe"
        self.mock = True
        self.model_path = ""
        self.index_path = ""
        self.infer_ms = 0.0
        self.calls = 0

    def load(self, model_path: str, index_path: str = "", pitch: int = 0,
             f0method: str = "rmvpe", device: str = "cpu", is_half: bool = False) -> dict:
        import time
        t0 = time.perf_counter()
        self.pitch = int(pitch)
        self.f0method = f0method or "rmvpe"
        self.model_path = model_path
        self.index_path = index_path or ""
        self.mock = True
        self.rvc = None
        def _log(m):
            print(f"[worker] {m}", file=sys.stderr, flush=True)

        try:
            _log("import torch...")
            import torch
            _log(f"torch ok {torch.__version__}")
            # Windows + CPU 版 torch 多线程容易在线程池里死锁（0%% CPU、几十线程）
            try:
                n_threads = int(os.environ.get('RVC_THREADS', '1'))
                torch.set_num_threads(n_threads)
                _log(f'threads set to {n_threads}')
            except Exception as _e:
                _log(f'set_num_threads failed: {_e}')
            from configs.config import Config
            from infer import rtrvc as rvc_for_realtime
            _log("imports ok")

            cfg = Config()
            _log(f"config ok device={cfg.device} is_half={cfg.is_half}")
            cfg.device = torch.device(device)
            cfg.is_half = bool(is_half) and device.startswith("cuda")
            self.rvc = rvc_for_realtime.RVC(
                self.pitch, 0.0, model_path, index_path or "", 0.75 if index_path else 0.0, cfg,
            )
            _log("RVC 构造完成")
            self.tgt_sr = int(getattr(self.rvc, "tgt_sr", 40000))
            # 预热：跑一块静音，避免第一块超时（RVC_NO_WARMUP=1 可跳过，便于定位加载问题）
            if os.environ.get('RVC_NO_WARMUP', '0') != '1':
                warm = np.zeros(16000 // 3, dtype=np.int16)
                self._infer_real(warm)
                _log('warmup ok')
            self.mock = False
            note = "真实 RVC 引擎已加载"
        except Exception as exc:
            note = f"RVC 加载失败，降级 mock 变调：{type(exc).__name__}: {exc}"
            self.rvc = None
            self.mock = True
        _log(f'returning ready mock={self.mock} tgt_sr={self.tgt_sr}')
        return {
            "event": "ready",
            "mock": self.mock,
            "tgt_sr": self.tgt_sr,
            "model_path": model_path,
            "index_path": index_path or "",
            "load_ms": round((time.perf_counter() - t0) * 1000, 1),
            "note": note,
        }

    # -- 真实推理 -----------------------------------------------------------
    def _infer_real(self, pcm16: np.ndarray) -> np.ndarray:
        import torch
        x = pcm16.astype(np.float32) / 32768.0
        tensor = torch.from_numpy(x).to(self.rvc.device)
        n = int(tensor.numel())
        out = self.rvc.infer(tensor, n, 0, n, self.f0method)
        if isinstance(out, tuple):
            out = out[0]
        if hasattr(out, "detach"):
            out = out.detach().cpu().numpy()
        out = np.asarray(out, dtype=np.float32).flatten()
        return np.clip(out * 32767.0, -32768, 32767).astype(np.int16)

    # -- mock 变调（仅验证链路）---------------------------------------------
    def _infer_mock(self, pcm16: np.ndarray) -> np.ndarray:
        if self.pitch == 0 or pcm16.size == 0:
            return pcm16
        x = pcm16.astype(np.float32) / 32768.0
        ratio = 2.0 ** (self.pitch / 12.0)
        out_len = max(1, int(round(x.size / ratio)))
        idx = np.linspace(0, x.size - 1, out_len)
        y = np.interp(idx, np.arange(x.size), x)
        # 拉回原长度，保持与输入块严格对齐
        idx2 = np.linspace(0, y.size - 1, pcm16.size)
        y = np.interp(idx2, np.arange(y.size), y)
        return np.clip(y * 32767.0, -32768, 32767).astype(np.int16)

    def process(self, pcm16: np.ndarray) -> np.ndarray:
        import time
        t0 = time.perf_counter()
        if self.rvc is not None:
            try:
                out = self._infer_real(pcm16)
            except Exception as exc:
                self.rvc = None
                self.mock = True
                send_json({"event": "error", "error": f"推理失败，切 mock：{type(exc).__name__}: {exc}"})
                out = self._infer_mock(pcm16)
        else:
            out = self._infer_mock(pcm16)
        self.infer_ms = (time.perf_counter() - t0) * 1000.0
        self.calls += 1
        if self.calls % 50 == 0:
            send_json({"event": "stats", "infer_ms": round(self.infer_ms, 1), "calls": self.calls,
                       "mock": self.mock, "tgt_sr": self.tgt_sr})
        return out


def main() -> None:
    eng = Engine()
    send_json({"event": "hello", "pid": os.getpid(), "mode": "rvc-worker"})
    while True:
        try:
            tag, data = recv()
        except EOFError:
            break
        except Exception:
            break
        if tag == TAG_J:
            try:
                msg = json.loads(data.decode("utf-8") or "{}")
            except Exception:
                send_json({"event": "error", "error": "JSON 解析失败"})
                continue
            cmd = msg.get("cmd")
            if cmd == "load":
                try:
                    print("[worker] calling load", file=sys.stderr, flush=True)
                    send_json(eng.load(
                        msg.get("model_path", ""), msg.get("index_path", ""),
                        int(msg.get("pitch", 0)), msg.get("f0method", "rmvpe"),
                        msg.get("device", "cpu"), bool(msg.get("is_half", False)),
                    ))
                except Exception as exc:
                    send_json({"event": "error", "error": f"{type(exc).__name__}: {exc}",
                               "trace": traceback.format_exc()[-800:]})
            elif cmd == "ping":
                send_json({"event": "pong"})
            elif cmd == "info":
                send_json({"event": "info", "mock": eng.mock, "tgt_sr": eng.tgt_sr,
                           "infer_ms": round(eng.infer_ms, 1), "calls": eng.calls,
                           "model_path": eng.model_path, "index_path": eng.index_path})
            elif cmd == "quit":
                send_json({"event": "bye"})
                break
            else:
                send_json({"event": "error", "error": f"未知指令 {cmd}"})
        elif tag == TAG_A:
            if not data:
                continue
            pcm = np.frombuffer(data, dtype=np.int16)
            try:
                out = eng.process(pcm)
            except Exception as exc:
                send_json({"event": "error", "error": f"{type(exc).__name__}: {exc}"})
                out = pcm
            send_audio(out)
        else:
            send_json({"event": "error", "error": f"未知标签 {tag!r}"})


if __name__ == "__main__":
    main()
