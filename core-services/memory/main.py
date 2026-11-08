# -*- coding: utf-8 -*-
r"""persona-os · Memory 微服务（第二阶段 / 任务 1）

职责：把原本混杂在 Python 里的记忆存取，剥离成一个独立的 HTTP 微服务。
只管「存取」——不做向量计算、不调大模型总结。底层直接读写源项目的 meow
记忆库（SQLite），与 meow-memory 插件共享同一份数据，因此 DSH 里的
memory_search 也能搜到这里写入的内容。

接口：
    GET  /health            健康检查 + 库表统计
    POST /remember          写入一条记忆  {"text": "...", "tags": [...]}  -> {"ok", "id", "level"}
    GET  /recall?query=...  关键词检索     -> {"ok", "query", "count", "results"}

运行（复用源项目 ohwhale-deploy 的虚拟环境，已含 fastapi/uvicorn；推荐绝对路径，任意 cwd 可跑）：
    & "c:\Users\user\Desktop\projects (2)\ohwhale-deploy\.venv\Scripts\python.exe" "c:\Users\user\Desktop\projects (2)\github-release\persona-os\core-services\memory\main.py"
或先 cd 到 core-services\memory，再用相对路径（上溯 4 级到源项目根，注意是 4 个 ..）：
    & "..\..\..\..\ohwhale-deploy\.venv\Scripts\python.exe" main.py
或任意装了 requirements.txt 的 python：
    python main.py

环境变量：
    MEMORY_DB       记忆库绝对路径（默认：源项目 dsh/workspace/.dsh-meow/memory.db）
    PERSONA_OS_ROOT 源项目根（用于自动定位记忆库；找不到时回退到下方 LOCAL_FALLBACK_ROOTS）
    MEMORY_PORT     监听端口（默认 8001）

并发安全：连接开启 WAL + busy_timeout=5000，与 meow-memory 插件共用同一套
pragma，跨进程读写不互锁。
"""
from __future__ import annotations

import json
import os
import socket
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

LOG_TAG = "[memory]"

# ---------------------------------------------------------------------------
# 路径解析（优先级：MEMORY_DB > PERSONA_OS_ROOT > 上溯探测 > 本地回退）
# ---------------------------------------------------------------------------

# 本地兜底路径已移除（避免硬编码开发者机器路径）。
# 定位优先级：MEMORY_DB > PERSONA_OS_ROOT > 沿 __file__ 上溯探测；
# 开源用户请设置 PERSONA_OS_ROOT 或 MEMORY_DB 指向自己的项目。
LOCAL_FALLBACK_ROOTS: list[str] = []

MEOW_TABLES = ("soul", "user", "project", "fact", "lesson", "topic", "rules")
# 内心戏独立表：刻意不混进 MEOW_TABLES，避免被 /recent、/recall 当成「事实」召回
THOUGHT_TABLE = "inner_thoughts"
DB_REL = Path("dsh") / "workspace" / ".dsh-meow" / "memory.db"


def _looks_like_root(p: Path) -> bool:
    return (p / DB_REL).is_file()


def find_source_root() -> Optional[Path]:
    env_root = os.environ.get("PERSONA_OS_ROOT")
    if env_root:
        p = Path(env_root)
        if p.is_dir():
            return p
    here = Path(__file__).resolve()
    for parent in here.parents:
        if _looks_like_root(parent):
            return parent
    for root in LOCAL_FALLBACK_ROOTS:
        p = Path(root)
        if _looks_like_root(p):
            return p
    return None


def resolve_db_path() -> Path:
    env_db = os.environ.get("MEMORY_DB")
    if env_db:
        return Path(env_db)
    root = find_source_root()
    if root is None:
        raise RuntimeError(
            f"{LOG_TAG} 无法定位记忆库：请设置 MEMORY_DB 或 PERSONA_OS_ROOT 指向源项目根"
        )
    return root / DB_REL


DB_PATH: Optional[Path] = None  # 延迟到第一次 connect 时解析并缓存


def get_db_path() -> Path:
    global DB_PATH
    if DB_PATH is None:
        DB_PATH = resolve_db_path()
    return DB_PATH


# ---------------------------------------------------------------------------
# SQLite 连接（WAL + busy_timeout，与 meow-memory 一致）
# ---------------------------------------------------------------------------

def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(get_db_path()), timeout=5.0)
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass  # 某些环境 WAL 不可用，退回默认模式，不致命
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# id 生成（与 meow-memory 约定一致：时间前缀 base36 + uuid 片段，便于按时间排序）
# ---------------------------------------------------------------------------

def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = []
    while n:
        n, r = divmod(n, 36)
        digits.append("0123456789abcdefghijklmnopqrstuvwxyz"[r])
    return "".join(reversed(digits))


