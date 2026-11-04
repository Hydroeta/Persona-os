# -*- coding: utf-8 -*-
"""小鲸鱼 · 统一生图引擎（CogView 主 + 万相备）+ 成本/安全闸门

双通道：
  主  GLM CogView-3-flash   免费额度，同步返回 URL（契约已由 dream_engine._illustrate 验证）
  备  阿里百炼 万相           主通道失败/无 key 时降级，异步任务轮询

成本与安全防线（全部可在 painter_gate.config.json 调整）：
  1. 敏感词前置拦截 —— 命中直接拒绝，不触网不计费
  2. 按次计费闸门   —— 独立 sqlite 账本（painter_gate.db），日次数上限 + 月费用上限；
                       图像是按张计费，和 llm_gate 的 token 账是两个维度，故独立记账
  3. 场景冷却       —— group 60s / live 120s 全员 CD（防刷爆），线程安全
  4. 余额联动       —— ink_low() 综合 balance_monitor 告警 +  painter 剩余配额，
                       告急时调用方应降级（小鲸鱼说“画笔没墨水了”）

零三方依赖：只用标准库 + tools 内的 key_vault / balance_monitor，任何 venv 都能 import。
调用方（控制台 / live_bot / Tulpa）只需保证 tools 目录在 sys.path 上。

用法：
    from painter import generate_image_sync, generate_image_async, publish_to_obs, ink_low
    path, msg = generate_image_sync("一只猫", scene="group")
    if path:
        publish_to_obs(path)   # 覆盖 OBS 图片源，画面瞬间刷新

CLI：
    python tools/painter.py gen "一只赛博朋克猫"          # 跑全链路，落盘并打印证据
    python tools/painter.py gen "电饭煲" --scene live     # 指定场景（冷却/配额按场景）
    python tools/painter.py stats                         # 用量与剩余配额
    python tools/painter.py check " prompt"               # 只预检（敏感词/配额/冷却），不真画
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(GATE_DIR))  # 保证 import 得到同目录的 key_vault / balance_monitor

CONFIG_FILE = GATE_DIR / "painter_gate.config.json"
DB_FILE = GATE_DIR / "painter_gate.db"

DEFAULT_CONFIG = {
    "enabled": True,
    # 配额：每日成功生图次数上限（dream 离线配图不计入互动配额）+ 每月预估费用上限
    "daily_cap": 50,
    "monthly_cost_cap_yuan": 10.0,
    # 各场景全员冷却（秒）；0 = 不冷却。dream 是凌晨批处理，不与群聊/直播抢 CD
    "scene_cooldown": {"group": 60, "live": 120, "dream": 0, "default": 60},
    "providers": {
        "glm": {"model": "cogview-3-flash", "cost_per_image": 0.0,
                "enabled": True,
                "base_url": "https://open.bigmodel.cn"},
        "qwen": {"model": "wanx2.1-t2i-turbo", "cost_per_image": 0.2,
                 "enabled": True,
                 "base_url": "https://dashscope.aliyuncs.com"},
    },
    "primary": "glm",                      # 主通道，失败自动切备
    "sensitive_words": ["色情", "裸", "血腥", "暴力", "政治", "毒品", "枪", "裸体", "做爱"],
    "output_dir": "data/paint_output",     # 相对项目根
    "obs_image_path": r"D:\live_assets\current_paint.jpg",
    "default_size": "1024*1024",
    "request_timeout": 30,
    "download_timeout": 60,
    "qwen_poll_interval": 5,
    "qwen_poll_max_s": 90,
    # 余额联动：balance_monitor 告急时是否拒绝生图（dream 离线不受此限）
    "respect_balance_hint": True,
}

# 线程安全：冷却状态（内存，单进程内有效；live_bot 与 Tulpa 是不同进程，各自独立冷却）
_cd_lock = threading.Lock()
_last_paint: dict[str, float] = {}   # scene -> 最近一次成功生图的 monotonic 时间

_db_lock = threading.Lock()  # sqlite 单写保护（多线程并发记账）


# ============================================================
# 配置
# ============================================================
def load_config() -> dict:
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        except Exception:
            cfg = {}
        merged = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝默认值
        _deep_update(merged, cfg)
        return merged
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                               "utf-8")
    except OSError:
        pass
    return json.loads(json.dumps(DEFAULT_CONFIG))


def _deep_update(base: dict, over: dict) -> None:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v


# ============================================================
# 闸门（按次计费，独立账本）
# ============================================================
def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE), timeout=5)
    conn.execute("""CREATE TABLE IF NOT EXISTS calls(
        ts REAL, scene TEXT, provider TEXT, ok INTEGER, cost REAL, prompt TEXT)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)")
    return conn


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


