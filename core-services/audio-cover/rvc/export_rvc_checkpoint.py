"""把 RVC 训练产出的 G_*.pth 重新导出成推理可用的 checkpoint。

官方 RVC 推理侧 infer/rtrvc.py:get_synthesizer 读的是：
    cpt["weight"]            -> 模型参数（不带 optimizer）
    cpt["config"]            -> 18 个位置参数
    cpt.get("f0", 1)         -> 是否带 f0
    cpt.get("version", "v1")
而训练产出 logs/<exp>/G_*.pth 存的是：
    {"model": 参数, "iteration": n, "optimizer": ..., "learning_rate": ...}
两者字段名不同，直接复制出来 load 会 KeyError: 'weight'。

config 顺序（SynthesizerTrnMs256NSFsid.__init__ 的 18 个位置参数）：
    spec_channels, segment_size, inter_channels, hidden_channels, filter_channels,
    n_heads, n_layers, kernel_size, p_dropout, resblock, resblock_kernel_sizes,
    resblock_dilation_sizes, upsample_rates, upsample_initial_channel,
    upsample_kernel_sizes, spk_embed_dim, gin_channels, sr

用法：
    index-tts\\.venv\\Scripts\\python.exe export_rvc_checkpoint.py
"""
import json
import shutil
import sys
from pathlib import Path

import torch

RVC = Path(r"C:\Users\79365\Desktop\新建文件夹 (2)\svc\Retrieval-based-Voice-Conversion-WebUI-main")
DST = Path(r"C:\rvc-models")
SRC = Path(r"C:\Users\79365\Desktop\新建文件夹 (2)\svc\out")
# 每个角色用哪个 G_*.pth（换成更新的 epoch 只改这里）
LATEST = {"whale": "G_9450.pth", "mortis": "G_7200.pth"}


def build_config(sr_name: str = "40k") -> list:
    raw = json.loads((RVC / "configs" / "v1" / f"{sr_name}.json").read_text(encoding="utf-8"))
    m, d, t = raw["model"], raw["data"], raw["train"]
    return [
        d["filter_length"],            # spec_channels
        t["segment_size"],             # segment_size
        m["inter_channels"],
        m["hidden_channels"],
        m["filter_channels"],
        m["n_heads"],
        m["n_layers"],
        m["kernel_size"],
        m["p_dropout"],
        m["resblock"],
        m["resblock_kernel_sizes"],
        m["resblock_dilation_sizes"],
        m["upsample_rates"],
        m["upsample_initial_channel"],
        m["upsample_kernel_sizes"],
        m["spk_embed_dim"],            # 会被实际 ckpt 的 emb_g 行数覆盖
        m["gin_channels"],
        d["sampling_rate"],
    ]


def main() -> int:
    base_cfg = build_config()
    for name, last in LATEST.items():
        src = RVC / "logs" / name / last
        if not src.is_file():
            print(f"✗ 缺权重 {src}")
            continue
        ck = torch.load(src, map_location="cpu", weights_only=False)
        sd = ck["model"] if "model" in ck else ck
        cfg = list(base_cfg)
        cfg[15] = int(sd["emb_g.weight"].shape[0])
        out_dir = DST / name
        out_dir.mkdir(parents=True, exist_ok=True)
        dst = out_dir / f"{name}.pth"
        torch.save({
            "weight": sd,
            "config": cfg,
            "info": "RVC v1 40k fine-tuned",
            "version": "v1",
            "f0": 1,
            "sr": "40k",
        }, dst)
        # 索引：faiss 在 Windows 上打不开含中文的路径，所以复制一份到 ASCII 目录
        idx_src = SRC / name / f"added_{name}.index"
        idx_dst = out_dir / f"added_{name}.index"
        if idx_src.is_file():
            shutil.copy2(idx_src, idx_dst)
        print(f"✔ {name}: iter={ck.get('iteration')} spk_embed_dim={cfg[15]} "
              f"-> {dst} ({dst.stat().st_size / 1e6:.1f} MB)"
              + (f" + {idx_dst.name}" if idx_dst.is_file() else ""), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
