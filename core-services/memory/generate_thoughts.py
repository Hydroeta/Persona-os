# -*- coding: utf-8 -*-
r"""generate_thoughts.py —— 夜间内心戏生成器

职责：每天深夜，把「今天发生过的事」喂给本地 Ollama，用第一人称写一段**从没说出口**的潜台词，
存进记忆微服务的 `inner_thoughts` 表（独立表，绝不混进 /recent 的事实召回）。

用法：
    python generate_thoughts.py                 # 生成今天的（已有则跳过）
    python generate_thoughts.py --force         # 强制重新生成
    python generate_thoughts.py --model qwen2.5:7b --memory http://127.0.0.1:8001

设计：宁可产出平淡，也不要编造。提示词明确要求「只围绕给定素材」，素材为空就不生成。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

DEFAULT_MEMORY = os.environ.get("MEMORY_BUS_URL", "http://127.0.0.1:8001")
DEFAULT_OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")


def http_json(url: str, body=None, timeout=60):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def gather_events(memory: str, days: int = 1, limit: int = 40) -> list[str]:
    """今天的记忆条目当作「发生过的事」（不含内心戏本身）。"""
    url = f"{memory}/recent?days={days}&limit={limit}"
    try:
        res = http_json(url)
    except Exception as exc:
        print(f"✗ 取记忆失败：{exc}", file=sys.stderr)
        return []
    items = res.get("results") or []
    lines = []
    for it in items:
        text = (it.get("text") or it.get("content") or "").strip()
        if text:
            lines.append(f"- [{it.get('level', '')}] {text[:120]}")
    return lines


def build_prompt(events: list[str]) -> str:
    body = "\n".join(events)
    return (
        "下面是你今天知道的事情（可能很琐碎）：\n"
        f"{body}\n\n"
        "请用第一人称，写一段**从来没有说出口**的内心戏，50 字以内。\n"
        "要求：\n"
        "1. 只围绕上面列出的事情，不要编造没发生的事；\n"
        "2. 语气可以带点别扭、克制、逞强；\n"
        "3. 这是一段潜台词，你从未对任何人说过；\n"
        "4. 只输出这段话本身，不要解释、不要引号。"
    )


def ollama_generate(base: str, model: str, prompt: str, timeout: int = 120) -> str:
    res = http_json(
        f"{base}/api/generate",
        {"model": model, "prompt": prompt, "stream": False,
         "options": {"temperature": 0.8, "num_predict": 120}},
        timeout=timeout,
    )
    return (res.get("response") or "").strip()


def has_today(memory: str, day: str) -> bool:
    try:
        res = http_json(f"{memory}/thoughts/recent?days=1&limit=20")
    except Exception:
        return False
    return any(t.get("day") == day for t in (res.get("thoughts") or []))


def main() -> int:
    ap = argparse.ArgumentParser(description="生成今日内心戏并入库")
    ap.add_argument("--memory", default=DEFAULT_MEMORY, help="记忆微服务地址")
    ap.add_argument("--ollama", default=DEFAULT_OLLAMA, help="Ollama 地址")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Ollama 模型")
    ap.add_argument("--force", action="store_true", help="今天已有也重新生成")
    ap.add_argument("--dry-run", action="store_true", help="只打印不写库")
    args = ap.parse_args()

    today = dt.date.today().isoformat()
    if not args.force and has_today(args.memory, today):
        print(f"今天（{today}）已有内心戏，跳过（--force 可强制重生成）")
        return 0

    events = gather_events(args.memory)
    if not events:
        print("今天没有可用的素材，跳过（不硬编）")
        return 0

    prompt = build_prompt(events)
    try:
        text = ollama_generate(args.ollama, args.model, prompt)
    except Exception as exc:
        print(f"✗ Ollama 调用失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    text = text.strip().strip('“”"\'')
    if not text:
        print("Ollama 返回空内容，跳过", file=sys.stderr)
        return 1

    print(f"素材 {len(events)} 条 → 内心戏：{text}")
    if args.dry_run:
        return 0
    try:
        res = http_json(f"{args.memory}/thoughts/save",
                        {"content": text, "day": today, "source": f"ollama:{args.model}"})
    except Exception as exc:
        print(f"✗ 入库失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"✔ 已入库 id={res.get('id')} day={res.get('day')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
