# -*- coding: utf-8 -*-
"""小鲸鱼 · AI 运维诊断（ai_ops）

服务崩溃 → 取最后 N 行日志 → 本地 Ollama（scene=ai_ops，免费）→ 结构化建议。
设计原则（沿用项目铁律）：零硬依赖、懒加载、优雅降级、如实报缺。
  - llm_client / Ollama 不可用 → 返回降级结果（ok=False，suggestion 明确标注
    "AI 诊断不可用"，附上原始日志摘要 raw_excerpt），绝不抛异常阻断健康守护。
  - 不把原始日志全文暴露到前端：前端只展示 summary + suggestion；
    raw_excerpt 仅在后端事件里保留（供人工排查）。

被调用的地方：
  - console.py 健康守护 _health_loop 崩溃分支 → _diagnose_async(sid) → 本模块
  - 可独立 CLI：python tools/ai_ops.py diagnose <service> <log_path> [lines]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_SYS = (
    "你是赛博生命体「鲸鲸」的运维诊断助手。给定一个服务最后 N 行崩溃日志，"
    "用中文输出结构化诊断。严格只返回一个 JSON 对象（不要 markdown 代码块、不要多余文字），"
    "字段：summary（一句话概述发生了什么）、likely_cause（最可能的根因）、"
    "suggestion（一条可执行的修复/排查建议）、confidence（0 到 1 之间的小数，表示把握）。"
    "如果日志里没有明显错误信息，summary 写'日志未显示明显异常'，suggestion 给出通用排查方向。"
)

# 允许读取的日志根：项目根 + 用户主目录（日志可能在 ~/.dsh 等）
_ALLOWED_ROOTS = [ROOT, Path.home()]


def _read_tail(path, lines=50):
    """读文件最后 N 行（最多读尾部 64KB）。路径越界/不存在返回说明串，不抛。"""
    try:
        p = Path(path).resolve()
    except Exception:
        return "日志路径无效"
    if not any(p == a or a in p.parents for a in _ALLOWED_ROOTS):
        return "拒绝访问：路径不在允许范围内"
    if not p.is_file():
        return "日志文件不存在: %s" % p
    try:
        with open(p, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 64 * 1024))
            data = fh.read().decode("utf-8", "replace")
        return "\n".join(data.splitlines()[-lines:])
    except Exception as e:  # noqa: BLE001
        return "读取失败: %s" % e


def _parse_json(text):
    """从 LLM 输出里容错解析 JSON 对象；失败返回 None。"""
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
        s = s.strip()
    a, b = s.find("{"), s.rfind("}")
    if 0 <= a < b:
        s = s[a:b + 1]
    try:
        return json.loads(s)
    except Exception:
        return None


def diagnose_crash(service, log_path, lines=50):
    """诊断一次崩溃。返回 dict：
    {ok, service, summary, likely_cause, suggestion, confidence, raw_excerpt}
    ok=False 表示 AI 不可用/失败，suggestion 会明确标注，raw_excerpt 保留日志尾部。
    """
    excerpt = _read_tail(log_path, lines)
    base = {
        "ok": False,
        "service": service,
        "summary": "",
        "likely_cause": "",
        "suggestion": "",
        "confidence": 0.0,
        "raw_excerpt": excerpt[:1500],
    }
    # 懒加载 llm_client：缺了只是降级，不崩
    try:
        import llm_client  # type: ignore
    except Exception as e:  # noqa: BLE001
        base["summary"] = "AI 诊断不可用"
        base["suggestion"] = "AI 诊断不可用（llm_client 加载失败：%s），请人工查看日志。" % type(e).__name__
        return base

    messages = [
        {"role": "system", "content": _SYS},
        {"role": "user",
         "content": "服务「%s」崩溃了，下面是最后 %d 行日志，请诊断：\n%s"
                    % (service, lines, excerpt[:4000])},
    ]
    try:
        out = llm_client.chat(messages, scene="ai_ops", max_tokens=400, temperature=0.3)
    except Exception as e:  # noqa: BLE001  Ollama 没起 / 无 key / 网络等 → 降级
        base["summary"] = "AI 诊断不可用"
        base["suggestion"] = "AI 诊断不可用（LLM 调用失败：%s），请人工查看日志。" % type(e).__name__
        return base

    parsed = _parse_json(out)
    if parsed:
        for k in ("summary", "likely_cause", "suggestion"):
            if parsed.get(k):
                base[k] = str(parsed[k])
        try:
            base["confidence"] = float(parsed.get("confidence") or 0)
        except Exception:
            base["confidence"] = 0.0
        base["ok"] = True
    else:
        # LLM 没按 JSON 回：不丢内容，把原文作为 suggestion 呈现
        base["summary"] = "AI 返回了非结构化文本"
        base["suggestion"] = (out or "").strip()[:400] or "AI 未返回有效建议，请人工查看日志。"
    return base


def main(argv):
    if len(argv) >= 4 and argv[1] == "diagnose":
        svc = argv[2]
        path = argv[3]
        lines = int(argv[4]) if len(argv) > 4 else 50
        print(json.dumps(diagnose_crash(svc, path, lines), ensure_ascii=False, indent=2))
        return 0
    print("用法: python tools/ai_ops.py diagnose <service> <log_path> [lines]")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
