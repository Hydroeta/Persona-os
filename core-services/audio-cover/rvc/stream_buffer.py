# -*- coding: utf-8 -*-
r"""stream_buffer.py —— RVC 实时流式缓冲（纯 numpy，无 GPU 依赖，可单测）

这个模块只做一件事：把「任意长度的 16k 输入块」整理成 rtrvc.infer() 需要的
那个窗口，并把输出拼回连续的 48k(或 tgt_sr) 音频。

## 为什么需要它

`rtrvc.infer(input_wav, block_frame_16k, skip_head, return_length, f0method)` 的
参数**单位不是同一个**（见 realtime_gui.py 第 583~660 行）：

    zc              = samplerate // 100                # 每 10ms 的采样点数（48k → 480）
    block_frame     = round(block_time * sr / zc) * zc  # 每块采样点数（≈0.25s → 12000）
    block_frame_16k = 160 * block_frame // zc           # 每块在 16k 域的采样点数（4000）
    crossfade_frame = round(crossfade_time * sr / zc) * zc
    sola_buffer_frame = min(crossfade_frame, 4 * zc)
    sola_search_frame = zc
    extra_frame     = round(extra_time * sr / zc) * zc
    skip_head       = extra_frame // zc                 # ← 帧（不是采样点！）
    return_length   = (block_frame + sola_buffer_frame + sola_search_frame) // zc  # ← 帧

`infer()` 内部 `p_len = input_wav.shape[0] // 160`，所以**帧 = 16k 采样点 / 160**。
如果按采样点传 return_length，等于把长度放大 160 倍 → 显存直接爆/卡死。

## 窗口怎么取

输入缓冲总长 = extra_frame + crossfade_frame + sola_search_frame + block_frame。
每次推理取**整个窗口**（从旧到新），skip_head 告诉模型「前 extra_frame 只是上下文，
别输出」，return_length 告诉它「从 skip_head 之后要吐多少帧」。

输出再裁到最后 block_frame 那一段（对应最新输入），和前一块用 SOLA 对齐后拼接。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class StreamConfig:
    """实时参数。默认值对齐 realtime_gui.py，但延迟调小了（2.5s 对直播太慢）。"""
    samplerate: int = 48000        # 输入采样率（设备侧）
    extra_time: float = 0.5        # 上下文缓冲（秒）。realtime_gui 默认 2.5s，直播用 0.5s
    block_time: float = 0.25       # 每块时长（秒）
    crossfade_time: float = 0.05   # 交叉淡化（秒）
    tgt_sr: int = 40000            # 模型输出采样率

    def __post_init__(self) -> None:
        zc = self.samplerate // 100
        if zc != 160:
            # 16k 采样点 = 160 * block_frame // zc，只有 zc==160 时才等于 block_frame
            pass
        self.zc = zc
        self.block_frame = int(round(self.block_time * self.samplerate / zc)) * zc
        self.block_frame_16k = 160 * self.block_frame // zc
        self.crossfade_frame = int(round(self.crossfade_time * self.samplerate / zc)) * zc
        self.crossfade_frame_16k = 160 * self.crossfade_frame // zc
        # sola_buffer_frame 在 realtime_gui 里用的是**设备域采样点数**，
        # 但 return_length 是帧——所以这里必须换回 16k 域再 // 160，否则多算 3 倍
        self.sola_buffer_frame = min(self.crossfade_frame, 4 * zc)
        self.sola_buffer_frame_16k = 160 * self.sola_buffer_frame // zc
        self.sola_search_frame = zc
        self.sola_search_frame_16k = 160 * self.sola_search_frame // zc
        self.extra_frame = int(round(self.extra_time * self.samplerate / zc)) * zc
        self.skip_head = self.extra_frame // zc
        # return_length 全部按 16k 域换算成帧：realtime_gui 里是
        # (block_frame + sola_buffer_frame + sola_search_frame) // zc，
        # 因为 zc = sr//100 且 16k/zc == 160/100，两式等价；这里显式写清避免再算错
        self.return_length = (
            self.block_frame_16k + self.sola_buffer_frame_16k + self.sola_search_frame_16k
        ) // 160
        # 输入窗口总长（设备采样率域）
        self.window_len = (
            self.extra_frame
            + self.crossfade_frame
            + self.sola_search_frame
            + self.block_frame
        )
        # 16k 域窗口长度
        self.window_len_16k = 160 * self.window_len // zc

    def describe(self) -> dict:
        return {
            "samplerate": self.samplerate,
            "block_frame": self.block_frame,
            "block_frame_16k": self.block_frame_16k,
            "skip_head": self.skip_head,
            "return_length": self.return_length,
            "sola_buffer_frame": self.sola_buffer_frame,
            "window_len": self.window_len,
            "window_len_16k": self.window_len_16k,
            "latency_s": round((self.extra_frame + self.block_frame) / self.samplerate, 3),
        }


def resample_linear(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    """线性重采样（够用且快；RVC 自己也会再用 torch 的重采样器）"""
    if src == dst or x.size == 0:
        return x.astype(np.float32)
    n = max(1, int(round(x.size * dst / src)))
    idx = np.linspace(0, x.size - 1, n)
    return np.interp(idx, np.arange(x.size), x).astype(np.float32)


class StreamBuffer:
    """把无序的输入块整理成 infer() 窗口，并把输出拼连续。

    用法：
        buf = StreamBuffer(StreamConfig(samplerate=48000, tgt_sr=model.tgt_sr))
        for chunk in audio_in_16k:          # 任意长度，16k 单声道 float
            window = buf.push(chunk)        # 填缓冲；凑够一块就返回窗口，否则 None
            if window is not None:
                out = model.infer(window, cfg.block_frame_16k, cfg.skip_head,
                                  cfg.return_length, 'rmvpe')
                audio = buf.pop_output(out)  # 对齐、拼连续，返回可播的 tgt_sr 音频
    """

    def __init__(self, cfg: StreamConfig) -> None:
        self.cfg = cfg
        # 输入缓冲（设备采样率域），预填 0 保证启动时窗口是满的
        self.in_buf = np.zeros(cfg.window_len, dtype=np.float32)
        # 每块需要的新输入（设备域）
        self.step = cfg.block_frame
        # SOLA 相关
        self.sola_buffer = np.zeros(cfg.sola_buffer_frame, dtype=np.float32)
        self.sola_offset = 0
        self.first_block = True

    # -- 输入 ---------------------------------------------------------------
    def push(self, chunk_16k: np.ndarray) -> np.ndarray | None:
        """塞入一块 16k 音频（float 或 int16），返回待推理窗口（设备域 float）或 None。"""
        x = np.asarray(chunk_16k)
        if x.dtype == np.int16:
            x = x.astype(np.float32) / 32768.0
        else:
            x = x.astype(np.float32)
        if x.ndim > 1:
            x = x.mean(axis=1)
        if x.size == 0:
            return None

        # 16k → 设备采样率，对齐到块边界
        dev = resample_linear(x, 16000, self.cfg.samplerate)
        # 只取最新的一整块（多余部分丢弃——实时场景宁丢不积压延迟）
        if dev.size < self.step:
            dev = np.pad(dev, (self.step - dev.size, 0))
        take = dev[-self.step :]

        # 滚动缓冲：丢掉最旧的 step，把新的接在尾部
        self.in_buf = np.concatenate([self.in_buf[self.step :], take])
        return self.in_buf.copy()

    # -- 输出 ---------------------------------------------------------------
    def window_16k(self) -> np.ndarray:
        """当前窗口转成 16k（feed 给 infer 用）。"""
        return resample_linear(self.in_buf, self.cfg.samplerate, 16000)

    def pop_output(self, inferred: np.ndarray) -> np.ndarray:
        """把模型吐出的音频（tgt_sr）与本块对齐、拼到 SOLA 缓冲后，返回本块可播音频。"""
        y = np.asarray(inferred, dtype=np.float32).flatten()
        cfg = self.cfg
        # 模型返回的是 tgt_sr；先换算回设备采样率，长度对齐到最后一块
        dev = resample_linear(y, cfg.tgt_sr, cfg.samplerate)
        if dev.size >= self.step:
            dev = dev[-self.step :]
        else:
            dev = np.pad(dev, (self.step - dev.size, 0))

        if self.first_block:
            self.first_block = False
            self.sola_buffer[:] = dev[-cfg.sola_buffer_frame :]
            return dev

        # 找最佳对齐点（简化版 SOLA：在 oversamp 范围内做互相关）
        n_ov = cfg.sola_buffer_frame
        head = dev[:n_ov]
        best, best_score = 0, -1e18
        for off in range(0, cfg.sola_search_frame + 1, 2):
            seg = dev[off : off + n_ov]
            if seg.size < n_ov:
                break
            score = float(np.dot(head, self.sola_buffer))
            if score > best_score:
                best_score, best = score, off
        self.sola_offset = best

        # 交叉淡化拼接：本块头部淡入、上一块尾部淡出
        fade_in = np.linspace(0.0, 1.0, n_ov, dtype=np.float32)
        fade_out = 1.0 - fade_in
        merged_head = head * fade_in + self.sola_buffer * fade_out
        out = dev.copy()
        out[:n_ov] = merged_head
        self.sola_buffer[:] = dev[-n_ov:]
        return out


class MockModel:
    """测试用：把输入原样按 tgt_sr 输出，用来验证缓冲/对齐逻辑（不碰 GPU）。"""

    def __init__(self, cfg: StreamConfig) -> None:
        self.cfg = cfg
        self.calls = []
        self.tgt_sr = cfg.tgt_sr

    def infer(self, window_16k, block_frame_16k, skip_head, return_length, f0method):
        self.calls.append({
            "window_len": int(np.asarray(window_16k).size),
            "block_frame_16k": int(block_frame_16k),
            "skip_head": int(skip_head),
            "return_length": int(return_length),
            "f0method": f0method,
        })
        # 输出 return_length 帧对应的采样点数（tgt_sr 域）
        n = int(return_length) * (self.cfg.tgt_sr // 100)
        t = np.linspace(0, 2 * np.pi, n, endpoint=False)
        return np.sin(t * 4).astype(np.float32) * 0.3
