# -*- coding: utf-8 -*-
"""小鲸鱼生态 · 统一控制台
双击「控制台.cmd」启动，浏览器打开 http://127.0.0.1:8900
仅用标准库，仅监听本机回环。
"""
import json, os, re, secrets, socket, subprocess, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
PORT = 8900
TOKEN = secrets.token_urlsafe(16)  # 一次性访问令牌：启动时打印在 URL 里，防 CSRF
sys.path.insert(0, str(ROOT / "tools"))
try:
    import key_vault
except Exception:
    key_vault = None
try:
    import alert
except Exception:
    alert = None
try:
    import state_engine
except Exception:
    state_engine = None
try:
    import context_engine
except Exception:
    context_engine = None
try:
    import daily_report
except Exception:
    daily_report = None
try:
    import memory_bus
except Exception:
    memory_bus = None
try:
    import screen_buddy
except Exception:
    screen_buddy = None
try:
    import relations
except Exception:
    relations = None
try:
    import cost_sandbox
except Exception:
    cost_sandbox = None
try:
    import privacy_dashboard
except Exception:
    privacy_dashboard = None
try:
    import persona_judge
except Exception:
    persona_judge = None
try:
    import content_pipeline
except Exception:
    content_pipeline = None
try:
    import timeline
except Exception:
    timeline = None
try:
    import persona_snapshot
except Exception:
    persona_snapshot = None
try:
    import persona_distill
except Exception:
    persona_distill = None
# P2/P3 功能模块（观测/陪伴类，挂了不影响控制台主线）
for _m in ("goals", "time_capsule", "memory_review", "calendar_watch", "care",
           "allowance", "runbook", "silent_day", "guard", "growth",
           "fingerprint", "consistency", "persona_override", "voice_mail",
           "sleep_story", "group_summary", "desk_tidy", "audience",
           "call_context", "persona_switch"):
    try:
        globals()[_m] = __import__(_m)
    except Exception:
        globals()[_m] = None
OHWHALE = ROOT / "ohwhale-deploy"
DSH = ROOT / "dsh"
TULPA = ROOT / "Tulpa" / "Tulpa"
SNOWLUMA = ROOT / "SnowLuma"
PET = ROOT / "dsh-pet"
PET_EXE = PET / "dsh-pet-standalone-webm-chat.exe"
PET_CFG = Path(os.environ.get("APPDATA") or str(ROOT)) / "dsh-pet-standalone-webm-chat" / "config.json"
PET_MODELS_DIR = PET / "_internal" / "assets" / "characters"

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CREATE_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)

ALLOWED_HOSTS = ["127.0.0.1:", "localhost:"]  # Host 白名单；开 LAN 后追加局域网 IP


def lan_ip():
    """本机局域网 IP（判白名单/打印手机面板地址用），失败返回空串。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))  # 不真发包，只为拿到出口网卡 IP
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return ""

# ---------- 基础工具 ----------

def port_pid(port):
    """返回监听该端口的 PID，无则 None。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             encoding="gbk", errors="replace",
                             timeout=10, creationflags=CREATE_NO_WINDOW).stdout
    except Exception:
        return None
    for line in (out or "").splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(":%d" % port):
            try:
                return int(parts[4])
            except ValueError:
                pass
    return None


def kill_pid(pid):
    subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True,
                   creationflags=CREATE_NO_WINDOW)


_proc_cache = {"t": 0, "data": []}

def process_list():
    """带 3 秒缓存的进程清单（仅关心的几个）。"""
    if time.time() - _proc_cache["t"] < 3:
        return _proc_cache["data"]
    names = "','".join(["Tulpa.exe", "node.exe", "NapCatWinBootMain.exe",
                        "dsh-pet-standalone-webm-chat.exe"])
    cmd = ("Get-CimInstance Win32_Process -Filter \"Name in ('%s')\" "
           "| Select-Object ProcessId,Name,ExecutablePath "
           "| ConvertTo-Json -Compress" % names)
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                             capture_output=True, encoding="gbk", errors="replace",
                             timeout=20, creationflags=CREATE_NO_WINDOW).stdout.strip()
        data = json.loads(out) if out else []
        if isinstance(data, dict):
            data = [data]
    except Exception:
        data = []
    _proc_cache.update(t=time.time(), data=data)
    return data


def find_proc(exe_name, path_hint=""):
    hint = path_hint.replace("/", "\\").lower()
    for p in process_list():
        if p.get("Name") == exe_name:
            ep = (p.get("ExecutablePath") or "").lower()
            if not hint or hint in ep:
                return p.get("ProcessId")
    return None


def spawn(argv, cwd, new_console=False):
    flags = CREATE_NEW_CONSOLE if CREATE_NEW_CONSOLE and flags_visible(argv) else CREATE_NO_WINDOW
    env = dict(os.environ)
    if key_vault:  # DPAPI 保险库密钥解密后注入子进程环境，不经过明文文件
        try:
            env.update(key_vault.all_keys())
        except Exception:
            pass
    subprocess.Popen(argv, cwd=str(cwd), creationflags=flags, env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def flags_visible(argv):
    # NapCat 扫码等场景需要可见控制台窗口
    return any(str(a).endswith((".cmd", ".bat")) for a in argv)

# ---------- 服务定义 ----------

def svc_status():
    svcs = []

    pid = port_pid(3080)
    svcs.append({"id": "dsh", "name": "DSH 助手", "running": pid is not None,
                 "detail": "端口 3080" + (" (PID %d)" % pid if pid else " 未监听"),
                 "panel": "http://127.0.0.1:3080"})

    tts = port_pid(9880) is not None
    ab = port_pid(6185) is not None
    ll = find_proc("NapCatWinBootMain.exe") is not None
    up = sum([tts, ab, ll])
    svcs.append({"id": "ohwhale", "name": "哦鲸鲸全家桶",
                 "running": up == 3, "partial": 0 < up < 3,
                 "detail": "TTS:9880 %s · AstrBot:6185 %s · QQ(NapCat) %s" % (
                     "✓" if tts else "✗", "✓" if ab else "✗", "✓" if ll else "✗"),
                 "panel": "http://127.0.0.1:6185"})

    pid = find_proc("Tulpa.exe", "Tulpa")
    svcs.append({"id": "tulpa", "name": "Tulpa QQ 机器人", "running": pid is not None,
                 "detail": ("PID %d" % pid) if pid else "未运行", "panel": ""})

    pid = find_proc("node.exe", "SnowLuma") or port_pid(5099)
    svcs.append({"id": "snowluma", "name": "SnowLuma 桥接", "running": pid is not None,
                 "detail": ("PID %d" % pid) if pid else "未运行", "panel": "http://127.0.0.1:5099"})

    pid = find_proc("dsh-pet-standalone-webm-chat.exe")
    installed = PET_EXE.is_file()
    cur_model = pet_current_model()
    model_name = {m["id"]: m["name"] for m in pet_models()}.get(cur_model, cur_model)
    svcs.append({"id": "pet", "name": "桌宠（%s）" % (model_name or "未配置"), "running": pid is not None,
                 "optional": True, "installed": installed,
                 "detail": ("未安装（可选）" if not installed else
                            ("PID %d" % pid if pid else "未运行")), "panel": ""})
    for s in svcs:
        s["ready"] = svc_ready(s["id"])
        s["restarts"] = _restart_count(s["id"])
    return svcs


def svc_action(sid, action):
    if sid == "dsh":
        if action == "start":
            spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                   "-File", str(DSH / "start-dsh.ps1")], DSH)
            return True, "DSH 启动中（约 10 秒后刷新看状态）"
        pid = port_pid(3080)
        if pid:
            kill_pid(pid)
            return True, "DSH 已停止"
        return False, "DSH 未在运行"

    if sid == "ohwhale":
        py = OHWHALE / ".venv" / "Scripts" / "python.exe"
        if not py.is_file():
            py = OHWHALE / "runtime" / "Python312" / "python" / "python.exe"
        if not py.is_file():
            return False, "找不到 ohwhale Python（.venv 或 runtime/Python312）"
        act = "start" if action == "start" else "stop"
        spawn([str(py), "-m", "ohwhale.deploy", act], OHWHALE, new_console=True)
        return True, ("哦鲸鲸启动中（TTS→AstrBot→QQ，约 30 秒）" if act == "start"
                      else "哦鲸鲸停止指令已发出")

    if sid == "tulpa":
        exe = TULPA / "Tulpa.exe"
        if action == "start":
            pid = find_proc("Tulpa.exe", "Tulpa")
            if pid:
                return True, "Tulpa 已在运行（PID %d），跳过重复启动" % pid
            if not exe.is_file():
                return False, "找不到 Tulpa.exe"
            spawn([str(exe)], TULPA)
            return True, "Tulpa 启动中"
        pid = find_proc("Tulpa.exe", "Tulpa")
        if pid:
            kill_pid(pid)
            return True, "Tulpa 已停止"
        return False, "Tulpa 未在运行"

    if sid == "snowluma":
        pid = find_proc("node.exe", "SnowLuma") or port_pid(5099)
        if action == "start":
            if pid:
                return True, "SnowLuma 已在运行（PID %d），跳过重复启动" % pid
            node = SNOWLUMA / "node.exe"
            if not node.is_file():
                return False, "找不到 SnowLuma/node.exe"
            spawn([str(node), "index.mjs"], SNOWLUMA)
            return True, "SnowLuma 启动中"
        if pid:
            kill_pid(pid)
            return True, "SnowLuma 已停止"
        return False, "SnowLuma 未在运行"

    if sid == "pet":
        exe = PET / "dsh-pet-standalone-webm-chat.exe"
        if action == "start":
            pid = find_proc("dsh-pet-standalone-webm-chat.exe")
            if pid:
                return True, "桌宠已在运行（PID %d），跳过重复启动" % pid
            if not exe.is_file():
                return False, "桌宠未安装（可选组件，不影响其他服务）"
            spawn([str(exe)], PET)
            return True, "桌宠启动中"
        pid = find_proc("dsh-pet-standalone-webm-chat.exe")
        if pid:
            kill_pid(pid)
            return True, "桌宠已停止"
        return False, "桌宠未在运行"

    return False, "未知服务"

# ---------- 形象总控（人格卡 × 桌宠模型 联动） ----------

def pet_current_model():
    """桌宠当前模型（读 %APPDATA% 下桌宠配置的 character 字段）。"""
    try:
        return str(json.loads(PET_CFG.read_text("utf-8")).get("character") or "")
    except Exception:
        return ""


def pet_models():
    """可用桌宠模型：characters/ 下的子目录，显示名取桌宠配置的 character_aliases。"""
    cur = pet_current_model()
    aliases = {}
    try:
        aliases = json.loads(PET_CFG.read_text("utf-8")).get("character_aliases") or {}
    except Exception:
        pass
    out = []
    if PET_MODELS_DIR.is_dir():
        for d in sorted(PET_MODELS_DIR.iterdir()):
            if d.is_dir():
                out.append({"id": d.name, "name": aliases.get(d.name) or d.name,
                            "is_active": d.name == cur})
    return out


def pet_set_model(model):
    """改桌宠配置的 character 字段（其余字段原样保留）。返回是否有改动。"""
    cfg = json.loads(PET_CFG.read_text("utf-8"))
    if cfg.get("character") == model:
        return False
    cfg["character"] = model
    PET_CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    return True


def persona_pet_map(char_id):
    """角色人格卡里登记的桌宠模型（persona.json 的 pet.character）。"""
    try:
        p = json.loads((ROOT / "config" / "personas" / char_id
                        / "persona.json").read_text("utf-8"))
        return str((p.get("pet") or {}).get("character") or "")
    except Exception:
        return ""

# ---------- 就绪探针 / 依赖拓扑 / 健康守护（P0-2） ----------

HEALTH_DIR = ROOT / "logs"
HEALTH_LOG = HEALTH_DIR / "console_health.jsonl"

# 依赖图：默认内置；config/master.json 的 services 段可声明式覆盖
def _load_topo():
    try:
        cfg = json.loads((ROOT / "config" / "master.json").read_text("utf-8"))
        svcs = cfg.get("services")
        if isinstance(svcs, dict):
            svcs = svcs.get("list")
        if isinstance(svcs, list) and svcs:
            return {s["id"]: list(s.get("deps", [])) for s in svcs}
    except Exception:
        pass
    return {"snowluma": [], "dsh": [], "ohwhale": [], "tulpa": ["snowluma"],
            "pet": ["dsh"]}


DEPS = _load_topo()
WATCHED = ("dsh", "ohwhale", "tulpa")  # 守护范围：至少覆盖 DSH、Tulpa、AstrBot(哦鲸鲸)

HEALTH = {"enabled": False, "events": [], "thread": None}
RESTARTS = {}      # sid -> [重启时间戳]
MANUAL_STOP = {}   # sid -> ts，控制台手动停止后不自动拉起
_seen_ready = {}   # sid -> bool，守护期间见过它就绪（从未起来过的不算崩溃）


