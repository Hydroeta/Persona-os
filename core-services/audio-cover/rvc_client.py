# -*- coding: utf-8 -*-
r"""rvc_client.py —— audio-cover 侧的常驻 RVC worker 客户端

职责：把「起 worker / 热加载模型 / 送一块音频拿回一块」封装成对象，并把所有失败
变成**可降级**的结果：超时、崩溃、模型加载失败都只写 last_error 并回退直通，
绝不让音频流断掉。

实现要点：**独立读线程 + 队列**。管道阻塞读不能靠 deadline 兜底（read 会一直挂住），
所以后台线程无条件读包并塞进队列，调用方用 queue.get(timeout=...) 超时。
协议见 rvc_worker.py：`[4B 大端长度][1B 类型][payload]`，类型 J=JSON / A=int16 PCM。
"""
from __future__ import annotations

import json
import os
import queue
import struct
import subprocess
import threading
import time
from typing import Optional

import numpy as np

DEFAULT_PY = r"C:\Users\79365\Desktop\新建文件夹 (2)\index-tts\.venv\Scripts\python.exe"
DEFAULT_SCRIPT = r"C:\Users\79365\Desktop\新建文件夹 (2)\svc\Retrieval-based-Voice-Conversion-WebUI-main\rvc_worker.py"

TAG_J = b"J"
TAG_A = b"A"