def _month0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m") + "-01", "%Y-%m-%d"))


def _cooldown_for(cfg: dict, scene: str) -> float:
    return float(cfg["scene_cooldown"].get(scene, cfg["scene_cooldown"].get("default", 60)))


def check_sensitive(prompt: str, cfg: dict | None = None) -> tuple[bool, str]:
    """前置敏感词拦截。返回 (是否放行, 拒绝原因)。"""
    cfg = cfg or load_config()
    text = (prompt or "").lower()
    for w in cfg.get("sensitive_words", []):
        if w and w.lower() in text:
            return False, "这个不能画，换个正经的。"
    return True, ""


def ink_low(scene: str = "group", cfg: dict | None = None) -> str:
    """画笔墨水是否不足。返回空串=可画；非空=降级原因（供调用方念出来）。

    综合：painter 自身剩余配额 + balance_monitor 的厂商告警。
    dream 场景只看 painter 月费用，不看 LLM 余额（离线配图走 GLM 免费额度）。
    """
    cfg = cfg or load_config()
    if not cfg["enabled"]:
        return ""
    stats = painter_stats(cfg)
    if scene != "dream":
        # 互动配额只统计群聊/直播；dream 是凌晨离线配图，不占互动额度（月费用仍全局兜住）
        conn = _db()
        try:
            interactive = conn.execute(
                "SELECT COUNT(*) FROM calls WHERE ts>=? AND ok=1 AND scene!='dream'",
                (_today0(),)).fetchone()[0]
        finally:
            conn.close()
        if interactive >= cfg["daily_cap"]:
            return "今天配额用光了，明天再画。"
    if stats["month_cost"] >= cfg["monthly_cost_cap_yuan"]:
        return "本月画笔预算花完了，先聊会天吧。"
    if scene != "dream" and cfg.get("respect_balance_hint"):
        try:
            import balance_monitor
            hint = balance_monitor.routing_hint()
            avoid = set(hint.get("avoid", []))
            # 主备都被余额告警回避 → 没墨水了
            usable = [p for p, pc in cfg["providers"].items()
                      if pc.get("enabled") and p not in avoid]
            if not usable:
                return "我的画笔没墨水了，咱们先聊会天吧。"
        except Exception:
            pass  # balance_monitor 不可用时不阻塞生图
    return ""


def painter_stats(cfg: dict | None = None) -> dict:
    cfg = cfg or load_config()
    conn = _db()
    try:
        today = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cost),0) FROM calls WHERE ts>=? AND ok=1",
            (_today0(),)).fetchone()
        month = conn.execute(
            "SELECT COALESCE(SUM(cost),0) FROM calls WHERE ts>=?", (_month0(),)).fetchone()[0]
        by_provider = dict(conn.execute(
            "SELECT provider, COUNT(*) FROM calls WHERE ts>=? AND ok=1 GROUP BY provider",
            (_today0(),)).fetchall())
    finally:
        conn.close()
    return {"today_done": today[0], "today_cost": round(today[1], 4),
            "month_cost": round(month, 4), "by_provider_today": by_provider,
            "daily_cap": cfg["daily_cap"],
            "monthly_cap": cfg["monthly_cost_cap_yuan"]}


def _record(scene: str, provider: str, ok: bool, cost: float, prompt: str) -> None:
    with _db_lock:
        conn = _db()
        try:
            conn.execute("INSERT INTO calls VALUES(?,?,?,?,?,?)",
                         (time.time(), scene, provider, int(ok), cost, (prompt or "")[:200]))
            conn.commit()
        finally:
            conn.close()


def _cooldown_wait(scene: str, cfg: dict) -> str:
    cd = _cooldown_for(cfg, scene)
    if cd <= 0:
        return ""
    with _cd_lock:
        last = _last_paint.get(scene, 0.0)
        now = time.monotonic()
        remain = cd - (now - last)
        if remain > 0:
            return "画笔还没干呢，等 %d 秒。" % int(remain + 0.999)
        _last_paint[scene] = now  # 预占冷却时刻（失败也计，防刷）
    return ""


