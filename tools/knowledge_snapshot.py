# -*- coding: utf-8 -*-
"""小鲸鱼 · 每日知识快照（玩法3B）

扫描当天修改的 .py / .md，切块后入本地向量库（tools/vector_store.VectorStore），
生成当日摘要报告（新增/修改了哪些知识块）。可被 console 定时或按钮调用。

设计原则：零硬依赖、懒加载、优雅降级——vector_store 不可用时降级为只出报告不入库。

CLI：
    python tools/knowledge_snapshot.py --today          # 扫当天
    python tools/knowledge_snapshot.py --today --root DIR
    python tools/knowledge_snapshot.py --all            # 扫全部（不限当天）
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

# 扫描时排除的目录（第三方 / 生成 / 大体积）
EXCLUDE_DIRS = {".venv", "__pycache__", "node_modules", ".git", ".trae",
                "backups", "release", "dsh-pet", "mortis-pet", "index-tts",
                "whale-pod", "surfcore"}
EXTS = (".py", ".md")
CHUNK_LINES = 40
CHUNK_OVERLAP = 5
MAX_CHUNKS_PER_FILE = 200  # 单文件最多切这么多块，防爆库


def _is_today(p: Path) -> bool:
    try:
        m = p.stat().st_mtime
    except OSError:
        return False
    return _dt.date.fromtimestamp(m) == _dt.date.today()


def _iter_files(root: Path, today_only: bool):
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in EXTS:
            continue
        if any(part in EXCLUDE_DIRS for part in p.parts):
            continue
        if today_only and not _is_today(p):
            continue
        yield p


def _chunks(text: str, lines_per_chunk: int = CHUNK_LINES,
            overlap: int = CHUNK_OVERLAP):
    """按行切块，相邻块重叠 overlap 行。"""
    lines = text.splitlines()
    if not lines:
        return []
    chunks = []
    i = 0
    while i < len(lines) and len(chunks) < MAX_CHUNKS_PER_FILE:
        chunk = lines[i:i + lines_per_chunk]
        if chunk:
            chunks.append("\n".join(chunk))
        i += max(1, lines_per_chunk - overlap)
    return chunks


def run(today_only: bool = True, root: Path | None = None,
        persist: bool = True) -> dict:
    """扫文件 → 切块 → 入库 → 返回摘要报告。
    persist=False 时只统计不入库（用于预览）。
    """
    root = root or ROOT
    report = {"ok": True, "today_only": today_only, "root": str(root),
              "files": 0, "chunks_added": 0, "chunks_skipped": 0,
              "items": [], "vector_mode": None, "msg": ""}
    try:
        import vector_store  # type: ignore
        vs = vector_store.VectorStore()
        vs.load()
        if vs.mode is None:
            vs._ensure_mode()  # 预览模式也要探测嵌入可用性，报告里如实反映
        report["vector_mode"] = vs.mode
    except Exception as e:
        vs = None
        report["vector_mode"] = "unavailable"
        report["msg"] = "向量库不可用（%s），仅生成报告不入库" % type(e).__name__

    files = list(_iter_files(root, today_only))
    report["files"] = len(files)
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        rel = str(p.relative_to(root)) if p.is_relative_to(root) else p.name
        mtime = 0
        try:
            mtime = int(p.stat().st_mtime)
        except OSError:
            pass
        added = 0
        for idx, chunk in enumerate(_chunks(text)):
            meta = {"path": rel, "mtime": mtime, "chunk": idx}
            if vs is not None and persist:
                if vs.add(chunk, meta=meta, dedup=True):
                    added += 1
                else:
                    report["chunks_skipped"] += 1
            else:
                added += 1  # 预览模式全计为新增
        report["chunks_added"] += added
        report["items"].append({"file": rel, "chunks": added, "mtime": mtime})

    if vs is not None and persist and report["chunks_added"] > 0:
        vs.save()
    report["items"].sort(key=lambda x: -x["chunks"])
    if not report["msg"]:
        report["msg"] = "快照完成：扫描 %d 个文件，新增 %d 个知识块（跳过 %d 个重复）" % (
            report["files"], report["chunks_added"], report["chunks_skipped"])
    return report


def main(argv):
    today_only = "--all" not in argv
    root = None
    for i, a in enumerate(argv):
        if a == "--root" and i + 1 < len(argv):
            root = Path(argv[i + 1])
    report = run(today_only=today_only, root=root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