class RvcWorkerClient:
    def __init__(self) -> None:
        # 与子进程环境保持一致：默认 GPU 半精度（4GB 显存跑 fp16 更稳），CPU 线程压到 1
        os.environ.setdefault("RVC_DEVICE", "cuda")
        os.environ.setdefault("RVC_HALF", "1")
        os.environ.setdefault("OMP_NUM_THREADS", "1")
        self.python = os.environ.get("RVC_WORKER_PYTHON", DEFAULT_PY)
        self.script = os.environ.get("RVC_WORKER_SCRIPT", DEFAULT_SCRIPT)
        self.block_timeout = float(os.environ.get("RVC_WORKER_TIMEOUT", "3.0"))
        self.load_timeout = float(os.environ.get("RVC_LOAD_TIMEOUT", "120"))
        self._p: Optional[subprocess.Popen] = None
        self._raw: "queue.Queue[tuple]" = queue.Queue(maxsize=64)
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.state = "stopped"          # stopped / starting / ready / failed
        self.last_error = ""
        self.tgt_sr = 40000
        self.mock = True
        self.restarts = 0
        self.infer_ms = 0.0

    # ------------------------------------------------------------------
    def available(self) -> bool:
        return os.path.isfile(self.python) and os.path.isfile(self.script)

    def _reader_loop(self, proc: subprocess.Popen) -> None:
        """无条件读包；进程结束就退出。"""
        out = proc.stdout
        try:
            while True:
                head = out.read(4)
                if len(head) < 4:
                    break
                (length,) = struct.unpack(">I", head)
                payload = out.read(length) if length else b""
                if length and len(payload) < length:
                    break
                if self._raw.full():
                    try:
                        self._raw.get_nowait()
                    except queue.Empty:
                        pass
                self._raw.put_nowait((payload[:1], payload[1:]))
        except Exception:
            pass
        finally:
            try:
                self._raw.put_nowait(("EOF", b""))
            except queue.Full:
                pass

    def _spawn(self) -> None:
        self.state = "starting"
        self._raw = queue.Queue(maxsize=64)
        cwd = os.path.dirname(self.script)
        env = dict(os.environ)
        # 默认跳过预热：底模预热在这台机器上会挂住（0 CPU），跳过才能验证协议
        env.setdefault('RVC_NO_WARMUP', '1')
        env.setdefault('RVC_DEVICE', 'cuda')
        env.setdefault('RVC_HALF', '1')
        env.setdefault('OMP_NUM_THREADS', '1')
        self._p = subprocess.Popen(
            [self.python, "-u", self.script],
            cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        self._reader = threading.Thread(target=self._reader_loop, args=(self._p,), daemon=True)
        self._reader.start()
        hello = self._recv_json(timeout=30)
        if hello.get("event") != "hello":
            raise RuntimeError(f"worker 握手异常：{hello}")
        self.state = "ready"

    def _send(self, tag: bytes, data: bytes) -> None:
        p = self._p
        if not p or p.poll() is not None:
            raise RuntimeError("worker 未运行")
        payload = tag + data
        p.stdin.write(struct.pack(">I", len(payload)) + payload)
        p.stdin.flush()

    def _recv(self, timeout: float):
        tag, data = self._raw.get(timeout=max(0.05, timeout))
        if tag == "EOF":
            raise EOFError("worker 进程已退出")
        return tag, data

    def _recv_json(self, timeout: float) -> dict:
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise TimeoutError("等 worker JSON 回执超时")
            tag, data = self._recv(remain)
            if tag == TAG_J:
                return json.loads(data.decode("utf-8") or "{}")

    # ------------------------------------------------------------------
    def load(self, model_path: str, index_path: str = "", pitch: int = 0) -> dict:
        """起 worker 并加载模型；失败返回 {ok:False,error}，调用方据此降级。"""
        with self._lock:
            try:
                self.close()
                self._spawn()
                self._send(TAG_J, json.dumps({
                    "cmd": "load", "model_path": model_path, "index_path": index_path or "",
                    "pitch": int(pitch), "device": os.environ.get("RVC_DEVICE", "cuda"),
                    "is_half": os.environ.get("RVC_HALF", "1") == "1",
                }).encode("utf-8"))
                rsp = self._recv_json(self.load_timeout)
                if rsp.get("event") == "ready":
                    self.tgt_sr = int(rsp.get("tgt_sr", 40000))
                    self.mock = bool(rsp.get("mock", True))
                    self.state = "ready"
                    return {"ok": True, **rsp}
                self.state = "failed"
                self.last_error = str(rsp.get("error") or rsp)
                self.close()
                return {"ok": False, "error": self.last_error}
            except queue.Empty:
                self.last_error = f"worker 在 {self.load_timeout:.0f}s 内没有回应（推理/加载卡死）"
                self.state = "failed"
                self.close()
                return {"ok": False, "error": self.last_error}
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                self.state = "failed"
                self.close()
                return {"ok": False, "error": self.last_error}

    def process(self, pcm16: np.ndarray) -> np.ndarray:
        """送一块 16k int16，拿回一块（tgt_sr 或同 16k，取决于 worker 是否 mock）。"""
        with self._lock:
            if not self._p or self._p.poll() is not None or self.state != "ready":
                raise RuntimeError("worker 不可用")
            t0 = time.perf_counter()
            self._send(TAG_A, pcm16.astype(np.int16).tobytes())
            deadline = t0 + self.block_timeout
            while True:
                remain = deadline - time.time()
                if remain <= 0:
                    raise TimeoutError(f"worker 推理超时（>{self.block_timeout}s）")
                tag, data = self._recv(remain)
                if tag == TAG_A:
                    self.infer_ms = (time.perf_counter() - t0) * 1000.0
                    return np.frombuffer(data, dtype=np.int16)
                msg = json.loads(data.decode("utf-8", "ignore") or "{}")
                if msg.get("event") == "error":
                    self.last_error = str(msg.get("error", "worker 报错"))

    def restart(self) -> None:
        with self._lock:
            self.restarts += 1
            model = getattr(self, "_model_args", None)
            self.close()
            try:
                self._spawn()
                if model:
                    self._send(TAG_J, json.dumps({"cmd": "load", **model}).encode("utf-8"))
                    self._recv_json(self.load_timeout)
            except Exception as exc:
                self.state = "failed"
                self.last_error = f"重启失败：{type(exc).__name__}: {exc}"

    def close(self) -> None:
        p, self._p = self._p, None
        if p is None:
            return
        try:
            if p.poll() is None:
                try:
                    payload = TAG_J + json.dumps({"cmd": "quit"}).encode()
                    p.stdin.write(struct.pack(">I", len(payload)) + payload)
                    p.stdin.flush()
                except Exception:
                    pass
                time.sleep(0.05)
                p.kill()
        except Exception:
            pass
        self.state = "stopped"

    def info(self) -> dict:
        return {
            "state": self.state,
            "mock": self.mock,
            "tgt_sr": self.tgt_sr,
            "restarts": self.restarts,
            "infer_ms": round(self.infer_ms, 1),
            "last_error": self.last_error or None,
        }
