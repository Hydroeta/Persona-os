# -*- coding: utf-8 -*-
"""小鲸鱼 · 桌面整理提醒（P2）

桌宠本职：桌面乱了她提醒整理，ddl 文件高亮提示。只读扫描，
永不自动移动/删除任何文件。

CLI：
    python tools/desk_tidy.py scan
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

DESKTOP = Path.home() / "Desktop"
DOWNLOADS = Path.home() / "Downloads"
AUDIT_LOG = ROOT / "logs" / "desk_tidy.log"
MESSY_COUNT = 30       # 桌面超过这么多项算「乱」
OLD_DAYS = 30          # 超过 30 天没动的文件视为「可能该归档」
DDL_WORDS = ("ddl", "deadline", "截止", "期末", "报告", "论文", "答辩",
             "作业", "汇报")


def scan(desktop: Path | None = None) -> dict:
    """返回桌面概况与建议。只读。找不到桌面返回 ok=False。"""
    desk = desktop or DESKTOP
    if not desk.is_dir():
        return {"ok": False, "msg": "找不到桌面目录"}
    now = __import__("time").time()
    items, old, ddl = [], [], []
    try:
        for p in desk.iterdir():
            try:
                st = p.stat()
            except OSError:
                continue
            items.append(p.name)
            age_d = (now - st.st_mtime) / 86400.0
            if p.is_file() and age_d >= OLD_DAYS:
                old.append(p.name)
            low = p.name.lower()
            if p.is_file() and any(w in low for w in DDL_WORDS):
                ddl.append(p.name)
    except OSError as e:
        return {"ok": False, "msg": type(e).__name__}
    suggestions = []
    if len(items) >= MESSY_COUNT:
        suggestions.append("桌面有 %d 项了，要不要收拾一下？" % len(items))
    if old:
        suggestions.append("有 %d 个文件超过 %d 天没动过，也许可以归档"
                           % (len(old), OLD_DAYS))
    if ddl:
        suggestions.append("这几个文件名看着像有期限：%s"
                           % "、".join(ddl[:5]))
    return {"ok": True, "count": len(items), "old": len(old),
            "ddl_like": ddl[:10], "suggestions": suggestions,
            "note": "只读扫描，不会移动任何文件"}


# ============================================================
# 下载文件夹自动归档（玩法3A）：默认 dry_run，--yes 才真移动
# ============================================================

# 扩展名硬编码分类：LLM 不可用时降级用
_EXT_CATEGORIES = {
    "图片": {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".heic"},
    "文档": {".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt"},
    "表格": {".xls", ".xlsx", ".csv", ".ods"},
    "演示": {".ppt", ".pptx", ".key", ".odp"},
    "压缩包": {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"},
    "视频": {".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".webm"},
    "音频": {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"},
    "安装包": {".exe", ".msi", ".apk", ".dmg", ".pkg", ".deb", ".rpm"},
    "代码": {".py", ".js", ".ts", ".html", ".css", ".json", ".xml", ".java",
             ".cpp", ".c", ".h", ".go", ".rs", ".sh", ".ps1", ".bat", ".cmd"},
}


def _ext_category(name: str) -> str:
    suf = Path(name).suffix.lower()
    for cat, exts in _EXT_CATEGORIES.items():
        if suf in exts:
            return cat
    return "其他"


def _sanitize_category(cat: str) -> str:
    """清洗分类名，防路径穿越/非法字符。"""
    cat = (cat or "").strip()
    for ch in ("/", "\\", ":", "*", "?", '"', "<", ">", "|", ".."):
        cat = cat.replace(ch, "_")
    return cat or "其他"


def _parse_json_map(text: str, filenames: list[str]):
    """容错解析 LLM 返回的 {文件名: 分类}；解析失败返回 None。"""
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
        obj = json.loads(s)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def _llm_classify(filenames: list[str]):
    """调本地 Ollama（scene=desk_tidy）分类，返回 {name: category}；
    LLM 不可用/失败返回 None（调用方降级扩展名）。"""
    try:
        import llm_client  # type: ignore
    except Exception:
        return None
    prompt = (
        "把下面下载文件夹里的文件名各自归到一个通用中文分类文件夹名"
        "（如 图片/文档/视频/音频/压缩包/安装包/表格/演示/代码/其他）。"
        "同类文件归同一分类，不要为单个文件造独特分类。"
        "严格只返回一个 JSON 对象 {文件名: 分类}，不要任何解释文字。文件列表：\n"
        + json.dumps(filenames, ensure_ascii=False)
    )
    try:
        out = llm_client.chat([{"role": "user", "content": prompt}],
                              scene="desk_tidy", max_tokens=900, temperature=0.2)
    except Exception:
        return None
    parsed = _parse_json_map(out, filenames)
    if parsed is None:
        return None
    # 只保留输入文件名对应的值，过滤掉 LLM 幻觉的键
    return {n: parsed.get(n) for n in filenames}


def _unique_dest(dest: Path) -> Path:
    """目标已存在同名文件时加 _1/_2 后缀，避免覆盖。"""
    if not dest.exists():
        return dest
    stem, suf = dest.stem, dest.suffix
    i = 1
    while True:
        cand = dest.with_name("%s_%d%s" % (stem, i, suf))
        if not cand.exists():
            return cand
        i += 1


def _audit_move(src: Path, dest: Path, category: str) -> None:
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write("%s\t%s\t%s\t%s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), category, src, dest))
    except Exception:
        pass


def _qq_report(text: str):
    """整理完 QQ 报告结果。失败不阻断归档，返回 (ok, msg)。"""
    group_id = os.environ.get("REPLY_QQ_GROUP_ID", "").strip()
    if not group_id:
        return False, "未配置 REPLY_QQ_GROUP_ID"
    try:
        import qq_painter  # type: ignore
        url, token = qq_painter.onebot_config()
    except Exception:
        return False, "qq_painter 不可用"
    if not url:
        return False, "未配置 REPLY_ONEBOT_URL"
    import urllib.request  # noqa: PLC0415
    payload = {"group_id": int(group_id),
               "message": [{"type": "text", "data": {"text": text}}]}
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/send_group_msg",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     **({"Authorization": "Bearer " + token} if token else {})})
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode("utf-8", "replace"))
        if resp.get("status") == "ok" and resp.get("retcode") == 0:
            return True, "QQ 报告已发送"
        return False, "OneBot 返回失败: %s" % str(resp)[:150]
    except Exception as e:
        return False, "QQ 发送失败: %s" % type(e).__name__


def organize(apply: bool = False, threshold: int = 10,
             downloads: Path | None = None) -> dict:
    """整理下载文件夹。
    apply=False（默认 dry_run）：只返回将要移动的清单，不创建文件夹、不移动。
    apply=True：建分类子文件夹 + 移动 + 写审计日志 + QQ 报告。
    文件数 <= threshold 时不触发。LLM 不可用降级按扩展名分类。
    """
    dl = downloads or DOWNLOADS
    result = {"ok": False, "downloads": str(dl), "apply": apply,
              "threshold": threshold, "total_files": 0, "plan": [],
              "moved": [], "skipped": [], "classifier": "", "msg": ""}
    if not dl.is_dir():
        result["msg"] = "找不到下载目录: %s" % dl
        return result
    try:
        files = [p for p in dl.iterdir() if p.is_file()]
    except OSError as e:
        result["msg"] = "读取下载目录失败: %s" % type(e).__name__
        return result
    result["total_files"] = len(files)
    if len(files) <= threshold:
        result["ok"] = True
        result["msg"] = "文件数 %d 未超阈值 %d，无需整理" % (len(files), threshold)
        return result

    names = [p.name for p in files]
    cat_map = _llm_classify(names)
    if cat_map is not None:
        result["classifier"] = "llm"
    else:
        result["classifier"] = "extension"
        cat_map = {n: _ext_category(n) for n in names}

    plan = []
    for p in files:
        cat = _sanitize_category(cat_map.get(p.name) or "")
        if not cat or cat == "其他":
            # LLM 没给分类或归到空 → 扩展名兜底
            cat = _ext_category(p.name)
        plan.append((p, cat))
    result["plan"] = [{"file": p.name, "category": cat} for p, cat in plan]

    if not apply:
        result["ok"] = True
        result["msg"] = "dry-run：将移动 %d 个文件到 %d 个分类（未实际移动，加 --yes 执行）" % (
            len(plan), len({c for _, c in plan}))
        return result

    # apply=True：真正移动
    moved, skipped = [], []
    for p, cat in plan:
        target_dir = dl / cat
        try:
            target_dir.mkdir(exist_ok=True)
        except OSError:
            skipped.append({"file": p.name, "reason": "建文件夹失败"})
            continue
        dest = _unique_dest(target_dir / p.name)
        try:
            shutil.move(str(p), str(dest))
            moved.append({"file": p.name, "category": cat,
                          "from": str(p), "to": str(dest)})
            _audit_move(p, dest, cat)
        except Exception as e:
            skipped.append({"file": p.name, "reason": type(e).__name__})
    result["moved"] = moved
    result["skipped"] = skipped
    result["ok"] = True
    cats = sorted({m["category"] for m in moved})
    result["msg"] = "已整理：移动 %d 个文件到 %d 个分类文件夹（%s）" % (
        len(moved), len(cats), "、".join(cats))
    # QQ 报告（失败不阻断）
    try:
        qok, qmsg = _qq_report(result["msg"])
        result["qq_report"] = {"ok": qok, "msg": qmsg}
    except Exception as e:
        result["qq_report"] = {"ok": False, "msg": "QQ 报告异常: %s" % type(e).__name__}
    return result


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "scan"
    if cmd == "scan":
        print(json.dumps(scan(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "organize":
        apply = "--yes" in argv
        threshold = 10
        for i, a in enumerate(argv):
            if a == "--threshold" and i + 1 < len(argv):
                try:
                    threshold = int(argv[i + 1])
                except ValueError:
                    pass
        downloads = None
        for i, a in enumerate(argv):
            if a == "--downloads" and i + 1 < len(argv):
                downloads = Path(argv[i + 1])
        print(json.dumps(organize(apply=apply, threshold=threshold,
                                  downloads=downloads), ensure_ascii=False, indent=2))
        return 0
    print("用法: python tools/desk_tidy.py [scan|organize] [--yes] [--threshold N] [--downloads DIR]")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
