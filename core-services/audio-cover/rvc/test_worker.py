# -*- coding: utf-8 -*-
"""rvc_worker 协议冒烟测试：ping → load → 送若干音频块 → 统计延迟与长度。

用法（在 svc\env 里跑，保证和 worker 同环境）：
    python test_worker.py [模型路径] [index路径]
默认用 assets/pretrained_v2/f0G40k.pth（底模，能验证加载与推理不崩）。
"""
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = HERE  # 仓库根就是本脚本所在目录
WORKER = os.path.join(HERE, "rvc_worker.py")
DEFAULT_MODEL = os.path.join(ROOT, "assets", "pretrained_v2", "f0G40k.pth")


class Client:
    def __init__(self, model=os.environ.get("RVC_MODEL", DEFAULT_MODEL), index=os.environ.get("RVC_INDEX", "")):
        self.p = subprocess.Popen(
            [sys.executable, "-u", WORKER],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
        )
        self.model = model
        self.index = index

    def _send(self, tag: bytes, data: bytes):
        payload = tag + data
        self.p.stdin.write(struct.pack(">I", len(payload)) + payload)
        self.p.stdin.flush()

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.p.stdout.read(n - len(buf))
            if not chunk:
                raise EOFError("worker 关闭了 stdout（可能崩了）")
            buf += chunk
        return buf

    def recv(self):
        (length,) = struct.unpack(">I", self._read_exact(4))
        payload = self._read_exact(length) if length else b""
        return payload[:1], payload[1:]

    def json(self, obj):
        self._send(b"J", json.dumps(obj).encode("utf-8"))

    def audio(self, pcm16: np.ndarray):
        self._send(b"A", pcm16.astype(np.int16).tobytes())

    def close(self):
        try:
            self.json({"cmd": "quit"})
        except Exception:
            pass
        try:
            self.p.kill()
        except Exception:
            pass


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    index = sys.argv[2] if len(sys.argv) > 2 else ""
    c = Client(model, index)

    tag, data = c.recv()
    print("hello:", json.loads(data))

    c.json({"cmd": "ping"})
    print("ping ->", json.loads(c.recv()[1]))

    t0 = time.perf_counter()
    c.json({"cmd": "load", "model_path": model, "index_path": index, "pitch": 0, "device": "cpu"})
    tag, data = c.recv()
    ready = json.loads(data)
    print(f"load: {ready} ({(time.perf_counter()-t0)*1000:.0f}ms)")

    tgt_sr = int(ready.get("tgt_sr", 40000))
    sr_in = 16000
    block = int(sr_in * 0.064)  # 64ms 块
    t = np.arange(block, dtype=np.float32) / sr_in
    src = (np.sin(2 * np.pi * 220 * t) * 0.25 * 32767).astype(np.int16)

    lat = []
    for i in range(5):
        t0 = time.perf_counter()
        c.audio(src)
        tag, data = c.recv()
        if tag != b"A":
            print("意外回应:", tag, data[:200])
            break
        out = np.frombuffer(data, dtype=np.int16)
        lat.append((time.perf_counter() - t0) * 1000)
        print(f"block{i}: in={src.size} out={out.size} ({out.size/max(1,tgt_sr)*1000:.1f}ms @ {tgt_sr}Hz) "
              f"rms_in={np.sqrt(np.mean(src.astype(float)**2)):.0f} rms_out={np.sqrt(np.mean(out.astype(float)**2)):.0f}")

    if lat:
        print(f"延迟: 最小 {min(lat):.1f}ms / 平均 {sum(lat)/len(lat):.1f}ms / 最大 {max(lat):.1f}ms")
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
