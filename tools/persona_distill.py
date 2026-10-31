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
  3. 网络链接：字幕/文本/音视频直链直接下载处理；B站链接优先走原生字幕
     API（复用 ohwhale-deploy/data/bilibili/bili_cookie.json，零额外依赖），
     拿不到字幕再回退 yt-dlp（可选依赖）：抓不到字幕再下音频转写

非中文素材（日/英等语音或字幕）先自动识别语言并翻译成中文再蒸馏，
保证写入人格卡的内容是中文；whisper 转写按音频自动检测语言，不再硬编码 zh。

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

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
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


def transcribe_av(path: Path, model_size: str = "small") -> tuple[str, list[dict], str]:
    """音视频 → (台词文本, 带时间戳分段, 检测到的语言码)。依赖 ffmpeg + faster-whisper。
    语言自动检测（不硬编码 zh），外语台词按原语言转写，翻译在蒸馏前统一做。"""
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
        segs, info = model.transcribe(str(wav), vad_filter=True)
        lang = (getattr(info, "language", "") or "zh").lower()
        segments = []
        for s in segs:
            t = s.text.strip()
            if t:
                segments.append({"start": float(s.start), "end": float(s.end), "text": t})
        text = "\n".join(s["text"] for s in segments)
        return text, segments, lang
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# 参考音频存放目录（IndexTTS2 零样本克隆：ref_audio_path 指向参考 wav）
VOICE_REF_DIR = ROOT / "ohwhale-deploy" / "models" / "indextts2" / "refs"

# 配置人格正本（call_loop.py 读 config/persona.json 物化视图，由 persona_switch 生成）
PERSONAS_DIR = ROOT / "config" / "personas"
ACTIVE_FILE = PERSONAS_DIR / "active.json"
VIEW_PERSONA = ROOT / "config" / "persona.json"


def _persona_for_card(card_name: str) -> str | None:
    """按人格卡名反查配置人格 id：匹配各人格 canonical_text.persona_md 的文件名
    （如 mortis.personality.json → mortis）。匹配不到返回 None（调用方回退激活人格）。"""
    want = (card_name or "").lower()
    if not want or not PERSONAS_DIR.is_dir():
        return None
    for d in PERSONAS_DIR.iterdir():
        src = d / "persona.json"
        if not src.is_file():
            continue
        try:
            md = (json.loads(src.read_text("utf-8")).get("canonical_text") or {}).get("persona_md", "")
        except Exception:
            continue
        base = os.path.basename(str(md))
        if base.endswith(".personality.json") and base[:-len(".personality.json")].lower() == want:
            return d.name
    return None


def sync_voice_to_config(voice_ref: dict, card_name: str = "") -> str | None:
    """把蒸馏抽取的音色参考同步到对应配置人格正本：
    优先按人格卡名反查（--card mortis → 写入 mortis 正本），匹配不到回退当前激活人格。
    让 call_loop.py（读 config/persona.json 物化视图）自动用上新音色。
    只更新 voice.engine / ref_audio，不动 states 等人工配置。
    仅当目标就是激活人格时才重生物化视图（避免覆盖别的角色视图）。
    返回更新的人格 id，失败返回 None。"""
    try:
        active_id = json.loads(ACTIVE_FILE.read_text("utf-8")).get("active_id")
    except Exception:
        active_id = None
    target_id = _persona_for_card(card_name) or active_id
    if not target_id:
        return None
    src = PERSONAS_DIR / target_id / "persona.json"
    if not src.is_file():
        return None
    try:
        p = json.loads(src.read_text("utf-8"))
    except Exception:
        return None
    voice = p.setdefault("voice", {})
    # 人格卡用 ref_audio_path，配置正本用 ref_audio，统一映射
    # IndexTTS2 零样本克隆只需参考音频，清掉 GPT-SoVITS 时代的 prompt 字段
    voice["engine"] = voice_ref.get("engine", "indextts2")
    voice["ref_audio"] = voice_ref["ref_audio_path"]
    voice.pop("prompt_text", None)
    voice.pop("prompt_lang", None)
    src.write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n", "utf-8")
    # 仅激活人格重生物化视图，call_loop.py 下次调用 voice_extra() 就拿到新参考音
    if target_id == active_id:
        p["_view_of"] = active_id
        p["_view_note"] = ("物化视图，由 persona_switch 自动生成；"
                           "改人设请编辑 config/personas/%s/persona.json" % active_id)
        VIEW_PERSONA.write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return target_id