# ============================================================
# HTTP 工具（零三方依赖，统一不读环境代理，避免公司代理污染）
# ============================================================
def _http_json(url: str, data: dict | None, headers: dict, timeout: int,
               method: str = "POST") -> dict:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        # 把响应体带出来，便于区分参数错误/鉴权错误/模型名错误
        raise RuntimeError("HTTP %s %s" % (e.code, err_body[:600])) from None


def _download(url: str, dest: Path, timeout: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "painter/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _get_key(name: str) -> str:
    try:
        import key_vault
        return (key_vault.get_key(name) or "").strip()
    except Exception:
        return (os.environ.get(name) or "").strip()


# ============================================================
# Provider 1：GLM CogView（同步返回 URL，已验证契约）
# ============================================================
def _gen_glm(prompt: str, cfg: dict) -> str:
    pc = cfg["providers"]["glm"]
    key = _get_key("ZHIPU_API_KEY")
    if not key:
        raise RuntimeError("ZHIPU_API_KEY 未配置")
    url = pc["base_url"].rstrip("/") + "/api/paas/v4/images/generations"
    # cogview-3-flash 不接受 size 参数（传了报 1214 size参数不合法），用默认尺寸
    data = {"model": pc["model"], "prompt": prompt}
    resp = _http_json(url, data,
                      {"Content-Type": "application/json",
                       "Authorization": "Bearer %s" % key},
                      cfg["request_timeout"])
    img_url = ((resp.get("data") or [{}])[0]).get("url") or ""
    if not img_url:
        raise RuntimeError("GLM 返回无图片 url：%s" % str(resp)[:200])
    return img_url


# ============================================================
# Provider 2：阿里万相（异步任务，主通道失败时降级）
# ============================================================
_QWEN_DONE = {"SUCCEEDED"}
_QWEN_FAIL = {"FAILED", "CANCELED", "UNKNOWN"}


def _gen_qwen(prompt: str, cfg: dict) -> str:
    pc = cfg["providers"]["qwen"]
    key = _get_key("DASHSCOPE_API_KEY")
    if not key:
        raise RuntimeError("DASHSCOPE_API_KEY 未配置")
    base = pc["base_url"].rstrip("/")
    # 通用域名 dashscope.aliyuncs.com 走老接口 text2image/image-synthesis
    # （V2 新接口 image-generation/generation 需 workspace 专属域名，通用域名会报 url error）
    create_url = base + "/api/v1/services/aigc/text2image/image-synthesis"
    body = {
        "model": pc["model"],
        "input": {"prompt": prompt},
        "parameters": {"size": cfg.get("default_size", "1024*1024"), "n": 1},
    }
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer %s" % key,
               "X-DashScope-Async": "enable"}
    resp = _http_json(create_url, body, headers, cfg["request_timeout"])
    task_id = ((resp.get("output") or {}).get("task_id")) or ""
    if not task_id:
        raise RuntimeError("万相未返回 task_id：%s" % str(resp)[:200])
    # 2) 轮询
    poll_url = base + "/api/v1/tasks/" + task_id
    deadline = time.monotonic() + cfg["qwen_poll_max_s"]
    while True:
        time.sleep(cfg["qwen_poll_interval"])
        if time.monotonic() > deadline:
            raise RuntimeError("万相生图超时（%ds）" % cfg["qwen_poll_max_s"])
        status_resp = _http_json(poll_url, None,
                                 {"Authorization": "Bearer %s" % key},
                                 cfg["request_timeout"], method="GET")
        out = status_resp.get("output") or {}
        st = out.get("task_status") or ""
        if st in _QWEN_DONE:
            results = out.get("results") or out.get("choices") or []
            img_url = ""
            for it in results:
                img_url = it.get("url") or ""
                if img_url:
                    break
            if not img_url:
                raise RuntimeError("万相成功但无图片 url：%s" % str(status_resp)[:200])
            return img_url
        if st in _QWEN_FAIL:
            raise RuntimeError("万相任务失败：%s" % st)
        # PENDING / RUNNING 继续轮询


# ============================================================
# 对外主接口
# ============================================================
def _output_dir(cfg: dict) -> Path:
    out = cfg.get("output_dir", "data/paint_output")
    p = Path(out)
    return p if p.is_absolute() else (ROOT / p)


