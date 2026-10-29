# -*- coding: utf-8 -*-
"""小鲸鱼 · 共同日历（P2）：本地 ICS 只读导入 + 到点提醒

她记得你的会议、生日、ddl：把日历软件导出的 .ics 文件放进来，她按
config/calendar.json 的提醒窗口提前用角色口吻提醒（走日报/告警通道）。
只读导入，永不回写日历源文件。

ICS 解析刻意最小：只认 SUMMARY / DTSTART / DTEND，够自用；Z 结尾的 UTC
时间按本地时区换算（用系统时区偏移）。

CLI：
    python tools/calendar_watch.py import path/to/cal.ics
    python tools/calendar_watch.py upcoming [天数]
    python tools/calendar_watch.py remind      # 到点提醒（日报/控制台调用）
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "calendar.json"
ICS_DIR = ROOT / "data" / "calendar"
STATE_FILE = ROOT / "data" / "calendar_reminded.json"

DEFAULT_CONFIG = {"sources": [], "remind_minutes": [1440, 60]}


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    return merged


def save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def import_ics(path: Path) -> dict:
    """把外部 ics 拷进 data/calendar/ 并登记为源（只读来源，不回写）。"""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    ICS_DIR.mkdir(parents=True, exist_ok=True)
    dst = ICS_DIR / path.name
    shutil.copyfile(path, dst)
    cfg = load_config()
    if path.name not in cfg["sources"]:
        cfg["sources"].append(path.name)
        save_config(cfg)
    return {"imported": path.name, "sources": cfg["sources"]}


def _parse_dt(v: str) -> float:
    """DTSTART 值 → 本地时间戳。支持 20261028T100000(Z) / 20261028。"""
    v = v.strip()
    m = re.match(r"^(\d{8})T(\d{6})(Z?)$", v)
    try:
        if m:
            t = time.mktime(time.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"))
            if m.group(3) == "Z":  # UTC → 本地
                t -= time.timezone if time.localtime().tm_isdst == 0 else time.altzone
                t += 0  # timezone 已是「本地-UTC」秒数，减它即得 UTC 对应的本地戳
            return t
        return time.mktime(time.strptime(v[:8], "%Y%m%d"))
    except Exception:
        return 0.0


def events() -> list:
    """汇总所有已登记源的 VEVENT。"""
    out = []
    for name in load_config()["sources"]:
        f = ICS_DIR / name
        if not f.is_file():
            continue
        try:
            text = f.read_text("utf-8", errors="replace")
        except OSError:
            continue
        for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
            summary = re.search(r"SUMMARY[^:]*:(.+)", block)
            dtstart = re.search(r"DTSTART[^:]*:(.+)", block)
            dtend = re.search(r"DTEND[^:]*:(.+)", block)
            out.append({"title": (summary.group(1).strip() if summary else "（无标题）"),
                        "start": _parse_dt(dtstart.group(1)) if dtstart else 0.0,
                        "end": _parse_dt(dtend.group(1)) if dtend else 0.0,
                        "source": name})
    return sorted(out, key=lambda e: e["start"])


def upcoming(days: int = 7, now: float | None = None) -> list:
    now = time.time() if now is None else now
    return [e for e in events() if now - 300 <= e["start"] <= now + days * 86400]


def due_reminders(now: float | None = None) -> list:
    """落入提醒窗口且还没提醒过的事件；提醒过的记入 STATE_FILE 防重复。"""
    now = time.time() if now is None else now
    try:
        done = json.loads(STATE_FILE.read_text("utf-8"))
    except Exception:
        done = {}
    out = []
    for ev in upcoming(days=30, now=now):
        for mins in load_config()["remind_minutes"]:
            delta = ev["start"] - now
            if 0 <= delta <= mins * 60:
                key = "%s|%s|%d" % (ev["source"], ev["title"], int(ev["start"]))
                if done.get(key):
                    continue
                done[key] = now
                out.append({"title": ev["title"], "in_minutes": int(delta // 60),
                            "source": ev["source"]})
                break  # 一个事件一次提醒命中最近一档即可
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(done, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    return out


def _main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "import":
        print(json.dumps(import_ics(argv[1]), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "upcoming":
        days = int(argv[1]) if len(argv) >= 2 else 7
        print(json.dumps(upcoming(days), ensure_ascii=False, indent=2, default=str))
    elif argv and argv[0] == "remind":
        print(json.dumps(due_reminders(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
