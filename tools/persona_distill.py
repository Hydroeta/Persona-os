# -*- coding: utf-8 -*-
"""小鲸鱼 · 人格蒸馏管线（视频/字幕素材 → Tulpa 人格卡增量更新）

定位：人格卡（personality.json）的"增量训练"。只生长素材驱动的五个字段：
  core_traits / catchphrases / emotion_patterns / speaking_style / few_shots
不动 identity、taboo、chat_tenets、rhythm、forbidden_ai_words、group_culture
——那些是人工调校的底线，素材只补充、不覆盖；rules.json（系统边界）永不涉及。

输入三选一：
  1. 字幕/台词文本（.srt/.vtt/.txt/.md，首选，零依赖）
  2. 音视频文件（.mp4/.mkv/.mp3/.wav 等）：ffmpeg 抽 16k 单声道 wav，
     faster-whisper 本地转写（两者都是可选依赖，缺了会给出明确提示）
  3. 网络链接：字幕/文本/音视频直链直接下载处理；视频平台页面链接
     （B站/YouTube 等）走 yt-dlp（可选依赖）：优先抓字幕，抓不到再下音频转写

蒸馏走 llm_client.chat（scene="distill"，预算闸门内，配额兜底 other）。
合并策略：列表字段 strip 去重追加；emotion_patterns 只加新 key；
few_shots 按 user 去重。已有人工条目一律不覆盖、不删除。

默认 dry-run（只打印预览）；--apply 才写卡。写卡前在同目录留 .bak-<时间戳>，
写完同步 ~/.tulpa/prompts/mcp_chat/ 副本（Tulpa 优先读的那份），并 timeline 留痕。

CLI：
    python tools/persona_distill.py 素材.srt                       # 预览
    python tools/persona_distill.py 素材.mp4 --apply               # 转写+蒸馏+写卡
    python tools/persona_distill.py 素材.srt --card little_whale --max-chars 8000
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

CARD_DIR = ROOT / "Tulpa" / "Tulpa" / "chatlocal" / "prompts" / "mcp_chat"
USER_CARD_DIR = Path.home() / ".tulpa" / "prompts" / "mcp_chat"

TEXT_EXTS = {".srt", ".vtt", ".txt", ".md"}
AV_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm",
           ".mp3", ".wav", ".m4a", ".flac", ".ogg"}

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) persona-distill/1.0"
_TEXT_MAX_BYTES = 5 * 1024 * 1024
_AV_MAX_BYTES = 500 * 1024 * 1024

# 素材可以生长的字段（其余字段人工维护，蒸馏不碰）
LIST_FIELDS = ("core_traits", "catchphrases", "speaking_style")
DICT_FIELDS = ("emotion_patterns",)
SHOT_FIELDS = ("few_shots",)


# ---------- 1. 转写 ----------

def _strip_subtitle(raw: str) -> str:
    """剥 srt/vtt 的序号、时间轴、标签，只留台词行。"""
    lines = []
    for ln in raw.replace("\r\n", "\n").split("\n"):
        s = ln.strip()
        if not s or s.isdigit():
            continue
        if s.startswith("WEBVTT") or s.startswith("NOTE"):
            continue
        if re.match(r"^\d{2}:\d{2}:\d{2}[,.]\d+\s*-->\s*", s):
            continue
        s = re.sub(r"</?c[^>]*>", "", s)  # vtt 的 <c.xxx> 标签
        s = re.sub(r"<[^>]+>", "", s).strip()
        if s:
            lines.append(s)
    return "\n".join(lines)


def _read_text_file(path: Path) -> str:
    raw = path.read_text("utf-8-sig", errors="replace")
    if path.suffix.lower() in (".srt", ".vtt"):
        return _strip_subtitle(raw)
    return raw


def _find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    # 项目内常见位置（桌宠/TTS 组件偶尔自带）
    for cand in ROOT.rglob("ffmpeg.exe"):
        return str(cand)
    return None


def transcribe_av(path: Path, model_size: str = "small") -> str:
    """音视频 → 台词文本。依赖 ffmpeg + faster-whisper，缺哪个报哪个。"""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "音视频转写需要 faster-whisper：pip install faster-whisper。"
            "或者直接提供 .srt/.txt 字幕文件（零依赖，首选）") from e
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "找不到 ffmpeg（PATH 与项目目录都没有）。"
            "装 ffmpeg，或者直接提供 .srt/.txt 字幕文件")
    tmp = Path(tempfile.mkdtemp(prefix="pdistill_"))
    wav = tmp / "audio.wav"
    try:
        r = subprocess.run(
            [ffmpeg, "-y", "-i", str(path), "-vn",
             "-ac", "1", "-ar", "16000", str(wav)],
            capture_output=True, timeout=600)
        if r.returncode != 0 or not wav.is_file():
            raise RuntimeError("ffmpeg 提取音频失败（文件损坏或格式不支持）")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segs, _ = model.transcribe(str(wav), language="zh", vad_filter=True)
        return "\n".join(s.text.strip() for s in segs if s.text.strip())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _download(url: str, max_bytes: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise RuntimeError("下载内容超过 %dMB 上限" % (max_bytes // 1024 // 1024))
    return data


def _ytdlp_cmd() -> list[str] | None:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return None


def _transcript_from_page(url: str) -> str:
    """视频平台页面链接：yt-dlp 先抓字幕，抓不到再下音频转写。"""
    base = _ytdlp_cmd()
    if not base:
        raise RuntimeError(
            "页面链接需要 yt-dlp：pip install yt-dlp。"
            "或者直接提供字幕/文本文件或直链（零依赖）")
    tmp = Path(tempfile.mkdtemp(prefix="pdistill_dl_"))
    try:
        # 先字幕（人工字幕 + 自动字幕，中文优先）
        subprocess.run(
            base + ["--skip-download", "--write-subs", "--write-auto-subs",
                    "--sub-langs", "zh.*,zh-Hans.*,en.*", "--sub-format", "srt/vtt",
                    "--no-playlist", "-o", str(tmp / "sub.%(ext)s"), url],
            capture_output=True, timeout=300)
        subs = sorted(tmp.glob("sub.*.srt")) + sorted(tmp.glob("sub.*.vtt"))
        if subs:
            return _read_text_file(subs[0])
        # 字幕不可得：下音频走 whisper
        r = subprocess.run(
            base + ["-f", "bestaudio/best", "--no-playlist",
                    "-o", str(tmp / "audio.%(ext)s"), url],
            capture_output=True, timeout=600)
        aud = sorted(p for p in tmp.glob("audio.*") if p.suffix.lower() in AV_EXTS)
        if r.returncode != 0 or not aud:
            raise RuntimeError("yt-dlp 抓字幕和音频都失败（链接无效或平台限制）")
        return transcribe_av(aud[0])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _transcript_from_url(url: str) -> str:
    ext = Path(urlparse(url).path).suffix.lower()
    if ext in TEXT_EXTS:
        raw = _download(url, _TEXT_MAX_BYTES).decode("utf-8-sig", "replace")
        return _strip_subtitle(raw) if ext in (".srt", ".vtt") else raw
    if ext in AV_EXTS:
        tmp = Path(tempfile.mkdtemp(prefix="pdistill_dl_"))
        try:
            f = tmp / ("av" + ext)
            f.write_bytes(_download(url, _AV_MAX_BYTES))
            return transcribe_av(f)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return _transcript_from_page(url)


def load_transcript(source: str | Path) -> str:
    """统一入口：字幕/文本直接读，音视频走转写，链接先下载。"""
    if str(source).startswith(("http://", "https://")):
        text = _transcript_from_url(str(source))
        text = text.strip()
        if len(text) < 20:
            raise RuntimeError("提取到的台词太短（%d 字），没有蒸馏价值" % len(text))
        return text
    p = Path(source)
    if not p.is_file():
        raise RuntimeError("素材文件不存在：%s" % source)
    ext = p.suffix.lower()
    if ext in TEXT_EXTS:
        text = _read_text_file(p)
    elif ext in AV_EXTS:
        text = transcribe_av(p)
    else:
        raise RuntimeError("不支持的素材类型 %s（支持 %s / %s）" % (
            ext, "/".join(sorted(TEXT_EXTS)), "/".join(sorted(AV_EXTS))))
    text = text.strip()
    if len(text) < 20:
        raise RuntimeError("提取到的台词太短（%d 字），没有蒸馏价值" % len(text))
    return text


# ---------- 2. 蒸馏 ----------

_DISTILL_SYS = """你是人格卡蒸馏器。给你一段角色的台词素材，提取ta的语言特质，输出严格 JSON（不要 Markdown 围栏，不要解释）：
{
  "core_traits": ["性格特质，3~6字短语，只写素材里能看出来的"],
  "catchphrases": ["口头禅/口癖/口癖句式，原样摘录或轻微归整"],
  "emotion_patterns": {"场景（如被怼/被夸/被问隐私）": "该场景下的典型反应方式"},
  "speaking_style": ["说话风格观察（句式长短、语气习惯、标点习惯等）"],
  "few_shots": [{"user": "假设别人对ta说的一句话", "reply": ["ta可能的1~3条回应"]}]
}
规则：
- 只提取素材里真实出现的特质，不许凭空发明；拿不准的宁可不写
- 每个字段最多 8 条，抓最典型的；抓不到就留空数组/空对象
- catchphrases 要尽量是原话碎片，不是概括
- 不要提取身份信息（名字、外貌）、不要提取底线规则"""

_DISTILL_USER = "角色参考名：{name}\n\n台词素材：\n{text}"


def _parse_distilled(raw: str) -> dict:
    """容错解析 LLM 输出：剥围栏 → 整段 loads → 截取首个 {...} 块。"""
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.S).strip()
    data = None
    try:
        data = json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", s, flags=re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        raise RuntimeError("LLM 输出不是合法 JSON，可重试或缩短素材")
    out: dict = {}
    for f in LIST_FIELDS:
        v = data.get(f)
        if isinstance(v, list):
            out[f] = [str(x).strip() for x in v if str(x).strip()][:8]
    for f in DICT_FIELDS:
        v = data.get(f)
        if isinstance(v, dict):
            out[f] = {str(k).strip(): str(x).strip()
                      for k, x in v.items() if str(k).strip() and str(x).strip()}
    shots = data.get("few_shots")
    if isinstance(shots, list):
        ok = []
        for it in shots[:8]:
            if not isinstance(it, dict):
                continue
            u = str(it.get("user", "")).strip()
            rep = it.get("reply")
            if not u:
                continue
            if isinstance(rep, str):
                rep = [rep]
            if not isinstance(rep, list):
                continue
            rep = [str(x).strip() for x in rep if str(x).strip()]
            if rep:
                ok.append({"user": u, "reply": rep[:3]})
        if ok:
            out["few_shots"] = ok
    if not any(out.get(f) for f in LIST_FIELDS + DICT_FIELDS + SHOT_FIELDS):
        raise RuntimeError("蒸馏结果为空：素材里没提取到可用特质")
    return out


def distill(text: str, card_name: str = "角色", max_chars: int = 12000) -> dict:
    """调 LLM 蒸馏台词文本 → 结构化特质（已过白名单与类型校验）。"""
    import llm_client
    clipped = text[:max_chars]
    if len(text) > max_chars:
        clipped += "\n（素材过长，已截取前 %d 字）" % max_chars
    raw = llm_client.chat(
        [{"role": "system", "content": _DISTILL_SYS},
         {"role": "user", "content": _DISTILL_USER.format(name=card_name, text=clipped)}],
        scene="distill", max_tokens=2000, temperature=0.3)
    return _parse_distilled(raw)


# ---------- 3. 合并 ----------

def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def merge(card: dict, distilled: dict) -> tuple[dict, dict]:
    """把蒸馏结果并进人格卡。人工条目优先：只追加、不覆盖、不删除。
    返回 (新卡, 统计{字段: 新增条数})。"""
    merged = dict(card)
    stats: dict[str, int] = {}
    for f in LIST_FIELDS:
        new_items = distilled.get(f) or []
        if not new_items:
            continue
        old = list(card.get(f) or [])
        seen = {_norm(str(x)) for x in old}
        added = 0
        for item in new_items:
            key = _norm(str(item))
            if key and key not in seen:
                old.append(str(item).strip())
                seen.add(key)
                added += 1
        if added:
            merged[f] = old
        stats[f] = added
    for f in DICT_FIELDS:
        new_map = distilled.get(f) or {}
        if not new_map:
            continue
        old = dict(card.get(f) or {})
        added = 0
        for k, v in new_map.items():
            if k not in old:
                old[k] = v
                added += 1
        if added:
            merged[f] = old
        stats[f] = added
    for f in SHOT_FIELDS:
        new_shots = distilled.get(f) or []
        if not new_shots:
            continue
        old = list(card.get(f) or [])
        seen = {_norm(str((it or {}).get("user", "")))
                for it in old if isinstance(it, dict)}
        added = 0
        for shot in new_shots:
            key = _norm(str(shot.get("user", "")))
            if key and key not in seen:
                old.append(shot)
                seen.add(key)
                added += 1
        if added:
            merged[f] = old
        stats[f] = added
    return merged, stats


# ---------- 4. 写回 ----------

def card_path(card_name: str) -> Path:
    return CARD_DIR / ("%s.personality.json" % card_name)


def load_card(card_name: str) -> dict:
    p = card_path(card_name)
    if not p.is_file():
        raise RuntimeError("人格卡不存在：%s" % p)
    return json.loads(p.read_text("utf-8"))


def apply_card(card_name: str, merged: dict) -> dict:
    """写卡：同目录 .bak-<时间戳> 备份 → 写工作区卡 → 同步 ~/.tulpa 副本。"""
    p = card_path(card_name)
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = p.with_suffix(p.suffix + (".bak-%s" % ts))
    shutil.copy2(p, bak)
    text = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"
    p.write_text(text, encoding="utf-8")
    synced = None
    up = USER_CARD_DIR / p.name
    try:
        if USER_CARD_DIR.is_dir():
            up.write_text(text, encoding="utf-8")
            synced = str(up)
    except OSError:
        pass
    try:
        import timeline
        timeline.emit("persona_distill", "persona_distill",
                      card=card_name, backup=bak.name, synced=bool(synced))
    except Exception:
        pass
    return {"card": str(p), "backup": str(bak), "user_copy": synced}


# ---------- 5. 管线 ----------

def run(source: str | Path, card_name: str = "little_whale",
        apply: bool = False, max_chars: int = 12000) -> dict:
    """转写 → 蒸馏 → 合并 →（可选）写回。返回全过程报告。"""
    text = load_transcript(source)
    card = load_card(card_name)
    distilled = distill(text, card_name=card_name, max_chars=max_chars)
    merged, stats = merge(card, distilled)
    report = {"source": str(source), "card": card_name,
              "transcript_chars": len(text), "distilled": distilled,
              "added": stats, "applied": False}
    if apply and any(stats.values()):
        report["applied"] = True
        report.update(apply_card(card_name, merged))
    return report


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="人格蒸馏：素材 → Tulpa 人格卡增量更新")
    ap.add_argument("source", help="素材文件或链接（.srt/.vtt/.txt/.md、音视频、平台页面链接）")
    ap.add_argument("--card", default="little_whale", help="目标人格卡名（默认 little_whale）")
    ap.add_argument("--apply", action="store_true", help="实际写卡（默认只预览）")
    ap.add_argument("--max-chars", type=int, default=12000, help="蒸馏截取上限")
    args = ap.parse_args(argv)
    try:
        r = run(args.source, card_name=args.card,
                apply=args.apply, max_chars=args.max_chars)
    except Exception as e:  # noqa: BLE001
        print("失败：%s" % (str(e) or type(e).__name__))
        return 1
    print("素材：%s（台词 %d 字）" % (r["source"], r["transcript_chars"]))
    print("蒸馏结果：")
    print(json.dumps(r["distilled"], ensure_ascii=False, indent=2))
    print("合并统计（新增条数）：%s" % json.dumps(r["added"], ensure_ascii=False))
    if r["applied"]:
        print("已写卡：%s（备份 %s，用户副本 %s）" % (
            r["card"], Path(r["backup"]).name,
            "已同步" if r.get("user_copy") else "未同步"))
        print("提示：Tulpa 会话有 prompt 缓存，重启会话后生效")
    else:
        print("（dry-run，未写卡；加 --apply 实际写入）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