def new_id() -> str:
    t = _base36(int(time.time() * 1000)).rjust(9, "0")
    return t + "-" + uuid.uuid4().hex[:26]


# ---------------------------------------------------------------------------
# 业务逻辑
# ---------------------------------------------------------------------------

def table_columns() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    conn = connect()
    try:
        for tbl in MEOW_TABLES:
            try:
                out[tbl] = [r[1] for r in conn.execute(f"PRAGMA table_info({tbl})")]
            except sqlite3.Error:
                out[tbl] = []
    finally:
        conn.close()
    return out


def _table_columns(table: str) -> list[str]:
    """返回某张表的真实列名（进程内缓存）。

    meow 各表列不一致：soul/user 无 project 列；project 表的 project 列 NOT NULL 且无默认值；
    lesson 有 corrected 列。固定列的 INSERT 会在 soul/project 上报错，故按真实列自适应插入。"""
    cache = getattr(_table_columns, "cache", None)
    if cache is None:
        cache = {}
        _table_columns.cache = cache
    if table not in cache:
        conn = connect()
        try:
            cache[table] = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        except sqlite3.Error:
            cache[table] = []
        finally:
            conn.close()
    return cache[table]


def ensure_thought_table() -> None:
    """内心戏单独一张表：内容 + 归属日期 + 来源。"""
    conn = connect()
    try:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {THOUGHT_TABLE} ("
            "id TEXT PRIMARY KEY, content TEXT NOT NULL, day TEXT NOT NULL, "
            "source TEXT, created_at INTEGER NOT NULL)"
        )
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{THOUGHT_TABLE}_day ON {THOUGHT_TABLE}(day)")
        conn.commit()
    finally:
        conn.close()


def save_thought(content: str, day: Optional[str] = None, source: str = "ollama") -> dict:
    content = (content or "").strip()
    if not content:
        raise ValueError("content 不能为空")
    ensure_thought_table()
    d = (day or time.strftime("%Y-%m-%d")).strip()
    mid = new_id()
    now = int(time.time() * 1000)
    conn = connect()
    try:
        conn.execute(
            f"INSERT INTO {THOUGHT_TABLE}(id, content, day, source, created_at) VALUES(?,?,?,?,?)",
            (mid, content[:500], d, source, now),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "id": mid, "day": d, "content": content[:500]}


def recent_thoughts(days: int = 3, limit: int = 10) -> list[dict]:
    ensure_thought_table()
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT id, content, day, source, created_at FROM {THOUGHT_TABLE} "
            "WHERE day >= ? ORDER BY created_at DESC LIMIT ?",
            (cutoff, int(limit)),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": r[0], "content": r[1], "day": r[2], "source": r[3], "created_at": r[4]}
        for r in rows
    ]


def write_memory(text: str, tags: Optional[list[str]] = None, level: str = "fact") -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("text 不能为空")
    if level not in MEOW_TABLES:
        raise ValueError(f"未知记忆层：{level}")
    tags = [str(t) for t in (tags or []) if str(t).strip()]
    mid = new_id()
    now = int(time.time() * 1000)
    title = text[:40]
    keywords = json.dumps(tags, ensure_ascii=False)

    # 候选值覆盖所有表可能出现的列；只插入该表真实存在的列。
    # project 列在 project 表上 NOT NULL 无默认 → 用首标签兜底，避免约束失败。
    candidate = {
        "id": mid,
        "title": title,
        "content": text,
        "importance": 1,
        "keywords": keywords,
        "status": "active",
        "source_session": "memory-bus",
        "hit_count": 0,
        "created_at": now,
        "updated_at": now,
        "last_accessed_at": None,
        "project": tags[0] if tags else "default",
        "subcategory": None,
        "corrected": 0,
        "goal": None,
    }
    cols = [c for c in _table_columns(level) if c in candidate]
    if not cols:
        raise RuntimeError(f"表 {level} 无可用列（schema 异常）")
    placeholders = ",".join(["?"] * len(cols))
    values = [candidate[c] for c in cols]
    conn = connect()
    try:
        conn.execute(
            f"INSERT INTO {level}({','.join(cols)}) VALUES({placeholders})",
            values,
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "id": mid, "level": level}


