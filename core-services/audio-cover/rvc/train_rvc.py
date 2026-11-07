# -*- coding: utf-8 -*-
r"""train_rvc.py —— persona-os 的 RVC「炼丹炉」：一条命令把一段长音频训成可用的音色模型

放在 svc/ 下，跑在 svc\env（torch 2.15.0+cpu）或 index-tts\.venv（torch 2.8.0+cu128）都可以，
默认用 index-tts\.venv（有 CUDA）。训练本身只吃 GPU，推理才需要 rvc_worker。

用法：
    # 最小用法：给一段带背景音的长音频，自动分轨 + 切分 + 提特征 + 训练 + 出模型
    svc\env\Scripts\python.exe train_rvc.py --input D:\audio\whale.mp3 --name whale

    # 已经是干净干声，跳过 demucs
    ... --input D:\audio\whale.wav --name whale --no-demucs

    # 显存特别紧：batch 1 + 更长训练
    ... --batch 1 --epochs 300

产物：
    svc\out\<name>\<name>.pth      ← 给 rvc_worker / audio-cover 用的模型
    svc\out\<name>\added_*.index   ← 索引（可选，音色更像，但更吃内存）

设计要点：
  * 每一步都落一个 .done 标记在工作目录里，中途崩了重跑会跳过已完成的步骤
  * 训练参数按 4GB 显存给：默认 batch=2、fp16、每 10 epoch 存一次、总 200 epoch
  * 40k 用 v1 架构（RVC 的 40k 权重就是 v1 结构），48k 用 v2
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _resolve_rvc() -> Path:
    """RVC 仓库位置：RVC_REPO 环境变量 > 本文件上溯 > 常见 svc 路径。"""
    env = os.environ.get("RVC_REPO")
    if env and (Path(env) / "infer" / "rtrvc.py").is_file():
        return Path(env)
    for parent in [HERE, *HERE.parents]:
        for cand in (parent, parent / "svc" / "Retrieval-based-Voice-Conversion-WebUI-main"):
            if (cand / "infer" / "rtrvc.py").is_file():
                return cand
    for cand in (Path(r"C:\svc\Retrieval-based-Voice-Conversion-WebUI-main"),
                 Path.home() / "svc" / "Retrieval-based-Voice-Conversion-WebUI-main"):
        if (cand / "infer" / "rtrvc.py").is_file():
            return cand
    return HERE / "Retrieval-based-Voice-Conversion-WebUI-main"


RVC = _resolve_rvc()
DEFAULT_PY = Path(os.environ.get("RVC_PYTHON") or
                  (HERE.parents[3] / "index-tts" / ".venv" / "Scripts" / "python.exe"))
FALLBACK_PY = Path(os.environ.get("RVC_PYTHON") or
                   (RVC / "env" / "Scripts" / "python.exe"))

LOG = []


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG.append(line)


def run(cmd: list[str], cwd: Path, step: str) -> None:
    log(f"▶ {step}\n  {' '.join(str(c) for c in cmd)}")
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    tail = []
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line)
        if len(tail) > 6:
            tail.pop(0)
        print("   " + line, flush=True)
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"{step} 失败（exit {code}），最后输出：\n" + "\n".join(tail))
    log(f"✔ {step} 完成，用时 {time.time() - started:.0f}s")


def done_marker(work: Path, name: str) -> Path:
    return work / f"{name}.done"


def step_done(work: Path, name: str, step: str) -> bool:
    return done_marker(work, name).joinpath(step).exists() if False else (work / f".{step}.done").exists()


def mark(work: Path, step: str) -> None:
    (work / f".{step}.done").write_text(str(time.time()), encoding="utf-8")


def find_python(explicit: str | None) -> str:
    if explicit:
        return explicit
    for cand in (DEFAULT_PY, FALLBACK_PY):
        if cand.is_file():
            return str(cand)
    return sys.executable


def ensure_demucs(py: str) -> None:
    code = subprocess.run([py, "-c", "import demucs"], capture_output=True)
    if code.returncode == 0:
        return
    log("demucs 未安装，开始安装（约 1GB，含 torchaudio 依赖）…")
    idx = "https://mirrors.aliyun.com/pypi/simple/"
    subprocess.run(["uv", "pip", "install", "--python", py, "demucs", "--index-url", idx], check=True)


def collect_inputs(src: Path) -> list[Path]:
    exts = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".mp4", ".mkv"}
    if src.is_file():
        return [src]
    return sorted(p for p in src.rglob("*") if p.suffix.lower() in exts)


def main() -> int:
    ap = argparse.ArgumentParser(description="RVC 训练流水线（4GB 显存友好）")
    ap.add_argument("--input", required=True, help="音频文件或目录（可含背景音）")
    ap.add_argument("--name", required=True, help="实验名 / 角色名，如 whale / mortis")
    ap.add_argument("--sr", choices=["40k", "48k"], default="40k", help="采样率：40k(v1,省显存) / 48k(v2,更细腻)")
    ap.add_argument("--epochs", type=int, default=200, help="总 epoch（数据少可 100~200）")
    ap.add_argument("--batch", type=int, default=2, help="batch size（4GB 显卡建议 1~2，别超 2）")
    ap.add_argument("--python", default=None, help="指定解释器（默认 index-tts\\.venv）")
    ap.add_argument("--no-demucs", action="store_true", help="输入已是干净干声，跳过分轨")
    ap.add_argument("--work", default=None, help="工作目录（默认 svc\\work\\<name>）")
    ap.add_argument("--out", default=None, help="产物目录（默认 svc\\out\\<name>）")
    ap.add_argument("--yes", action="store_true", help="跳过开跑前的显存提醒确认")
    args = ap.parse_args()

    py = find_python(args.python)
    src = Path(args.input).expanduser().resolve()
    if not src.exists():
        print(f"✗ 输入不存在：{src}")
        return 2
    work = Path(args.work).expanduser().resolve() if args.work else HERE / "work" / args.name
    out = Path(args.out).expanduser().resolve() if args.out else HERE / "out" / args.name
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    logfile = work / "train.log"

    log(f"python   = {py}")
    log(f"RVC 仓库 = {RVC}")
    log(f"工作目录 = {work}")
    log(f"产物目录 = {out}")
    log(f"采样率 {args.sr} / batch {args.batch} / epochs {args.epochs}")

    if not RVC.is_dir():
        print(f"✗ 找不到 RVC 仓库：{RVC}")
        return 2

    if not args.yes:
        print("\n⚠️  训练会把 4GB 显存吃满，期间 IndexTTS2 / 游戏代理 / 别的大模型都可能卡住。")
        print("   建议关掉 DSH 桌面端、OBS、游戏，在睡前挂机。")
        ans = input("   继续？[y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("   已取消。")
            return 1

    # ---------------- 1) 分轨 ----------------
    raw_dir = work / "raw"
    raw_dir.mkdir(exist_ok=True)
    vocals: list[Path] = []
    if args.no_demucs:
        for p in collect_inputs(src):
            dst = raw_dir / f"{p.stem}.wav"
            if not dst.exists():
                subprocess.run(["ffmpeg", "-y", "-i", str(p), "-ac", "1", "-ar", "44100", str(dst)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            vocals.append(dst)
        log(f"跳过 demucs，直接使用 {len(vocals)} 个文件")
    else:
        ensure_demucs(py)
        sep = work / "demucs"
        if not (sep / "done").exists():
            for p in collect_inputs(src):
                run([py, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(sep), str(p)],
                    cwd=RVC, step=f"demucs 分轨 {p.name}")
            (sep / "done").write_text("1", encoding="utf-8")
        for v in sep.rglob("vocals.wav"):
            dst = raw_dir / f"{v.parent.name}.wav"
            if not dst.exists():
                shutil.copy2(v, dst)
            vocals.append(dst)
        if not vocals:
            print("✗ demucs 没有产出 vocals.wav，检查输入音频")
            return 2
        log(f"分轨完成，得到 {len(vocals)} 段人声")
    total_sec = 0.0
    for v in vocals:
        try:
            import wave
            with wave.open(str(v)) as w:
                total_sec += w.getnframes() / w.getframerate()
        except Exception:
            pass
    if total_sec:
        log(f"人声总时长约 {total_sec / 60:.1f} 分钟")
        if total_sec < 300:
            log("⚠️ 人声不足 5 分钟，训出来的模型容易跑调/不像，建议 10 分钟以上")

    exp = args.name
    exp_dir = RVC / "logs" / exp
    exp_dir.mkdir(parents=True, exist_ok=True)

    # ---------------- 2) 切片 + 重采样 ----------------
    if not step_done(work, "preprocess"):
        run([py, "train/preprocess.py", str(raw_dir), "40000" if args.sr == "40k" else "48000",
             str(max(1, os.cpu_count() // 2)), str(exp_dir), "False", "3.7"],
            cwd=RVC, step="切片 + 重采样（preprocess）")
        mark(work, "preprocess")

    # ---------------- 3) F0 ----------------
    if not step_done(work, "f0"):
        run([py, "train/dataset/extract_f0.py", "cpu", str(exp_dir), str(max(1, os.cpu_count() // 2)), "rmvpe"],
            cwd=RVC, step="提取 F0（rmvpe，走 CPU 省显存）")
        mark(work, "f0")

    # ---------------- 4) HuBERT 特征 ----------------
    version = "v1" if args.sr == "40k" else "v2"
    if not step_done(work, "hubert"):
        run([py, "train/dataset/extract_hubert_feature.py", "cuda", "1", "0", "0", str(exp_dir), version, "true"],
            cwd=RVC, step=f"提取 HuBERT 特征（{version} / 16k）")
        mark(work, "hubert")

    # ---------------- 5) 训练配置 ----------------
    cfg_src = RVC / "configs" / ("v1" if args.sr == "40k" else "v2") / f"{args.sr}.json"
    cfg_dst = exp_dir / "config.json"
    if not cfg_dst.exists():
        shutil.copy2(cfg_src, cfg_dst)
        log(f"已写入训练配置：{cfg_dst.name}（来自 {cfg_src.relative_to(RVC)}）")

    # ---------------- 6) 训练 ----------------
    if not step_done(work, "train"):
        pre_g = RVC / "assets" / "pretrained_v2" / f"f0G{args.sr}.pth"
        pre_d = RVC / "assets" / "pretrained_v2" / f"f0D{args.sr}.pth"
        if not pre_g.is_file():
            pre_g, pre_d = Path(""), Path("")
            log("⚠️ 没找到预训练底模，将从零训练（更慢、更容易崩）")
        cmd = [py, "train/train.py", "-e", exp, "-sr", args.sr, "-f0", "1",
               "-bs", str(max(1, min(2, args.batch))), "-g", "0",
               "-te", str(args.epochs), "-se", "10",
               "-pg", str(pre_g), "-pd", str(pre_d),
               "-l", "0", "-c", "0", "-sw", "1", "-v", version]
        run(cmd, cwd=RVC, step=f"训练（{args.epochs} epoch，batch {max(1, min(2, args.batch))}）")
        mark(work, "train")

    # ---------------- 7) 索引 ----------------
    index_files: list[Path] = []
    if not step_done(work, "index"):
        try:
            run([py, "train/train_index.py", exp, version, str(out), str(max(1, os.cpu_count() // 2))],
                cwd=RVC, step="训练检索索引（faiss）")
            mark(work, "index")
        except Exception as exc:
            log(f"⚠️ 索引训练失败（不影响出模型，只是音色细节差一点）：{exc}")
    index_files = sorted(RVC.glob(f"logs/{exp}/*.index")) + sorted(out.glob("*.index"))

    # ---------------- 8) 导出 ----------------
    weights_dirs = [RVC / "weights", RVC / "logs" / exp]
    pths: list[Path] = []
    for d in weights_dirs:
        pths += sorted(d.glob(f"{exp}*.pth")) + sorted(d.glob("G_*.pth"))
    pths = [p for p in pths if p.is_file()]
    if not pths:
        print("✗ 没找到训练产出的 .pth，检查训练日志")
        return 2
    # 选最新/最大的一个作为最终模型
    best = max(pths, key=lambda p: p.stat().st_mtime)
    dst_pth = out / f"{args.name}.pth"
    shutil.copy2(best, dst_pth)
    dst_idx = None
    if index_files:
        best_idx = max(index_files, key=lambda p: p.stat().st_mtime)
        dst_idx = out / f"added_{args.name}.index"
        shutil.copy2(best_idx, dst_idx)

    summary = {
        "name": args.name, "sr": args.sr, "version": version,
        "epochs": args.epochs, "batch": max(1, min(2, args.batch)),
        "model": str(dst_pth), "index": str(dst_idx) if dst_idx else None,
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "voice_seconds": round(total_sec, 1),
    }
    (out / "train_result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    logfile.write_text("\n".join(LOG), encoding="utf-8")

    print("\n✅ 训练完成")
    print(f"   模型：{dst_pth}")
    if dst_idx:
        print(f"   索引：{dst_idx}")
    print("\n加载到实时翻唱：")
    print(f"   curl -X POST http://127.0.0.1:8005/load_model -H \"content-type: application/json\" "
          f"-d '{{\"model_path\":\"{dst_pth}\",\"index_path\":\"{dst_idx or ''}\"}}'")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断（已完成步骤有 .done 标记，重跑会跳过）")
        sys.exit(130)
