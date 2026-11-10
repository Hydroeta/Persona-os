# -*- coding: utf-8 -*-
r"""persona-os · Painter 生图微服务（第二阶段 / 任务 2）

职责：把源项目 tools/painter.py（CogView 主 + 万相备，含成本/冷却/敏感词闸门与 DPAPI key_vault）
包装成独立 HTTP 微服务，供 dsh-painter 插件调用获取底图字节。TS 插件只管「逐帧显影 + 原子写 OBS」，
生图算力仍留在 Python（密钥在 Windows DPAPI 里，TS 读不到，也不该复制一份闸门逻辑）。

接口：
    GET  /health            健康检查 + 源项目定位
    GET  /stats             painter 用量与剩余配额（painter_stats）
    POST /check             只预检（敏感词/配额/冷却），不真画  {"prompt":"...","scene":"live"}
    POST /generate          生图并返回图片字节（image/jpeg）    {"prompt":"...","scene":"live","style":"..."}
                            成功：200 + 二进制；响应头 X-Painter-Provider / X-Painter-Msg / X-Painter-Path
                            闸门拒绝/失败：400 + {"ok":false,"error":"..."}

运行（复用源项目 ohwhale-deploy 虚拟环境，已含 fastapi/uvicorn；绝对路径，任意 cwd 可跑）：
    & "c:\Users\user\Desktop\projects (2)\ohwhale-deploy\.venv\Scripts\python.exe" "c:\Users\user\Desktop\projects (2)\github-release\persona-os\core-services\painter\main.py"

环境变量：
    PAINTER_PORT       监听端口（默认 8002）
    PERSONA_OS_ROOT    源项目根（用于定位 tools/painter.py；找不到时回退 LOCAL_FALLBACK_ROOTS）

dsh-painter 插件侧设：
    IMAGE_GEN_URL=http://127.0.0.1:8002/generate
"""
from __future__ import annotations

from urllib.parse import quote

import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

LOG_TAG = "[painter]"

# ---------------------------------------------------------------------------
# 路径解析（优先级：PERSONA_OS_ROOT > 沿 __file__ 上溯找 tools/painter.py > 本地回退）
# ---------------------------------------------------------------------------

# 本地兜底路径已移除（避免硬编码开发者机器路径）；请设置 PERSONA_OS_ROOT 指向含 tools/painter.py 的项目根。
LOCAL_FALLBACK_ROOTS: list[str] = []

PAINTER_REL = Path("tools") / "painter.py"


def _looks_like_root(p: Path) -> bool:
    return (p / PAINTER_REL).is_file()


def find_source_root() -> Optional[Path]:
    env_root = os.environ.get("PERSONA_OS_ROOT")
    if env_root:
        p = Path(env_root)
        if _looks_like_root(p):
            return p
    here = Path(__file__).resolve()
    for parent in here.parents:
        if _looks_like_root(parent):
            return parent
    for root in LOCAL_FALLBACK_ROOTS:
        p = Path(root)
        if _looks_like_root(p):
            return p
    return None


SOURCE_ROOT: Optional[Path] = None


def get_source_root() -> Path:
    global SOURCE_ROOT
    if SOURCE_ROOT is None:
        root = find_source_root()
        if root is None:
            raise RuntimeError(
                f"{LOG_TAG} 无法定位源项目 tools/painter.py：请设置 PERSONA_OS_ROOT 指向源项目根"
            )
        SOURCE_ROOT = root
    return SOURCE_ROOT


# 把源项目的 tools/ 加入 sys.path，使 `import painter` 可用；painter 自身会再把同目录
# 的 key_vault / balance_monitor 加入 sys.path。
_painter_imported = False


def import_painter():
    global _painter_imported
    if _painter_imported:
        return sys.modules["painter"]
    root = get_source_root()
    tools_dir = str(root / "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    import painter  # noqa: E402
    _painter_imported = True
    return painter


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

app = FastAPI(title="persona-os painter", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenIn(BaseModel):
    prompt: str = Field(..., description="生图提示词")
    scene: str = Field(default="live", description="场景：group / live / dream，决定冷却与配额")
    style: str = Field(default="", description="可选风格后缀，如 'anime, high quality'")


class CheckIn(BaseModel):
    prompt: str = Field(..., description="要预检的提示词")
    scene: str = Field(default="live", description="场景")


@app.get("/health")
def api_health():
    try:
        root = get_source_root()
        return {"ok": True, "source_root": str(root), "painter_py": str(root / PAINTER_REL)}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
def api_stats():
    try:
        p = import_painter()
        return p.painter_stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.post("/check")
def api_check(body: CheckIn):
    try:
        p = import_painter()
        cfg = p.load_config()
        ok, reason = p.check_sensitive(body.prompt, cfg)
        low = p.ink_low(body.scene, cfg)
        return {
            "ok": True,
            "prompt": body.prompt,
            "sensitive_ok": ok,
            "sensitive_reason": reason,
            "ink_msg": low,
            "stats": p.painter_stats(cfg),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.post("/generate")
def api_generate(body: GenIn):
    t0 = time.monotonic()
    try:
        p = import_painter()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"painter 导入失败：{type(e).__name__}: {e}")

    try:
        path, msg = p.generate_image_sync(body.prompt, style=body.style, scene=body.scene)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生图异常：{type(e).__name__}: {e}")

    elapsed = round(time.monotonic() - t0, 2)
    if not path:
        # 闸门拒绝 / 双通道全失败：painter 已记账，把原因返回给调用方念出来
        raise HTTPException(status_code=400, detail=json.dumps({"ok": False, "error": msg, "elapsed_s": elapsed}, ensure_ascii=False))

    src = Path(path)
    if not src.is_file():
        raise HTTPException(status_code=500, detail=json.dumps({"ok": False, "error": f"落盘文件不存在：{path}"}, ensure_ascii=False))

    data = src.read_bytes()
    provider = src.stem.split("_")[-1] if "_" in src.stem else "unknown"
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "X-Painter-Provider": provider,
            "X-Painter-Msg": quote(str(msg or ""), safe=""),  # HTTP 头只能 latin-1，中文必须转义
            "X-Painter-Path": quote(str(src), safe=""),  # 中文路径也必须转义
            "X-Painter-Elapsed-S": str(elapsed),
        },
    )


# ---------------------------------------------------------------------------
# 端口防冲突 + 启动
# ---------------------------------------------------------------------------

def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main() -> int:
    port = int(os.environ.get("PAINTER_PORT", "8002"))
    if port_in_use(port):
        print(f"{LOG_TAG} 端口 {port} 已被占用，painter 微服务未启动（可能已有实例在跑）", file=sys.stderr)
        return 1
    try:
        root = get_source_root()
        print(f"{LOG_TAG} source_root = {root} (painter.py exists={(root / PAINTER_REL).is_file()})")
    except RuntimeError as e:
        print(f"{LOG_TAG} {e}", file=sys.stderr)
        return 2
    import uvicorn
    print(f"{LOG_TAG} starting on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