def recall(query: str, limit: int = 20) -> list[dict]:
    q = (query or "").strip()
    if not q:
        return []
    out: list[dict] = []
    like = f"%{q}%"
    conn = connect()
    try:
        for tbl in MEOW_TABLES:
            try:
                rows = conn.execute(
                    f"SELECT id,title,content,keywords FROM {tbl} "
                    "WHERE status='active' AND "
                    "(title LIKE ? OR content LIKE ? OR keywords LIKE ?) LIMIT ?",
                    (like, like, like, limit),
                ).fetchall()
            except sqlite3.Error:
                continue
            for r in rows:
                kws = []
                try:
                    kws = json.loads(r["keywords"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    pass
                out.append({
                    "id": r["id"],
                    "level": tbl,
                    "title": r["title"] or "",
                    "snippet": (r["content"] or "")[:160],
                    "tags": kws if isinstance(kws, list) else [],
                })
                if len(out) >= limit:
                    return out
    finally:
        conn.close()
    return out[:limit]


def recent(days: int = 90, limit: int = 500) -> list[dict]:
    """拉取最近 days 天内的活跃记忆（跨所有层），按 created_at 倒序，最多 limit 条。
    供批量聚合 / 导出使用（全字段，含 content / tags / importance / 时间）。"""
    cutoff = int((time.time() - days * 86400) * 1000)
    out: list[dict] = []
    conn = connect()
    try:
        for tbl in MEOW_TABLES:
            try:
                rows = conn.execute(
                    f"SELECT id,title,content,importance,keywords,created_at,updated_at,hit_count "
                    f"FROM {tbl} WHERE status='active' AND created_at >= ? "
                    f"ORDER BY created_at DESC LIMIT ?",
                    (cutoff, limit),
                ).fetchall()
            except sqlite3.Error:
                continue
            for r in rows:
                kws: list = []
                try:
                    kws = json.loads(r["keywords"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    pass
                out.append({
                    "id": r["id"],
                    "level": tbl,
                    "title": r["title"] or "",
                    "content": r["content"] or "",
                    "tags": kws if isinstance(kws, list) else [],
                    "importance": int(r["importance"] or 1),
                    "created_at": int(r["created_at"] or 0),
                    "updated_at": int(r["updated_at"] or 0),
                    "hit_count": int(r["hit_count"] or 0),
                })
    finally:
        conn.close()
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out[:limit]


def health() -> dict:
    counts: dict[str, int] = {}
    conn = connect()
    try:
        for tbl in MEOW_TABLES:
            try:
                counts[tbl] = conn.execute(
                    f"SELECT COUNT(*) FROM {tbl} WHERE status='active'"
                ).fetchone()[0]
            except sqlite3.Error:
                counts[tbl] = -1
    finally:
        conn.close()
    return {
        "ok": True,
        "db_path": str(get_db_path()),
        "db_exists": get_db_path().is_file(),
        "tables": list(counts.keys()),
        "active_counts": counts,
    }


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

app = FastAPI(title="persona-os memory", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RememberIn(BaseModel):
    text: str = Field(..., description="要记住的内容")
    tags: list[str] = Field(default_factory=list, description="可选关键词标签")
    level: str = Field(default="fact", description="记忆层，默认 fact")


class ThoughtIn(BaseModel):
    content: str = Field(..., description="内心戏正文，第一人称")
    day: Optional[str] = Field(default=None, description="归属日期 YYYY-MM-DD，缺省今天")
    source: str = Field(default="ollama", description="生成来源")


@app.get("/health")
def api_health():
    try:
        return health()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.post("/remember")
def api_remember(body: RememberIn):
    try:
        return write_memory(body.text, body.tags, body.level)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.post("/thoughts/save")
def api_thought_save(body: ThoughtIn):
    try:
        return save_thought(body.content, body.day, body.source)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.get("/thoughts/recent")
def api_thought_recent(days: int = Query(3, ge=1, le=365), limit: int = Query(10, ge=1, le=100)):
    """最近的内心戏（供 dsh-persona-core 做语气参考，禁止当事实引用）。"""
    try:
        items = recent_thoughts(days, limit)
        return {"ok": True, "days": days, "count": len(items), "thoughts": items}
    finally:
        pass


@app.get("/recall")
def api_recall(query: str = Query(..., min_length=1), limit: int = Query(20, ge=1, le=100)):
    try:
        results = recall(query, limit)
        return {"ok": True, "query": query, "count": len(results), "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.get("/recent")
def api_recent(days: int = Query(90, ge=1, le=3650), limit: int = Query(500, ge=1, le=5000)):
    """批量拉取最近 days 天的活跃记忆（供聚合 / 导出）。"""
    try:
        results = recent(days, limit)
        return {"ok": True, "days": days, "count": len(results), "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# 端口防冲突 + 启动
# ---------------------------------------------------------------------------

def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main() -> int:
    port = int(os.environ.get("MEMORY_PORT", "8001"))
    if port_in_use(port):
        print(f"{LOG_TAG} 端口 {port} 已被占用，memory 微服务未启动（可能已有实例在跑）", file=sys.stderr)
        return 1
    try:
        db = get_db_path()
        print(f"{LOG_TAG} db = {db} (exists={db.is_file()})")
    except RuntimeError as e:
        print(f"{LOG_TAG} {e}", file=sys.stderr)
        return 2
    import uvicorn
    print(f"{LOG_TAG} starting on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
