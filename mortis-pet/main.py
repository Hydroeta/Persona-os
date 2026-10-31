# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""mortis-pet：墨提斯桌宠（全新独立应用）。
角色视频素材整理自原 dsh-pet 的 mortis 角色包（渲染自游戏 Live2D 资源，权利归原作方，不入库）；
人格台词整理自《Ave Mujica》动画及部分二创作品（权利归各权利方、不适用 MIT，不随源码分发，
需用户自备 config.json，缺失时回退 config.example.json 占位模板）。本应用为独立实现。"""

import json
import os
import queue
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import webbrowser

from PySide6.QtCore import QObject, QPoint, QRect, Qt, QTimer, Signal
from PySide6.QtGui import (QAction, QActionGroup, QColor, QCursor, QFontMetrics,
                           QGuiApplication, QIcon, QImage, QPainter, QPainterPath,
                           QPixmap)
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget

# 资源定位：PyInstaller 打包后资源在 sys._MEIPASS，脚本运行用源码目录
if getattr(sys, "frozen", False):
    APP_DIR = sys._MEIPASS
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
VIDEO_DIR = os.path.join(APP_DIR, "videos")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
CONFIG_EXAMPLE_PATH = os.path.join(APP_DIR, "config.example.json")

# ffmpeg 查找顺序：exe 捆绑的 bin\ffmpeg.exe -> 用户目录 .local\bin -> PATH
_FFMPEG_CANDIDATES = [
    os.path.join(APP_DIR, "bin", "ffmpeg.exe"),
    os.path.join(os.path.expanduser("~"), ".local", "bin", "ffmpeg.exe"),
    "ffmpeg",
]
FFMPEG = next((c for c in _FFMPEG_CANDIDATES if c == "ffmpeg" or os.path.exists(c)), "ffmpeg")

# 运行日志：exe 同目录（脚本运行时为源码目录），--noconsole 下也有排障依据
LOG_PATH = os.path.join(os.path.dirname(sys.executable)
                        if getattr(sys, "frozen", False) else APP_DIR,
                        "mortis-pet.log")
try:
    _LOG_FP = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
except OSError:
    _LOG_FP = None
if sys.stderr is None:
    sys.stderr = _LOG_FP or open(os.devnull, "w")


def log(msg):
    if _LOG_FP:
        try:
            _LOG_FP.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
        except OSError:
            pass


def _excepthook(t, v, tb):
    log("未捕获异常:\n" + "".join(traceback.format_exception(t, v, tb)).rstrip())


sys.excepthook = _excepthook

# persona-os 控制台（读屏陪伴开关在控制台网页里）
# 定位顺序：环境变量 PERSONA_OS_DIR -> 按常见布局向上找 console.py（兼容源码/exe 两种形态）
def _default_console_dir():
    env = os.environ.get("PERSONA_OS_DIR")
    if env:
        return env
    if getattr(sys, "frozen", False):
        start = os.path.dirname(sys.executable)
    else:
        start = os.path.dirname(os.path.abspath(__file__))
    for cand in (start, os.path.dirname(start)):
        if os.path.isfile(os.path.join(cand, "console.py")):
            return cand
    return os.path.dirname(start)

CONSOLE_DIR = _default_console_dir()
CONSOLE_PY = os.path.join(CONSOLE_DIR, "console.py")
CONSOLE_URL_FILE = os.path.join(CONSOLE_DIR, "data", "console.url")

SRC_W, SRC_H = 1280, 720                      # 源视频画布（720p 源渲染尺寸）
FRAME_BYTES = SRC_W * SRC_H * 4               # 单帧 rgba 字节数 = 3686400
CROP_X, CROP_Y, CROP_W, CROP_H = 500, 0, 284, 720   # 角色实际内容区（裁掉两侧透明，消除隐形体积）
FPS_MS = 42                                   # 24fps 取帧间隔
CLICK_MOVES = 6                               # 点击/拖拽判定阈值（逻辑像素）


def load_config():
    # 台词文本不随源码分发（动画/二创来源，不适用 MIT）：用户自备 config.json，
    # 缺失时回退仓库内置占位模板，保证可启动；设置变更仍写回 config.json
    path = CONFIG_PATH if os.path.exists(CONFIG_PATH) else CONFIG_EXAMPLE_PATH
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def list_clips(category):
    """列出 videos/<category>/ 下全部 webm：{动作名: 完整路径}"""
    d = os.path.join(VIDEO_DIR, category)
    if not os.path.isdir(d):
        return {}
    return {os.path.splitext(f)[0]: os.path.join(d, f)
            for f in sorted(os.listdir(d)) if f.lower().endswith(".webm")}


class ClipPlayer(QObject):
    """单个 webm 的 ffmpeg 解码管线：子进程流式输出 rgba 原始帧，后台线程读入队列。"""

    finished = Signal(int)                    # 一次性 clip 自然播完（队列已消费完），带播放代次

    def __init__(self):
        super().__init__()
        self.path = None
        self.loop = False
        self.proc = None
        self.thread = None
        self.frames = queue.Queue(maxsize=4)
        self._stop = False
        self.play_id = 0                      # 播放代次：切换 clip 时 +1，用于丢弃过期线程

    def _spawn(self):
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return subprocess.Popen(
            [FFMPEG, "-v", "error",
             "-c:v", "libvpx-vp9",            # 关键：ffmpeg 默认 vp9 解码器会丢 alpha，必须显式 libvpx
             "-i", self.path,
             "-vf", "format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

    def play(self, path, loop):
        self.stop()
        self.path, self.loop = path, loop
        self._stop = False
        self.play_id += 1
        pid = self.play_id
        self.thread = threading.Thread(target=self._run, args=(pid,), daemon=True)
        self.thread.start()

    def _run(self, pid):
        # pid 与当前 play_id 不一致说明已被新播放取代（含 stop 后 join 超时的僵尸线程），直接退出
        self.proc = self._spawn()
        while not self._stop and pid == self.play_id:
            data = self.proc.stdout.read(FRAME_BYTES)
            if len(data) == FRAME_BYTES:
                while not self._stop and pid == self.play_id:  # 队列满则等待界面消费，形成自然节流
                    try:
                        self.frames.put(data, timeout=0.1)
                        break
                    except queue.Full:
                        continue
                continue
            # EOF：循环 clip 重启进程接着播；一次性 clip 结束
            if self.loop and not self._stop and pid == self.play_id:
                self._kill_proc()
                self.proc = self._spawn()
                continue
            break
        if not self.loop and not self._stop and pid == self.play_id:
            # 等队列里剩余帧被界面消费完再发完成信号，避免结尾被切掉
            deadline = time.time() + 2.0
            while (not self._stop and pid == self.play_id
                   and not self.frames.empty() and time.time() < deadline):
                time.sleep(0.05)
            self.finished.emit(pid)

    def _kill_proc(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass

    def stop(self):
        self._stop = True
        self._kill_proc()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=0.8)
        while not self.frames.empty():
            try:
                self.frames.get_nowait()
            except queue.Empty:
                break
        self.proc = None
        self.thread = None

    def next_frame(self):
        try:
            return self.frames.get_nowait()
        except queue.Empty:
            return None


class Bubble(QWidget):
    """台词气泡：白底圆角 + 下方小尾巴，浮在角色头顶上方。"""

    TAIL = 8

    def __init__(self, pet):
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.pet = pet
        self.text = ""
        self.hide_timer = QTimer(self)
        self.hide_timer.setSingleShot(True)
        self.hide_timer.timeout.connect(self.hide)

    def show_text(self, text, seconds):
        self.text = text
        fm = QFontMetrics(self.font())
        w = fm.horizontalAdvance(text) + 28
        h = fm.height() + 16 + self.TAIL
        self.setFixedSize(w, h)
        cx = self.pet.x() + self.pet.width() // 2
        pos = QPoint(cx - w // 2, self.pet.y() - h - 4)
        screen = QGuiApplication.screenAt(QPoint(cx, self.pet.y())) or QGuiApplication.primaryScreen()
        g = screen.geometry()
        pos.setX(min(max(pos.x(), g.left() + 4), g.right() - w - 4))
        pos.setY(max(pos.y(), g.top() + 4))
        self.move(pos)
        self.show()
        self.update()
        self.hide_timer.start(int(seconds * 1000))

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        body = QRect(0, 0, self.width(), self.height() - self.TAIL)
        path = QPainterPath()
        path.addRoundedRect(body, 10, 10)
        cx = self.width() // 2                # 小尾巴（指向角色头部）
        path.moveTo(cx - 6, body.bottom() - 1)
        path.lineTo(cx, body.bottom() + self.TAIL)
        path.lineTo(cx + 6, body.bottom() - 1)
        p.fillPath(path, QColor(255, 255, 255, 245))
        p.setPen(QColor(30, 30, 30))
        p.drawText(body, Qt.AlignCenter, self.text)


class MortisPet(QWidget):
    """桌宠主窗口：无边框、透明背景、置顶工具窗口，只渲染角色内容区。"""

    SCALES = (0.75, 1.0, 1.25, 1.5, 2.0)

    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.scale = float(self.cfg.get("scale", 1.0))
        self.setWindowTitle("mortis-pet")
        flags = Qt.FramelessWindowHint | Qt.Tool
        if self.cfg.get("on_top", False):     # 默认不置顶：让任务栏能盖住她
            flags |= Qt.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.setAttribute(Qt.WA_TranslucentBackground)

        self.clips = {c: list_clips(c) for c in ("idle", "click", "drag", "random")}
        if not self.clips["idle"]:
            raise RuntimeError("缺少 idle 视频素材")

        self.frame_img = None                 # 当前帧（已裁剪并预乘）
        self.mode = "idle"                    # idle / action / drag
        self.current_clip = None
        self._gaze = None                     # 视线追随：当前注视方向对应的 idle clip 名
        self._press = None                    # (按下时全局坐标, 按下时窗口坐标)
        self._drag_started = False
        self._tray_icon_set = False

        self.bubble = Bubble(self)
        self.player = ClipPlayer()
        self.player.finished.connect(self._on_clip_finished)

        self._apply_size()
        self._place_initial()
        self._build_tray()
        self._play_idle()

        self.frame_timer = QTimer(self)       # 取帧定时器（24fps）
        self.frame_timer.timeout.connect(self._tick)
        self.frame_timer.start(FPS_MS)

        self.talk_timer = QTimer(self)        # 自说话定时器
        self.talk_timer.setSingleShot(True)
        self.talk_timer.timeout.connect(self._self_talk)
        self._schedule_talk()

        self.act_timer = QTimer(self)         # 随机动作定时器
        self.act_timer.setSingleShot(True)
        self.act_timer.timeout.connect(self._random_action)
        self._schedule_action()

        self._gaze_last = 0.0                 # 上次视线切换时刻（防抖动）
        self.gaze_timer = QTimer(self)        # 视线追随轮询（仅开关开启时生效）
        self.gaze_timer.timeout.connect(self._gaze_check)
        self.gaze_timer.start(250)

        QTimer.singleShot(800, self._entry_line)   # 进场台词

    # ---------- 基础 ----------

    def _apply_size(self):
        self.setFixedSize(round(CROP_W * self.scale), round(CROP_H * self.scale))

    def _place_initial(self):
        g = QGuiApplication.primaryScreen().geometry()
        self.move(g.right() - self.width() - 120, g.bottom() - self.height())

    def _screen(self):
        center = self.pos() + QPoint(self.width() // 2, self.height() // 2)
        return QGuiApplication.screenAt(center) or QGuiApplication.primaryScreen()

    def _clamp(self, pos):
        """拖拽边界（逻辑坐标）：腿可伸出屏幕下沿 leg_out_px×scale，
        左右只保留 120×scale px 在屏内，顶部最多超出 -50。"""
        g = self._screen().geometry()
        keep = round(120 * self.scale)
        leg = round(float(self.cfg.get("leg_out_px", 400)) * self.scale)
        x = min(max(pos.x(), g.left() + keep - self.width()), g.right() + 1 - keep)
        y = min(max(pos.y(), g.top() - 50), g.bottom() + 1 - self.height() + leg)
        return QPoint(x, y)

    # ---------- 播放 ----------

    def _play(self, category, name=None, loop=False):
        choices = self.clips.get(category) or {}
        if not choices:
            return
        if name is None or name not in choices:
            name = random.choice(list(choices))
        log("播放 %s/%s loop=%s" % (category, name, loop))
        self.player.play(choices[name], loop)
        self.current_clip = (category, name)

    def _play_idle(self):
        self.mode = "idle"
        # 待机跟随视线方向；无对应素材时退回随机轮换
        self._play("idle", self._gaze if self._gaze in self.clips["idle"] else None)

    def _on_clip_finished(self, pid):
        if pid != self.player.play_id:        # 过期线程的完成信号，丢弃
            return
        if self.mode in ("idle", "action"):
            self._play_idle()

    def _tick(self):
        data = self.player.next_frame()
        if data is None:
            return
        img = QImage(data, SRC_W, SRC_H, SRC_W * 4, QImage.Format_RGBA8888)
        # 裁剪内容区并预乘，保证放大时边缘干净
        self.frame_img = img.copy(CROP_X, CROP_Y, CROP_W, CROP_H).convertToFormat(
            QImage.Format_RGBA8888_Premultiplied)
        if not self._tray_icon_set:           # 用首帧头部裁一个托盘头像
            self._tray_icon_set = True
            head = QPixmap.fromImage(self.frame_img.copy(0, 0, CROP_W, 300)).scaled(
                64, 64, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            self.tray.setIcon(QIcon(head))
        self.update()

    def paintEvent(self, _event):
        if self.frame_img is None:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        p.drawImage(self.rect(), self.frame_img)

    # ---------- 鼠标交互 ----------

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._press = (e.globalPosition().toPoint(), self.pos())
            self._drag_started = False
        elif e.button() == Qt.RightButton:
            self._show_menu(e.globalPosition().toPoint())

    def mouseMoveEvent(self, e):
        if not self._press or not (e.buttons() & Qt.LeftButton):
            return
        gp = e.globalPosition().toPoint()
        if not self._drag_started:
            if (gp - self._press[0]).manhattanLength() < CLICK_MOVES:
                return
            self._drag_started = True
            self.bubble.hide()
            self.mode = "drag"
            self._play("drag", loop=True)
        self.move(self._clamp(self._press[1] + (gp - self._press[0])))

    def mouseReleaseEvent(self, e):
        if e.button() != Qt.LeftButton or self._press is None:
            return
        if self._drag_started:
            self._play_idle()
        else:
            self._click()
        self._press = None
        self._drag_started = False

    def _click(self):
        choices = self.clips["click"]
        if not choices:
            return
        name = random.choice(list(choices))
        self.mode = "action"
        self._play("click", name)
        lines = self.cfg.get("click_talk_bindings", {}).get(name) or []
        if lines:
            self.bubble.show_text(random.choice(lines),
                                  float(self.cfg.get("self_talk_duration_seconds", 3.2)))

    # ---------- 视线追随 / 进场台词 ----------

    def _gaze_check(self):
        """「视线追随」开启时持续注视鼠标水平方位；拖动与动作播放期间不动。"""
        if not self.cfg.get("follow_mouse", True):
            return
        if self.mode != "idle":
            return
        dead = max(60, self.width() // 2)     # 死区，避免在正中间来回跳
        cx = self.x() + self.width() // 2
        mx = QCursor.pos().x()
        target = ("待机-看左" if mx < cx - dead
                  else "待机-看右" if mx > cx + dead else "待机呼吸休闲")
        if target == self._gaze:
            return
        now = time.time()
        if now - self._gaze_last < 0.5:       # 最小切换间隔，避免边界处抖动
            return
        self._gaze = target
        self._gaze_last = now
        if target in self.clips["idle"] and self.current_clip != ("idle", target):
            self._play("idle", target)        # 同构图直接切，视线转移本就是瞬间动作

    def _set_follow_mouse(self, on):
        self.cfg["follow_mouse"] = bool(on)
        save_config(self.cfg)
        log("视线追随: %s" % ("开" if on else "关"))
        if on:
            self._gaze_last = 0.0
            self._gaze_check()                # 立刻看一眼当前鼠标位置
        else:
            self._gaze = None
            if (self.mode == "idle" and "待机呼吸休闲" in self.clips["idle"]
                    and self.current_clip != ("idle", "待机呼吸休闲")):
                self._play("idle", "待机呼吸休闲")

    def _entry_line(self):
        lines = self.cfg.get("entry_lines") or []
        if lines:
            self.bubble.show_text(random.choice(lines),
                                  float(self.cfg.get("self_talk_duration_seconds", 3.2)))

    # ---------- 读屏陪伴（persona-os 控制台） ----------

    def _console_url_if_alive(self):
        """控制台在跑则返回带 token 的完整地址，否则 None。"""
        try:
            url = open(CONSOLE_URL_FILE, encoding="utf-8").read().strip()
            port = int(re.match(r"http://127\.0\.0\.1:(\d+)/", url).group(1))
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return url
        except Exception:
            return None

    def _open_screen_buddy(self):
        # 拉起控制台可能有几秒等待，放后台线程避免卡住界面
        threading.Thread(target=self._open_screen_buddy_bg, daemon=True).start()

    def _open_screen_buddy_bg(self):
        try:
            url = self._console_url_if_alive()
            if url is None:                   # 没在跑：无窗口拉起 console.py，等它写出地址
                mtime = (os.path.getmtime(CONSOLE_URL_FILE)
                         if os.path.exists(CONSOLE_URL_FILE) else 0)
                py = shutil.which("py")
                argv = ([py, "-3"] if py else ["python"]) + [CONSOLE_PY]
                log("拉起控制台: %s" % argv)
                subprocess.Popen(argv, cwd=CONSOLE_DIR,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                deadline = time.time() + 12
                while time.time() < deadline:
                    time.sleep(0.4)
                    if (os.path.exists(CONSOLE_URL_FILE)
                            and os.path.getmtime(CONSOLE_URL_FILE) > mtime):
                        url = self._console_url_if_alive()
                        if url:
                            break
            if url:
                log("打开控制台: %s" % url)
                webbrowser.open(url)
            else:
                log("控制台拉起超时")
                QTimer.singleShot(0, lambda: self.bubble.show_text("控制台没拉起来……", 3))
        except Exception as e:
            log("打开控制台失败: %r" % e)
            QTimer.singleShot(0, lambda: self.bubble.show_text("控制台启动失败", 3))

    # ---------- 自说话 / 随机动作 ----------

    def _schedule_talk(self):
        lo = float(self.cfg.get("self_talk_min_interval", 20.0))
        hi = float(self.cfg.get("self_talk_max_interval", 60.0))
        self.talk_timer.start(int(random.uniform(lo, hi) * 1000))

    def _self_talk(self):
        if self.cfg.get("self_talk_enabled", True) and self.mode != "drag":
            texts = self.cfg.get("self_talk_texts") or []
            if texts:
                self.bubble.show_text(random.choice(texts),
                                      float(self.cfg.get("self_talk_duration_seconds", 3.2)))
        self._schedule_talk()

    def _schedule_action(self):
        lo = float(self.cfg.get("random_action_min_interval", 25.0))
        hi = float(self.cfg.get("random_action_max_interval", 50.0))
        self.act_timer.start(int(random.uniform(lo, hi) * 1000))

    def _random_action(self):
        if self.mode == "idle":
            self.mode = "action"
            self._play("random")
        self._schedule_action()

    # ---------- 菜单 / 托盘 ----------

    def _show_menu(self, global_pos):
        menu = QMenu(self)
        title = menu.addAction("墨提斯")
        title.setEnabled(False)
        menu.addSeparator()

        sub = menu.addMenu("播放动作")
        for name in self.clips["random"]:
            act = sub.addAction(name)
            act.triggered.connect(lambda _c=False, n=name: self._menu_play(n))

        size_menu = menu.addMenu("大小")
        group = QActionGroup(menu)
        group.setExclusive(True)
        for s in self.SCALES:
            act = size_menu.addAction(str(s))
            act.setCheckable(True)
            act.setChecked(abs(s - self.scale) < 1e-6)
            act.triggered.connect(lambda _c=False, v=s: self._set_scale(v))
            group.addAction(act)

        talk_act = menu.addAction("台词")
        talk_act.setCheckable(True)
        talk_act.setChecked(bool(self.cfg.get("self_talk_enabled", True)))
        talk_act.toggled.connect(self._set_talk_enabled)

        gaze_act = menu.addAction("视线追随")
        gaze_act.setCheckable(True)
        gaze_act.setChecked(bool(self.cfg.get("follow_mouse", True)))
        gaze_act.toggled.connect(self._set_follow_mouse)

        top_act = menu.addAction("置顶")
        top_act.setCheckable(True)
        top_act.setChecked(bool(self.cfg.get("on_top", False)))
        top_act.toggled.connect(self._set_on_top)

        buddy_act = menu.addAction("读屏陪伴（控制台）")
        buddy_act.triggered.connect(self._open_screen_buddy)

        menu.addSeparator()
        quit_act = menu.addAction("退出")
        quit_act.triggered.connect(self._quit)
        menu.exec(global_pos)

    def _menu_play(self, name):
        log("菜单动作: %s" % name)
        self.mode = "action"
        self._play("random", name)

    def _set_scale(self, value):
        cx = self.x() + self.width() // 2     # 以窗口中心/底边为锚点缩放
        bottom = self.y() + self.height()
        self.scale = float(value)
        self._apply_size()
        self.move(self._clamp(QPoint(cx - self.width() // 2, bottom - self.height())))
        self.cfg["scale"] = self.scale
        save_config(self.cfg)
        self.update()

    def _set_talk_enabled(self, on):
        self.cfg["self_talk_enabled"] = bool(on)
        save_config(self.cfg)

    def _set_on_top(self, on):
        self.cfg["on_top"] = bool(on)
        save_config(self.cfg)
        self.setWindowFlag(Qt.WindowStaysOnTopHint, bool(on))
        self.show()                           # 改窗口标志后需重新 show

    def _build_tray(self):
        pm = QPixmap(64, 64)                  # 首帧出来前的占位图标
        pm.fill(Qt.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.Antialiasing)
        p.setBrush(QColor(150, 90, 170))
        p.setPen(Qt.NoPen)
        p.drawEllipse(4, 4, 56, 56)
        p.end()
        self.tray = QSystemTrayIcon(QIcon(pm), self)
        self.tray.setToolTip("mortis-pet")
        tray_menu = QMenu()
        act = tray_menu.addAction("退出")
        act.triggered.connect(self._quit)
        self.tray.setContextMenu(tray_menu)
        self.tray.show()

    def _quit(self):
        save_config(self.cfg)
        self.player.stop()
        self.tray.hide()
        QApplication.instance().quit()


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("mortis-pet")
    app.setQuitOnLastWindowClosed(False)      # 靠菜单/托盘退出
    pet = MortisPet()
    app.aboutToQuit.connect(pet.player.stop)
    pet.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
