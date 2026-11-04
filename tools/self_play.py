# -*- coding: utf-8 -*-
"""小鲸鱼 · 自我对弈负向规则学习（玩法4B）

用本地 Ollama 生成若干句「小鲸鱼可能说的话」→ 检测 AI 味 / 黑名单漂移
（关键词为主，persona_judge 打分为辅，任一不可用自动降级）→ 命中则把对应
负向规则追加到 little_whale.rules.json 的 send_format.rules 数组。

为什么放 send_format.rules：mcp_chat_prompts._send_format 会渲染该数组
（每条加句号拼进人格卡），所以追加即生效，且**零侵入**——不改 mcp_chat_prompts.py。

安全：
  - 写 rules 前先存快照到 data/persona_snapshots/，可 rollback 回滚。
  - confirm_before_write：定时任务默认只报告不写（dry_run），手动端点才写；
    可配成 false 让定时自动写。
  - 手动跑后标记 state，本周定时自动跳过（手动覆盖本周自动）。

铁律：零硬依赖、懒加载、优雅降级——Ollama 不可用 → run_round 返回 ok=False
不写 rules、不抛异常。

CLI：
    python tools/self_play.py run [--dry]   # 跑一轮（--dry 只检测不写）
    python tools/self_play.py rollback      # 回滚到最近快照
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

RULES_PATH = ROOT / "Tulpa" / "Tulpa" / "chatlocal" / "prompts" / "mcp_chat" / "little_whale.rules.json"
SNAPSHOT_DIR = ROOT / "data" / "persona_snapshots"
AUDIT_LOG = ROOT / "logs" / "self_play_audit.log"
STATE_FILE = ROOT / "data" / "self_play_state.json"
CONFIG_FILE = ROOT / "config" / "self_play.json"

# AI 味 / 客服腔黑名单词（候选回复命中任一即视为漂移）
AI_TASTE_WORDS = [
    "作为一个AI", "作为人工智能", "我是一个AI", "作为AI", "人工智能助手",
    "我无法", "我不能", "很抱歉", "非常抱歉", "对不起", "不好意思",
    "感谢您", "谢谢您", "请您", "您的", "您",
    "希望能够", "有助于", "综上所述", "总而言之", "总之",
    "首先", "其次", "再次", "接下来",
    "我来帮", "需要我", "根据您", "按照您", "为您", "无法为您",
    "作为语言模型", "根据我的", "据我所知",
]

GEN_PROMPT = (
    "你是小鲸鱼，一只蓝鲸娘，说话活泼口语、一行一句、不用句号、偶尔傲娇毒舌。"
    "请生成 10 句你在群里可能随口说的话，每句一行，不要编号、不要引号、不要解释。"
    "内容像真人随手发的：吐槽、接梗、生活碎片、玩梗。"
)

JUDGE_WARN_BELOW = 60  # persona_judge 低于此分也算漂移
KEEP_SNAPSHOTS = 20


def _config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _audit(line: str) -> None:
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write("%s\t%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), line))
    except Exception:
        pass


def _snapshot() -> Path | None:
    """写 rules 前存快照，返回快照路径；失败返回 None。"""
    if not RULES_PATH.is_file():
        return None
    try:
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        ts = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        dst = SNAPSHOT_DIR / ("little_whale.rules.json.%s.bak" % ts)
        shutil.copy2(str(RULES_PATH), str(dst))
        snaps = sorted(SNAPSHOT_DIR.glob("little_whale.rules.json.*.bak"))
        for old in snaps[:-KEEP_SNAPSHOTS]:
            try:
                old.unlink()
            except OSError:
                pass
        return dst
    except Exception:
        return None


def _generate_candidates(n: int = 10) -> list[str]:
    """Ollama 生成候选句；失败返回 []。"""
    try:
        import llm_client  # type: ignore
    except Exception:
        return []
    try:
        out = llm_client.chat([{"role": "user", "content": GEN_PROMPT}],
                              scene="self_play", max_tokens=500, temperature=0.9)
    except Exception:
        return []
    cands = []
    for line in (out or "").splitlines():
        s = line.strip().strip("\"'“”‘’")
        s = re.sub(r"^\s*\d+[\.\、\)]\s*", "", s).strip()
        if 2 <= len(s) <= 80:
            cands.append(s)
    return cands[:n]


def _detect(text: str) -> tuple[bool, list[str], float | None]:
    """返回 (是否命中, 命中的词/原因, persona_judge 分)。"""
    hit_words = [w for w in AI_TASTE_WORDS if w in text]
    judge_score = None
    try:
        import persona_judge  # type: ignore
        r = persona_judge.judge(text)
        judge_score = r.get("score")
        if judge_score is not None and judge_score < JUDGE_WARN_BELOW:
            hit_words.append("人格分过低(%s)" % judge_score)
    except Exception:
        pass  # persona_judge 不可用 → 仅靠关键词，不阻断
    return (len(hit_words) > 0, hit_words, judge_score)


def _rule_for(text: str, words: list[str]) -> str:
    core = [w for w in words if not w.startswith("人格")]
    if core:
        return "不许说「%s」这类 AI 味/客服腔词，说话像真人别像客服" % core[0]
    return "这句话有 AI 味、不像小鲸鱼，下次别这么说：「%s」" % text[:30]


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(d: dict) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _this_week_monday_ts(ts: float | None = None) -> float:
    d = _dt.datetime.fromtimestamp(ts or time.time())
    monday = d - _dt.timedelta(days=d.weekday())
    monday = monday.replace(hour=0, minute=0, second=0, microsecond=0)
    return monday.timestamp()


def mark_manual_done() -> None:
    st = _load_state()
    st["last_manual_ts"] = time.time()
    st["last_manual_week"] = _this_week_monday_ts()
    _save_state(st)


def should_skip_auto_this_week() -> bool:
    """本周已手动跑过 → 定时自动跳过。"""
    st = _load_state()
    last_week = st.get("last_manual_week")
    return bool(last_week and last_week >= _this_week_monday_ts())


def run_round(dry_run: bool = False) -> dict:
    """跑一轮。dry_run=True 只检测不写 rules。"""
    result = {"ok": False, "dry_run": dry_run, "generated": 0,
              "hits": [], "added_rules": [], "snapshot": None, "msg": ""}
    cands = _generate_candidates()
    result["generated"] = len(cands)
    if not cands:
        result["msg"] = "未生成候选（Ollama 不可用），跳过本轮"
        _audit("skip no_candidates")
        return result

    hits, new_rules = [], []
    for c in cands:
        hit, words, score = _detect(c)
        if hit:
            hits.append({"text": c, "matched": words, "score": score})
            rule = _rule_for(c, words)
            if rule not in new_rules:
                new_rules.append(rule)
    result["hits"] = hits

    # 和现有 rules.json 去重：已存在的规则不再算新增
    # （dry_run 预览与实际写入保持一致，避免重复报"将新增"）
    try:
        cur = json.loads(RULES_PATH.read_text(encoding="utf-8"))
        existing = set(cur.get("send_format", {}).get("rules", []))
        new_rules = [r for r in new_rules if r not in existing]
    except Exception:
        pass

    if not new_rules:
        result["ok"] = True
        result["msg"] = "生成 %d 句，未发现 AI 味漂移，无需新增规则" % len(cands)
        _audit("round generated=%d hits=0" % len(cands))
        return result

    if dry_run:
        result["ok"] = True
        result["added_rules"] = new_rules
        result["msg"] = "dry-run：命中 %d 处，将新增 %d 条规则（未写入，加确认才写）" % (
            len(hits), len(new_rules))
        _audit("dry_run hits=%d rules=%d" % (len(hits), len(new_rules)))
        return result

    snap = _snapshot()
    result["snapshot"] = str(snap) if snap else None
    try:
        rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
        sf = rules.setdefault("send_format", {})
        arr = sf.setdefault("rules", [])
        added = [r for r in new_rules if r not in arr]
        arr.extend(added)
        RULES_PATH.write_text(json.dumps(rules, ensure_ascii=False, indent=2),
                              encoding="utf-8")
        result["added_rules"] = added
        result["ok"] = True
        result["msg"] = "写入 %d 条新规则（命中 %d 处，快照%s）" % (
            len(added), len(hits), "已存" if snap else "存失败")
        _audit("write rules=%d snapshot=%s" % (len(added), snap))
    except Exception as e:
        result["msg"] = "写 rules 失败: %s" % type(e).__name__
        _audit("WRITE_FAIL " + type(e).__name__)
    return result


def rollback() -> dict:
    """回滚到最近一份快照。"""
    snaps = sorted(SNAPSHOT_DIR.glob("little_whale.rules.json.*.bak"))
    if not snaps:
        return {"ok": False, "msg": "没有可用快照"}
    latest = snaps[-1]
    try:
        shutil.copy2(str(latest), str(RULES_PATH))
        _audit("rollback to %s" % latest.name)
        return {"ok": True, "msg": "已回滚到 %s" % latest.name, "snapshot": latest.name}
    except Exception as e:
        return {"ok": False, "msg": "回滚失败: %s" % type(e).__name__}


def run_auto_scheduled() -> dict:
    """定时入口：本周手动跑过则跳过；confirm_before_write=true 则只 dry-run。"""
    if should_skip_auto_this_week():
        return {"ok": True, "skipped": True,
                "msg": "本周已手动跑过，跳过本周定时"}
    confirm = _config().get("confirm_before_write", True)
    return run_round(dry_run=bool(confirm))


def main(argv):
    if len(argv) > 1 and argv[1] == "run":
        dry = "--dry" in argv
        r = run_round(dry_run=dry)
        if not dry and r.get("ok") and r.get("added_rules"):
            mark_manual_done()
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0
    if len(argv) > 1 and argv[1] == "rollback":
        print(json.dumps(rollback(), ensure_ascii=False, indent=2))
        return 0
    print("用法: python tools/self_play.py run [--dry] | rollback")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
