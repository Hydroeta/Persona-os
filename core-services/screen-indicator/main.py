#!/usr/bin/env python3
"""screen-indicator —— 读屏陪伴的「绿眼睛」悬浮窗

作用：把「AI 正在看屏幕」这件事变成用户可见、可随时关掉的东西。
  - 右上角一个极小、半透明的绿色小眼睛，置顶、无边框、不抢焦点
  - 每 2 秒往 %TEMP%/dsh-screen-indicator.heartbeat 写一次心跳
  - 关掉这个窗口（右键菜单「关掉」或 Alt+F4）→ 进程退出 → 心跳停 → 插件立刻停止截屏

只依赖标准库（tkinter），不装任何东西。用法：
    python main.py
"""
import os
import sys
import tempfile
import threading
import time
import tkinter as tk

HEARTBEAT = os.path.join(tempfile.gettempdir(), "dsh-screen-indicator.heartbeat")
W, H = 46, 30
POLL_MS = 2000


def beat_forever(stop_evt: threading.Event) -> None:
    while not stop_evt.is_set():
        try:
            with open(HEARTBEAT, "w", encoding="utf-8") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass
        stop_evt.wait(POLL_MS / 1000)


def draw_eye(canvas: tk.Canvas, blink: bool = False) -> None:
    canvas.delete("all")
    cx, cy = W / 2, H / 2
    # 眼白（杏仁形）：两段二次曲线拼一个眼睛
    canvas.create_oval(cx - 15, cy - 9, cx + 15, cy + 9, outline="#2ecc71", width=2, fill="#0d1f16")
    if blink:
        canvas.create_line(cx - 14, cy, cx + 14, cy, fill="#2ecc71", width=2)
    else:
        canvas.create_oval(cx - 5, cy - 5, cx + 5, cy + 5, fill="#2ecc71", outline="")
        canvas.create_oval(cx - 1, cy - 3, cx + 2, cy, fill="#0d1f16", outline="")


def main() -> int:
    root = tk.Tk()
    root.title("screen-indicator")
    root.overrideredirect(True)          # 无边框
    root.attributes("-topmost", True)    # 置顶
    try:
        root.attributes("-alpha", 0.55)  # 半透明
    except tk.TclError:
        pass

    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{W}x{H}+{sw - W - 24}+{18}")

    canvas = tk.Canvas(root, width=W, height=H, bg="#0d1f16", highlightthickness=0)
    canvas.pack(fill="both", expand=True)
    draw_eye(canvas)

    menu = tk.Menu(root, tearoff=0)
    menu.add_command(label="关掉读屏陪伴", command=root.destroy)

    def popup(event):
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    canvas.bind("<Button-3>", popup)
    root.bind("<Escape>", lambda _e: root.destroy())

    stop_evt = threading.Event()
    threading.Thread(target=beat_forever, args=(stop_evt,), daemon=True).start()

    # 每 6 秒眨一下眼，表示还活着
    def blink():
        if not root.winfo_exists():
            return
        draw_eye(canvas, blink=True)
        root.after(160, lambda: draw_eye(canvas) if root.winfo_exists() else None)
        root.after(6000, blink)

    root.after(6000, blink)

    try:
        root.mainloop()
    finally:
        stop_evt.set()
        try:
            os.remove(HEARTBEAT)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
