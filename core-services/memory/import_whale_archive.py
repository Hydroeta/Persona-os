# -*- coding: utf-8 -*-
r"""一次性导入脚本：把老记忆档案（C:\Users\user\Documents\档案\鲸鱼）接入当前记忆微服务。

源：
  - 记忆卡.md  ：从 meow-memory 导出的 261 条长期记忆，分六章，每条末尾带 ⟨簇:标签⟩
  - 日记\*.md  ：散篇日记

策略（绝不写源文件）：
  1. 只读解析档案 → [{text, tags, level}]
  2. GET /recent?days=3650&limit=5000 拉全量已有记忆，按 content 归一化后去重（幂等）
  3. 逐条 POST /remember 写入，失败不中断，打印上下文

用法：
  python import_whale_archive.py            # dry-run：只打印将导入/跳过/失败的条数
  python import_whale_archive.py --apply    # 真正写入
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ARCHIVE = Path(r"C:\Users\user\Documents\档案\鲸鱼")
CARD = ARCHIVE / "记忆卡.md"
DIARY_DIR = ARCHIVE / "日记"
BASE = "http://127.0.0.1:8001"

# 章节 → meow 记忆层映射（必须 ∈ MEOW_TABLES）
CHAPTER_LEVEL = {
    "我是谁": "soul",
    "底线与约定": "rules",
    "在忙的项目": "project",
    "经历过的事": "fact",
    "学到的": "lesson",
    "一起走过的": "topic",
}

CLUSTER_RE = re.compile(r"⟨簇:([^⟩]+)⟩")
CHAPTER_RE = re.compile(r"^##\s+(.*)$")


def norm(s: str) -> str:
    """归一化文本用于去重：去掉所有空白。"""
    return re.sub(r"\s+", "", s or "")


def parse_card(path: Path) -> list[dict]:
    entries: list[dict] = []
    current_level = "fact"
    current_chapter = ""
    lines = path.read_text(encoding="utf-8").splitlines()
    i, n = 0, len(lines)
    while i < n:
        raw = lines[i]
        stripped = raw.strip()

        # 章节标题 → 映射 level
        m = CHAPTER_RE.match(stripped)
        if m:
            title = m.group(1).strip()
            current_chapter = title
            for key, lvl in CHAPTER_LEVEL.items():
                if key in title:
                    current_level = lvl
                    break
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        # 子弹条目
        if stripped.startswith("- "):
            body = stripped[2:].strip()
            # 吸收续行（缩进 / 非 - 非 # 的非空行）
            j = i + 1
            while j < n:
                nxt = lines[j]
                ns = nxt.strip()
                if not ns or ns.startswith("- ") or ns.startswith("#"):
                    break
                if nxt.startswith("  ") or nxt.startswith("\t") or not nxt.startswith(("-", "#")):
                    body += " " + ns
                    j += 1
                else:
                    break
            cm = CLUSTER_RE.search(body)
            cluster = cm.group(1).strip() if cm else ""
            text = CLUSTER_RE.sub("", body).strip()
            text = re.sub(r"[·•\s]+$", "", text).strip()
            if text:
                tags = [cluster] if cluster else [current_chapter]
                entries.append({
                    "text": text,
                    "tags": tags,
                    "level": current_level,
                    "source": "记忆卡",
                    "chapter": current_chapter,
                    "cluster": cluster,
                })
            i = j
            continue

        # 加粗段落（如第三章的项目概述）→ 作为一条记忆导入
        if stripped.startswith("**"):
            cm = CLUSTER_RE.search(stripped)
            cluster = cm.group(1).strip() if cm else ""
            text = CLUSTER_RE.sub("", stripped).strip()
            text = re.sub(r"[·•\s]+$", "", text).strip()
            if text:
                tags = [cluster] if cluster else [current_chapter]
                entries.append({
                    "text": text,
                    "tags": tags,
                    "level": current_level,
                    "source": "记忆卡",
                    "chapter": current_chapter,
                    "cluster": cluster,
                })
            i += 1
            continue

        # 其它行（章节引言、引用块等）跳过
        i += 1
    return entries


def parse_diaries(d: Path) -> list[dict]:
    entries: list[dict] = []
    if not d.is_dir():
        return entries
    for f in sorted(d.glob("*.md")):
        text = f.read_text(encoding="utf-8").strip()
        if text:
            entries.append({
                "text": text,
                "tags": ["日记", f.stem],
                "level": "fact",
                "source": "日记",
                "chapter": "",
                "cluster": "",
            })
    return entries


def get_existing() -> list[dict]:
    url = f"{BASE}/recent?days=3650&limit=5000"
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("results", [])


def build_dedup_index(existing: list[dict]) -> tuple[set[str], list[str]]:
    exact: set[str] = set()
    norms: list[str] = []
    for r in existing:
        nn = norm(r.get("content", ""))
        if nn:
            exact.add(nn)
            norms.append(nn)
    return exact, norms


def is_dup(text: str, exact: set[str], norms: list[str]) -> bool:
    nn = norm(text)
    if not nn:
        return True
    if nn in exact:
        return True
    # 子串包含：已有内容包含本条（或本条包含已有），长度阈值避免误判
    if len(nn) >= 15:
        for e in norms:
            if len(e) >= 15 and (nn in e or e in nn):
                return True
    return False


def post_remember(entry: dict) -> tuple[bool, str]:
    payload = json.dumps({
        "text": entry["text"],
        "tags": entry["tags"],
        "level": entry["level"],
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/remember",
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return True, body
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def main() -> int:
    apply = "--apply" in sys.argv

    if not CARD.is_file():
        print(f"[FATAL] 找不到记忆卡：{CARD}")
        return 2

    # 1. 解析
    card_entries = parse_card(CARD)
    diary_entries = parse_diaries(DIARY_DIR)
    all_entries = card_entries + diary_entries
    print(f"[解析] 记忆卡 {len(card_entries)} 条 + 日记 {len(diary_entries)} 篇 = {len(all_entries)} 条候选")

    # 按簇统计
    cluster_stat: dict[str, int] = {}
    level_stat: dict[str, int] = {}
    for e in card_entries:
        c = e["cluster"] or "(无簇)"
        cluster_stat[c] = cluster_stat.get(c, 0) + 1
        level_stat[e["level"]] = level_stat.get(e["level"], 0) + 1
    print("[簇分布 Top]")
    for c, cnt in sorted(cluster_stat.items(), key=lambda x: -x[1])[:15]:
        print(f"    {cnt:>3}  {c}")
    print(f"[记忆层分布] {level_stat}")

    # 2. 去重
    try:
        existing = get_existing()
    except Exception as e:  # noqa: BLE001
        print(f"[FATAL] 拉取已有记忆失败：{type(e).__name__}: {e}")
        return 3
    exact, norms = build_dedup_index(existing)
    print(f"[去重] 已有活跃记忆 {len(existing)} 条（归一化样本 {len(norms)}）")

    to_import: list[dict] = []
    skipped = 0
    for e in all_entries:
        if is_dup(e["text"], exact, norms):
            skipped += 1
        else:
            to_import.append(e)
    print(f"[去重] 跳过重复 {skipped} 条，待导入 {len(to_import)} 条")

    if not to_import:
        print("[完成] 没有新记忆需要导入。")
        return 0

    if not apply:
        print("\n[DRY-RUN] 未写入。确认无误后加 --apply 执行：")
        print(f"  python {Path(__file__).name} --apply")
        # 打印前 5 条预览
        print("[预览 前5条]")
        for e in to_import[:5]:
            print(f"  - [{e['level']}] tags={e['tags']} :: {e['text'][:80]}...")
        return 0

    # 3. 写入
    ok = 0
    fail = 0
    for idx, e in enumerate(to_import, 1):
        success, msg = post_remember(e)
        if success:
            ok += 1
        else:
            fail += 1
            print(f"  [FAIL #{idx}] {e['source']} level={e['level']} tags={e['tags']} :: {msg}")
            print(f"            text={e['text'][:100]}...")
        if idx % 25 == 0:
            print(f"  ...进度 {idx}/{len(to_import)} (成功 {ok}, 失败 {fail})")
        time.sleep(0.05)  # 轻微节流，避免打爆 sqlite

    print(f"\n[完成] 成功 {ok}，失败 {fail}，跳过重复 {skipped}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