def extract_voice_ref(source: Path, segments: list[dict], card_name: str) -> dict | None:
    """从转写分段里挑一段干净人声（5~12 秒），切出来做音色参考。
    返回 {"engine": "indextts2", "ref_audio_path": ...}，失败返回 None。"""
    if not segments:
        return None
    # 挑时长在 5~12s 之间、文本最长的一段（信息量足、克隆效果好）
    best = None
    for s in segments:
        dur = s["end"] - s["start"]
        if 5.0 <= dur <= 12.0:
            if best is None or len(s["text"]) > len(best["text"]):
                best = s
    # 没合适的就取最长的一段（截断到 12s）
    if best is None:
        best = max(segments, key=lambda s: s["end"] - s["start"])
        if best["end"] - best["start"] > 12.0:
            best = {"start": best["start"], "end": best["start"] + 12.0,
                    "text": best["text"]}
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        return None
    VOICE_REF_DIR.mkdir(parents=True, exist_ok=True)
    out = VOICE_REF_DIR / ("%s.wav" % card_name)
    try:
        r = subprocess.run(
            [ffmpeg, "-y", "-ss", "%.3f" % best["start"], "-t",
             "%.3f" % (best["end"] - best["start"]), "-i", str(source),
             "-vn", "-ac", "1", "-ar", "32000", str(out)],
            capture_output=True, timeout=120)
        if r.returncode != 0 or not out.is_file() or out.stat().st_size < 1024:
            return None
    except Exception:
        return None
    return {"engine": "indextts2", "ref_audio_path": str(out)}


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


# ---------- B站原生字幕（零额外依赖，复用 bili_cookie.json） ----------

_BILI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
_BILI_HDR = {"User-Agent": _BILI_UA, "Referer": "https://www.bilibili.com/"}
_BILI_MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]
_bili_mixin = {"key": "", "exp": 0.0}


def _bili_cookie_paths() -> list[Path]:
    paths = [
        ROOT / "ohwhale-deploy" / "data" / "bilibili" / "bili_cookie.json",
        Path.home() / ".bili" / "bili_cookie.json",
    ]
    env = os.environ.get("BILI_COOKIE_JSON")
    if env:
        paths.insert(0, Path(env))
    return paths


