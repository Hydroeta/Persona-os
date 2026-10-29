# -*- coding: utf-8 -*-
"""小鲸鱼 · 人格快照与回滚（人格是核心资产，改坏要能退）

把「一个灵魂」相关的正本文件打包成带清单的快照：
  config/persona.json          人格+声音+记忆指针正本
  config/state.json            情绪/精力状态
  config/memory_layers.json    记忆分层（如存在）
  ohwhale-deploy/persona/default.md   人格正本文本
  声音参考音频（persona.json voice.ref_audio 指向的文件，≤30MB 才复制）

快照存 data/persona_snapshots/<id>/，manifest.json 记录原始路径与 SHA1。
回滚前会**先把当前状态自动快照一份**（安全网），再覆盖回去。

CLI：
    python tools/persona_snapshot.py create "实验语气词调整"
    python tools/persona_snapshot.py list
    python tools/persona_snapshot.py rollback 20261028-153000
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAP_DIR = ROOT / "data" / "persona_snapshots"
MAX_VOICE_BYTES = 30 * 1024 * 1024


def _target_files() -> list[str]:
    """要打包的相对路径；persona.json 不存在则快照无从谈起，调用方报错。"""
    files = ["config/persona.json", "config/state.json", "config/memory_layers.json"]
    try:
        pj = json.loads((ROOT / "config" / "persona.json").read_text("utf-8"))
        md = (pj.get("canonical_text") or {}).get("persona_md")
        ref = (pj.get("voice") or {}).get("ref_audio")
        if md:
            files.append(md)
        if ref:
            files.append(ref)
    except Exception:
        pass
    seen, out = set(), []
    for f in files:
        if f not in seen and (ROOT / f).is_file():
            seen.add(f)
            out.append(f)
    return out


def _sha1(p: Path) -> str:
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def create(note: str = "") -> dict:
    files = _target_files()
    if "config/persona.json" not in files:
        raise RuntimeError("config/persona.json 不存在，快照无从谈起")
    sid = time.strftime("%Y%m%d-%H%M%S")
    n = 1
    while (SNAP_DIR / sid).exists():   # 同一秒内连拍会撞目录（回滚前的保护快照就会撞上）
        n += 1
        sid = "%s-%d" % (time.strftime("%Y%m%d-%H%M%S"), n)
    dst = SNAP_DIR / sid
    dst.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, rel in enumerate(files):
        src = ROOT / rel
        if src.stat().st_size > MAX_VOICE_BYTES:
            continue  # 参考音频异常大就不复制，manifest 里记路径即可
        stored = "%d%s" % (i, src.suffix or ".bin")
        shutil.copy2(src, dst / stored)
        entries.append({"orig": rel, "stored": stored, "sha1": _sha1(src),
                        "size": src.stat().st_size})
    manifest = {"id": sid, "ts": time.time(), "note": note, "files": entries}
    (dst / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    _prune()
    return manifest


def _prune(keep: int = 10) -> None:
    """只留最近 10 份，防止快照把音频复制爆盘。"""
    try:
        dirs = sorted(d for d in SNAP_DIR.iterdir() if d.is_dir())
        for d in dirs[:-keep]:
            shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


def list_all() -> list[dict]:
    out = []
    if not SNAP_DIR.is_dir():
        return out
    for d in sorted(SNAP_DIR.iterdir(), reverse=True):
        mf = d / "manifest.json"
        if not mf.is_file():
            continue
        try:
            m = json.loads(mf.read_text("utf-8"))
            out.append({"id": m["id"], "note": m.get("note", ""),
                        "files": len(m.get("files", [])),
                        "date": time.strftime("%Y-%m-%d %H:%M",
                                              time.localtime(m.get("ts", 0)))})
        except Exception:
            continue
    return out


def rollback(sid: str) -> dict:
    dst = SNAP_DIR / sid
    mf = dst / "manifest.json"
    if not mf.is_file():
        raise RuntimeError("快照 %s 不存在" % sid)
    m = json.loads(mf.read_text("utf-8"))
    # 安全网：回滚前先把当前状态存一份
    guard = create(note="rollback %s 前的自动快照" % sid)
    restored = []
    for e in m["files"]:
        src, tgt = dst / e["stored"], ROOT / e["orig"]
        if src.is_file() and tgt.parent.exists():
            shutil.copy2(src, tgt)
            restored.append(e["orig"])
    return {"restored": restored, "guard_snapshot": guard["id"]}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "create":
        m = create(argv[1] if len(argv) > 1 else "")
        print("快照 %s 已建（%d 个文件）：%s" % (m["id"], len(m["files"]), m["note"]))
    elif argv and argv[0] == "list":
        for s in list_all():
            print("%s  %s  %s（%d 文件）" % (s["id"], s["date"], s["note"], s["files"]))
    elif len(argv) >= 2 and argv[0] == "rollback":
        r = rollback(argv[1])
        print("已回滚 %d 个文件；回滚前状态自动存为 %s"
              % (len(r["restored"]), r["guard_snapshot"]))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