def http_ok(url, timeout=1.5):
    """业务探测：HTTP 有响应（<500）才算就绪，不只看端口。
    401/403 说明服务进程与路由都活着（DSH 首页必须带 token），同样算就绪。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "console-probe"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code in (401, 403)   # 鉴权页也算活着；404/500 仍判失败
    except Exception:
        return False


_ready_cache = {"t": 0.0, "data": {}}

def svc_ready(sid):
    """就绪探针（8 秒缓存）：进程 + 端口 + 业务响应。"""
    now = time.time()
    if now - _ready_cache["t"] >= 8:
        _ready_cache["t"] = now
        _ready_cache["data"] = {
            "dsh": port_pid(3080) is not None and http_ok("http://127.0.0.1:3080/"),
            "ohwhale": (http_ok("http://127.0.0.1:9880/docs") and
                        http_ok("http://127.0.0.1:6185/") and
                        find_proc("NapCatWinBootMain.exe") is not None),
            "tulpa": find_proc("Tulpa.exe", "Tulpa") is not None,
            "snowluma": (find_proc("node.exe", "SnowLuma") is not None
                         or port_pid(5099) is not None),
            "pet": find_proc("dsh-pet-standalone-webm-chat.exe") is not None,
        }
    return _ready_cache["data"].get(sid, False)


def topo_order():
    order, done, pending = [], set(), list(DEPS)
    while pending:
        progressed = False
        for sid in list(pending):
            if all(d in done for d in DEPS[sid]):
                order.append(sid)
                done.add(sid)
                pending.remove(sid)
                progressed = True
        if not progressed:
            order.extend(pending)
            break
    return order


def health_log(event, **fields):
    msg = fields.get("msg", "")
    try:
        HEALTH_DIR.mkdir(exist_ok=True)
        with open(HEALTH_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), "event": event, **fields},
                               ensure_ascii=False) + "\n")
    except Exception:
        pass
    HEALTH["events"].insert(0, {"time": time.strftime("%H:%M:%S"),
                                "event": event, "msg": msg})
    del HEALTH["events"][50:]
    # 无人值守告警外发：崩溃与重启触顶不能只亮红灯
    if event in ("crash", "restart_cap") and alert:
        try:
            alert.send("小鲸鱼服务异常", "[%s] %s" % (event, msg),
                       key="%s:%s" % (event, fields.get("service", "")))
        except Exception:
            pass


def _restart_count(sid, window=600):
    now = time.time()
    RESTARTS[sid] = [t for t in RESTARTS.get(sid, []) if now - t < window]
    return len(RESTARTS[sid])


STARTALL = {"running": False, "log": []}

def start_all(dry=False):
    """按依赖拓扑序拉起全部服务；前置未就绪则阻塞其依赖并提示。
    dry=True 只预检：打印拓扑序与各服务当前状态，不启动任何进程。"""
    if STARTALL["running"]:
        return False, "全部启动正在执行中"
    STARTALL.update(running=True, log=[])

    def work():
        log = STARTALL["log"]
        if dry:
            log.append("—— 预检（dry-run）：只列计划，不启动 ——")
            for sid in topo_order():
                deps = "、".join(DEPS[sid]) or "无"
                state = "已就绪" if svc_ready(sid) else "未运行"
                log.append("· %s｜依赖: %s｜当前: %s" % (sid, deps, state))
            log.append("—— 预检结束。确认无误后点「全部启动」 ——")
            STARTALL["running"] = False
            return
        for sid in topo_order():
            unready = [d for d in DEPS[sid] if not svc_ready(d)]
            if unready:
                log.append("⊘ %s 被阻塞：前置 %s 未就绪" % (sid, "、".join(unready)))
                health_log("blocked", service=sid, msg="前置未就绪: %s" % ",".join(unready))
                continue
            if svc_ready(sid):
                log.append("✓ %s 已就绪，跳过" % sid)
                continue
            ok, msg = svc_action(sid, "start")
            MANUAL_STOP.pop(sid, None)
            log.append(("▶ " if ok else "✗ ") + msg)
            if not ok:
                continue
            deadline = time.time() + 120
            while time.time() < deadline:
                if svc_ready(sid):
                    log.append("✓ %s 就绪" % sid)
                    break
                time.sleep(3)
            else:
                log.append("✗ %s 120 秒内未就绪，依赖它的服务将被阻塞" % sid)
                health_log("start_timeout", service=sid, msg="120s 未就绪")
        STARTALL["running"] = False
        log.append("—— 全部启动流程结束 ——")

    threading.Thread(target=work, daemon=True).start()
    if dry:
        return True, "预检中（不启动任何进程）"
    return True, "已按依赖拓扑顺序启动（snowluma/dsh/ohwhale → tulpa/pet）"


def stop_all():
    for sid in reversed(topo_order()):
        svc_action(sid, "stop")
        MANUAL_STOP[sid] = time.time()
    return True, "全部停止指令已发出（已标记手动停止，守护不会拉起）"


def _health_loop():
    """健康检查：崩溃 → 写日志告警 → 退避重启（10s→80s），10 分钟最多 5 次。"""
    while HEALTH["enabled"]:
        for sid in WATCHED:
            try:
                ready = svc_ready(sid)
                if sid in MANUAL_STOP and time.time() - MANUAL_STOP[sid] < 3600:
                    _seen_ready[sid] = ready
                    continue
                if ready:
                    _seen_ready[sid] = True
                    continue
                if not _seen_ready.get(sid):
                    continue  # 从未就绪过（可能没装完），不视为崩溃
                n = _restart_count(sid)
                if n >= 5:
                    health_log("restart_cap", service=sid,
                               msg="10 分钟内已重启 5 次，停止自动拉起，请人工排查")
                    _seen_ready[sid] = False
                    continue
                delay = min(80, 10 * (2 ** min(n, 3)))
                health_log("crash", service=sid,
                           msg="进程消失，%.0f 秒后自动重启（第 %d 次）" % (delay, n + 1))
                time.sleep(delay)
                if svc_ready(sid) or sid in MANUAL_STOP:
                    continue
                ok, msg = svc_action(sid, "start")
                RESTARTS.setdefault(sid, []).append(time.time())
                health_log("restart", service=sid, msg=msg)
            except Exception as e:
                health_log("watchdog_error", service=sid, msg=type(e).__name__)
        for _ in range(15):
            if not HEALTH["enabled"]:
                break
            time.sleep(1)


def set_watchdog(enabled):
    HEALTH["enabled"] = bool(enabled)
    t = HEALTH.get("thread")
    if enabled and not (t and t.is_alive()):
        HEALTH["thread"] = threading.Thread(target=_health_loop, daemon=True)
        HEALTH["thread"].start()
    return True, "健康守护已%s" % ("开启（崩溃自动重启：退避 + 5 次上限）" if enabled else "关闭")

# ---------- 定时任务 ----------

CRON_FILE = DSH / "home" / "cron-jobs.json"

def cron_list():
    try:
        jobs = json.loads(CRON_FILE.read_text("utf-8"))
    except Exception as e:
        return {"ok": False, "msg": "读取失败: %s" % e, "jobs": []}
    out = []
    for j in jobs:
        sch = j.get("schedule", "")
        # 兼容 cron 表达式字符串 "分 时 * * *" 与字典两种格式
        if isinstance(sch, dict):
            hh, mm = sch.get("hour", 0), sch.get("minute", 0)
        else:
            parts = str(sch).split()
            mm, hh = (parts + ["0", "0"])[:2] if len(parts) >= 2 else ("0", "0")
        try:
            time_str = "%02d:%02d" % (int(hh), int(mm))
        except (TypeError, ValueError):
            time_str = str(sch)
        out.append({"id": j.get("id"), "label": j.get("name") or j.get("label") or j.get("id"),
                    "time": time_str,
                    "kind": "cron", "enabled": bool(j.get("enabled")),
                    "session": j.get("sessionTarget"),
                    "lastRun": j.get("lastRunStatus") or "-",
                    "runs": j.get("runCount", 0)})
    return {"ok": True, "jobs": out}


def cron_set(job_id, enabled):
    jobs = json.loads(CRON_FILE.read_text("utf-8"))
    hit = False
    for j in jobs:
        if j.get("id") == job_id:
            j["enabled"] = bool(enabled)
            hit = True
    if not hit:
        return False, "任务不存在"
    CRON_FILE.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), "utf-8")
    return True, "已%s（DSH 下次读配置生效）" % ("启用" if enabled else "停用")

# ---------- 密钥 ----------

def env_get(path, key):
    try:
        for line in path.read_text("utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def env_set(path, key, value):
    lines = path.read_text("utf-8").splitlines() if path.exists() else []
    out, found = [], False
    for line in lines:
        if line.startswith(key + "="):
            out.append("%s=%s" % (key, value))
            found = True
        else:
            out.append(line)
    if not found:
        out.append("%s=%s" % (key, value))
    path.write_text("\n".join(out) + "\n", "utf-8")

KEY_DEFS = [
    ("DEEPSEEK_API_KEY", "DeepSeek 密钥", True),
    ("ZHIPU_API_KEY", "GLM 智谱密钥", False),
    ("DASHSCOPE_API_KEY", "百炼 DashScope 密钥", False),
    ("ASTRBOT_DASHBOARD_PASSWORD", "AstrBot 面板密码", False),
    ("ONEBOT_ACCESS_TOKEN", "OneBot 访问令牌", False),
]

def qq_master_get():
    """读 ohwhale config.json 的 master.qq（缺文件/字段返回空串）。"""
    try:
        return str(json.loads((OHWHALE / "config.json").read_text("utf-8-sig"))
                   .get("master", {}).get("qq", "") or "")
    except Exception:
        return ""


def qq_master_set(qq):
    """写主人 QQ 到 ohwhale config.json；文件不存在则从模板创建。"""
    qq = str(qq).strip()
    if not (qq.isdigit() and 5 <= len(qq) <= 12):
        return False, "QQ 号应为 5~12 位数字"
    cfg_file = OHWHALE / "config.json"
    try:
        if cfg_file.is_file():
            cfg = json.loads(cfg_file.read_text("utf-8-sig"))
        else:
            tpl = OHWHALE / "config" / "config.example.json"
            cfg = json.loads(tpl.read_text("utf-8-sig")) if tpl.is_file() else {}
        if not isinstance(cfg, dict):
            cfg = {}
        cfg.setdefault("master", {})["qq"] = qq
        cfg_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
        return True, "已写入（重启哦鲸鲸生效）"
    except Exception as e:
        return False, "写入失败: %s" % type(e).__name__


def keys_status():
    """密钥状态以 DPAPI 保险库为准；.env 只剩占位符，不再是事实源。"""
    res = []
    for key, label, sync in KEY_DEFS:
        v = ""
        if key_vault:
            try:
                v = key_vault.get_key(key) or ""
            except Exception:
                v = ""
        res.append({"key": key, "label": label,
                    "filled": len(v) > 3, "len": len(v),
                    "sync": sync, "synced": len(v) > 3})
    return res


def key_write(key, value):
    if key not in [k for k, _, _ in KEY_DEFS]:
        return False, "不支持的键"
    if not value or len(value) < 4:
        return False, "值太短"
    if not key_vault:
        return False, "DPAPI 保险库不可用"
    try:
        key_vault.set_key(key, value)
    except Exception as e:
        return False, "保险库写入失败: %s" % type(e).__name__
    # 文件里只留占位符：服务由控制台启动时注入环境变量，明文不再落盘
    for rel in key_vault.SECRET_FILES.get(key, []):
        f = ROOT / rel
        if f.exists():
            key_vault._file_write(f, key, "${VAULT:%s}" % key)
    return True, "已写入 DPAPI 保险库（.env 已改占位符；从控制台启动服务自动注入）"

# ---------- 日志 ----------

LOG_DIRS = [
    OHWHALE / "runtime" / "logs", OHWHALE / "data" / "logs", OHWHALE / "logs",
    SNOWLUMA / "logs", TULPA / "logs", TULPA / "data" / "logs",
    DSH / "data" / "logs", DSH / "home" / "logs", PET / "logs", HEALTH_DIR,
]

def log_list():
    files = []
    for d in LOG_DIRS:
        if d.is_dir():
            for f in d.glob("*.log"):
                try:
                    st = f.stat()
                    files.append({"name": "%s/%s" % (d.parent.name, f.name),
                                  "path": str(f), "size": st.st_size,
                                  "mtime": int(st.st_mtime)})
                except OSError:
                    pass
    files.sort(key=lambda x: -x["mtime"])
    return files[:30]


def log_tail(path, lines=200):
    p = Path(path).resolve()
    if ROOT not in p.parents and p != ROOT:
        return "拒绝访问：路径不在项目内"
    if not p.is_file():
        return "文件不存在"
    try:
        with open(p, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 64 * 1024))
            data = fh.read().decode("utf-8", "replace")
        return "\n".join(data.splitlines()[-lines:])
    except Exception as e:
        return "读取失败: %s" % e

# ---------- QQ 登录 ----------

def qq_login():
    bat = OHWHALE / "runtime" / "LL" / "NapCat.52230.Shell" / "启动NapCat.bat"
    if not bat.is_file():
        inst = OHWHALE / "runtime" / "LL" / "NapCatInstaller.exe"
        if not inst.is_file():
            return False, "NapCat 未安装且找不到安装器"
        subprocess.Popen([str(inst)], cwd=str(inst.parent))
        return True, "NapCat 未安装，正在启动安装器，装完后再点一次"
    subprocess.Popen(["cmd", "/c", str(bat)], cwd=str(bat.parent),
                     creationflags=CREATE_NEW_CONSOLE)
    return True, "NapCat 已启动：首次需扫码（手机确认登录），之后免扫码"

# ---------- 一键部署 ----------

SURF = ROOT / "surfcore"
BIV = DSH / "plugin-src" / "dsh-bili-vision"
BIV_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
_deploy = {}  # id -> {"running":bool, "output":str, "code":int|None}


def _cmd_ver(args):
    """跑命令解析首个版本号；命令不存在返回 None。"""
    try:
        out = subprocess.run(["cmd", "/c"] + args, capture_output=True, timeout=20,
                             encoding="gbk", errors="replace",
                             creationflags=CREATE_NO_WINDOW).stdout or ""
    except Exception:
        return None
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", out)
    return tuple(int(x) for x in m.groups(default="0")) if m else None


def _ck_node():
    v = _cmd_ver(["node", "--version"])
    ok = v is not None and v >= (22, 13)
    return ok, ("v%d.%d.%d" % v) if v else "未检测到"


def _ck_python():
    """按 py 启动器 → python3.12 → python 依次探测，认任意可用的 3.12。"""
    for args in (["py", "-3.12", "--version"], ["python3.12", "--version"],
                 ["python", "--version"]):
        v = _cmd_ver(args)
        if v and v[:2] == (3, 12):
            return True, "v%d.%d.%d" % v
    v = _cmd_ver(["python", "--version"])
    return False, ("当前 python 是 v%d.%d.%d，非 3.12" % v) if v else "未检测到 Python"


def _ck_pnpm():
    v = _cmd_ver(["pnpm", "--version"])
    return v is not None, ("v%d.%d.%d" % v) if v else "未检测到"


def _ck_dsh():
    ok = (DSH / "node_modules" / ".bin" / "dsh.cmd").is_file()
    return ok, "依赖已安装" if ok else "node_modules 缺失"


def _ck_surfcore():
    deps = (SURF / "node_modules").is_dir()
    reg = False
    try:
        pj = Path.home() / ".dsh" / "profiles" / "web" / "package.json"
        reg = "surfcore" in pj.read_text("utf-8", "replace")
    except Exception:
        pass
    return deps and reg, "依赖%s · DSH注册%s" % ("✓" if deps else "✗", "✓" if reg else "✗")


def _ck_ohwhale():
    ok = (OHWHALE / "runtime" / "Python312" / "python" / "python.exe").is_file()
    return ok, "运行时已就绪" if ok else "需跑 install.ps1（下载约 8GB）"


def _ck_tulpa():
    try:
        p = subprocess.run(["python", "-c", "import dotenv,psutil,Crypto,fastapi,uvicorn"],
                           capture_output=True, timeout=20, creationflags=CREATE_NO_WINDOW)
        return p.returncode == 0, "依赖✓" if p.returncode == 0 else "缺 chatlocal 依赖"
    except Exception:
        return False, "系统 python 不可用"


def _ck_biv():
    venv = (BIV_HOME / "bili-vision-venv" / "Scripts" / "python.exe").is_file()
    reg = False
    try:
        pj = Path.home() / ".dsh" / "profiles" / "web" / "package.json"
        reg = "bili-vision" in pj.read_text("utf-8", "replace")
    except Exception:
        pass
    return venv and reg, "venv%s · DSH注册%s" % ("✓" if venv else "✗", "✓" if reg else "✗")


def _biv_steps():
    """bili-vision 用插件自带 install.ps1：建 venv + 装依赖 + 注册进 DSH profile。

    venv 用哦鲸鲸自带的 3.12 建（不影响其运行时；独立 venv 内第三方依赖与系统 3.14 分开）。
    """
    venv_py = BIV_HOME / "bili-vision-venv" / "Scripts" / "python.exe"
    steps = []
    if not venv_py.is_file():
        rt = OHWHALE / "runtime" / "Python312" / "python" / "python.exe"
        steps.append(([str(rt), "-m", "venv", str(BIV_HOME / "bili-vision-venv")], None, False))
    steps.append((["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                   "$env:PIP_INDEX_URL='https://mirrors.aliyun.com/pypi/simple/'; & '%s'"
                   % (BIV / "install.ps1")], BIV, False))
    return steps


ASR_MODEL = OHWHALE / "models" / "asr" / "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
ASR_HF = ("https://hf-mirror.com/csukuangfj/"
          "sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main")


def _ck_asr():
    py = OHWHALE / ".venv" / "Scripts" / "python.exe"
    try:
        p = subprocess.run([str(py), "-c", "import sherpa_onnx"],
                           capture_output=True, timeout=25, creationflags=CREATE_NO_WINDOW)
        pkg = p.returncode == 0
    except Exception:
        pkg = False
    files = all((ASR_MODEL / f).is_file()
                for f in ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"))
    return pkg and files, "包%s · 模型%s" % ("✓" if pkg else "✗", "✓" if files else "✗")


def _asr_steps():
    """本地 ASR：pip 装 sherpa-onnx + 从 HF 镜像拉三个模型文件（约 236MB，CPU 跑）。"""
    py = str(OHWHALE / ".venv" / "Scripts" / "python.exe")
    steps = [([py, "-m", "pip", "install", "sherpa-onnx",
               "-i", "https://mirrors.aliyun.com/pypi/simple/"], OHWHALE, False),
             ([py, "-c", "from pathlib import Path; "
                         "Path(r'%s').mkdir(parents=True, exist_ok=True)" % ASR_MODEL],
              OHWHALE, False)]
    for f in ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"):
        steps.append((["curl.exe", "-sSL", "-m", "900", "-o", str(ASR_MODEL / f),
                       "%s/%s" % (ASR_HF, f)], OHWHALE, False))
    steps.append(([py, "scripts\\asr_local.py", "--check"], OHWHALE, False))
    return steps


DEPLOY_TASKS = [
    {"id": "node", "name": "Node.js ≥ 22.13", "check": _ck_node,
     "desc": "winget 静默安装 LTS（会弹 UAC，装完需重启控制台刷新检测）",
     "steps": lambda: [(["winget", "install", "-e", "--id", "OpenJS.NodeJS.LTS",
                         "--accept-package-agreements", "--accept-source-agreements"],
                        None, True)]},
    {"id": "python", "name": "Python 3.12", "check": _ck_python,
     "desc": "winget 静默安装 3.12（会弹 UAC，装完需重启控制台刷新检测）",
     "steps": lambda: [(["winget", "install", "-e", "--id", "Python.Python.3.12",
                         "--accept-package-agreements", "--accept-source-agreements"],
                        None, True)]},
    {"id": "pnpm", "name": "pnpm", "check": _ck_pnpm,
     "desc": "DSH profile 装插件用（依赖 Node）",
     "steps": lambda: [(["cmd", "/c", "npm", "i", "-g", "pnpm",
                         "--registry=https://registry.npmmirror.com"], None, False)]},
    {"id": "dsh", "name": "DSH 依赖", "check": _ck_dsh,
     "desc": "在 dsh/ 执行 npm install（@deepseek-ai/dsh）",
     "steps": lambda: [(["cmd", "/c", "npm", "install",
                         "--registry=https://registry.npmmirror.com"], DSH, False)]},
    {"id": "surfcore", "name": "SurfCore 安装+注册", "check": _ck_surfcore,
     "desc": "npm install + setup-dsh.mjs 自动写入 DSH profile",
     "steps": lambda: [(["cmd", "/c", "npm", "install",
                         "--registry=https://registry.npmmirror.com"], SURF, False),
                       (["node", "scripts\\setup-dsh.mjs"], SURF, False)]},
    {"id": "ohwhale", "name": "哦鲸鲸环境", "check": _ck_ohwhale,
     "desc": "install.ps1 全自动：Python 3.12 + AstrBot + torch + GPT-SoVITS + 模型（新窗口执行）",
     "steps": lambda: [(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", str(OHWHALE / "install.ps1")], OHWHALE, True)]},
    {"id": "asr", "name": "本地 ASR（sherpa-onnx）", "check": _ck_asr,
     "desc": "装 sherpa-onnx + 拉流式 paraformer 模型（约 236MB，CPU 跑，可免百炼密钥）",
     "steps": _asr_steps},
    {"id": "tulpa", "name": "Tulpa Python 依赖", "check": _ck_tulpa,
     "desc": "chatlocal 脚本依赖：dotenv/psutil/pycryptodome/fastapi/uvicorn",
     "steps": lambda: [(["python", "-m", "pip", "install", "python-dotenv", "psutil",
                         "pycryptodome", "fastapi", "uvicorn",
                         "-i", "https://mirrors.aliyun.com/pypi/simple/"], None, False)]},
    {"id": "bilivision", "name": "bili-vision 环境", "check": _ck_biv,
     "desc": "创建独立 venv 并装插件依赖（另需自行安装 ffmpeg）",
     "steps": _biv_steps},
]


def _run_bg(tid, steps):
    st = _deploy.setdefault(tid, {})
    st.update(running=True, output="", code=None)

    def work():
        log, code = [], 0
        for argv, cwd, visible in steps:
            log.append("$ " + " ".join(str(a) for a in argv))
            try:
                if visible:
                    subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                     creationflags=CREATE_NEW_CONSOLE)
                    log.append("（已在新窗口执行，完成后回到这里看状态）")
                else:
                    p = subprocess.Popen(argv, cwd=str(cwd) if cwd else None,
                                         stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT,
                                         creationflags=CREATE_NO_WINDOW)
                    for line in iter(p.stdout.readline, b""):
                        log.append(line.decode("gbk", "replace").rstrip())
                        st["output"] = "\n".join(log[-400:])
                    code = p.wait()
                    if code != 0:
                        log.append("[退出码 %d，已中止后续步骤]" % code)
                        break
            except Exception as e:
                log.append("执行失败: %s" % e)
                code = -1
                break
            st["output"] = "\n".join(log[-400:])
        st.update(running=False, code=code, output="\n".join(log[-400:]))

    threading.Thread(target=work, daemon=True).start()


def deploy_list():
    out = []
    for t in DEPLOY_TASKS:
        st = _deploy.get(t["id"], {})
        try:
            done, detail = t["check"]()
        except Exception:
            done, detail = False, "检测失败"
        out.append({"id": t["id"], "name": t["name"], "desc": t["desc"],
                    "done": bool(done), "detail": detail,
                    "running": bool(st.get("running")), "code": st.get("code")})
    return out


def deploy_run(tid):
    t = next((x for x in DEPLOY_TASKS if x["id"] == tid), None)
    if not t:
        return False, "未知任务"
    if _deploy.get(tid, {}).get("running"):
        return False, "正在执行中"
    steps = t["steps"]()
    if not steps:
        return False, "该组件需手动安装"
    _run_bg(tid, steps)
    return True, "已开始：%s" % t["name"]


def deploy_output(tid):
    st = _deploy.get(tid, {})
    return {"running": bool(st.get("running")), "output": st.get("output", ""),
            "code": st.get("code")}

# ---------- 指标（P1-2 / P1-4） ----------

def _find_metrics_file():
    for p in (OHWHALE / "logs" / "call_metrics.jsonl", ROOT / "logs" / "call_metrics.jsonl"):
        if p.is_file():
            return p
    return None


def call_metrics_summary():
    """通话指标：端到端首音延迟 P50/P95、打断率、降级触发次数。"""
    f = _find_metrics_file()
    if not f:
        return {"turns": 0}
    turns, degr = [], {}
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("event") == "turn":
                    turns.append(d)
                elif d.get("event") in ("degrade", "echo_drop", "asr_timeout"):
                    degr[d["event"]] = degr.get(d["event"], 0) + 1
    except OSError:
        return {"turns": 0}
    lat = sorted(t["tts_first"] for t in turns if t.get("tts_first") is not None)
    out = {"turns": len(turns), "degrade": degr}
    if lat:
        out["p50"] = round(lat[len(lat) // 2], 2)
        out["p95"] = round(lat[min(len(lat) - 1, int(len(lat) * 0.95))], 2)
        out["interrupt_rate"] = round(
            sum(1 for t in turns if t.get("interrupted")) / len(turns), 3)
    return out


def metrics_summary():
    m = {"call": call_metrics_summary(), "health_events": HEALTH["events"][:10]}
    try:
        import search_gate
        m["search"] = search_gate.stats()
        cfg = search_gate.load_config()
        m["search_caps"] = {"daily_call_cap": cfg["daily_call_cap"],
                            "daily_cost_cap": cfg["daily_cost_cap_yuan"],
                            "monthly_cost_cap": cfg["monthly_cost_cap_yuan"],
                            "billing_starts": cfg["billing_starts"]}
    except Exception:
        pass
    try:
        import resource_gate
        m["resource"] = resource_gate.status()
        if alert and m["resource"].get("warn"):
            alert.send("小鲸鱼显存告警", "显存超过安全阈值，重任务请暂停",
                       key="vram_warn")
    except Exception:
        pass
    try:
        import llm_gate
        m["llm"] = llm_gate.stats()
    except Exception:
        pass
    try:
        import balance_monitor
        m["balance"] = balance_monitor.status()
    except Exception:
        pass
    if state_engine:
        try:
            m["state"] = state_engine.status()
        except Exception:
            pass
    if daily_report:
        try:
            rp = daily_report.latest()
            m["report"] = {"date": rp.get("date"), "anomalies": rp.get("anomalies", []),
                           "voice": rp.get("voice", "")}
        except Exception:
            pass
    if screen_buddy:
        try:
            m["screen"] = screen_buddy.status()
        except Exception:
            pass
    return m

# ---------- 待办提示 ----------

def todo_hints():
    hints = []
    try:
        cfg = json.loads((OHWHALE / "config.json").read_text("utf-8"))
        if not str(cfg.get("master", {}).get("qq", "")).strip():
            hints.append("master.qq（主人 QQ 号）未填，AstrBot 自动配置（31_astrbot.ps1）尚未运行")
    except Exception:
        pass
    try:
        dash = (key_vault.get_key("DASHSCOPE_API_KEY") or "") if key_vault else ""
    except Exception:
        dash = ""
    if not dash:
        hints.append("DASHSCOPE_API_KEY 未配置（计划用 FunASR 本地识别替代——通话高频调用，优先级最高）")
    if key_vault:
        try:
            plain = key_vault.plaintext_remaining()
            if plain:
                hints.append("发现明文密钥残留：%s（重启控制台自动迁移，或手动 python tools/key_vault.py migrate）" % "、".join(plain))
        except Exception:
            pass
    if port_pid(9880) is None:
        hints.append("GPT-SoVITS 语音服务未运行")
    # 失败告警：cron 上次失败 / 服务反复重启 / 通话 P95 超标 / Search 费用逼近上限
    try:
        for j in json.loads(CRON_FILE.read_text("utf-8")):
            st = str(j.get("lastRunStatus") or "").lower()
            if j.get("enabled") and st and st not in ("success", "ok", "none", "-"):
                hints.append("定时任务「%s」上次运行失败：%s" % (j.get("name") or j.get("id"), st))
    except Exception:
        pass
    for sid in WATCHED:
        if _restart_count(sid) >= 3:
            hints.append("服务 %s 10 分钟内重启 %d 次，请查日志" % (sid, _restart_count(sid)))
    cm = call_metrics_summary()
    if cm.get("p95") and cm["p95"] > 8:
        hints.append("通话首音延迟 P95 = %.1fs（>8s），链路需要优化" % cm["p95"])
    try:
        import search_gate
        sg, cfg = search_gate.stats(), search_gate.load_config()
        if sg["month_cost"] >= cfg["monthly_cost_cap_yuan"] * 0.8:
            hints.append("Search/Fetch 本月费用 ¥%.2f 已达月上限 80%%" % sg["month_cost"])
    except Exception:
        pass
    try:
        import llm_gate
        w = llm_gate.budget_warn()
        if w:
            hints.append(w)
            if alert:
                alert.send("小鲸鱼预算告警", w, key="llm_budget")
    except Exception:
        pass
    # 多厂商资金看板：余额/预算告急提示（DeepSeek 直查、GLM/Qwen 本地精算）
    try:
        import balance_monitor
        hint = balance_monitor.routing_hint()
        for name, reason in (hint.get("reasons") or {}).items():
            w = "API 资金告急：%s %s，路由已自动降级让位" % (name, reason)
            hints.append(w)
            if alert:
                alert.send("小鲸鱼 API 资金告警", w, key="balance_%s" % name)
    except Exception:
        pass
    return hints

# ---------- 一键自检（P2-3） ----------

def self_check():
    """把 FAQ 排障产品化：一次点完，逐项给结果。"""
    items = []

    import shutil
    # 端口占用
    for label, port in (("控制台", 8900), ("DSH", 3080), ("AstrBot", 6185),
                        ("GPT-SoVITS", 9880), ("NapCat WS", 6199)):
        pid = port_pid(port)
        items.append({"name": "端口 %d（%s）" % (port, label),
                      "ok": True,
                      "detail": ("被 PID %d 监听" % pid) if pid else "空闲"})
    # VB-Cable
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "Get-CimInstance Win32_SoundDevice | Select-Object -Expand Name"],
                             capture_output=True, timeout=15, encoding="gbk",
                             errors="replace", creationflags=CREATE_NO_WINDOW).stdout
        vb = "VB-Audio" in out or "CABLE" in out.upper()
    except Exception:
        vb = False
    items.append({"name": "VB-CABLE 虚拟声卡", "ok": vb,
                  "detail": "已安装" if vb else "未检测到（通话链路必需）"})
    # 密钥保险库完整性 + 明文残留
    if key_vault:
        missing = []
        for k, _, _ in KEY_DEFS:
            try:
                if not key_vault.get_key(k):
                    missing.append(k)
            except Exception:
                missing.append(k)
        items.append({"name": "密钥保险库（DPAPI）", "ok": not missing,
                      "detail": "齐全" if not missing else "缺: " + ", ".join(missing)})
        try:
            plain = key_vault.plaintext_remaining()
            items.append({"name": "明文密钥残留", "ok": not plain,
                          "detail": "无（.env 均为占位符）" if not plain
                          else "仍有明文: " + ", ".join(plain)})
        except Exception:
            pass
    else:
        items.append({"name": "密钥保险库（DPAPI）", "ok": False,
                      "detail": "key_vault 不可用"})
    # QQ 在线
    ll = find_proc("NapCatWinBootMain.exe") is not None
    items.append({"name": "QQ（NapCat）在线", "ok": ll,
                  "detail": "进程在" if ll else "未运行（控制台「QQ 登录」启动）"})
    # TTS 试合成（业务探测，不真合成以免占显存）
    tts = http_ok("http://127.0.0.1:9880/docs")
    items.append({"name": "GPT-SoVITS 服务", "ok": tts,
                  "detail": "API 有响应" if tts else "无响应（未启动则忽略）"})
    # 磁盘余量
    try:
        free = shutil.disk_usage(str(ROOT)).free // 1073741824
        items.append({"name": "磁盘剩余", "ok": free >= 5, "detail": "%d GB" % free})
    except Exception:
        pass
    return items


def self_check_deep():
    """端到端闭环探针（占 GPU / 依赖服务已启动，需用户确认后手动触发）。"""
    items = []
    # OneBot 反向 WS：NapCat → AstrBot 的连接端口真实可连
    try:
        socket.create_connection(("127.0.0.1", 6199), timeout=3).close()
        ws = True
    except OSError:
        ws = False
    items.append({"name": "OneBot 反向 WS（6199）", "ok": ws,
                  "detail": "端口可连接" if ws else "连不上（检查 NapCat 反向连接配置）"})
    # TTS 闭环：真合成一句，验证产物是非空 wav
    try:
        cfg = json.loads((OHWHALE / "config.json").read_text("utf-8"))
        ref = OHWHALE / cfg["paths"]["voice_ref"]
        body = json.dumps({"text": "自检试音，听个响", "text_lang": "zh",
                           "ref_audio_path": str(ref),
                           "prompt_text": cfg["voice"]["prompt_text"],
                           "prompt_lang": "zh", "media_type": "wav",
                           "streaming_mode": False}).encode()
        req = urllib.request.Request("http://127.0.0.1:9880/tts", data=body,
                                     headers={"Content-Type": "application/json"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        ok = len(data) > 10240
        items.append({"name": "TTS 闭环试合成", "ok": ok,
                      "detail": ("合成 %.0fKB / 用时 %.1fs" % (len(data) / 1024, time.time() - t0))
                      if ok else "返回仅 %d 字节，疑似失败" % len(data)})
    except Exception as e:
        items.append({"name": "TTS 闭环试合成", "ok": False,
                      "detail": "失败: %s（TTS 未启动则忽略）" % type(e).__name__})
    return items

# ---------- 页面 ----------

PAGE = r"""<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Persona-OS 控制台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f141b;--card:rgba(26,34,48,.72);--line:rgba(42,53,71,.8);--fg:#dbe6f4;--dim:#8fa0b8;--ok:#3ecf8e;--warn:#f5a623;--bad:#e5534b;--acc:#5b9dff}
*{box-sizing:border-box}body{margin:0;color:var(--fg);font:14px/1.6 "Microsoft YaHei",sans-serif;
background-color:var(--bg);
background-image:radial-gradient(circle at 15% 50%,rgba(91,157,255,.05),transparent 25%),radial-gradient(circle at 85% 30%,rgba(62,207,142,.05),transparent 25%);
background-attachment:fixed}
.wrap{max-width:1280px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:20px;margin:0 0 4px;background:linear-gradient(90deg,var(--acc),var(--ok));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;display:inline-block}
h2{font-size:15px;color:var(--acc);margin:0 0 10px;border-left:3px solid var(--acc);padding-left:8px}
.sub{color:var(--dim);font-size:12px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:0 20px;align-items:start}
.grid>div{min-width:0}
.span2{grid-column:span 2}
@media (max-width:820px){.span2{grid-column:span 1}}
.card{background:var(--card);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:16px;
box-shadow:0 4px 20px rgba(0,0,0,.2);transition:transform .2s ease,border-color .2s ease}
.card:hover{transform:translateY(-2px);border-color:rgba(91,157,255,.4)}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.name{font-weight:600;min-width:150px}.detail{color:var(--dim);font-size:12px;flex:1}
.dot{width:9px;height:9px;border-radius:50%;background:var(--bad);display:inline-block;margin-right:6px}
.on .dot{background:var(--ok);box-shadow:0 0 8px var(--ok);animation:pulse 2s infinite}
.part .dot{background:var(--warn);box-shadow:0 0 8px var(--warn)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(62,207,142,.6)}70%{box-shadow:0 0 0 9px rgba(62,207,142,0)}100%{box-shadow:0 0 0 0 rgba(62,207,142,0)}}
button{background:rgba(91,157,255,.12);border:1px solid var(--acc);color:var(--acc);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;font-weight:600;transition:all .2s}
button:hover{background:var(--acc);color:#fff;box-shadow:0 0 10px rgba(91,157,255,.5)}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg);font-weight:400}
button.ghost:hover{border-color:var(--acc);color:var(--acc);box-shadow:none;background:rgba(91,157,255,.08)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--dim);font-weight:400}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#263144;color:var(--dim)}
.badge.on{background:#14362a;color:var(--ok)}
input[type=text],input[type=password],input:not([type]){background:#0d1219;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;width:260px}
select{background:#0d1219;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 10px;max-width:340px}
pre{background:#0d1219;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12px;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.toast{position:fixed;top:16px;right:16px;background:rgba(38,49,68,.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);padding:10px 18px;border-radius:8px;border:1px solid var(--acc);display:none;z-index:9;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.hint{background:rgba(42,33,24,.85);border:1px solid #4d3b1e;color:var(--warn);border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:8px}
.pbar{width:100%;height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:4px}
.pbar>i{display:block;height:100%;background:var(--acc);border-radius:3px;transition:width .5s}
#metrics .row>div{background:rgba(13,18,25,.55);border:1px solid var(--line);border-radius:10px;padding:10px 14px;flex:1;min-width:230px}
tr:hover td{background:rgba(91,157,255,.05)}
.badge{border:1px solid var(--line)}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#2a3547;border-radius:4px}::-webkit-scrollbar-track{background:transparent}
a{color:var(--acc);text-decoration:none}
/* --- SPA 布局：侧边栏 + Hash 路由页面视图 --- */
body{display:flex}
.sidebar{width:210px;min-height:100vh;position:fixed;left:0;top:0;background:rgba(18,25,36,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:20px 0;z-index:5}
.brand{padding:0 20px 16px;font-size:18px;font-weight:bold;background:linear-gradient(90deg,var(--acc),var(--ok));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.nav-btn{padding:11px 20px;cursor:pointer;color:var(--dim);font-size:14px;border-left:3px solid transparent;transition:all .2s;user-select:none}
.nav-btn:hover{background:rgba(91,157,255,.08);color:var(--fg)}
.nav-btn.active{border-left-color:var(--acc);color:var(--acc);font-weight:600;background:rgba(91,157,255,.06)}
.side-sub{margin-top:auto;padding:14px 20px 0;font-size:11px;color:var(--dim);border-top:1px solid var(--line);line-height:1.5}
.main{margin-left:210px;flex:1;padding:24px 28px 60px;max-width:1400px;min-width:0}
.page-view{display:none;animation:fadeIn .25s ease}
.page-view.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@media (max-width:820px){
body{display:block}
.sidebar{position:static;width:100%;min-height:0;flex-direction:row;flex-wrap:wrap;padding:8px;border-right:none;border-bottom:1px solid var(--line)}
.brand{padding:6px 10px;width:100%}
.nav-btn{padding:8px 12px;border-left:none;border-bottom:2px solid transparent}
.nav-btn.active{border-bottom-color:var(--acc)}
.side-sub{display:none}
.main{margin-left:0;padding:14px}
}
</style></head><body>
<div class="sidebar">
<div class="brand">🐋 Persona-OS</div>
<div class="nav-btn active" data-page="dashboard" onclick="navigate('dashboard')">📊 仪表盘</div>
<div class="nav-btn" data-page="ops" onclick="navigate('ops')">🛠 运维与配置</div>
<div class="nav-btn" data-page="ai" onclick="navigate('ai')">🧠 智能与内容</div>
<div class="nav-btn" data-page="companion" onclick="navigate('companion')">💖 陪伴与数据</div>
<div class="side-sub">统一管理 DSH · 哦鲸鲸 · Tulpa · SnowLuma · 桌宠<br>仅本机访问 · token 鉴权</div>
</div>
<div class="main">
<h1>🐋 Persona-OS 生态控制台</h1>
<div class="sub">统一管理 DSH · 哦鲸鲸 · Tulpa · SnowLuma · 桌宠 ｜ 仅本机访问</div>
<div id="hints"></div>

<div id="page-dashboard" class="page-view active">
<div class="grid">
<div class="span2">
<h2>服务</h2>
<div class="card row"><button onclick="startAll(false)">⏵ 全部启动（按依赖顺序）</button>
<button class="ghost" onclick="startAll(true)">预检（不启动）</button>
<button class="ghost" onclick="stopAll()">■ 全部停止</button>
<label style="margin-left:auto;font-size:12px;color:var(--dim)"><input type="checkbox" id="wd" onchange="toggleWd(this.checked)"> 健康守护（崩溃自动重启 + 告警）</label></div>
<div id="sal"></div>
<div id="svcs"></div>

</div>
<div class="span2">
<h2>指标</h2><div class="card" id="metrics" style="font-size:13px">加载中…</div>
</div>
<div>
<h2>💳 API 资金看板</h2><div class="card" id="apiBalance" style="font-size:13px">加载中…</div>

</div>
<div>
<h2>一键自检</h2>
<div class="card"><button onclick="selfCheck()">开始自检（端口/声卡/密钥/QQ/TTS/磁盘）</button>
<label style="font-size:12px;color:var(--dim);margin-left:10px"><input type="checkbox" id="deepck"> 深度自检（OneBot 反连 + TTS 真合成一句，占显存，需服务已启动）</label><div id="sck" style="margin-top:10px"></div></div>

</div>
</div>
</div>

<div id="page-companion" class="page-view">
<div class="grid">
<div class="span2">
<h2>陪伴与隐私</h2>
<div class="card" id="care" style="font-size:13px">
<div class="row"><div id="careState" style="flex:1">状态加载中…</div>
<div id="careReport" style="flex:1">日报加载中…</div>
<div id="careScreen" style="flex:1">读屏加载中…</div></div>
<div class="row" style="margin-top:10px"><button onclick="makeReport()">生成今天的日报</button>
<button onclick="showReport()">查看日报全文</button>
<label style="font-size:12px;color:var(--dim)"><input type="checkbox" id="fdiary"> 同时遗忘日记</label></div>
<div class="row" style="margin-top:8px"><input id="fq" placeholder="要她忘掉什么（关键词）" style="flex:1">
<button onclick="forgetPreview()">先预演</button><button onclick="forgetDo()">确认遗忘</button></div>
<div id="fres" style="margin-top:8px;color:var(--dim)"></div>
<div class="row" style="margin-top:10px"><input id="mq" placeholder="记忆查询（她这句话的依据）" style="flex:1">
<button onclick="memSearch()">查记忆</button><button class="ghost" onclick="dream()">让她做个梦</button></div>
<div id="mres" style="margin-top:8px;color:var(--dim)"></div>
<div class="row" style="margin-top:10px">
<label style="font-size:13px"><input type="checkbox" id="silentck" onchange="toggleSilent(this.checked)"> 陪伴静默模式（通话时只陪不说话，LLM 零消耗）</label>
<button class="ghost" onclick="judge()">人格保真度抽检</button><span id="jres" style="color:var(--dim);font-size:12px"></span></div>
<pre id="rfull" style="display:none;white-space:pre-wrap;background:#0b1017;padding:10px;border-radius:6px"></pre>
</div>

</div>
<div>
<h2>关系与纪念日</h2>
<div class="card" id="rel" style="font-size:13px">加载中…</div>

</div>
<div>
<h2>隐私仪表盘</h2>
<div class="card" id="privacy" style="font-size:13px">加载中…</div>

</div>
<div class="span2">
<h2>陪伴进阶（P2/P3）</h2>
<div class="card" style="font-size:13px">
<div id="p2sum">加载中…</div>
<div class="row" style="margin-top:10px">
<button class="ghost" onclick="goalGen()">重新生成小目标</button>
<button class="ghost" onclick="rebuildReview()">重建求证队列</button>
<button class="ghost" onclick="exportDiary()">导出日记合集（脱敏）</button>
<button class="ghost" id="sdbtn" onclick="toggleSilentDay()">一键静默日</button>
</div>
<div class="row" style="margin-top:8px">
<input id="capdate" placeholder="拆信日 2027-01-01" style="width:150px">
<input id="captext" placeholder="想对未来的自己/主人说…（留空则由她写）" style="flex:1">
<button onclick="capCreate()">封存胶囊</button>
</div>
<div class="row" style="margin-top:8px">
<input id="vmtext" placeholder="给她留一句语音留言…" style="flex:1">
<button onclick="vmLeave()">留语音</button>
</div>
</div>

</div>
</div>
</div>

<div id="page-ai" class="page-view">
<div class="grid">
<div>
<h2>成本沙盘（上线前先算算）</h2>
<div class="card" id="sandbox" style="font-size:13px">加载中…</div>

</div>
<div class="span2">
<h2>内容工坊（一个灵魂四张嘴）</h2>
<div class="card" style="font-size:13px">
<div class="row"><input id="ct" placeholder="标题" style="flex:1"><input id="cb" placeholder="正文素材" style="flex:2">
<button onclick="contentCreate()">登记素材</button>
<button class="ghost" onclick="contentDiary()">从日记生成草稿</button></div>
<div id="clist" style="margin-top:8px">加载中…</div></div>

</div>
<div>
<h2>人格快照</h2>
<div class="card" style="font-size:13px">
<div class="row"><input id="snapnote" placeholder="快照备注（改了什么）" style="flex:1">
<button onclick="snapCreate()">拍快照</button></div>
<div id="snaplist" style="margin-top:8px">加载中…</div></div>

</div>
<div>
<h2>人格蒸馏（素材 → 人格卡）</h2>
<div class="card" style="font-size:13px">
<div class="row"><input id="distillpath" placeholder="素材路径或链接（B站链接优先原生字幕，零依赖）" style="flex:2">
<input id="distillcard" placeholder="人格卡" value="little_whale" style="width:110px"></div>
<div class="row" style="margin-top:6px">
<button onclick="distillRun(false)">蒸馏预览</button>
<button class="ghost" onclick="distillRun(true)">应用写卡</button></div>
<pre id="distillout" style="margin-top:8px;max-height:280px;overflow:auto;white-space:pre-wrap;display:none"></pre></div>

</div>
<div>
<h2>时间机器</h2>
<div class="card" style="font-size:13px">
<div class="row"><select id="tldate" onchange="loadTimeline()"></select></div>
<div id="tllist" style="margin-top:8px;max-height:300px;overflow:auto">加载中…</div></div>

</div>
</div>
</div>

<div id="page-ops" class="page-view">
<div class="grid">
<div>
<h2>一键部署（新机器初始化）</h2>
<div class="card" id="deploy" style="font-size:13px">加载中…</div>
<pre id="deployOut" style="display:none"></pre>

</div>
<div class="span2">
<h2>定时任务（DSH cron）</h2>
<div class="card"><table id="cron"><thead><tr><th>任务</th><th>时间</th><th>状态</th><th>上次</th><th>次数</th><th></th></tr></thead><tbody></tbody></table></div>

</div>
<div>
<h2>故障 Runbook</h2>
<div class="card" id="runbook" style="font-size:13px">加载中…</div>

</div>
<div class="span2">
<h2>密钥与配置</h2>
<div class="card" id="keys"></div>
<div class="card"><div class="row">
<span class="name" style="min-width:200px">主人 QQ（哦鲸鲸）</span>
<span class="badge" id="qqm-badge">未配置</span>
<input id="qqm-input" placeholder="QQ 号" style="width:140px">
<button class="ghost" onclick="saveQqMaster()">保存</button></div></div>

</div>
<div>
<h2>QQ 登录</h2>
<div class="card row"><div class="detail">启动 NapCat（协议端，首次扫码登录，之后免扫码）</div>
<button onclick="qqLogin()">启动 NapCat</button>
<a href="http://127.0.0.1:6185" target="_blank">AstrBot 面板</a>
<a href="http://127.0.0.1:3080" style="margin-left:10px">DSH 面板</a></div>

</div>
<div class="span2">
<h2>日志</h2>
<div class="card"><div class="row"><select id="logsel" onchange="loadLog()"></select>
<button class="ghost" onclick="loadLog()">刷新</button></div>
<pre id="logview" style="margin-top:10px">选择日志文件…</pre></div>
</div>
</div>
</div>
</div>
<div class="toast" id="toast"></div>
<script>
const TOKEN=new URLSearchParams(location.search).get('token')||'';
async function api(p, m, body){const r=await fetch(p,{method:m||'GET',headers:{'Content-Type':'application/json','X-Console-Token':TOKEN},body:body?JSON.stringify(body):undefined});return r.json()}
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.style.display='block';setTimeout(()=>e.style.display='none',3000)}

async function loadSvcs(){const d=await api('/api/status');
document.getElementById('hints').innerHTML=(d.hints||[]).map(h=>`<div class="hint">⚠ ${h}</div>`).join('')
+((d.health&&d.health.events)||[]).filter(e=>e.event!=='restart').slice(0,5).map(e=>`<div class="hint">🛠 ${e.time} [${e.event}] ${e.msg}</div>`).join('');
document.getElementById('wd').checked=!!(d.health&&d.health.enabled);
const sa=d.startall||{};document.getElementById('sal').innerHTML=(sa.log&&sa.log.length)?`<div class="card"><pre>${sa.log.join('\n')}</pre></div>`:'';
document.getElementById('svcs').innerHTML=d.services.map(s=>`<div class="card row ${s.running?'on':(s.partial?'part':'')}"><span class="dot"></span><span class="name">${s.name}</span>
<span class="badge ${s.ready?'on':''}">${s.ready?'就绪':(s.optional?'可选':'未就绪')}</span>
${s.restarts?`<span class="badge" style="color:var(--warn)">重启×${s.restarts}</span>`:''}
<span class="detail">${s.detail}</span>
${s.panel?`<a href="${s.panel}" target="_blank">面板</a>`:''}
<button onclick="act('${s.id}','${s.running?'stop':'start'}')">${s.running?'停止':'启动'}</button></div>`).join('')}
async function act(id,a){const d=await api('/api/service','POST',{id,action:a});toast(d.msg);setTimeout(loadSvcs,2500)}
async function startAll(dry){const d=await api('/api/start-all','POST',{dry});toast(d.msg);setTimeout(loadSvcs,2000)}
async function stopAll(){const d=await api('/api/stop-all','POST',{});toast(d.msg);setTimeout(loadSvcs,2000)}
async function toggleWd(on){const d=await api('/api/watchdog','POST',{enabled:on});toast(d.msg)}

let deployTimer=null;
async function loadDeploy(){const d=await api('/api/deploy');
document.getElementById('deploy').innerHTML=d.map(t=>`<div class="row" style="margin-bottom:8px">
<span class="name" style="min-width:170px">${t.name}</span>
<span class="badge ${t.done?'on':''}">${t.done?'已就绪':(t.running?'执行中…':'待安装')}</span>
<span class="detail">${t.detail} · ${t.desc}</span>
<button class="ghost" onclick="showDeploy('${t.id}')">输出</button>
<button onclick="runDeploy('${t.id}')" ${t.running?'disabled':''}>执行</button></div>`).join('');
clearTimeout(deployTimer);if(d.some(t=>t.running))deployTimer=setTimeout(loadDeploy,3000)}
async function runDeploy(id){const d=await api('/api/deploy','POST',{id});toast(d.msg);showDeploy(id);setTimeout(loadDeploy,2000)}
async function showDeploy(id){const el=document.getElementById('deployOut');el.style.display='block';
const d=await api('/api/deploy/output?task='+encodeURIComponent(id));el.textContent=d.output||'（还没有输出）';
if(d.running)setTimeout(()=>showDeploy(id),2000)}

async function loadCron(){const d=await api('/api/cron');const tb=document.querySelector('#cron tbody');
const row=j=>`<tr><td>${j.label}</td><td>${j.time}</td><td><span class="badge ${j.enabled?'on':''}">${j.enabled?'启用':'停用'}</span></td><td>${j.lastRun}</td><td>${j.runs}</td>
<td><button class="ghost" onclick="cronToggle('${j.id}',${!j.enabled})">${j.enabled?'停用':'启用'}</button></td></tr>`;
const on=(d.jobs||[]).filter(j=>j.enabled),off=(d.jobs||[]).filter(j=>!j.enabled);
tb.innerHTML=(on.map(row).join('')||'<tr><td colspan=6 style="color:var(--dim)">当前没有启用中的任务</td></tr>')
+(off.length?`<tr><td colspan=6 style="color:var(--dim);font-size:12px;padding-top:12px">—— 历史存档（已停用，仅保留记录）——</td></tr>`+off.map(row).join(''):'')}
async function cronToggle(id,en){const d=await api('/api/cron','POST',{id,enabled:en});toast(d.msg);loadCron()}

async function loadKeys(){const d=await api('/api/keys');document.getElementById('keys').innerHTML=d.map(k=>`<div class="row" style="margin-bottom:10px">
<span class="name" style="min-width:200px">${k.label}</span>
<span class="badge ${k.filled?'on':''}">${k.filled?'已配置 '+k.len+' 位':'未配置'}</span>
${k.sync?`<span class="badge ${k.synced?'on':''}">${k.synced?'DSH 已同步':'DSH 未同步'}</span>`:''}
<input type="password" id="k_${k.key}" placeholder="输入新值（留空不改）">
<button class="ghost" onclick="saveKey('${k.key}')">保存</button></div>`).join('')}
async function saveKey(key){const v=document.getElementById('k_'+key).value;if(!v)return toast('请输入值');
const d=await api('/api/keys','POST',{key,value:v});toast(d.msg);loadKeys()}

async function loadQqMaster(){const d=await api('/api/qq-master');const b=document.getElementById('qqm-badge');
b.textContent=d.qq?'已配置':'未配置';b.className='badge'+(d.qq?' on':'');
if(d.qq&&!document.getElementById('qqm-input').value)document.getElementById('qqm-input').value=d.qq}
async function saveQqMaster(){const v=document.getElementById('qqm-input').value.trim();
if(!v)return toast('请输入 QQ 号');const d=await api('/api/qq-master','POST',{qq:v});toast(d.msg);loadQqMaster()}

async function qqLogin(){const d=await api('/api/qq-login','POST',{});toast(d.msg)}

async function loadMetrics(){const d=await api('/api/metrics');const c=d.call||{},s=d.search||{},caps=d.search_caps||{},r=d.resource||{},l=d.llm||{};
let h='<div class="row" style="gap:24px">';
h+=`<div>📞 通话<br>轮次 ${c.turns||0}${c.p50?`｜首音 P50 ${c.p50}s / P95 ${c.p95}s｜打断率 ${(c.interrupt_rate*100).toFixed(0)}%`:''}${c.degrade&&Object.keys(c.degrade).length?`<br><span style="color:var(--warn)">降级触发: ${Object.entries(c.degrade).map(([k,v])=>k+'×'+v).join(' ')}</span>`:''}</div>`;
h+=`<div>🔎 Search/Fetch<br>今日 ${s.today_calls||0}/${caps.daily_call_cap||'-'} 次｜缓存命中 ${s.today_cache_hit||0}｜待审核 ${s.pending_audit||0}<br>费用 今日 ¥${(s.today_cost||0).toFixed(3)} / 本月 ¥${(s.month_cost||0).toFixed(3)}（上限 ¥${caps.monthly_cost_cap||'-'}，${caps.billing_starts||''} 起计费）</div>`;
h+=`<div>🎮 资源<br>${r.busy?`<span style="color:var(--warn)">通话/直播进行中——重任务已让路</span>`:'空闲'}${r.vram_used_mb!=null?`<br>显存 ${r.vram_used_mb}/${r.vram_total_mb} MB`+(r.vram_peak_7d_mb?`｜7日峰值 ${r.vram_peak_7d_mb} MB`:''):''}${r.warn?' <span style="color:var(--bad)">显存告急</span>':''}</div>`;
if(l.today_tokens!=null){const ps=l.per_scene_today||{};
h+=`<div>🧠 LLM token<br>今日 ${l.today_tokens}/${l.daily_token_cap||'-'}｜费用 今日 ¥${(l.today_cost||0).toFixed(3)} / 本月 ¥${(l.month_cost||0).toFixed(2)}（上限 ¥${l.monthly_cost_cap||'-'}）`+
(Object.keys(ps).length?`<br><span style="color:var(--dim)">${Object.entries(ps).map(([k,v])=>k+': '+v.calls+'次/¥'+v.cost_per_call.toFixed(4)).join(' ｜ ')}</span>`:'')+`</div>`}
renderBalance(d.balance);
h+='</div>';
if(d.health_events&&d.health_events.length)h+=`<div style="margin-top:8px;color:var(--dim)">最近事件: ${d.health_events.slice(0,5).map(e=>e.time+' '+e.event+' '+e.msg).join(' ｜ ')}</div>`;
document.getElementById('metrics').innerHTML=h
const st=d.state||{},rp=d.report||{},sc=d.screen||{};
document.getElementById('careState').innerHTML=`🐳 她的状态<br>精力 <b>${st.energy_label||'—'}</b>（${st.energy??'—'}）｜情绪 <b>${st.mood_label||'—'}</b>（${st.mood??'—'}）<br><span style="color:var(--dim)">${(st.advice||[]).join('；')||'状态正常'}</span>`;
document.getElementById('careReport').innerHTML=`📄 日报 ${rp.date||'今天还没有'}<br>${(rp.anomalies||[]).length?`<span style="color:var(--warn)">${rp.anomalies.join('；')}</span>`:'<span style="color:var(--dim)">暂无异常</span>'}`;
document.getElementById('careScreen').innerHTML=`👁 读屏陪伴 <b>${sc.enabled?'开启':'关闭（默认）'}</b>｜OCR ${sc.ocr_available?'可用':'不可用'}<br><button onclick="toggleScreen(${sc.enabled?'false':'true'})">${sc.enabled?'关闭':'开启'}</button>
<span style="color:var(--dim);font-size:12px">开启后屏幕内容只在本机内存处理，Ctrl+Alt+P 暂停</span>`}

async function makeReport(){const d=await api('/api/report','POST',{});toast(d.ok?'日报已生成':'生成失败：'+(d.msg||''));loadMetrics()}
async function refreshBalance(){const d=await api('/api/balance/refresh','POST',{});toast(d.ok?'资金看板已直查刷新':'刷新失败：'+(d.msg||''));loadMetrics()}
function renderBalance(bal){
const el=document.getElementById('apiBalance');if(!el)return;
const bps=(bal&&bal.providers)||{};
if(!Object.keys(bps).length){el.innerHTML='<span style="color:var(--dim)">未配置厂商（见 config/api_pricing.json）</span>';return}
let h=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
<span style="color:var(--dim);font-size:12px">${bal.updated_at?'更新于 '+bal.updated_at:'未直查（DeepSeek 显示为缓存/待刷新）'}</span>
<button class="ghost" style="font-size:12px" onclick="refreshBalance()">直查刷新</button></div>`;
h+=Object.entries(bps).map(([k,v])=>{
const tag=v.mode==='live'?'直查':'估算';
const dot=v.warn?'bad':(v.status==='ok'||v.status==='estimated')?'ok':'';
let row=`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">
<span><span class="dot" style="background:${v.warn?'var(--bad)':'var(--ok)'};${v.warn?'':'box-shadow:0 0 8px var(--ok)'}"></span>${v.label||k} <span style="color:var(--dim);font-size:12px">（${tag}）</span></span>`;
if(v.status==='ok')row+=`<span style="font-weight:700;color:${v.warn?'var(--bad)':'var(--fg)'}">¥ ${v.balance.toFixed(2)}</span></div>`;
else if(v.status==='estimated'){
const pct=v.budget?Math.min(v.used_this_month/v.budget*100,100):0;
row+=`<span style="color:var(--dim);font-size:13px">已用 ¥${v.used_this_month.toFixed(4)} / ¥${v.budget.toFixed(2)}</span></div>
<div class="pbar"><i style="width:${pct}%;background:${v.warn?'var(--bad)':'var(--acc)'}"></i></div>`}
else row+=`<span style="color:var(--dim);font-size:12px">${v.msg||'未知'}</span></div>`;
if(v.warn)row+=`<div style="color:var(--bad);font-size:12px;padding-top:2px">⚠ 资金告急，路由已自动降级让位</div>`;
return row}).join('');
h+=`<div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;color:var(--dim)">
<span><span class="dot" style="background:var(--ok);box-shadow:0 0 8px var(--ok)"></span>本地 Ollama（兜底）</span><span>¥ 0.00</span></div>`;
el.innerHTML=h}
async function showReport(){const d=await api('/api/report?full=1');const el=document.getElementById('rfull');el.style.display='block';el.textContent=d.text||''}
async function forgetPreview(){const q=document.getElementById('fq').value.trim();if(!q)return toast('先填关键词');
const d=await api('/api/memory/forget','POST',{topic:q,confirm:false,include_diary:document.getElementById('fdiary').checked});
const r=(d.result||{});document.getElementById('fres').textContent=r.topic?`预演：meow ${r.meow} 条 / 通话摘要 ${r.calls} 份 / 日记 ${r.diary} 篇（尚未删除）`:'没有命中'}
async function forgetDo(){const q=document.getElementById('fq').value.trim();if(!q)return toast('先填关键词');
if(q!==document.getElementById('fq').value.trim())return;if(!confirm(`确认让鲸鲸忘掉「${q}」？软删除可在审计里追溯。`))return;
const d=await api('/api/memory/forget','POST',{topic:q,confirm:true,include_diary:document.getElementById('fdiary').checked});
const r=(d.result||{});document.getElementById('fres').textContent=r.moved?`已遗忘：meow ${r.moved.meow} 条 / 摘要 ${r.moved.calls} 份 / 日记 ${r.moved.diary} 篇`:'没有命中'}
async function toggleScreen(on){if(on&&!confirm('开启读屏陪伴后，她将能看到你的屏幕内容（仅本机内存处理、可随时 Ctrl+Alt+P 暂停）。确认开启？'))return;
const d=await api('/api/screen','POST',{enabled:on,confirm:on?true:false});toast(d.ok?('读屏已'+(on?'开启':'关闭')):('操作失败：'+(d.msg||'')));loadMetrics()}

async function memSearch(){const q=document.getElementById('mq').value.trim();if(!q)return toast('先填关键词');
const d=await api('/api/memory?q='+encodeURIComponent(q));
document.getElementById('mres').innerHTML=(d.hits||[]).length?d.hits.slice(0,8).map(h=>`<div>· <span class="badge">${h.source||'?'}</span> ${h.title||h.id||''} <span style="color:var(--dim)">${(h.snippet||'').slice(0,60)}</span></div>`).join(''):'没有命中'}
async function dream(){const d=await api('/api/memory/dream','POST',{});toast(d.ok?'梦境已写进日记':'失败：'+(d.msg||''))}
async function toggleSilent(on){const d=await api('/api/call-mode','POST',{silent:on});toast(d.ok?('静默模式已'+(on?'开启':'关闭')):'设置失败')}
async function loadSilent(){const d=await api('/api/call-mode');document.getElementById('silentck').checked=!!d.silent}
async function judge(){document.getElementById('jres').textContent=' 抽检中…';
const d=await api('/api/persona-judge','POST',{n:5});
document.getElementById('jres').textContent=d.ok===false?(' '+d.msg):(d.avg==null?' 没有可抽检的回复':` 平均 ${d.avg} 分${d.warn?'（低于 '+d.threshold+'，人格可能漂移）':''}`)}

async function loadRelations(){const d=await api('/api/relations');
let h=(d.anniversaries||[]).map(a=>`<div style="color:var(--warn)">🎂 ${a.label}</div>`).join('');
h+='<table><thead><tr><th>谁</th><th>认识天数</th><th>温度</th><th>7天互动</th><th>接受率</th></tr></thead><tbody>'
+(d.everyone||[]).map(r=>`<tr><td>${r.name}</td><td>${r.days}</td><td>${r.score}</td><td>${r.interactions_7d}</td><td>${r.accept_rate==null?'—':(r.accept_rate*100).toFixed(0)+'%'}</td></tr>`).join('')+'</tbody></table>';
document.getElementById('rel').innerHTML=h}
async function loadSandbox(){const d=await api('/api/cost-sandbox');
if(d.ok===false){document.getElementById('sandbox').textContent=d.msg;return}
const rows=(d.scenes||[]).map(s=>`<tr><td>${s.scene}</td><td>${s.turns}</td><td>${s.tokens_per_day}</td><td>¥${s.cost_per_day.toFixed(3)}${s.over_cap?' <span style="color:var(--bad)">超配额</span>':''}</td></tr>`).join('');
document.getElementById('sandbox').innerHTML=`<table><thead><tr><th>场景</th><th>次数/日</th><th>token/日</th><th>预估费用/日</th></tr></thead><tbody>${rows}</tbody></table>
<div style="margin-top:6px">合计约 <b>¥${(d.total_per_day||0).toFixed(2)}</b>/天、<b>¥${(d.total_per_month||0).toFixed(2)}</b>/月（月上限 ¥${d.monthly_cost_cap||'-'}）</div>
<div style="color:var(--dim);font-size:12px">${d.note||''}</div>`}
async function contentCreate(){const t=document.getElementById('ct').value.trim(),b=document.getElementById('cb').value.trim();
if(!t||!b)return toast('标题和正文都要填');
const d=await api('/api/content','POST',{action:'create',source:'manual',title:t,body:b});toast(d.ok?'已登记':'失败：'+(d.msg||''));loadContent()}
async function contentAct(id,action,platform){const d=await api('/api/content','POST',{action,id,platform});toast(d.ok?'完成':'失败：'+(d.msg||''));loadContent()}
async function loadContent(){const d=await api('/api/content');
document.getElementById('clist').innerHTML=(d.items||[]).map(it=>`<div style="margin-bottom:8px">· <b>${it.title}</b> <span class="badge">${it.status}</span><br>${['bilibili','douyin','qq'].map(p=>`<span style="margin-right:8px">${p}: ${it.platforms&&it.platforms[p]?(it.approved&&it.approved.includes(p)?'✅已审核':`<button class="ghost" onclick="contentAct('${it.id}','approve','${p}')">审核</button>`):`<button class="ghost" onclick="contentAct('${it.id}','rewrite','${p}')">改写</button>`}</span>`).join('')}</div>`).join('')||'还没有素材'}
async function snapCreate(){const d=await api('/api/persona-snapshot','POST',{action:'create',note:document.getElementById('snapnote').value});toast(d.ok?'快照已建':'失败：'+(d.msg||''));loadSnaps()}
async function distillRun(apply){const p=document.getElementById('distillpath').value.trim();if(!p)return toast('先填素材路径');
const card=document.getElementById('distillcard').value.trim()||'little_whale';
const el=document.getElementById('distillout');el.style.display='block';el.textContent=apply?'蒸馏并写卡中…（LLM 调用，稍等）':'蒸馏中…（LLM 调用，稍等）';
const d=await api('/api/persona-distill','POST',{path:p,card,apply});
if(!d.ok){el.textContent='失败：'+(d.msg||'');return}
let t=(d.new_card?'【将新建人格卡：'+d.card+'】\n':'')+'台词 '+d.transcript_chars+' 字\n新增：'+JSON.stringify(d.added)+(d.voice_ref?'\n音色参考：'+d.voice_ref.ref_audio_path+'\n  prompt: '+d.voice_ref.prompt_text:'\n音色参考：无（文本素材无音频）')+'\n\n蒸馏结果：\n'+JSON.stringify(d.distilled,null,2);
if(d.applied)t+='\n\n'+(d.new?'已新建人格卡':'已写卡（备份 '+d.backup+'）')+'；重启 Tulpa 会话后生效';
else t+='\n\n（预览，未写卡）';
el.textContent=t;if(apply)toast(d.new_card?'人格卡已新建':'人格卡已更新')}
async function snapRollback(id){if(!confirm('回滚到快照 '+id+'？当前状态会先自动存一份。'))return;
const d=await api('/api/persona-snapshot','POST',{action:'rollback',id});toast(d.ok?('已回滚（当前状态存为 '+d.guard_snapshot+'）'):'失败：'+(d.msg||''));loadSnaps()}
async function loadSnaps(){const d=await api('/api/persona-snapshots');
document.getElementById('snaplist').innerHTML=(d.snapshots||[]).map(s=>`<div>· ${s.id} <span style="color:var(--dim)">${s.date} ${s.note||''}（${s.files} 文件）</span> <button class="ghost" onclick="snapRollback('${s.id}')">回滚</button></div>`).join('')||'还没有快照'}
async function loadTimeline(){const sel=document.getElementById('tldate');const date=sel.value;
const d=await api('/api/timeline'+(date?'?date='+date:''));
if(!sel.options.length){sel.innerHTML='<option value="">最近 50 条</option>'+(d.days||[]).map(x=>`<option>${x}</option>`).join('')}
document.getElementById('tllist').innerHTML=(d.events||[]).map(e=>`<div>· ${new Date(e.ts*1000).toTimeString().slice(0,8)} <span class="badge">${e.type}</span> ${e.source} <span style="color:var(--dim)">${JSON.stringify(e.payload).slice(0,80)}</span></div>`).join('')||'没有事件'}
async function loadPrivacy(){const d=await api('/api/privacy');
document.getElementById('privacy').innerHTML=(d.sections||[]).map(s=>`<div style="margin-bottom:8px">· ${s.ok?'✅':'❌'} <b>${s.name}</b><br><span style="color:var(--dim);font-size:12px">${(s.lines||[]).join('<br>')}</span></div>`).join('')||'暂无数据'}

async function selfCheck(){document.getElementById('sck').textContent='自检中…';const deep=document.getElementById('deepck').checked?'?deep=1':'';const d=await api('/api/selfcheck'+deep);
document.getElementById('sck').innerHTML='<table>'+d.map(i=>`<tr><td>${i.ok?'✅':'❌'}</tr></td><td>${i.name}</td><td style="color:var(--dim)">${i.detail}</td></tr>`).join('')+'</table>'}

async function loadLogs(){const d=await api('/api/logs');document.getElementById('logsel').innerHTML='<option value="">选择日志…</option>'+d.map(l=>`<option value="${l.path}">${l.name} (${(l.size/1024).toFixed(0)}KB)</option>`).join('')}
async function loadLog(){const p=document.getElementById('logsel').value;if(!p)return;
const d=await api('/api/log?path='+encodeURIComponent(p));document.getElementById('logview').textContent=d.text}

async function loadP2(){const d=await api('/api/p2');let h='';
const g=d.goals||{};if((g.items||[]).length)h+='🎯 小目标：'+g.items.map(i=>`<span style="${i.done?'text-decoration:line-through;color:var(--dim)':''}">${i.text}</span>${i.done?'':` <button class="ghost" style="padding:1px 8px;font-size:11px" onclick="goalDone('${i.id}')">勾</button>`}`).join(' ｜ ')+'<br>';
if((d.capsules_due||[]).length)h+=`⏳ <b style="color:var(--warn)">${d.capsules_due.length} 颗时间胶囊到期：</b> `+d.capsules_due.map(c=>`${c.author}写于${c.created} <button class="ghost" style="padding:1px 8px;font-size:11px" onclick="capOpen('${c.id}')">拆开</button>`).join(' ')+'<br>';
if((d.review_pending||[]).length)h+=`🧠 求证队列 ${d.review_pending.length} 条：`+d.review_pending.slice(0,3).map(r=>`「${r.title}」 <button class="ghost" style="padding:1px 8px;font-size:11px" onclick="asked('${encodeURIComponent(r.title)}')">已问过</button>`).join(' ')+'<br>';
const al=d.allowance||{};if(al.budget!=null)h+=`💰 零花钱（虚拟）：本月 ¥${al.spent} / ¥${al.budget} <span style="color:${al.over?'var(--bad)':'var(--dim)'}">${al.line||''}</span><br>`;
const cr=d.care||{};h+=`💗 关怀：今日提醒 ${cr.nudges_today||0} 次${cr.idle_minutes!=null?`｜主人已 ${Math.round(cr.idle_minutes)} 分钟没动过`:''}<br>`;
if(d.observe)h+=`👀 ${d.observe}<br>`;
if((d.reminders||[]).length)h+='📅 '+d.reminders.map(r=>`「${r.title}」${r.in_minutes<60?r.in_minutes+'分钟后':Math.round(r.in_minutes/60)+' 小时后'}`).join('；')+'<br>';
const fp=d.fingerprint||{};if(fp.drift&&fp.drift.length)h+=`🗣 语言指纹：<span style="color:var(--warn)">${fp.drift.join('；')}</span><br>`;
const cs=d.consistency||{};if((cs.conflicts||[]).length)h+=`⚡ 人格裂缝 ${cs.conflicts.length} 处：`+cs.conflicts.slice(0,3).map(c=>`「${c.topic}」(${c.pos}/${c.neg})`).join(' ')+'<br>';
const dk=d.desk||{};if(dk.ok&&(dk.suggestions||[]).length)h+=`🗂 桌面：${dk.suggestions.join('；')}<br>`;
const gr=(d.growth||[]);const un=gr.filter(x=>x.unlocked);if(un.length)h+=`🌱 技能树：已解锁 ${un.length}/${gr.length}（${un.slice(-3).map(x=>x.name).join('、')}）<br>`;
if((d.mails||[]).length)h+=`📮 语音留言 ${d.mails.length} 条（最近：${(d.mails[0].text||'').slice(0,20)}）<br>`;
if(d.env&&d.env.line)h+='🌐 '+d.env.line+'<br>';
document.getElementById('p2sum').innerHTML=h||'暂无动态';
document.getElementById('sdbtn').textContent=(d.silent_day&&d.silent_day.silent)?'解除静默日':'一键静默日'}
async function goalGen(){await api('/api/goals','POST',{action:'gen'});loadP2()}
async function goalDone(id){await api('/api/goals','POST',{action:'done',id});loadP2()}
async function rebuildReview(){const d=await api('/api/memory-review','POST',{action:'rebuild'});toast(d.ok?('队列新增 '+d.added+' 条'):'失败');loadP2()}
async function asked(t){await api('/api/memory-review','POST',{action:'asked',title:decodeURIComponent(t)});loadP2()}
async function exportDiary(){const d=await api('/api/memory-review','POST',{action:'export',mask:true});toast(d.ok?('已导出 '+d.entries+' 篇 → '+d.path):'失败：'+(d.msg||''))}
async function toggleSilentDay(){const d=await api('/api/p2');const on=!(d.silent_day&&d.silent_day.silent);const r=await api('/api/silent-day','POST',{enabled:on});toast(r.ok?(on?'今天她完全静默':'静默已解除'):'失败');loadP2()}
async function capCreate(){const dt=document.getElementById('capdate').value.trim(),tx=document.getElementById('captext').value.trim();if(!dt)return toast('先填拆信日期');
const d=await api('/api/capsule','POST',tx?{action:'create',open_date:dt,text:tx}:{action:'gen',open_date:dt});toast(d.ok?'胶囊已封存':'失败：'+(d.msg||''));loadP2()}
async function capOpen(id){const d=await api('/api/capsule','POST',{action:'open',id});if(d.ok&&d.capsule)alert('💌 '+d.capsule.author+' 写于 '+d.capsule.created+'：\n\n'+d.capsule.text);loadP2()}
async function vmLeave(){const t=document.getElementById('vmtext').value.trim();if(!t)return toast('先写点内容');const d=await api('/api/voicemail','POST',{text:t});toast(d.ok?(d.mail.wav?'语音已合成':'已存文本（TTS 不在线）'):'失败：'+(d.msg||''));loadP2()}
async function contentDiary(){const d=await api('/api/content','POST',{action:'from_diary'});toast(d.ok?'已生成日记草稿':'失败：'+(d.msg||''));loadContent()}
async function loadRunbook(){const d=await api('/api/runbook');document.getElementById('runbook').innerHTML=(d.items||[]).map(r=>`<button class="ghost" style="margin-right:8px" onclick="showRb('${r.id}')">${r.title}</button>`).join('')+'<div id="rbsteps" style="margin-top:8px"></div>'}
async function showRb(id){const d=await api('/api/runbook?id='+id);if(!d.found)return;document.getElementById('rbsteps').innerHTML='<b>'+d.title+'</b><ol>'+d.steps.map(s=>`<li>${s}</li>`).join('')+'</ol>'}

/* --- Hash 路由：按需加载，刷新/前进后退保持当前页 --- */
const PAGE_LOADS={dashboard:[loadSvcs,loadMetrics],ops:[loadDeploy,loadCron,loadKeys,loadQqMaster,loadLogs,loadRunbook],ai:[loadSandbox,loadContent,loadSnaps,loadTimeline],companion:[loadRelations,loadPrivacy,loadP2,loadSilent]};
function navigate(id){if(!PAGE_LOADS[id])id='dashboard';
document.querySelectorAll('.page-view').forEach(e=>e.classList.remove('active'));
document.querySelectorAll('.nav-btn').forEach(e=>e.classList.toggle('active',e.dataset.page===id));
const pv=document.getElementById('page-'+id);if(pv)pv.classList.add('active');
if(location.hash!=='#'+id)history.replaceState(null,'','#'+id);
PAGE_LOADS[id].forEach(f=>{try{f()}catch(e){}})}
window.addEventListener('hashchange',()=>navigate(location.hash.replace('#','')||'dashboard'));
navigate(location.hash.replace('#','')||'dashboard');
setInterval(()=>{if(document.getElementById('page-dashboard').classList.contains('active'))loadSvcs()},10000);
setInterval(()=>{if(document.getElementById('page-dashboard').classList.contains('active'))loadMetrics()},30000);
</script></body></html>"""

# 手机只读面板（默认关闭，config/console_mobile.json 开启；仅局域网/本机，token 同源）
MOBILE_PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0f141b">
<title>Persona-OS · 手机面板（只读）</title>
<style>body{background:#0f141b;color:#dbe6f4;font:15px/1.7 sans-serif;margin:0;padding:18px}
h1{font-size:18px}.c{background:#1a2230;border:1px solid #2a3547;border-radius:10px;padding:12px 14px;margin-bottom:10px}
button{background:#e5534b;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px}</style></head><body>
<h1>🐋 手机面板（只读 + 一键停止全部）</h1>
<div class="c" id="dream">🌙 还没有梦</div>
<div id="m">加载中…</div>
<div class="c"><button onclick="stopAll()">■ 一键停止全部服务</button><span id="sr"></span></div>
<script>
const T=new URLSearchParams(location.search).get('token')||'';
fetch('/api/metrics',{headers:{'X-Console-Token':T}}).then(r=>r.json()).then(d=>{
const st=d.state||{},l=d.llm||{},rp=d.report||{},c=d.call||{},bp=(d.balance||{}).providers||{};
const balLine=Object.entries(bp).map(([k,v])=>{
const clr=v.warn?'#e5534b':'#3ecf8e';
const body=v.status==='ok'?`¥${v.balance.toFixed(2)}`:v.status==='estimated'?`已用 ¥${v.used_this_month} / ¥${v.budget}`:(v.msg||'—');
return `<div>${v.label||k}（${v.mode==='live'?'直查':'估算'}）：<span style="color:${clr}">${body}</span></div>`}).join('');
document.getElementById('m').innerHTML=
`<div class="c">🐳 她的状态<br>精力 ${st.energy_label||'—'}｜情绪 ${st.mood_label||'—'}</div>
<div class="c">📞 通话<br>今日轮次 ${c.turns||0}${c.p95?`｜P95 ${c.p95}s`:''}</div>
<div class="c">🧠 LLM<br>今日 ${l.today_tokens||0} token｜¥${(l.today_cost||0).toFixed(3)}</div>
${balLine?`<div class="c">💳 API 资金<br>${balLine}</div>`:''}
<div class="c">📄 日报 ${rp.date||'未生成'}<br>${(rp.anomalies||[]).join('；')||'暂无异常'}</div>`;
}).catch(e=>{document.getElementById('m').textContent='加载失败：'+e});
fetch('/api/dream-latest',{headers:{'X-Console-Token':T}}).then(r=>r.json()).then(d=>{
if(d.text)document.getElementById('dream').innerHTML='🌙 梦 · '+d.date+'<br><span style="color:#9fb3c8">'+d.text.replace(/\n+/g,'<br>')+'</span>'});
fetch('/api/p2',{headers:{'X-Console-Token':T}}).then(r=>r.json()).then(d=>{if(d.env&&d.env.line)document.getElementById('dream').insertAdjacentHTML('beforebegin','<div class="c">🌐 '+d.env.line+'</div>')});
async function stopAll(){if(!confirm('确认停止全部服务？'))return;
const r=await fetch('/api/stop-all',{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':T},body:'{}'});
const d=await r.json();document.getElementById('sr').textContent=' '+d.msg}
</script></body></html>"""


MANIFEST = {"name": "Persona-OS 控制台", "short_name": "Persona-OS",
            "start_url": "/mobile", "display": "standalone",
            "background_color": "#0f141b", "theme_color": "#0f141b",
            "icons": [{"src": "/icon.svg", "sizes": "any",
                       "type": "image/svg+xml"}]}

ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
<rect width="512" height="512" rx="96" fill="#0f141b"/>
<text x="256" y="340" font-size="230" text-anchor="middle">🐋</text>
</svg>"""


def dream_latest() -> dict:
    """最近一篇梦境日记（手机面板用），没有返回 {}。"""
    d = ROOT / "diary"
    if not d.is_dir():
        return {}
    fs = sorted(d.glob("dream-*.md"), reverse=True)
    if not fs:
        return {}
    try:
        return {"date": fs[0].stem[6:], "text": fs[0].read_text("utf-8")}
    except OSError:
        return {}


def p2_summary() -> dict:
    """P2/P3 聚合状态：一个接口喂饱「陪伴进阶」卡片。单项失败不影响整体。"""
    out = {}
    def _safe(key, fn, default=None):
        try:
            out[key] = fn() if fn else default
        except Exception:
            out[key] = default
    _safe("goals", goals.today if goals else None, {"items": []})
    _safe("capsules_due", time_capsule.due if time_capsule else None, [])
    _safe("review_pending", memory_review.pending if memory_review else None, [])
    _safe("care", care.status if care else None, {})
    _safe("observe", care.observe_day if care else None, "")
    _safe("allowance", allowance.status if allowance else None, {})
    _safe("env", context_engine.snapshot if context_engine else None, {})
    _safe("silent_day", silent_day.status if silent_day else None, {})
    _safe("growth", growth.list_all if growth else None, [])
    _safe("consistency", consistency.check if consistency else None, {})
    _safe("fingerprint", fingerprint.analyze if fingerprint else None, {})
    _safe("desk", desk_tidy.scan if desk_tidy else None, {})
    _safe("reminders", calendar_watch.due_reminders if calendar_watch else None, [])
    _safe("mails", voice_mail.list_all if voice_mail else None, [])
    _safe("stories", sleep_story.list_themes if sleep_story else None, [])
    return out

# ---------- HTTP ----------

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        """Host 白名单（挡 DNS rebinding）+ 一次性 token（挡 CSRF）。
        手机面板开 LAN 时（console_mobile.json enabled+lan）追加本机局域网 IP。"""
        host = (self.headers.get("Host") or "").lower()
        if not any(host.startswith(p) for p in ALLOWED_HOSTS):
            return False
        tok = parse_qs(urlparse(self.path).query).get("token", [""])[0] or \
            self.headers.get("X-Console-Token", "")
        return tok == TOKEN

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/" and not self._auth():
            body = ("<meta charset=utf-8><body style='background:#0f141b;color:#dbe6f4;"
                    "font-family:sans-serif;padding:40px'>链接无效或已过期。<br>"
                    "请复制控制台窗口里打印的完整链接（带 token）打开。</body>"
                    ).encode("utf-8")
            self.send_response(403)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not self._auth():
            self._json({"ok": False, "msg": "鉴权失败（Host 或 token 不合法）"}, 403)
            return
        if u.path == "/":
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/status":
            self._json({"services": svc_status(), "hints": todo_hints(),
                        "health": {"enabled": HEALTH["enabled"],
                                   "events": HEALTH["events"][:8]},
                        "startall": {"running": STARTALL["running"],
                                     "log": STARTALL["log"][-30:]}})
        elif u.path == "/api/deploy":
            self._json(deploy_list())
        elif u.path == "/api/deploy/output":
            self._json(deploy_output(parse_qs(u.query).get("task", [""])[0]))
        elif u.path == "/api/cron":
            self._json(cron_list())
        elif u.path == "/api/metrics":
            self._json(metrics_summary())
        elif u.path == "/api/selfcheck":
            items = self_check()
            if parse_qs(u.query).get("deep"):
                items += self_check_deep()
            self._json(items)
        elif u.path == "/api/keys":
            self._json(keys_status())
        elif u.path == "/api/qq-master":
            self._json({"qq": qq_master_get()})
        elif u.path == "/api/logs":
            self._json(log_list())
        elif u.path == "/api/log":
            q = parse_qs(u.query)
            self._json({"text": log_tail(q.get("path", [""])[0])})
        elif u.path == "/api/state":
            self._json(state_engine.status() if state_engine else {})
        elif u.path == "/api/report":
            q = parse_qs(u.query)
            if q.get("full"):
                p = (ROOT / "data" / "reports" / (time.strftime("%Y-%m-%d") + ".md"))
                self._json({"text": p.read_text("utf-8") if p.is_file() else "今天还没生成日报"})
            else:
                self._json(daily_report.latest() if daily_report else {})
        elif u.path == "/api/memory":
            q = parse_qs(u.query)
            topic = q.get("q", [""])[0]
            self._json({"topic": topic,
                        "hits": memory_bus.search(topic, 20) if memory_bus else []})
        elif u.path == "/api/screen":
            self._json(screen_buddy.status() if screen_buddy else {"enabled": False})
        elif u.path == "/api/audit":
            self._json({"memory": memory_bus.audit(40) if memory_bus else []})
        elif u.path == "/api/relations":
            if relations:
                self._json({"everyone": relations.everyone(),
                            "anniversaries": relations.anniversaries_today()})
            else:
                self._json({"everyone": [], "anniversaries": []})
        elif u.path == "/api/cost-sandbox":
            if cost_sandbox:
                try:
                    self._json(cost_sandbox.simulate())
                except Exception as e:
                    self._json({"ok": False, "msg": type(e).__name__})
            else:
                self._json({"ok": False, "msg": "成本沙盘模块不可用"})
        elif u.path == "/api/privacy":
            self._json(privacy_dashboard.summary() if privacy_dashboard else {})
        elif u.path == "/api/timeline":
            q = parse_qs(u.query)
            if not timeline:
                self._json({"days": [], "events": []})
            else:
                date = q.get("date", [""])[0]
                if date:
                    self._json({"date": date, "events": timeline.day(date)})
                else:
                    self._json({"days": timeline.days()[:14],
                                "events": timeline.recent(50)})
        elif u.path == "/api/content":
            self._json({"items": content_pipeline.list_items()
                        if content_pipeline else []})
        elif u.path == "/api/persona-snapshots":
            self._json({"snapshots": persona_snapshot.list_all()
                        if persona_snapshot else []})
        elif u.path == "/api/personas":
            self._json({"characters": persona_switch.list_characters()
                        if persona_switch else [],
                        "active": persona_switch.active_id()
                        if persona_switch else None})
        elif u.path == "/api/avatar":
            chars = []
            if persona_switch:
                for c in persona_switch.list_characters():
                    c["pet_model"] = persona_pet_map(c["id"])
                    chars.append(c)
            self._json({"ok": True, "personas": chars,
                        "active_persona": persona_switch.active_id()
                        if persona_switch else None,
                        "pet_models": pet_models(),
                        "active_model": pet_current_model(),
                        "pet_installed": PET_EXE.is_file()})
        elif u.path == "/api/call-mode":
            p = ROOT / "config" / "call_mode.json"
            try:
                self._json(json.loads(p.read_text("utf-8")))
            except Exception:
                self._json({"silent": False})
        elif u.path == "/api/p2":
            self._json(p2_summary())
        elif u.path == "/api/runbook":
            q = parse_qs(u.query)
            rid = q.get("id", [""])[0]
            if runbook is None:
                self._json({"found": False})
            elif rid:
                self._json(runbook.show(rid))
            else:
                self._json({"items": runbook.list_all()})
        elif u.path == "/manifest.json":
            body = json.dumps(MANIFEST, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/manifest+json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/icon.svg":
            body = ICON_SVG.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/dream-latest":
            self._json(dream_latest())
        elif u.path == "/mobile":
            mp = ROOT / "config" / "console_mobile.json"
            try:
                en = bool(json.loads(mp.read_text("utf-8")).get("enabled"))
            except Exception:
                en = False
            if not en:
                self._json({"ok": False,
                            "msg": "手机面板默认关闭：把 config/console_mobile.json "
                                   "的 enabled 改为 true 再开"}, 403)
                return
            body = MOBILE_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json({"ok": False}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        if not self._auth():
            self._json({"ok": False, "msg": "鉴权失败（Host 或 token 不合法）"}, 403)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        if u.path == "/api/service":
            sid, act = body.get("id", ""), body.get("action", "")
            if act == "stop":
                MANUAL_STOP[sid] = time.time()
            elif act == "start":
                MANUAL_STOP.pop(sid, None)
            ok, msg = svc_action(sid, act)
            if timeline:
                timeline.emit("svc", "console", id=sid, action=act, ok=ok)
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/start-all":
            ok, msg = start_all(dry=bool(body.get("dry")))
            if timeline:
                timeline.emit("svc", "console", id="all", action="start", ok=ok)
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/stop-all":
            ok, msg = stop_all()
            if timeline:
                timeline.emit("svc", "console", id="all", action="stop", ok=ok)
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/watchdog":
            ok, msg = set_watchdog(body.get("enabled", False))
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/deploy":
            ok, msg = deploy_run(body.get("id", ""))
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/cron":
            ok, msg = cron_set(body.get("id", ""), body.get("enabled", False))
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/keys":
            ok, msg = key_write(body.get("key", ""), body.get("value", ""))
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/qq-master":
            ok, msg = qq_master_set(body.get("qq", ""))
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/qq-login":
            ok, msg = qq_login()
            self._json({"ok": ok, "msg": msg})
        elif u.path == "/api/report":
            if not daily_report:
                self._json({"ok": False, "msg": "日报模块不可用"})
            else:
                try:
                    r = daily_report.run(notify=False)
                    self._json({"ok": True, "path": r["path"],
                                "anomalies": r["anomalies"], "voice": r["voice"]})
                except Exception as e:
                    self._json({"ok": False, "msg": type(e).__name__})
        elif u.path == "/api/balance/refresh":
            try:
                import balance_monitor
                self._json({"ok": True, "balance": balance_monitor.update_all()})
            except Exception as e:
                self._json({"ok": False, "msg": type(e).__name__})
        elif u.path == "/api/memory/forget":
            if not memory_bus:
                self._json({"ok": False, "msg": "记忆模块不可用"})
            else:
                topic = str(body.get("topic", "")).strip()
                try:
                    r = memory_bus.forget(topic, include_diary=bool(body.get("include_diary")),
                                          yes=bool(body.get("confirm")))
                    self._json({"ok": True, "result": r})
                except Exception as e:
                    self._json({"ok": False, "msg": type(e).__name__})
        elif u.path == "/api/screen":
            if not screen_buddy:
                self._json({"ok": False, "msg": "读屏模块不可用"})
            else:
                want = bool(body.get("enabled"))
                if want and not body.get("confirm"):
                    self._json({"ok": False,
                                "msg": "开启读屏需要二次确认（她将能看到你的屏幕内容）"})
                else:
                    cfg = screen_buddy.load_config()
                    cfg["enabled"] = want
                    screen_buddy.save_config(cfg)
                    self._json({"ok": True, "status": screen_buddy.status()})
        elif u.path == "/api/persona-judge":
            if not persona_judge:
                self._json({"ok": False, "msg": "裁判模块不可用"})
            else:
                try:
                    self._json(persona_judge.judge_recent(int(body.get("n", 5))))
                except Exception as e:
                    msg = str(e) if type(e).__name__ == "GateError" else type(e).__name__
                    self._json({"ok": False, "msg": msg})
        elif u.path == "/api/persona-switch":
            if not persona_switch:
                self._json({"ok": False, "msg": "角色切换模块不可用"})
            else:
                try:
                    self._json(persona_switch.switch_character(
                        str(body.get("id", ""))))
                except Exception as e:
                    self._json({"ok": False, "msg": str(e)})
        elif u.path == "/api/call-mode":
            p = ROOT / "config" / "call_mode.json"
            try:
                cur = json.loads(p.read_text("utf-8"))
            except Exception:
                cur = {}
            cur["silent"] = bool(body.get("silent"))
            p.write_text(json.dumps(cur, ensure_ascii=False), "utf-8")
            self._json({"ok": True, "silent": cur["silent"]})
        elif u.path == "/api/content":
            if not content_pipeline:
                self._json({"ok": False, "msg": "内容工坊模块不可用"})
            else:
                act = body.get("action", "")
                try:
                    if act == "create":
                        self._json({"ok": True,
                                    "item": content_pipeline.create(
                                        str(body.get("source", "manual")),
                                        str(body.get("title", "")),
                                        str(body.get("body", "")))})
                    elif act == "rewrite":
                        self._json({"ok": True,
                                    "item": content_pipeline.rewrite(
                                        str(body.get("id", "")),
                                        str(body.get("platform", "bilibili")))})
                    elif act == "approve":
                        self._json({"ok": True,
                                    "item": content_pipeline.approve(
                                        str(body.get("id", "")),
                                        str(body.get("platform", "")))})
                    elif act == "from_diary":
                        self._json({"ok": True,
                                    "item": content_pipeline.draft_from_diary(
                                        str(body.get("date", "")) or None)})
                    else:
                        self._json({"ok": False, "msg": "未知 action"})
                except Exception as e:
                    self._json({"ok": False, "msg": str(e) or type(e).__name__})
        elif u.path == "/api/persona-snapshot":
            if not persona_snapshot:
                self._json({"ok": False, "msg": "快照模块不可用"})
            else:
                act = body.get("action", "")
                try:
                    if act == "create":
                        self._json({"ok": True, "snapshot": persona_snapshot.create(
                            note=str(body.get("note", "")))})
                    elif act == "rollback":
                        self._json({"ok": True,
                                    **persona_snapshot.rollback(str(body.get("id", "")))})
                    else:
                        self._json({"ok": False, "msg": "未知 action"})
                except Exception as e:
                    self._json({"ok": False, "msg": str(e) or type(e).__name__})
        elif u.path == "/api/persona-distill":
            if not persona_distill:
                self._json({"ok": False, "msg": "蒸馏模块不可用"})
            else:
                try:
                    r = persona_distill.run(
                        str(body.get("path", "")),
                        card_name=str(body.get("card", "little_whale")) or "little_whale",
                        apply=bool(body.get("apply")))
                    self._json({"ok": True, **r})
                except Exception as e:
                    self._json({"ok": False, "msg": str(e) or type(e).__name__})
        elif u.path == "/api/memory/dream":
            if not memory_bus:
                self._json({"ok": False, "msg": "记忆模块不可用"})
            else:
                try:
                    r = memory_bus.dream(force=True)
                    self._json({"ok": True, "dream": r})
                except Exception as e:
                    self._json({"ok": False, "msg": type(e).__name__})
        elif u.path == "/api/goals":
            if goals is None:
                self._json({"ok": False, "msg": "目标模块不可用"})
            else:
                act = body.get("action", "")
                if act == "gen":
                    self._json({"ok": True, **goals.generate()})
                elif act == "done":
                    self._json({"ok": True, **goals.complete(str(body.get("id", "")))})
                else:
                    self._json({"ok": True, **goals.today()})
        elif u.path == "/api/capsule":
            if time_capsule is None:
                self._json({"ok": False, "msg": "胶囊模块不可用"})
            else:
                act = body.get("action", "")
                try:
                    if act == "create":
                        self._json({"ok": True, "capsule": time_capsule.create(
                            str(body.get("text", "")), str(body.get("open_date", "")))})
                    elif act == "gen":
                        self._json({"ok": True, "capsule": time_capsule.generate(
                            str(body.get("open_date", "")), str(body.get("hint", "")))})
                    elif act == "open":
                        self._json({"ok": True, **time_capsule.open_one(
                            str(body.get("id", "")))})
                    else:
                        self._json({"ok": False, "msg": "未知 action"})
                except Exception as e:
                    self._json({"ok": False, "msg": str(e) or type(e).__name__})
        elif u.path == "/api/silent-day":
            if silent_day is None:
                self._json({"ok": False, "msg": "模块不可用"})
            else:
                r = silent_day.enable() if body.get("enabled") else silent_day.disable()
                self._json({"ok": True, **r})
        elif u.path == "/api/memory-review":
            if memory_review is None:
                self._json({"ok": False, "msg": "模块不可用"})
            else:
                act = body.get("action", "")
                if act == "rebuild":
                    self._json({"ok": True, **memory_review.rebuild_queue()})
                elif act == "asked":
                    self._json({"ok": True,
                                **memory_review.mark_asked(str(body.get("title", "")))})
                elif act == "export":
                    try:
                        self._json({"ok": True, **memory_review.export_diaries(
                            mask=bool(body.get("mask")))})
                    except Exception as e:
                        self._json({"ok": False, "msg": type(e).__name__})
                else:
                    self._json({"ok": False, "msg": "未知 action"})
        elif u.path == "/api/voicemail":
            if voice_mail is None:
                self._json({"ok": False, "msg": "留言模块不可用"})
            else:
                self._json(voice_mail.leave(str(body.get("text", ""))))
        else:
            self._json({"ok": False}, 404)


def main():
    port = PORT
    # 8900 被占用时自动顺延（最多试 10 个端口）
    for _ in range(10):
        if port_pid(port) is None:
            break
        print("端口 %d 被占用，顺延到 %d" % (port, port + 1))
        port += 1
    # 启动时自动迁移明文密钥进 DPAPI 保险库，文件改占位符
    if key_vault:
        try:
            for line in key_vault.migrate():
                print("密钥迁移:", line)
        except Exception:
            pass
    # 每天 23:50 后自动生成日报（控制台开着就管；长期无人值守请另挂 Windows 计划任务）
    if daily_report:
        def _report_loop():
            while True:
                try:
                    now = time.localtime()
                    if (now.tm_hour, now.tm_min) >= (23, 50):
                        p = ROOT / "data" / "reports" / (time.strftime("%Y-%m-%d") + ".md")
                        if not p.is_file():
                            daily_report.run(notify=True)
                            print("已生成今日日报：%s" % p)
                except Exception as e:
                    print("日报生成失败：%s" % e)
                time.sleep(600)
        threading.Thread(target=_report_loop, daemon=True).start()
    # 手机面板开 LAN 时绑 0.0.0.0，并把局域网 IP 加进 Host 白名单
    bind, lip = "127.0.0.1", ""
    try:
        mc = json.loads((ROOT / "config" / "console_mobile.json").read_text("utf-8"))
        if mc.get("enabled") and mc.get("lan"):
            lip = lan_ip()
            if lip:
                bind = "0.0.0.0"
                ALLOWED_HOSTS.append(lip + ":")
    except Exception:
        pass
    srv = ThreadingHTTPServer((bind, port), H)
    print("控制台已启动（复制下面整行到浏览器，token 每次启动都会变）:")
    print("  http://127.0.0.1:%d/?token=%s" % (port, TOKEN))
    if lip:
        print("手机面板（同一 Wi-Fi 下手机浏览器打开，可加主屏幕）:")
        print("  http://%s:%d/mobile?token=%s" % (lip, port, TOKEN))
    print("Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