def generate_image_sync(prompt: str, style: str = "",
                        scene: str = "group") -> tuple[str | None, str]:
    """同步生图。返回 (本地文件路径|None, 给用户的文案)。

    scene: group / live / dream —— 决定冷却时长与是否占互动配额。
    """
    cfg = load_config()
    prompt = (prompt or "").strip()
    if not prompt:
        return None, "画啥？你倒是说啊。"

    # 1) 敏感词前置
    ok, reason = check_sensitive(prompt, cfg)
    if not ok:
        return None, reason

    # 2) 配额 / 余额
    if cfg["enabled"]:
        low = ink_low(scene, cfg)
        if low:
            return None, low
        cd_msg = _cooldown_wait(scene, cfg)
        if cd_msg:
            return None, cd_msg

    # 3) 组装 prompt（加风格后缀）
    full_prompt = ("%s, %s" % (prompt, style)).strip(" ,") if style else prompt

    # 4) 主→备 双通道调用
    order = [cfg.get("primary", "glm")]
    for p in cfg["providers"]:
        if p not in order and cfg["providers"][p].get("enabled"):
            order.append(p)

    last_err = ""
    for provider in order:
        pc = cfg["providers"].get(provider) or {}
        if not pc.get("enabled"):
            continue
        try:
            if provider == "glm":
                img_url = _gen_glm(full_prompt, cfg)
            elif provider == "qwen":
                img_url = _gen_qwen(full_prompt, cfg)
            else:
                continue
        except Exception as e:
            last_err = "%s: %s" % (provider, e)
            print("  [painter] %s 失败 → %s" % (provider, e))
            continue  # 切下一个 provider

        # 5) 下载落盘
        try:
            out_dir = _output_dir(cfg)
            dest = out_dir / ("%d_%s.jpg" % (int(time.time()), provider))
            _download(img_url, dest, cfg["download_timeout"])
        except Exception as e:
            last_err = "%s 下载失败: %s" % (provider, e)
            print("  [painter] %s" % last_err)
            continue

        # 6) 成功记账
        _record(scene, provider, True, float(pc.get("cost_per_image", 0.0)), prompt)
        return str(dest), "画好啦！"

    # 全部失败
    _record(scene, "none", False, 0.0, prompt)
    return None, "网络问题，画布裂开了。（%s）" % last_err


async def generate_image_async(prompt: str, style: str = "",
                               scene: str = "group") -> tuple[str | None, str]:
    """异步包装（供 asyncio 环境调用）。"""
    return await asyncio.to_thread(generate_image_sync, prompt, style, scene)


def publish_to_obs(local_path: str, obs_path: str | None = None) -> bool:
    """覆盖 OBS 图片源文件，画面瞬间刷新。OBS 需勾选「文件更改时重新加载」。

    用 copy2 保留元信息；目标目录不存在则创建。任何失败返回 False，不抛异常。
    """
    cfg = load_config()
    target = Path(obs_path or cfg.get("obs_image_path", ""))
    src = Path(local_path)
    if not target or not src.is_file():
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(target))
        return True
    except Exception as e:
        print("  [painter] OBS 刷新失败: %s" % e)
        return False


# ============================================================
# CLI
# ============================================================
def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "gen" and len(argv) >= 3:
        scene = "group"
        style = "anime, high quality"
        rest = argv[2:]
        if "--scene" in rest:
            i = rest.index("--scene")
            scene = rest[i + 1]
            rest = rest[:i] + rest[i + 2:]
        if "--style" in rest:
            i = rest.index("--style")
            style = rest[i + 1]
            rest = rest[:i] + rest[i + 2:]
        prompt = " ".join(rest)
        print("🎨 prompt: %s" % prompt)
        print("    scene: %s, style: %s" % (scene, style))
        t0 = time.monotonic()
        path, msg = generate_image_sync(prompt, style=style, scene=scene)
        print("    耗时: %.1fs" % (time.monotonic() - t0))
        if path:
            print("✅ 落盘: %s" % path)
        else:
            print("❌ %s" % msg)
            return 2
        return 0
    if cmd == "stats":
        print(json.dumps(painter_stats(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "check" and len(argv) >= 3:
        cfg = load_config()
        prompt = " ".join(argv[2:])
        ok, reason = check_sensitive(prompt, cfg)
        print("敏感词: %s%s" % ("放行" if ok else "拦截 → " + reason, ""))
        low = ink_low("group", cfg)
        print("墨水: %s" % ("充足" if not low else "不足 → " + low))
        print(json.dumps(painter_stats(cfg), ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
