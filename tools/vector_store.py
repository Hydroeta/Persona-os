# -*- coding: utf-8 -*-
"""小鲸鱼 · 最小本地向量库（玩法3B）

文本 → 向量 → 余弦相似度检索，纯本地、零外部服务依赖（向量存 data/vector_store.json）。
嵌入方案：优先本地 Ollama（nomic-embed-text，与 llm_client 共用 local_base_url），
不可用自动降级 TF-IDF（numpy 实现）；numpy 也缺则 mode=none，query 返回 [] 不崩。

设计原则（沿用铁律）：零硬依赖、懒加载、优雅降级。
  - embed 模式：余弦用纯 python 实现，不依赖 numpy。
  - tfidf 模式：懒加载 numpy，缺了降级为 none。
  - Ollama 挂了 / embed 模型没拉 → 自动落 tfidf，doctor 可报缺。

接口：
    vs = VectorStore()
    vs.add("文本", meta={"path":"..."})
    vs.query("关键词", top_k=5) -> [{text, meta, score}]
    vs.save() / vs.load()
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

DEFAULT_PATH = ROOT / "data" / "vector_store.json"
DEFAULT_EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")


def _ollama_base() -> str:
    """与 llm_client 共用 local_base_url（OpenAI 兼容端点）。"""
    try:
        with open(TOOLS / "llm_gate.config.json", encoding="utf-8") as f:
            cfg = json.load(f)
        return (cfg.get("local_base_url") or "http://127.0.0.1:11434/v1").rstrip("/")
    except Exception:
        return "http://127.0.0.1:11434/v1"


def _cosine(a, b) -> float:
    """纯 python 余弦相似度（embed 模式不依赖 numpy）。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


class VectorStore:
    def __init__(self, path=None, embed_model=None, mode=None):
        """mode: None=自动探测；'embed'=强制 Ollama 嵌入；'tfidf'=强制 TF-IDF；'none'=不可用。"""
        self.path = Path(path or DEFAULT_PATH)
        self.embed_model = embed_model or DEFAULT_EMBED_MODEL
        self.mode = mode
        self.docs = []  # [{text, meta, vec?}]

    # ---------- Ollama 嵌入 ----------
    def _embed_one(self, text: str, timeout: int = 15):
        import urllib.request  # noqa: PLC0415
        url = _ollama_base() + "/embeddings"
        payload = json.dumps({"model": self.embed_model, "input": text}).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        # OpenAI 兼容 → data.data[0].embedding；Ollama 原生 → data.embedding
        if isinstance(data.get("data"), list) and data["data"]:
            return data["data"][0].get("embedding")
        return data.get("embedding")

    def _embed_available(self) -> bool:
        try:
            v = self._embed_one("probe", timeout=6)
            return isinstance(v, list) and len(v) > 0
        except Exception:
            return False

    def _ensure_mode(self):
        if self.mode is None:
            if self._embed_available():
                self.mode = "embed"
            else:
                try:
                    import numpy  # noqa: F401
                    self.mode = "tfidf"
                except Exception:
                    self.mode = "none"

    # ---------- TF-IDF（懒加载 numpy）----------
    @staticmethod
    def _tokens(text: str):
        import re  # noqa: PLC0415
        text = (text or "").lower()
        toks = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", text)
        chars = re.findall(r"[\u4e00-\u9fff]", text)
        for i in range(len(chars) - 1):
            toks.append(chars[i] + chars[i + 1])  # 中文 bigram 增强匹配
        return toks

    def _tfidf_matrix(self, texts):
        import numpy as np  # noqa: PLC0415
        docs_tokens = [self._tokens(t) for t in texts]
        vocab = {}
        for toks in docs_tokens:
            for t in set(toks):
                vocab.setdefault(t, len(vocab))
        if not vocab:
            return np.zeros((len(texts), 1)), vocab
        n = len(texts)
        df = [0] * len(vocab)
        for toks in docs_tokens:
            for t in set(toks):
                df[vocab[t]] += 1
        idf = [math.log((n + 1) / (df[i] + 1)) + 1 for i in range(len(vocab))]
        mat = np.zeros((n, len(vocab)))
        for i, toks in enumerate(docs_tokens):
            tf = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            for t, c in tf.items():
                j = vocab.get(t)
                if j is not None:
                    mat[i, j] = c * idf[j]
            norm = float(np.linalg.norm(mat[i]))
            if norm > 0:
                mat[i] /= norm
        return mat, vocab

    # ---------- 公开接口 ----------
    def add(self, text: str, meta: dict | None = None, dedup: bool = True) -> bool:
        text = text or ""
        if not text.strip():
            return False
        if dedup:
            for d in self.docs:
                if d["text"] == text:
                    d["meta"] = meta or d.get("meta", {})
                    return False
        self._ensure_mode()
        doc = {"text": text, "meta": meta or {}}
        if self.mode == "embed":
            try:
                doc["vec"] = self._embed_one(text)
            except Exception:
                doc["vec"] = None  # 嵌入失败：存原文，query 时排末尾
        self.docs.append(doc)
        return True

    def query(self, text: str, top_k: int = 5):
        text = text or ""
        if not self.docs or not text.strip():
            return []
        self._ensure_mode()
        if self.mode == "embed":
            try:
                qv = self._embed_one(text)
            except Exception:
                qv = None
            scored = []
            for d in self.docs:
                v = d.get("vec")
                scored.append((_cosine(qv, v) if (qv and v) else 0.0, d))
        elif self.mode == "tfidf":
            try:
                import numpy as np  # noqa: PLC0415
                texts = [d["text"] for d in self.docs] + [text]
                mat, _vocab = self._tfidf_matrix(texts)
                sims = mat[:-1] @ mat[-1]  # 已归一化 → 点积即余弦
                order = np.argsort(-sims)
                scored = [(float(sims[i]), self.docs[i]) for i in order]
            except Exception:
                scored = [(0.0, d) for d in self.docs]
        else:
            return []  # mode=none
        scored.sort(key=lambda x: -x[0])
        return [{"text": d["text"], "meta": d.get("meta", {}), "score": round(s, 4)}
                for s, d in scored[:top_k] if s > 0]

    def save(self) -> bool:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            data = {"mode": self.mode, "embed_model": self.embed_model,
                    "ts": time.time(), "docs": self.docs}
            self.path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return True
        except Exception:
            return False

    def load(self) -> bool:
        if not self.path.is_file():
            return False
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.mode = data.get("mode")
            if data.get("embed_model"):
                self.embed_model = data["embed_model"]
            self.docs = data.get("docs", [])
            return True
        except Exception:
            return False

    def __len__(self) -> int:
        return len(self.docs)


def main(argv):
    if len(argv) >= 3 and argv[1] == "query":
        vs = VectorStore()
        vs.load()
        print(json.dumps(vs.query(argv[2], top_k=int(argv[3]) if len(argv) > 3 else 5),
                         ensure_ascii=False, indent=2))
        return 0
    print("用法: python tools/vector_store.py query <text> [top_k]")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
