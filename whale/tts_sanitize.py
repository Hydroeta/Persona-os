# -*- coding: utf-8 -*-
"""喂给 IndexTTS2 之前的文本净化（纯标准库，零新依赖）。

IndexTTS2 的两个崩溃触发条件（已验证）：
  ① 长文本   —— 60 字纯中文就崩（20 字可以），表现 torch.cat 空列表
  ② 英文/符号 —— 文本块里只要有 IndexTTS2 这种英文（或 ASCII 符号）就必崩，
                 表现 0xC0000005，且上层包装脚本会把报错吞掉

两件套配套修法：
  speakify(text)        —— 技术名换中文说法，剩下的字母按读音展开（a→诶、w→达不溜），
                           ASCII 标点转中文、其余符号剔除；输出仅含中文 + 数字 + 中文标点
  split_chunks(text, maxlen=20) —— 按 maxlen 切块（优先在标点处断句），逐块合成再拼接

约定（项目规则）：喂给 TTS 的文本一律先过 speakify；显示用的文案可以保留英文原词。
"""
from __future__ import annotations

import re

# ---------- 术语表：英文/技术词 → 中文说法（命中即整词替换，最长优先） ----------
# 只列项目里真会出现在台词/播报里的词；要扩展直接往表里加，无需改逻辑。
TERM_MAP: dict[str, str] = {
    "IndexTTS2": "因德克斯替提艾斯二",
    "IndexTTS": "因德克斯替提艾斯",
    "GPT-SoVITS": "吉批替索维次",
    "SoVITS": "索维次",
    "TTS": "替提艾斯",
    "ASR": "诶艾斯啊",
    "API": "诶批艾",
    "GPU": "吉批优",
    "CPU": "西批优",
    "NPU": "恩批优",
    "QQ": "扣扣",
    "OBS": "欧比艾斯",
    "DSH": "迪艾斯艾尺",
    "VAD": "维诶迪",
    "PCM": "批西艾姆",
    "RVC": "啊维西",
    "SVC": "艾斯维西",
    "LLM": "艾勒艾姆",
    "MCP": "艾姆西批",
    "CLI": "西艾勒艾",
    "HTTP": "诶尺梯踢批",
    "URL": "优啊勒",
    "JSON": "杰森",
}

# ---------- 字母读音表：a-z → 汉语拼音近似读法 ----------
LETTER_SOUND: dict[str, str] = {
    "a": "诶", "b": "比", "c": "西", "d": "迪", "e": "伊", "f": "艾弗",
    "g": "吉", "h": "艾尺", "i": "艾", "j": "杰", "k": "开", "l": "艾勒",
    "m": "艾姆", "n": "艾娜", "o": "欧", "p": "批", "q": "丘", "r": "阿",
    "s": "艾丝", "t": "提", "u": "优", "v": "维", "w": "达不溜", "x": "艾克斯",
    "y": "歪", "z": "贼",
}

# ASCII 标点 → 中文标点（其余 ASCII 符号直接剔除）
_PUNCT_MAP = {
    ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；",
    "(": "（", ")": "）", "[": "（", "]": "）", "{": "（", "}": "）",
    "<": "《", ">": "》", "/": "、", "\\": "、", "|": "、",
    "~": "～", "@": "艾特", "#": "井", "&": "和", "+": "加", "=": "等于",
    "%": "百分之", "*": "星", "^": "的",
}

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]")


def _replace_terms(text: str) -> str:
    """按 TERM_MAP 替换整词（最长优先、大小写不敏感）。"""
    if not TERM_MAP:
        return text
    for key in sorted(TERM_MAP, key=len, reverse=True):
        text = re.sub(re.escape(key), TERM_MAP[key], text, flags=re.IGNORECASE)
    return text


def speakify(text: str) -> str:
    """把文本净化成 IndexTTS2 安全的形式：仅中文 + 数字 + 中文标点。

    英文术语 → 中文说法；其余字母 → 按读音展开；ASCII 标点 → 中文标点；
    无法映射的符号 → 剔除。数字原样保留（IndexTTS2 能读）。
    喂给 TTS 前必过；显示文案不要用这个（会丢失英文原词）。
    """
    if not text:
        return ""
    text = _replace_terms(text)
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        # 中文 / 中文标点 / 全角字符 → 保留
        if _CJK_RE.match(ch):
            out.append(ch)
            continue
        # 数字 → 保留
        if "0" <= ch <= "9":
            out.append(ch)
            continue
        lo = ch.lower()
        if lo in LETTER_SOUND:
            out.append(LETTER_SOUND[lo])
            continue
        if ch in _PUNCT_MAP:
            out.append(_PUNCT_MAP[ch])
            continue
        # 空格及其他 ASCII 符号 → 丢弃（不发音也不崩）
    return "".join(out)


# 可断句的标点（中英文皆可，speakify 后通常只剩中文标点）
_BREAK_CHARS = "。！？!?；;，,、\n"


def split_chunks(text: str, maxlen: int = 20) -> list[str]:
    """把文本切成每段 ≤ maxlen 字的块，优先在标点处断句。

    纯中文计数（maxlen 按 lesson 的「字」语义）。标点和数字都算一个字。
    若某段无标点且超长，硬切 maxlen。返回非空块列表。
    """
    if maxlen < 1:
        maxlen = 1
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= maxlen:
        return [text]

    chunks: list[str] = []
    # 先按断句标点切（保留标点在句尾）
    segments = re.findall(r"[^%s]*[%s]?" % (re.escape(_BREAK_CHARS), re.escape(_BREAK_CHARS)), text)
    segments = [s for s in segments if s]
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        if len(seg) <= maxlen:
            chunks.append(seg)
        else:
            # 无标点超长段：硬切
            for i in range(0, len(seg), maxlen):
                piece = seg[i:i + maxlen].strip()
                if piece:
                    chunks.append(piece)
    return chunks


if __name__ == "__main__":
    # 快速自检：不加载模型，只打印净化结果，人工核对
    samples = [
        "IndexTTS2 合成失败了",
        "GPU 温度 80 度",
        "打开 OBS 开始录制",
        "这是一句超过二十个字的中文长句子用来测试切块功能是否正常工作哈哈",
        "Hello world, QQ 登录成功！",
        "",
    ]
    for s in samples:
        safe = speakify(s)
        print(repr(s), "->", repr(safe), "chunks=", split_chunks(safe, 20))
