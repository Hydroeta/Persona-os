# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 资源闸门（P1-3）：通话/直播进行时，重任务让路；显存峰值记录

RTX 3050 4GB 是硬边界：GPT-SoVITS 推理期间再跑 bili-vision 抽帧/OCR 会拖慢
TTS 首包，直接砸通话体验。重任务（bili-vision、cron 运营任务）启动前必须先问
本模块：busy() 为 True 就推迟或降优先级。

CLI：
    python tools/resource_gate.py status    # {"busy":bool,"why":...,"vram_mb":...}
    python tools/resource_gate.py record    # 记录一次显存峰值（可挂计划任务每 5 分钟）
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"
RESOURCE_LOG = LOG_DIR / "resource.jsonl"

# 通话心跳：call_loop.py 每轮写 loop.heartbeat；30 秒内新鲜视为通话中
HEARTBEAT_AGE_BUSY = 30
# 显存峰值超过该值计入告警（MB）
VRAM_WARN_MB = 3600  # 4GB 卡留 ~400MB 余量


# 通话/直播心跳固定在这两个位置（ohwhale-deploy/logs）
# 不要用 recursive glob 扫 ohwhale-deploy/**：那里有 10 GB 运行时，会拖死指标接口
HEARTBEATS = (
    ROOT / "ohwhale-deploy" / "logs" / "loop.heartbeat",
    ROOT / "ohwhale-deploy" / "logs" / "live.heartbeat",
    ROOT / "logs" / "loop.heartbeat",
    ROOT / "logs" / "live.heartbeat",
)


def _heartbeat_files():
    yield from HEARTBEATS


def busy() -> tuple[bool, str]:
    """通话或直播是否进行中。"""
    now = time.time()
    for f in _heartbeat_files():
        try:
            if now - f.stat().st_mtime < HEARTBEAT_AGE_BUSY:
                return True, "%s 心跳新鲜（%.0f 秒前）" % (f.name, now - f.stat().st_mtime)
        except OSError:
            pass
    return False, ""


def vram_mb() -> tuple[int | None, int | None]:
    """(已用MB, 总量MB)；无 nvidia-smi 返回 (None, None)。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, timeout=10, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()
        used, total = out.splitlines()[0].split(",")
        return int(used), int(total)
    except Exception:
        return None, None


def record() -> dict:
    b, why = busy()
    used, total = vram_mb()
    entry = {"ts": round(time.time(), 1), "busy": b, "vram_used_mb": used,
             "vram_total_mb": total, "why": why}
    try:
        LOG_DIR.mkdir(exist_ok=True)
        with open(RESOURCE_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass
    return entry


def peak(days: int = 7) -> int | None:
    """最近 N 天显存峰值（MB）。"""
    if not RESOURCE_LOG.is_file():
        return None
    cut = time.time() - days * 86400
    hi = None
    try:
        with open(RESOURCE_LOG, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("ts", 0) >= cut and d.get("vram_used_mb") is not None:
                    hi = max(hi or 0, d["vram_used_mb"])
    except OSError:
        pass
    return hi


def status() -> dict:
    b, why = busy()
    used, total = vram_mb()
    lease = lease_holder()
    return {"busy": b, "why": why, "vram_used_mb": used, "vram_total_mb": total,
            "vram_peak_7d_mb": peak(),
            "warn": used is not None and used >= VRAM_WARN_MB,
            "lease": lease}


# ---------- GPU 租约（互斥，不只是让路） ----------
# 4GB 卡上两个重任务并行会 OOM：重任务开工前先 acquire，干完 release。
# 租约文件带 TTL（30 分钟），持有者崩溃也不会死锁。

LEASE_FILE = Path(__file__).resolve().parent / "gpu_lease.json"
LEASE_TTL = 1800


def lease_holder() -> str:
    try:
        d = json.loads(LEASE_FILE.read_text("utf-8"))
        if time.time() - d.get("ts", 0) < d.get("ttl", LEASE_TTL):
            return d.get("holder", "")
    except Exception:
        pass
    return ""


def acquire(holder: str, ttl: int = LEASE_TTL) -> bool:
    """拿 GPU 租约。通话/直播进行中或已被别人持有时返回 False。"""
    b, why = busy()
    if b:
        return False
    cur = lease_holder()
    if cur and cur != holder:
        return False
    try:
        LEASE_FILE.write_text(json.dumps(
            {"holder": holder, "ts": time.time(), "ttl": ttl}), "utf-8")
        return True
    except OSError:
        return False


def release(holder: str) -> bool:
    if lease_holder() != holder:
        return False
    try:
        LEASE_FILE.unlink(missing_ok=True)
        return True
    except OSError:
        return False


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "record":
        print(json.dumps(record()))
    elif len(args) >= 2 and args[0] == "acquire":
        ok = acquire(args[1])
        print("已持有 GPU 租约" if ok else "拿不到（通话/直播进行中或被别人持有）")
        sys.exit(0 if ok else 1)
    elif len(args) >= 2 and args[0] == "release":
        print("已释放" if release(args[1]) else "不是你持有的租约")
    else:
        print(json.dumps(status(), ensure_ascii=False))
