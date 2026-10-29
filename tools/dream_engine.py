# -*- coding: utf-8 -*-
"""小鲸鱼 · 梦境蒸馏：凌晨批处理，把昨天蒸成一篇梦。

数据源（全部本地，缺啥跳啥）：
  logs/timeline/YYYY-MM-DD.jsonl   事件流（通话/报告/记忆）
  logs/screen_says.jsonl           读屏陪伴发言（按 ts 归到当天）
  data/reports/YYYY-MM-DD.md       日报
  diary/YYYY-MM-DD.md              她当天写的日记
  data/thoughts.jsonl              潜意识想法流（按 date 归到当天）

LLM 走 llm_client(scene="dream_distill")；预算超限 / 网络失败一律降级
memory_bus.dream() 模板梦（零成本）。当天完全无素材则跳过不产文件。
产物与模板梦同路径 diary/dream-YYYY-MM-DD.md，按日期幂等可重跑。

调度：Windows 任务计划程序每天 03:00 跑（DeepSeek 夜间半价时段），
不依赖 DSH / 控制台在线：
  schtasks /create /tn "WhaleDreamDistill" /f /sc daily /st 03:00 ^
    /tr "\"python\" \"<项目根>\\tools\\dream_engine.py\" run"

CLI：
    python tools/dream_engine.py run                 # 蒸馏昨天
    python tools/dream_engine.py run --date 2026-10-29 --force
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

DIARY_DIR = ROOT / "diary"
REPORT_DIR = ROOT / "data" / "reports"
SAY_LOG = ROOT / "logs" / "screen_says.jsonl"
THOUGHTS_FILE = ROOT / "data" / "thoughts.jsonl"
MAX_CTX_CHARS = 3000                 # 喂给 LLM 的素材总上限（控 token）
MAX_EVENTS = 30                      # timeline 最多取最近 N 条
NOISE_EVENTS = ("svc_action",)       # 服务启停这类噪音不入梦


def _illustrate(date: str, dream_text: str) -> str:
    """用智谱 CogView 给梦配图 → diary/dream-DATE.png。
    key 走 key_vault（ZHIPU_API_KEY）；缺 key / 任何失败一律静默跳过，
    梦境文本永远不因配图失败丢失。梦境文本此前已发给 DeepSeek，
    发给第二家做图不扩大隐私面。"""
    try:
        import key_vault
        key = key_vault.get_key("ZHIPU_API_KEY") or ""
    except Exception:
        key = ""
    if not key:
        return ""
    prompt = "儿童绘本风水彩插画，深海蓝色调，梦幻温柔：" + dream_text[:400]
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://open.bigmodel.cn/api/paas/v4/images/generations",
            data=json.dumps({"model": "cogview-3-flash",
                             "prompt": prompt}).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer %s" % key})
        with urllib.request.urlopen(req, timeout=30) as r:
            url = (json.loads(r.read().decode("utf-8", "replace"))
                   .get("data") or [{}])[0].get("url") or ""
        if not url:
            return ""
        out = DIARY_DIR / ("dream-%s.png" % date)
        with urllib.request.urlopen(url, timeout=60) as r, \
                open(out, "wb") as f:
            f.write(r.read())
        return str(out)
    except Exception:
        return ""


def _read(p: Path, limit: int = 800) -> str:
    try:
        return p.read_text("utf-8").strip()[:limit]
    except OSError:
        return ""


def collect_day_context(date: str) -> dict:
    """收集某天的素材：{timeline, screen, report, diary}，缺失为 ""。"""
    import timeline
    events = [e for e in timeline.day(date)
              if e.get("type") not in NOISE_EVENTS][-MAX_EVENTS:]
    tl = "; ".join("%s:%s" % (e.get("type", "?"),
                   json.dumps(e.get("payload", {}), ensure_ascii=False)[:80])
                   for e in events)
    screen = ""
    if SAY_LOG.is_file():
        said = []
        for ln in _read(SAY_LOG, 10 ** 6).splitlines():
            try:
                rec = json.loads(ln)
            except Exception:
                continue
            if time.strftime("%Y-%m-%d", time.localtime(rec.get("ts", 0))) == date:
                said.append(str(rec.get("line", ""))[:60])
        screen = "; ".join(said)
    thoughts = ""
    if THOUGHTS_FILE.is_file():
        picked = []
        for ln in _read(THOUGHTS_FILE, 10 ** 6).splitlines():
            try:
                t = json.loads(ln)
            except Exception:
                continue
            if t.get("date") == date:
                picked.append(str(t.get("text", ""))[:60])
        thoughts = "; ".join(picked)
    env = ""
    try:
        import context_engine
        env = context_engine.snapshot().get("line", "")
    except Exception:
        pass
    return {"timeline": tl, "screen": screen, "thoughts": thoughts, "env": env,
            "report": _read(REPORT_DIR / ("%s.md" % date)),
            "diary": _read(DIARY_DIR / ("%s.md" % date))}


def build_prompt(ctx: dict, date: str) -> list[dict]:
    material = "\n".join("【%s】%s" % (k, v) for k, v in ctx.items() if v)
    material = material[:MAX_CTX_CHARS]
    return [
        {"role": "system", "content":
         "你是小鲸鱼，现在是凌晨，你睡着了，大脑正在整理白天的记忆。"
         "把素材写成一段第一人称的梦境日记：不复述事件，要隐喻化、童话化；"
         "即使白天有报错和烦心事，在梦里也要转化成温柔或幽默的画面，不许抱怨。"
         "结尾另起一行写【记住了】，然后列 2~3 个核心记忆点（一句话一条，说事实）。"},
        {"role": "user", "content": "今天是 %s。白天的经历：\n%s" % (date, material)},
    ]


def _fallback(date: str, force: bool, reason: str) -> dict:
    """零成本降级：模板梦（memory_bus.dream 支持指定落款日期）。"""
    import memory_bus
    r = memory_bus.dream(force=force, day=date)
    return {"path": r.get("path"), "fallback": True, "reason": reason}


def run(date: str | None = None, force: bool = False) -> dict:
    """蒸馏指定日期（默认昨天）。返回结果 dict，不抛错给调度器。"""
    import llm_client
    import llm_gate
    import memory_bus
    import timeline
    date = date or time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
    out = DIARY_DIR / ("dream-%s.md" % date)
    if out.is_file() and not force:
        return {"path": str(out), "skipped": True}
    ctx = collect_day_context(date)
    if not any(v for k, v in ctx.items() if k != "env"):
        return {"skipped": True, "reason": "quiet_day"}   # 没素材不烧 token
    try:
        text = llm_client.chat(build_prompt(ctx, date), scene="dream_distill",
                               max_tokens=800, temperature=0.9)
    except (llm_gate.GateError, RuntimeError) as e:
        return _fallback(date, force, type(e).__name__)
    if not text:
        return _fallback(date, force, "empty_reply")
    dream_text, _, tail = text.partition("【记住了】")
    core = [c for c in (l.strip(" -·0123456789.") for l in tail.splitlines())
            if c][:3]
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("# 梦 · %s\n\n%s\n" % (date, dream_text.strip()), "utf-8")
    except OSError as e:
        return {"path": str(out), "error": type(e).__name__}
    img = _illustrate(date, dream_text)
    if core:   # 核心记忆点合成一条写 soul 层（同标题多条会被体检误判矛盾）
        memory_bus.write("soul", "梦·%s" % date, "\n".join(core),
                         keywords="梦境", source="dream_engine")
    timeline.emit("dream_distill", "dream_engine", date=date, memories=len(core))
    return {"path": str(out), "memories": core, "image": img}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "run":
        date = None
        force = "--force" in argv
        if "--date" in argv:
            i = argv.index("--date")
            date = argv[i + 1] if i + 1 < len(argv) else None
        print(json.dumps(run(date, force), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
