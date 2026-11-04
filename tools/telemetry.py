# -*- coding: utf-8 -*-
"""小鲸鱼 · 硬件级赛博生命体征遥测（零硬依赖 + 优雅降级）

采集本机 GPU / CPU / 网络状态，写共享状态 data/telemetry_state.json，
供：控制台遥测卡片（GET /api/telemetry）、GPU 过热主动说话、
游戏破防甩锅改写（网络飙延迟 → "破网 460"）。

设计原则（沿用项目约定）：零硬依赖、懒加载、优雅降级、doctor 报缺啥。
  - nvidia-smi 缺失 → gpu.available=false，不崩，doctor 报缺。
  - psutil 缺失 → cpu/net 不采集，doctor 报缺。
  - CPU 温度在 Windows 下 psutil 取不到（需 wmi / LibreHardwareMonitor），
    如实只报 cpu.percent，不报温度，doctor 明确说明。
  - Ollama 不依赖（纯本地采集）。

被调用的地方：
  - console.py 一键自检 → telemetry.doctor_check()
  - console.py 启动 → telemetry.run_loop(...) 后台线程
  - tools/game_context.py prompt_block() → 读 telemetry_state.json 改写破防文案

CLI：
    python tools/telemetry.py collect   # 采集一次并打印
    python tools/telemetry.py doctor    # 体检：报缺啥
    python tools/telemetry.py loop      # 前台跑采集循环（测试用）
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

CONFIG_FILE = TOOLS_DIR / "telemetry_config.json"
STATE_FILE = ROOT / "data" / "telemetry_state.json"

CREATE_NO_WINDOW = 0x08000000

DEFAULT_CONFIG = {
    "enabled": True,
    "gpu_temp_threshold": 80,        # GPU 温度超此值（℃）持续 duration 秒 → 触发提醒
    "gpu_temp_duration": 30,         # 持续秒数
    "ping_threshold": 300,           # 网络延迟超此值（ms）→ 破防理由改写成"破网 460"
    "cpu_percent_threshold": 90,     # CPU 负载超此值（%）→ 标记（仅展示，本轮不主动说话）
    "collect_interval": 5,           # 采集间隔（秒）
    "alert_cooldown": 1800,          # 过热播报防刷间隔（秒，默认 30 分钟）
    "ping_target": "223.5.5.5",      # ping 目标（公网 DNS，代理网络健康度）
}

# 懒加载 psutil（缺了只是不采集 cpu/net，绝不崩）
try:
    import psutil  # type: ignore
except Exception:  # noqa: BLE001
    psutil = None

_io_lock = threading.Lock()
_prev_net = {"sent": 0, "recv": 0, "ts": 0.0}
_overheat_since = {"gpu": 0.0}
_last_alert_ts = {"gpu": 0.0}


# ============================================================
# 配置
# ============================================================
def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        if CONFIG_FILE.is_file():
            user = json.loads(CONFIG_FILE.read_text("utf-8"))
            if isinstance(user, dict):
                cfg.update(user)
    except Exception:  # noqa: BLE001
        pass
    return cfg


# ============================================================
# 采集
# ============================================================
def nvidia_smi_available() -> bool:
    return shutil.which("nvidia-smi") is not None


def _collect_gpu() -> dict:
    """nvidia-smi 取 GPU 温度 / 显存。失败返回 available=false。"""
    out = {"available": False, "temp": None, "mem_used": None,
           "mem_total": None, "name": None}
    if not nvidia_smi_available():
        return out
    try:
        p = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=temperature.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, timeout=8, creationflags=CREATE_NO_WINDOW)
        line = (p.stdout or b"").decode("utf-8", "replace").strip()
        # 例："49, 98, 4096"
        parts = [x.strip() for x in line.split(",")]
        if len(parts) >= 3 and parts[0].isdigit():
            out["temp"] = int(parts[0])
            out["mem_used"] = int(parts[1])
            out["mem_total"] = int(parts[2])
            out["available"] = True
    except Exception:  # noqa: BLE001
        pass
    # 名称（可选，失败不影响主流程）
    try:
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, timeout=8, creationflags=CREATE_NO_WINDOW)
        name = (p.stdout or b"").decode("utf-8", "replace").strip()
        if name:
            out["name"] = name
    except Exception:  # noqa: BLE001
        pass
    return out


def _collect_cpu() -> dict:
    """CPU 负载（psutil）。温度在 Windows 取不到，如实标记 temp_available=false。"""
    out = {"available": psutil is not None, "percent": None,
           "temp_available": False, "temp": None}
    if psutil is None:
        return out
    try:
        # interval=0.3 阻塞 300ms 取真实负载；独立线程不影响 console
        out["percent"] = round(float(psutil.cpu_percent(interval=0.3)), 1)
    except Exception:  # noqa: BLE001
        pass
    # 注意：Windows 下 psutil 无 sensors_temperatures()，不尝试，避免误导
    return out


def _ping_ms(target: str, timeout_ms: int = 800) -> float | None:
    """ping 一次取延迟（ms）；失败/超时返回 None。兼容中英文 ping 输出。"""
    try:
        p = subprocess.run(
            ["ping", "-n", "1", "-w", str(timeout_ms), target],
            capture_output=True, timeout=timeout_ms / 1000 + 1.5,
            creationflags=CREATE_NO_WINDOW)
        text = (p.stdout or b"").decode("gbk", "replace")
        # 中文："时间=19ms"；英文："time=19ms"
        m = re.search(r"(?:时间|time)\s*[=<]\s*(\d+)\s*ms", text, re.IGNORECASE)
        if m:
            return float(m.group(1))
    except Exception:  # noqa: BLE001
        pass
    return None


def _collect_net(cfg: dict) -> dict:
    """网络吞吐（KB/s）+ 延迟（ms）。"""
    out = {"sent_kbps": 0.0, "recv_kbps": 0.0, "latency_ms": None,
           "ping_target": cfg.get("ping_target", "223.5.5.5")}
    if psutil is not None:
        try:
            c = psutil.net_io_counters()
            now = time.time()
            with _io_lock:
                prev = _prev_net
                if prev["ts"] > 0:
                    dt = max(0.001, now - prev["ts"])
                    out["sent_kbps"] = round((c.bytes_sent - prev["sent"]) / dt / 1024, 1)
                    out["recv_kbps"] = round((c.bytes_recv - prev["recv"]) / dt / 1024, 1)
                _prev_net["sent"] = c.bytes_sent
                _prev_net["recv"] = c.bytes_recv
                _prev_net["ts"] = now
        except Exception:  # noqa: BLE001
            pass
    out["latency_ms"] = _ping_ms(out["ping_target"])
    return out


def collect(cfg: dict | None = None) -> dict:
    """采集一次，写 data/telemetry_state.json，返回 state dict。永不抛异常。"""
    cfg = cfg or load_config()
    state = {
        "ts": time.time(),
        "gpu": _collect_gpu(),
        "cpu": _collect_cpu(),
        "net": _collect_net(cfg),
        "triggers": {"gpu_overheat": False, "high_latency": False,
                     "cpu_high": False},
    }
    state["triggers"] = _eval_triggers(state, cfg, time.time())["triggers"]
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _io_lock:
            STATE_FILE.write_text(
                json.dumps(state, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass
    return state


def _eval_triggers(state: dict, cfg: dict, now: float) -> dict:
    """根据阈值计算触发状态 + 持续计时。返回 {'triggers':..., 'fired':[...]}。
    fired = 本次新触发（过持续时长且过防刷间隔）的事件名，供调用方播报。"""
    trig = {"gpu_overheat": False, "high_latency": False, "cpu_high": False}
    fired: list[str] = []
    # GPU 过热
    g = state.get("gpu") or {}
    if g.get("available") and isinstance(g.get("temp"), (int, float)):
        if g["temp"] >= cfg.get("gpu_temp_threshold", 80):
            trig["gpu_overheat"] = True
            if _overheat_since["gpu"] == 0.0:
                _overheat_since["gpu"] = now
            elif now - _overheat_since["gpu"] >= cfg.get("gpu_temp_duration", 30):
                if now - _last_alert_ts["gpu"] >= cfg.get("alert_cooldown", 1800):
                    fired.append("gpu_overheat")
                    _last_alert_ts["gpu"] = now
        else:
            _overheat_since["gpu"] = 0.0
    # 网络高延迟
    lat = (state.get("net") or {}).get("latency_ms")
    if isinstance(lat, (int, float)) and lat >= cfg.get("ping_threshold", 300):
        trig["high_latency"] = True
    # CPU 高负载（仅标记展示，本轮不主动说话）
    cpu = state.get("cpu") or {}
    if isinstance(cpu.get("percent"), (int, float)) and \
            cpu["percent"] >= cfg.get("cpu_percent_threshold", 90):
        trig["cpu_high"] = True
    return {"triggers": trig, "fired": fired}


def latest() -> dict:
    """读最新遥测状态（供 /api/telemetry 端点）。文件缺失返回空骨架。"""
    try:
        if STATE_FILE.is_file():
            with _io_lock:
                data = json.loads(STATE_FILE.read_text("utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:  # noqa: BLE001
        pass
    return {"ts": 0, "gpu": {"available": False}, "cpu": {"available": False},
            "net": {}, "triggers": {}}


# ============================================================
# 后台循环
# ============================================================
def run_loop(cfg: dict | None = None, on_event=None,
             stop: threading.Event | None = None) -> None:
    """后台采集循环。on_event(state, fired) 在有新触发时回调（best-effort）。"""
    cfg = cfg or load_config()
    interval = max(1, int(cfg.get("collect_interval", 5)))
    while stop is None or not stop.is_set():
        try:
            if cfg.get("enabled", True):
                state = collect(cfg)
                fired = state.get("fired") or _eval_triggers(
                    state, cfg, state.get("ts", time.time()))["fired"]
                if fired and on_event:
                    try:
                        on_event(state, fired)
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as e:  # noqa: BLE001  循环自身绝不能崩
            try:
                print("[telemetry] loop error:", type(e).__name__, file=sys.stderr)
            except Exception:  # noqa: BLE001
                pass
        # 小段睡眠，便于及时响应 stop
        for _ in range(interval * 2):
            if stop is not None and stop.is_set():
                break
            time.sleep(0.5)


# ============================================================
# doctor 自检（供 console 一键自检调用）
# ============================================================
def doctor_check() -> list[dict]:
    """返回 [{'name','ok','detail'}, ...]，如实报缺啥，不谎报可运行。"""
    items: list[dict] = []
    nv = nvidia_smi_available()
    items.append({
        "name": "GPU 遥测（nvidia-smi）",
        "ok": nv,
        "detail": "可用：能采集 GPU 温度 / 显存" if nv
        else "不可用：未找到 nvidia-smi，GPU 温度 / 显存将不采集（安装 NVIDIA 驱动后恢复）",
    })
    items.append({
        "name": "系统负载（psutil）",
        "ok": psutil is not None,
        "detail": "可用：能采集 CPU 负载 / 网络吞吐" if psutil
        else "不可用：pip 安装 psutil 后恢复（本轮已装，若仍报缺请检查 venv）",
    })
    # CPU 温度在 Windows 取不到：诚实说明，ok=True 因为不是故障
    items.append({
        "name": "CPU 温度",
        "ok": True,
        "detail": "Windows 下 psutil 取不到 CPU 温度（需 wmi / LibreHardwareMonitor），"
                  "仅报 CPU 负载；GPU 温度正常采集。不影响过热提醒（看 GPU 温度）。",
    })
    return items


# ============================================================
# CLI
# ============================================================
def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "collect"
    if cmd == "collect":
        print(json.dumps(collect(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "doctor":
        for it in doctor_check():
            flag = "✓" if it["ok"] else "✗"
            print("%s %s：%s" % (flag, it["name"], it["detail"]))
        return 0
    if cmd == "loop":
        stop = threading.Event()
        try:
            def _show(state, fired):
                print("[telemetry] fired:", fired, "temp=",
                      (state.get("gpu") or {}).get("temp"))
            run_loop(on_event=_show, stop=stop)
        except KeyboardInterrupt:
            stop.set()
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
