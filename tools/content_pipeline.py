# -*- coding: utf-8 -*-
"""小鲸鱼 · 内容再创作流水线（一个灵魂四张嘴：源内容按平台语气改写）

让「一个灵魂四张嘴」真正成立：一条内容源（日记/通话素材/想法）登记进来，
按平台语气改写成 B 站吐槽 / 抖音短平快 / QQ 接梗三个版本。

红线：**不自动发布**。改写完进「待审核」，人工确认后才落到
data/content_out/ 供手动复制发布。改写走 llm_gate 的 rewrite 场景
（独立日配额），改写失败不破坏原条目。

条目 schema（data/content_items/<id>.json）：
    {id, ts, source, title, body,
     platforms: {bilibili: str, douyin: str, qq: str},   # 改写产物
     approved: [platform], status: draft|published}

CLI：
    python tools/content_pipeline.py create 日记 "今天的状态" "正文..."
    python tools/content_pipeline.py rewrite <id> bilibili
    python tools/content_pipeline.py list
    python tools/content_pipeline.py approve <id> bilibili
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITEM_DIR = ROOT / "data" / "content_items"
OUT_DIR = ROOT / "data" / "content_out"

PLATFORMS = {
    "bilibili": "B 站动态：可以吐槽、可以梗、稍微长一点（100 字内），像发动态不像营销号",
    "douyin": "抖音文案：短平快，2 句以内，有钩子，配视频口播用",
    "qq": "QQ 空间/群：口语接梗、像跟熟人聊天，1~2 句",
}
SCENE = "rewrite"


def _item_path(item_id: str) -> Path:
    return ITEM_DIR / ("%s.json" % item_id)


def create(source: str, title: str, body: str) -> dict:
    item = {"id": time.strftime("%Y%m%d-%H%M%S"), "ts": time.time(),
            "source": source or "manual", "title": title, "body": body,
            "platforms": {"bilibili": "", "douyin": "", "qq": ""},
            "approved": [], "status": "draft"}
    ITEM_DIR.mkdir(parents=True, exist_ok=True)
    _item_path(item["id"]).write_text(
        json.dumps(item, ensure_ascii=False, indent=2), "utf-8")
    return item


def get(item_id: str) -> dict | None:
    try:
        return json.loads(_item_path(item_id).read_text("utf-8"))
    except Exception:
        return None


def list_items(limit: int = 20) -> list[dict]:
    if not ITEM_DIR.is_dir():
        return []
    out = []
    for f in sorted(ITEM_DIR.glob("*.json"), reverse=True)[:limit]:
        try:
            out.append(json.loads(f.read_text("utf-8")))
        except Exception:
            continue
    return out


def rewrite(item_id: str, platform: str) -> dict:
    """按平台语气改写（走 LLM，记 rewrite 场景账）。失败抛异常，条目不动。"""
    item = get(item_id)
    if not item:
        raise RuntimeError("条目 %s 不存在" % item_id)
    if platform not in PLATFORMS:
        raise ValueError("未知平台 %s（支持 %s）" % (platform, "/".join(PLATFORMS)))
    import llm_client
    text = llm_client.chat(
        [{"role": "system",
          "content": "你是鲸鲸（温柔傲娇的摸鱼女仆鲸鱼娘），把自己的经历改写成%s。"
                     "只输出改写后的文案，不要解释、不要加引号。" % PLATFORMS[platform]},
         {"role": "user", "content": "素材标题：%s\n素材正文：%s"
          % (item["title"], item["body"][:800])}],
        scene=SCENE, max_tokens=200, temperature=0.8)
    item["platforms"][platform] = text[:600]
    _item_path(item_id).write_text(
        json.dumps(item, ensure_ascii=False, indent=2), "utf-8")
    return item


def approve(item_id: str, platform: str) -> dict:
    """人工审核通过：把该平台文案落到 data/content_out/（仍由人手动发布）。"""
    item = get(item_id)
    if not item:
        raise RuntimeError("条目 %s 不存在" % item_id)
    text = (item["platforms"].get(platform) or "").strip()
    if not text:
        raise RuntimeError("该平台还没改写，先 rewrite")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / ("%s.%s.md" % (item_id, platform))).write_text(
        "# %s（%s）\n\n%s\n" % (item["title"], platform, text), "utf-8")
    if platform not in item["approved"]:
        item["approved"].append(platform)
    if len(item["approved"]) >= len(PLATFORMS):
        item["status"] = "published"
    _item_path(item_id).write_text(
        json.dumps(item, ensure_ascii=False, indent=2), "utf-8")
    return item


def draft_from_diary(date: str | None = None) -> dict:
    """她的 B 站动态运营（P3，红线内）：挑一篇日记自动生成动态草稿。

    只登记素材条目（status=draft），改写与发布照旧走人工审核闸门。
    """
    import re as _re
    diary = ROOT / "diary"
    if not diary.is_dir():
        raise RuntimeError("没有日记目录")
    files = [f for f in sorted(diary.glob("*.md"), reverse=True)
             if not f.name.startswith("dream-")]
    if date:
        files = [f for f in files if f.stem.startswith(date)]
    if not files:
        raise RuntimeError("没有可用日记")
    f = files[0]
    text = f.read_text("utf-8", errors="replace")
    plain = _re.sub(r"[#>*`\-\n]+", " ", text).strip()
    title = "日记 %s" % f.stem
    return create("diary", title, plain[:800])


def _main(argv: list[str]) -> int:
    if len(argv) >= 4 and argv[0] == "create":
        it = create(argv[1], argv[2], " ".join(argv[3:]))
        print("已创建条目 %s" % it["id"])
    elif len(argv) >= 3 and argv[0] == "rewrite":
        it = rewrite(argv[1], argv[2])
        print("[%s] %s" % (argv[2], it["platforms"][argv[2]]))
    elif len(argv) >= 3 and argv[0] == "approve":
        approve(argv[1], argv[2])
        print("已审核通过，产物在 data/content_out/（发布由人手动完成）")
    elif argv and argv[0] == "list":
        for it in list_items():
            done = "/".join(k for k, v in it["platforms"].items() if v) or "未改写"
            print("%s  [%s] %s  已改写: %s  已审核: %s"
                  % (it["id"], it["status"], it["title"][:24], done,
                     "/".join(it["approved"]) or "-"))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
