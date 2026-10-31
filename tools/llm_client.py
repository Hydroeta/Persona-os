# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · LLM 客户端（工具侧统一入口：provider 路由 + 闸门 + 记账 + 密钥注入）

tools/ 下的模块（保真度裁判、内容改写）要调 LLM，但不该各自手搓
httpx + 密钥 + 闸门。这里用**纯标准库 urllib**统一做四件事：
  1. key_vault 取 DEEPSEEK_API_KEY（绝不打印明文）
  2. llm_gate.allow(scene) 预检 → 调用 → llm_gate.record() 记账
  3. 超预算抛 llm_gate.GateError，调用方按场景降级（不要重试）
  4. 超时/网络异常抛 RuntimeError，调用方兜底

测试可 monkeypatch `llm_client._http_post`（不真发请求）。
"""
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
# 云端 provider 表：主用 DeepSeek，cloud_fallback 配置兜底（GLM/千问）
PROVIDERS = {
    "deepseek": {"base": API_BASE, "model": MODEL, "key": "DEEPSEEK_API_KEY"},
    "glm": {"base": "https://open.bigmodel.cn/api/paas/v4",
            "model": "glm-4-flash", "key": "ZHIPU_API_KEY"},
    "qwen": {"base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "model": "qwen-turbo", "key": "DASHSCOPE_API_KEY"},
}


def _http_post(url: str, body: dict, key: str) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer %s" % key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _chat_local(messages: list[dict], cfg: dict, max_tokens: int,
                temperature: float) -> str:
    """本地 Ollama（OpenAI 兼容端点）。免费不过预算闸门；失败抛 RuntimeError。"""
    base = cfg.get("local_base_url", "http://127.0.0.1:11434/v1")
    model = cfg.get("local_model", "qwen2.5:1.5b-instruct")
    try:
        data = _http_post("%s/chat/completions" % base,
                          {"model": model, "messages": messages,
                           "temperature": temperature, "max_tokens": max_tokens},
                          "ollama")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(type(e).__name__) from e
    return (((data.get("choices") or [{}])[0].get("message")
             or {}).get("content") or "").strip()


def chat(messages: list[dict], scene: str = "other", max_tokens: int = 256,
         temperature: float = 0.7) -> str:
    """调一次 LLM。返回回复文本；预算超限抛 GateError，网络失败抛 RuntimeError。

    scene 在 llm_gate.config.json 的 scene_providers 里标了 "local" 时走
    本地 Ollama（免费、不占云端配额）；本地失败默认落回云端，
    local_fallback_cloud=false 时直接抛错（隐私场景强制不出本机）。
    """
    import llm_gate
    cfg = llm_gate.load_config()
    if cfg.get("scene_providers", {}).get(scene) == "local":
        try:
            return _chat_local(messages, cfg, max_tokens, temperature)
        except RuntimeError:
            if not cfg.get("local_fallback_cloud", True):
                raise
    providers = ["deepseek"]
    fb = cfg.get("cloud_fallback", "")
    if fb and fb not in providers:
        providers.append(fb)
    # 财务降级：余额/预算告急的厂商让位（balance_monitor 故障时静默放行原顺序）
    degraded = {}
    try:
        import balance_monitor
        hint = balance_monitor.routing_hint()
        degraded = hint.get("reasons") or {}
        avoid = [p for p in providers if p in (hint.get("avoid") or [])]
        providers = [p for p in providers if p not in avoid] + avoid
    except Exception:
        pass
    tried, no_key = [], []
    for name in providers:
        p = PROVIDERS.get(name)
        if not p:
            continue
        try:
            import key_vault
            key = key_vault.get_key(p["key"]) or ""
        except Exception:
            key = ""
        if not key:
            no_key.append(name)
            continue
        in_chars = sum(len(str(m.get("content", ""))) for m in messages) + 50
        llm_gate.allow(scene, llm_gate.est_tokens(in_chars))
        try:
            data = _http_post("%s/chat/completions" % p["base"],
                              {"model": p["model"], "messages": messages,
                               "temperature": temperature,
                               "max_tokens": max_tokens}, key)
        except Exception:  # 网络层失败不泄鉴权信息，尝试下一个 provider
            tried.append(name)
            continue
        text = ((data.get("choices") or [{}])[0].get("message")
                or {}).get("content") or ""
        llm_gate.record(scene, in_chars, len(text), provider=name)
        if name != "deepseek":   # 发生云端切换：留痕，潜意识会察觉到"换了脑子"
            try:
                import timeline
                timeline.emit("llm_fallback", "llm_client",
                              provider=name, scene=scene,
                              reason=degraded.get("deepseek", ""))
            except Exception:
                pass
        return text.strip()
    if not tried:
        raise RuntimeError("DEEPSEEK_API_KEY 未配置（保险库为空）")
    raise RuntimeError("cloud_down:" + ",".join(tried))
