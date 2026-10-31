# -*- coding: utf-8 -*-
"""IndexTTS2 本地 HTTP 服务（零新依赖，stdlib http.server + torch/torchaudio）。

给 call_loop.py / live_bot.py 当 GPT-SoVITS /tts 的平替：
  GET /tts?text=...&ref_audio_path=...  → 原始 PCM（s16le 单声道 32kHz，octet-stream）
  GET /health                           → {"ok": true, "model_loaded": bool}
  GET /docs                             → 200（兼容 live_bot 的在线探测）

必须用 index-tts 的 venv 跑（indextts 包在那里）：
  C:\\...\\index-tts\\.venv\\Scripts\\python.exe indextts_server.py

环境变量：
  INDEXTTS_MODEL_DIR  模型权重目录（默认 C:\\idx_models，必须纯 ASCII 路径）
  INDEXTTS_PORT       监听端口（默认 9881）
  INDEXTTS_HOST       监听地址（默认 127.0.0.1）
"""

import json
import os
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR", r"C:\idx_models")
PORT = int(os.environ.get("INDEXTTS_PORT", "9881"))
HOST = os.environ.get("INDEXTTS_HOST", "127.0.0.1")

SRC_SR = 22050      # IndexTTS2 输出采样率（infer_v2.py 固定）
TARGET_SR = 32000   # 与 ohwhale config.json audio.tts_raw_rate 对齐

_lock = threading.Lock()
_tts = None         # IndexTTS2 实例，首次请求时惰性加载（启动快、探测立即可用）


def _load_model():
    global _tts
    if _tts is not None:
        return _tts
    with _lock:
        if _tts is not None:
            return _tts
        import torch
        from indextts.infer_v2 import IndexTTS2
        cuda = torch.cuda.is_available()
        print("[indextts] loading model from %s (cuda=%s) ..." % (MODEL_DIR, cuda), flush=True)
        _tts = IndexTTS2(
            cfg_path=os.path.join(MODEL_DIR, "config.yaml"),
            model_dir=MODEL_DIR,
            use_fp16=cuda,                       # 4GB 显存必须 fp16
            device="cuda" if cuda else "cpu",
        )
        print("[indextts] model ready", flush=True)
        return _tts


def _synthesize(text: str, ref_audio: str) -> bytes:
    """整句合成 → 22050Hz wav → 重采样 32000Hz 单声道 int16 PCM。"""
    import numpy as np
    import torch
    import torchaudio
    tts = _load_model()
    out = os.path.join(tempfile.gettempdir(), "indextts_out_%d.wav" % threading.get_ident())
    tts.infer(spk_audio_prompt=ref_audio, text=text, output_path=out)
    wav, sr = torchaudio.load(out)
    try:
        os.remove(out)
    except OSError:
        pass
    if wav.dim() > 1:
        wav = wav.mean(dim=0, keepdim=True)          # 混成单声道
    if sr != TARGET_SR:
        wav = torchaudio.transforms.Resample(sr, TARGET_SR)(wav)
    pcm = wav.squeeze(0).clamp(-1.0, 1.0)
    pcm = (pcm * 32767.0).to(torch.int16).numpy()
    return np.ascontiguousarray(pcm).tobytes()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if url.path in ("/health", "/docs"):
            self._send(200, json.dumps({"ok": True, "model_loaded": _tts is not None}).encode())
            return
        if url.path != "/tts":
            self._send(404, json.dumps({"error": "not found"}).encode())
            return
        text = (q.get("text") or [""])[0].strip()
        ref = (q.get("ref_audio_path") or [""])[0].strip()
        if not text:
            self._send(400, json.dumps({"error": "text required"}).encode())
            return
        if not ref or not os.path.isfile(ref):
            self._send(400, json.dumps({"error": "ref_audio_path invalid: %s" % ref}).encode())
            return
        try:
            pcm = _synthesize(text, ref)
        except Exception as e:  # noqa: BLE001
            print("[indextts] synthesize failed: %r" % e, flush=True)
            self._send(500, json.dumps({"error": "%s: %s" % (type(e).__name__, e)}).encode())
            return
        self._send(200, pcm, "application/octet-stream")

    def log_message(self, fmt, *args):   # 安静一点，合成错误已单独打
        pass


def main():
    print("[indextts] serving on http://%s:%d/tts (model lazy-loads on first request)"
          % (HOST, PORT), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
