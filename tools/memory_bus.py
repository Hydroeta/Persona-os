# -*- coding: utf-8 -*-
"""小鲸鱼 · 记忆总线（一个入口：检索 / 写入 / 遗忘）

「会遗忘」是卖点，「能删干净」是刚需。四套记忆此前各存各的，主人说一句
「忘掉这件事」根本没有统一出口。本模块把现有后端收在一个接口后面：

    meow    dsh/**/.dsh-meow/memory.db 的 7 张表（soul/user/project/fact/lesson/topic/rules）
    calls   data/call_summaries/*.json（通话后回味的结构化摘要）
    diary   diary/*.md（第一人称日记）

遗忘一律**软删除**（meow 置 status='forgotten'，文件移到 _forgotten/），
并且写 `logs/memory_audit.jsonl`（append-only，任何 forget 都不删审计）。
软删除是为可撤销——真删库不可逆，不给自己留后路。

CLI：
    python tools/memory_bus.py search 猫
    python tools/memory_bus.py forget 猫            # 预演，只报数量
    python tools/memory_bus.py forget 猫 --yes      # 执行（meow + calls）
    python tools/memory_bus.py forget 猫 --yes --include-diary
    python tools/memory_bus.py audit
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEOW_TABLES = ("soul", "user", "project", "fact", "lesson", "topic", "rules")
CALL_DIR = ROOT / "data" / "call_summaries"
DIARY_DIR = ROOT / "diary"
AUDIT_FILE = ROOT / "logs" / "memory_audit.jsonl"


def _meow_dbs() -> list[Path]:
    """已知的几个 meow 记忆库。不用 recursive glob：dsh 目录 3.4 GB，扫一次十几秒。"""
    cands = [ROOT / "dsh" / "workspace" / ".dsh-meow" / "memory.db"]
    home = ROOT / "dsh" / "home"
    if home.is_dir():
        try:
            cands += [d / ".dsh-meow" / "memory.db" for d in home.iterdir() if d.is_dir()]
        except OSError:
            pass
    return sorted({p for p in cands if p.is_file()})


def _connect(p: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(p), timeout=5)
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _hit(text: str, topic: str) -> bool:
    return topic.lower() in (text or "").lower()


def _file_text(p: Path) -> str:
    """读文件并归一化：JSON 里的 \\uXXXX 转义要还原成中文再比对，否则会漏。"""
    raw = p.read_text("utf-8", errors="replace")
    try:
        return json.dumps(json.loads(raw), ensure_ascii=False)
    except Exception:
        return raw


# ---------- 检索 ----------

def search(topic: str, limit: int = 20) -> list[dict]:
    """跨后端检索，返回带来源的引用（供「记忆引文溯源」点击查看）。"""
    out: list[dict] = []
    t = (topic or "").strip()
    if not t:
        return out
    for db in _meow_dbs():
        try:
            conn = _connect(db)
            for tbl in MEOW_TABLES:
                cols = "id,title,content" if tbl != "project" else "id,title,content,project"
                try:
                    rows = conn.execute(
                        f"SELECT {cols} FROM {tbl} WHERE status='active' AND "
                        "(title LIKE ? OR content LIKE ? OR keywords LIKE ?) LIMIT ?",
                        (f"%{t}%", f"%{t}%", f"%{t}%", limit)).fetchall()
                except sqlite3.Error:
                    continue
                for r in rows:
                    out.append({"source": "meow:%s:%s" % (db.parent.parent.name, tbl),
                                "id": r[0], "title": r[1] or "",
                                "snippet": (r[2] or "")[:160],
                                "extra": r[3] if len(r) > 3 else ""})
        except sqlite3.Error:
            continue
        finally:
            try:
                conn.close()
            except Exception:
                pass
    for f in sorted(CALL_DIR.glob("*.json")) if CALL_DIR.is_dir() else []:
        try:
            d = json.loads(f.read_text("utf-8"))
        except Exception:
            continue
        blob = json.dumps(d, ensure_ascii=False)
        if _hit(blob, t):
            out.append({"source": "calls", "id": f.name,
                        "title": d.get("date", f.stem),
                        "snippet": (d.get("summary") or "")[:160], "extra": ""})
    for f in sorted(DIARY_DIR.glob("*.md")) if DIARY_DIR.is_dir() else []:
        try:
            txt = f.read_text("utf-8", errors="replace")
        except OSError:
            continue
        if _hit(txt, t):
            i = txt.lower().find(t.lower())
            out.append({"source": "diary", "id": f.name, "title": f.stem,
                        "snippet": txt[max(0, i - 40): i + 120].replace("\n", " "),
                        "extra": ""})
    return out[:limit]


# ---------- 写入 ----------

def write(layer: str, title: str, content: str, keywords: str = "",
          source: str = "memory_bus") -> str:
    """写入 meow 的一个层（默认写 workspace 那份）。返回 id。"""
    if layer not in MEOW_TABLES:
        raise ValueError("未知记忆层：%s" % layer)
    dbs = _meow_dbs()
    db = next((d for d in dbs if "workspace" in str(d)), dbs[0] if dbs else None)
    if db is None:
        raise RuntimeError("找不到 meow 记忆库")
    mid = uuid.uuid4().hex[:12]
    now = int(time.time())
    conn = _connect(db)
    try:
        if layer == "project":
            conn.execute("INSERT INTO project("
                         "id,title,content,importance,keywords,status,source_session,"
                         "created_at,updated_at,project) VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (mid, title, content, 2, json.dumps([keywords], ensure_ascii=False),
                          "active", source, now, now, source))
        else:
            conn.execute("INSERT INTO %s("
                         "id,title,content,importance,keywords,status,source_session,"
                         "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)" % layer,
                         (mid, title, content, 2, json.dumps([keywords], ensure_ascii=False),
                          "active", source, now, now))
        conn.commit()
    finally:
        conn.close()
    _audit({"action": "write", "layer": layer, "id": mid, "title": title[:60]})
    return mid


# ---------- 遗忘 ----------

def plan_forget(topic: str, include_diary: bool = False) -> dict:
    """预演：各后端将被影响多少条。"""
    t = (topic or "").strip()
    plan = {"topic": t, "meow": 0, "calls": 0, "diary": 0}
    if not t:
        return plan
    for db in _meow_dbs():
        try:
            conn = _connect(db)
            for tbl in MEOW_TABLES:
                try:
                    plan["meow"] += conn.execute(
                        f"SELECT COUNT(*) FROM {tbl} WHERE status='active' AND "
                        "(title LIKE ? OR content LIKE ? OR keywords LIKE ?)",
                        (f"%{t}%", f"%{t}%", f"%{t}%")).fetchone()[0]
                except sqlite3.Error:
                    continue
            conn.close()
        except sqlite3.Error:
            continue
    if CALL_DIR.is_dir():
        for f in CALL_DIR.glob("*.json"):
            try:
                if _hit(_file_text(f), t):
                    plan["calls"] += 1
            except OSError:
                pass
    if include_diary and DIARY_DIR.is_dir():
        for f in DIARY_DIR.glob("*.md"):
            try:
                if _hit(f.read_text("utf-8", errors="replace"), t):
                    plan["diary"] += 1
            except OSError:
                pass
    return plan


def forget(topic: str, include_diary: bool = False, yes: bool = False) -> dict:
    """一键遗忘。软删除 + 审计；yes=False 时只返回预演。"""
    plan = plan_forget(topic, include_diary)
    if not yes or not plan["topic"]:
        return {"dry_run": True, **plan}
    t = plan["topic"]
    moved = {"meow": 0, "calls": 0, "diary": 0}
    now = int(time.time())
    for db in _meow_dbs():
        try:
            conn = _connect(db)
            for tbl in MEOW_TABLES:
                try:
                    cur = conn.execute(
                        f"UPDATE {tbl} SET status='forgotten', updated_at=? "
                        "WHERE status='active' AND "
                        "(title LIKE ? OR content LIKE ? OR keywords LIKE ?)",
                        (now, f"%{t}%", f"%{t}%", f"%{t}%"))
                    moved["meow"] += cur.rowcount or 0
                except sqlite3.Error:
                    continue
            conn.commit()
            conn.close()
        except sqlite3.Error:
            continue
    if CALL_DIR.is_dir():
        dst = CALL_DIR / "_forgotten"
        for f in list(CALL_DIR.glob("*.json")):
            try:
                if not _hit(_file_text(f), t):
                    continue
                dst.mkdir(exist_ok=True)
                f.rename(dst / f.name)
                moved["calls"] += 1
            except OSError:
                pass
    if include_diary and DIARY_DIR.is_dir():
        dst = DIARY_DIR / "_forgotten"
        for f in list(DIARY_DIR.glob("*.md")):
            try:
                if not _hit(f.read_text("utf-8", errors="replace"), t):
                    continue
                dst.mkdir(exist_ok=True)
                f.rename(dst / f.name)
                moved["diary"] += 1
            except OSError:
                pass
    _audit({"action": "forget", "topic": t, "moved": moved,
            "include_diary": include_diary})
    return {"dry_run": False, **plan, "moved": moved}


# ---------- 体检 + 梦境日记（P1） ----------

DREAM_DIR_PROP = "dreams"  # diary/dreams/ 下按天一篇
EXPIRE_DAYS = 45           # 超过 45 天没动的记忆算「即将过期」
COLD_DAYS = 90             # 超过 90 天没动且不重要算「冷门」


def health(limit: int = 5) -> dict:
    """记忆体检：即将过期 / 冷门 / 疑似矛盾。只读不改，供展示与求证队列。"""
    now = int(time.time())
    expiring, cold, titles = [], [], {}
    for db in _meow_dbs():
        try:
            conn = _connect(db)
            for tbl in MEOW_TABLES:
                try:
                    rows = conn.execute(
                        f"SELECT title, content, importance, updated_at FROM {tbl} "
                        "WHERE status='active'").fetchall()
                except sqlite3.Error:
                    continue
                for title, content, imp, upd in rows:
                    age = (now - (upd or 0)) / 86400.0
                    item = {"where": "meow:%s:%s" % (db.parent.parent.name, tbl),
                            "title": (title or "")[:40],
                            "days": int(age)}
                    if age >= EXPIRE_DAYS:
                        expiring.append(item)
                    if age >= COLD_DAYS and (imp or 1) <= 1:
                        cold.append(item)
                    t = (title or "").strip()
                    if len(t) >= 2:
                        titles.setdefault(t, []).append(item["where"])
            conn.close()
        except sqlite3.Error:
            continue
    conflicts = [{"title": t, "where": ws} for t, ws in titles.items() if len(ws) > 1]
    return {"expiring": len(expiring), "expiring_samples": expiring[:limit],
            "cold": len(cold), "cold_samples": cold[:limit],
            "conflicts": len(conflicts), "conflict_samples": conflicts[:limit],
            "total_tracked": len(expiring) + len(cold)}


def dream(force: bool = False, day: str | None = None) -> dict:
    """「她昨晚的梦」：整理记忆时随机抽几条，生成一篇梦境日记。

    纯模板、零 LLM 成本；按日期幂等（已存在直接返回）。
    day 可指定落款日期（默认今天），供凌晨蒸馏任务补写「昨天」。
    """
    day = day or time.strftime("%Y-%m-%d")
    if DIARY_DIR.is_dir():
        out = DIARY_DIR / ("dream-%s.md" % day)
    else:
        out = ROOT / "diary" / ("dream-%s.md" % day)
    if out.is_file() and not force:
        try:
            return {"path": str(out), "text": out.read_text("utf-8"), "existed": True}
        except OSError:
            pass
    # 抽素材：优先 expiring（趁还记得写进梦里），不够就随便补
    h = health(limit=10)
    pool = (h["expiring_samples"] + h["cold_samples"] + h["conflict_samples"])[:3]
    picks = [p["title"] or "一些模糊的影子" for p in pool] or ["一片安静的深海"]
    lines = ["# 梦 · %s" % day, "",
             "昨晚整理记忆的时候睡着了，梦见了：", ""]
    for i, p in enumerate(picks, 1):
        lines.append("%d. %s" % (i, p))
    lines += ["", "醒来之后有几件事想找个机会跟你确认一下，不急。",
              "（本篇由记忆体检自动生成，算她自己的日记）"]
    text = "\n".join(lines) + "\n"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, "utf-8")
        _audit({"action": "dream", "path": str(out)})
    except OSError as e:
        return {"path": str(out), "text": text, "error": type(e).__name__}
    return {"path": str(out), "text": text, "existed": False}


# ---------- 审计 ----------

def _audit(entry: dict) -> None:
    try:
        AUDIT_FILE.parent.mkdir(exist_ok=True)
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), **entry},
                               ensure_ascii=False) + "\n")
    except OSError:
        pass


def audit(limit: int = 50) -> list[dict]:
    if not AUDIT_FILE.is_file():
        return []
    rows = []
    try:
        with open(AUDIT_FILE, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except OSError:
        return []
    return rows[-limit:]


def _main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "search":
        print(json.dumps(search(argv[1]), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "forget":
        print(json.dumps(forget(argv[1], include_diary="--include-diary" in argv,
                                yes="--yes" in argv), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "audit":
        print(json.dumps(audit(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
