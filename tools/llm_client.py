# -*- coding: utf-8 -*-
"""小鲸鱼 · LLM 客户端（工具侧统一入口：闸门 + 记账 + 密钥注入）

tools/ 下的模块（保真度裁判、内容改写）要调 LLM，但不该各自手搓
httpx + 密钥 + 闸门。这里用**纯标准库 urllib**统一做四件事：
  1. key_vault 取 DEEPSEEK_API_KEY（绝不打印明文）
  2. llm_gate.allow(scene) 预检 → 调用 → llm_gate.record() 记账
  3. 超预算抛 llm_gate.GateError，调用方按场景降级（不要重试）
  4. 超时/网络异常抛 RuntimeError，调用方兜底

测试可 monkeypatch `llm_client._http_post`（不真发请求）。
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

API_BASE = "https://api.deepseek.com"
MODEL = "deepseek-chat"
TIMEOUT = 60


def _http_post(url: str, body: dict, key: str) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer %s" % key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def chat(messages: list[dict], scene: str = "other", max_tokens: int = 256,
         temperature: float = 0.7) -> str:
    """调一次 DeepSeek。返回回复文本；预算超限抛 GateError，网络失败抛 RuntimeError。"""
    import llm_gate
    try:
        import key_vault
        key = key_vault.get_key("DEEPSEEK_API_KEY") or ""
    except Exception:
        key = ""
    if not key:
        raise RuntimeError("DEEPSEEK_API_KEY 未配置（保险库为空）")
    in_chars = sum(len(str(m.get("content", ""))) for m in messages) + 50
    llm_gate.allow(scene, llm_gate.est_tokens(in_chars))
    try:
        data = _http_post("%s/chat/completions" % API_BASE,
                          {"model": MODEL, "messages": messages,
                           "temperature": temperature, "max_tokens": max_tokens}, key)
    except Exception as e:  # 网络层失败统一转 RuntimeError（鉴权信息不外泄）
        raise RuntimeError(type(e).__name__) from e
    text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    llm_gate.record(scene, in_chars, len(text))
    return text.strip()