def _bili_cookie_header() -> dict:
    for p in _bili_cookie_paths():
        try:
            c = json.loads(p.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if c.get("SESSDATA"):
            parts = [f"{k}={c[k]}" for k in ("SESSDATA", "bili_jct", "DedeUserID")
                     if c.get(k)]
            return {"Cookie": "; ".join(parts)}
    return {}


def _bili_get(url: str, headers: dict | None = None) -> dict:
    h = dict(_BILI_HDR)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _bili_mixin_key() -> str:
    if _bili_mixin["key"] and time.time() < _bili_mixin["exp"]:
        return _bili_mixin["key"]
    nav = _bili_get("https://api.bilibili.com/x/web-interface/nav")
    wbi = ((nav.get("data") or {}).get("wbi_img")) or {}
    img = (wbi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
    sub = (wbi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
    raw = img + sub
    _bili_mixin["key"] = "".join(raw[i] for i in _BILI_MIXIN_TAB)[:32]
    _bili_mixin["exp"] = time.time() + 3600
    return _bili_mixin["key"]


def _bili_signed(params: dict) -> str:
    p = {k: v for k, v in params.items() if v not in (None, "")}
    p["wts"] = int(time.time())
    q = urllib.parse.urlencode(sorted(p.items()))
    p["w_rid"] = hashlib.md5((q + _bili_mixin_key()).encode()).hexdigest()
    return urllib.parse.urlencode(p)


def _bili_bvid(url: str) -> str | None:
    m = re.search(r"BV[0-9A-Za-z]{10}", url)
    return m.group(0) if m else None


def _transcript_from_bilibili(url: str) -> tuple[str, str] | None:
    """B站原生字幕 API。拿到台词返回 (文本, 字幕语言码)，拿不到返回 None（交给 yt-dlp 回退）。"""
    bvid = _bili_bvid(url)
    if not bvid:
        return None
    ck = _bili_cookie_header()
    try:
        d = _bili_get("https://api.bilibili.com/x/web-interface/view?"
                      + urllib.parse.urlencode({"bvid": bvid}))
        if d.get("code") != 0 or not d.get("data", {}).get("cid"):
            return None
        cid = d["data"]["cid"]
        p = _bili_get("https://api.bilibili.com/x/player/wbi/v2?"
                      + _bili_signed({"bvid": bvid, "cid": cid}), ck)
        if p.get("code") != 0:
            return None
        subs = (((p.get("data") or {}).get("subtitle") or {}).get("subtitles")) or []
        subs = [s for s in subs if (s.get("subtitle_url") or "").strip()]
        if not subs:
            return None
        # 中文优先，其他语言字幕也接受（蒸馏前统一翻译成中文）
        subs.sort(key=lambda s: 0 if "zh" in (s.get("lan") or "") else 1)
        sub = subs[0]
        sub_url = sub["subtitle_url"]
        if sub_url.startswith("//"):
            sub_url = "https:" + sub_url
        body = _bili_get(sub_url).get("body") or []
        lines = [b.get("content", "") for b in body if b.get("content")]
        text = "\n".join(lines).strip()
        if len(text) < 20:
            return None
        return text, (sub.get("lan") or "")
    except Exception:
        return None


def _sub_lang(p: Path) -> str | None:
    """从 yt-dlp 字幕文件名（如 sub.zh-Hans.srt）推断语言码。"""
    n = p.name.lower()
    if re.search(r"\.(zh|cmn|chi)[.-]", n):
        return "zh"
    if re.search(r"\.en[.-]", n):
        return "en"
    if re.search(r"\.(ja|jp|jpn)[.-]", n):
        return "ja"
    return None


_SUB_RANK = {"zh": 0, "en": 1, "ja": 2}


def _transcript_from_page(url: str) -> tuple[str, list[dict] | None, Path | None, str | None]:
    """视频平台页面链接：yt-dlp 先抓字幕，抓不到再下音频转写。
    返回 (text, segments, av_path, lang)。"""
    base = _ytdlp_cmd()
    if not base:
        if _bili_bvid(url):
            raise RuntimeError(
                "该B站视频没有公开字幕（或需要登录）。可在 ohwhale-deploy/data/bilibili/"
                "bili_cookie.json 配置 SESSDATA 获取会员字幕，或安装 yt-dlp 下载音频后本地转写")
        raise RuntimeError(
            "页面链接需要 yt-dlp：pip install yt-dlp。"
            "或者直接提供字幕/文本文件或直链（零依赖）")
    tmp = Path(tempfile.mkdtemp(prefix="pdistill_dl_"))
    try:
        # 先字幕（人工字幕 + 自动字幕，中文优先，日/英也接受，之后统一翻译）
        subprocess.run(
            base + ["--skip-download", "--write-subs", "--write-auto-subs",
                    "--sub-langs", "zh.*,zh-Hans.*,en.*,ja.*", "--sub-format", "srt/vtt",
                    "--no-playlist", "-o", str(tmp / "sub.%(ext)s"), url],
            capture_output=True, timeout=300)
        subs = sorted(tmp.glob("sub.*.srt")) + sorted(tmp.glob("sub.*.vtt"))
        if subs:
            subs.sort(key=lambda p: _SUB_RANK.get(_sub_lang(p) or "", 3))
            best = subs[0]
            return _read_text_file(best), None, None, _sub_lang(best)
        # 字幕不可得：下音频走 whisper
        r = subprocess.run(
            base + ["-f", "bestaudio/best", "--no-playlist",
                    "-o", str(tmp / "audio.%(ext)s"), url],
            capture_output=True, timeout=600)
        aud = sorted(p for p in tmp.glob("audio.*") if p.suffix.lower() in AV_EXTS)
        if r.returncode != 0 or not aud:
            raise RuntimeError("yt-dlp 抓字幕和音频都失败（链接无效或平台限制）")
        text, segs, lang = transcribe_av(aud[0])
        return text, segs, aud[0], lang
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _transcript_from_url(url: str) -> tuple[str, list[dict] | None, Path | None, str | None]:
    ext = Path(urlparse(url).path).suffix.lower()
    if ext in TEXT_EXTS:
        raw = _download(url, _TEXT_MAX_BYTES).decode("utf-8-sig", "replace")
        return (_strip_subtitle(raw) if ext in (".srt", ".vtt") else raw), None, None, None
    if ext in AV_EXTS:
        tmp = Path(tempfile.mkdtemp(prefix="pdistill_dl_"))
        try:
            f = tmp / ("av" + ext)
            f.write_bytes(_download(url, _AV_MAX_BYTES))
            text, segs, lang = transcribe_av(f)
            return text, segs, f, lang
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    # B站优先走原生字幕 API（零额外依赖），失败再回退 yt-dlp
    if _bili_bvid(url):
        got = _transcript_from_bilibili(url)
        if got:
            return got[0], None, None, got[1] or None
    return _transcript_from_page(url)


def load_transcript(source: str | Path) -> tuple[str, list[dict] | None, Path | None, str | None]:
    """统一入口：字幕/文本直接读，音视频走转写，链接先下载。
    返回 (text, segments, av_path, lang)。segments/av_path 仅音视频源有值，
    lang 为检测到的语言码（文本/字幕源可能为 None）。"""
    if str(source).startswith(("http://", "https://")):
        text, segs, av, lang = _transcript_from_url(str(source))
        text = text.strip()
        if len(text) < 20:
            raise RuntimeError("提取到的台词太短（%d 字），没有蒸馏价值" % len(text))
        return text, segs, av, lang
    p = Path(source)
    if not p.is_file():
        raise RuntimeError("素材文件不存在：%s" % source)
    ext = p.suffix.lower()
    if ext in TEXT_EXTS:
        text = _read_text_file(p)
        segs, av, lang = None, None, None
    elif ext in AV_EXTS:
        text, segs, lang = transcribe_av(p)
        av = p
    else:
        raise RuntimeError("不支持的素材类型 %s（支持 %s / %s）" % (
            ext, "/".join(sorted(TEXT_EXTS)), "/".join(sorted(AV_EXTS))))
    text = text.strip()
    if len(text) < 20:
        raise RuntimeError("提取到的台词太短（%d 字），没有蒸馏价值" % len(text))
    return text, segs, av, lang


# ---------- 1.5 非中文台词 → 中文 ----------

_TRANS_SYS = ("你是台词翻译器。把给定台词文本完整翻译成自然、口语化的简体中文，"
              "保留原有换行与说话节奏，人名用常见中文译法，只输出译文，不要解释。")


def _needs_translation(text: str, lang: str | None) -> bool:
    """判断台词是否需要翻译。有语言码看语言码；没有就看字符构成
    （假名/谚文直接判外语；拉丁字母远多于汉字判英文等）。"""
    if lang:
        return not lang.lower().startswith("zh")
    if re.search(r"[぀-ヿ가-힯]", text):
        return True
    cjk = len(re.findall(r"[一-鿿]", text))
    latin = len(re.findall(r"[a-zA-Z]", text))
    return latin > cjk * 2


def translate_to_zh(text: str, max_chars: int = 12000) -> str:
    """非中文台词 → 中文（走 distill 场景配额，与蒸馏共用预算闸门）。"""
    import llm_client
    clipped = text[:max_chars]
    raw = llm_client.chat(
        [{"role": "system", "content": _TRANS_SYS},
         {"role": "user", "content": clipped}],
        scene="distill", max_tokens=4000, temperature=0.1)
    out = raw.strip()
    if len(out) < 10:
        raise RuntimeError("台词翻译失败：LLM 输出过短")
    return out


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


def _default_card(card_name: str) -> dict:
    """卡不存在时的最小可用模板：只填充蒸馏会碰的字段，其余留空待人工调校。"""
    return {
        "$format": "tulpa-personality-card/v1",
        "$note": "由人格蒸馏管线自动创建。素材只补充 core_traits / catchphrases / "
                 "emotion_patterns / speaking_style / few_shots，identity、taboo、"
                 "chat_tenets、rhythm 等字段需人工调校。",
        "identity": {
            "name": card_name,
            "alias": [card_name],
            "species": "",
            "appearance": "",
            "not_role": [],
            "self_awareness": "",
            "address_habit": "",
            "top_principle": "",
        },
        "core_traits": [],
        "taboo": {"words": [], "reaction": "", "exception": ""},
        "catchphrases": [],
        "emotion_patterns": {},
        "chat_tenets": [],
        "speaking_style": [],
        "rhythm": [],
        "forbidden_ai_words": [],
        "group_culture": [],
        "few_shots": [],
    }


def load_card(card_name: str) -> dict:
    p = card_path(card_name)
    if not p.is_file():
        return _default_card(card_name)
    return json.loads(p.read_text("utf-8"))


def apply_card(card_name: str, merged: dict) -> dict:
    """写卡：已存在则同目录 .bak-<时间戳> 备份；不存在则直接新建。
    写工作区卡 → 同步 ~/.tulpa 副本。"""
    p = card_path(card_name)
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = p.with_suffix(p.suffix + (".bak-%s" % ts))
    is_new = not p.is_file()
    if is_new:
        p.parent.mkdir(parents=True, exist_ok=True)
    else:
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
                      card=card_name, new=is_new,
                      backup=None if is_new else bak.name,
                      synced=bool(synced))
    except Exception:
        pass
    return {"card": str(p),
            "backup": None if is_new else str(bak),
            "user_copy": synced, "new": is_new}


# ---------- 5. 管线 ----------

def run(source: str | Path, card_name: str = "little_whale",
        apply: bool = False, max_chars: int = 12000) -> dict:
    """转写 →（非中文先翻译成中文）→ 蒸馏 → 合并 →（可选）写回。
    音视频源还会抽取参考音色写进人格卡。"""
    text, segments, av_path, lang = load_transcript(source)
    translated = False
    if _needs_translation(text, lang):
        text = translate_to_zh(text, max_chars)
        translated = True
    new_card = not card_path(card_name).is_file()
    card = load_card(card_name)
    distilled = distill(text, card_name=card_name, max_chars=max_chars)
    merged, stats = merge(card, distilled)
    # 音视频源：抽取参考音色（IndexTTS2 零样本克隆用）
    voice_ref = None
    if segments and av_path is not None:
        voice_ref = extract_voice_ref(av_path, segments, card_name)
        if voice_ref:
            merged["voice"] = voice_ref
    report = {"source": str(source), "card": card_name,
              "transcript_chars": len(text), "lang": lang,
              "translated": translated, "distilled": distilled,
              "added": stats, "applied": False, "new_card": new_card,
              "voice_ref": voice_ref}
    if apply and any(stats.values()):
        report["applied"] = True
        report.update(apply_card(card_name, merged))
        # 音色参考同步到配置人格正本，call_loop.py 自动用上新克隆音色
        if voice_ref:
            synced = sync_voice_to_config(voice_ref, card_name)
            report["voice_synced_to"] = synced
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
    if r.get("new_card"):
        print("人格卡不存在，将新建：%s" % r["card"])
    print("素材：%s（台词 %d 字）" % (r["source"], r["transcript_chars"]))
    if r.get("translated"):
        print("检测到%s素材，已先翻译成中文再蒸馏" % (r.get("lang") or "非中文"))
    print("蒸馏结果：")
    print(json.dumps(r["distilled"], ensure_ascii=False, indent=2))
    print("合并统计（新增条数）：%s" % json.dumps(r["added"], ensure_ascii=False))
    if r.get("voice_ref"):
        vr = r["voice_ref"]
        print("音色参考：%s" % vr["ref_audio_path"])
        if r.get("voice_synced_to"):
            print("音色已同步到配置人格：%s（通话链路自动生效）" % r["voice_synced_to"])
    else:
        print("音色参考：无（文本/字幕素材无音频可抽取）")
    if r["applied"]:
        if r.get("new"):
            print("已新建人格卡：%s（用户副本 %s）" % (
                r["card"], "已同步" if r.get("user_copy") else "未同步"))
        else:
            print("已写卡：%s（备份 %s，用户副本 %s）" % (
                r["card"], Path(r["backup"]).name,
                "已同步" if r.get("user_copy") else "未同步"))
        print("提示：Tulpa 会话有 prompt 缓存，重启会话后生效")
    else:
        print("（dry-run，未写卡；加 --apply 实际写入）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
