# -*- coding: utf-8 -*-
"""persona-os · 多厂商 API 资金看板（一厂一策：真实直查 + 本地 Token 账本精算）

各厂商财务接口开放程度不同，混合监控：
  - DeepSeek：官方 /user/balance 接口真实直查（Bearer Key，5s 超时，失败静默记 error）
  - GLM(智谱) / Qwen(阿里百炼)：无公开余额接口（百炼真实余额需主账号 BSS OpenAPI，
    权限过重不安全），改为读 llm_gate 账本本月 token × config/api_pricing.json 单价精算，
    用「月度预算 - 已估花费」得出剩余额度

进阶：路由网关喂给 llm_client 的降级依据
  - DeepSeek 余额 < low_balance_yuan      → routing_hint() 建议跳过 deepseek
  - GLM/Qwen 已估花费 ≥ 预算×warn_ratio   → 同样建议回避，把量让给本地/其他家

CLI：
    python tools/balance_monitor.py update    # 全量刷新（含 DeepSeek 网络直查），写缓存
    python tools/balance_monitor.py status    # 读缓存/本地估算，不触网
    python tools/balance_monitor.py hint      # 输出当前路由降级建议
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

PRICING_FILE = ROOT / "config" / "api_pricing.json"
CACHE_FILE = ROOT / "data" / "api_balance.json"

DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
HTTP_TIMEOUT = 5


def load_pricing() -> dict:
    """单价/预算/阈值配置。读不到就返回空 providers（看板降级为空，不崩业务）。"""
    try:
        cfg = json.loads(PRICING_FILE.read_text("utf-8"))
        if isinstance(cfg.get("providers"), dict):
            return cfg
    except Exception:
        pass
    return {"providers": {}, "budget_warn_ratio": 0.9}


def _http_get_json(url: str, key: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % key})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def check_deepseek() -> dict:
    """DeepSeek 真实直查。响应结构：{"balance_infos":[{"total_balance":"3.50",...}]}"""
    try:
        import key_vault
        key = key_vault.get_key("DEEPSEEK_API_KEY") or ""
    except Exception:
        key = ""
    if not key:
        return {"status": "error", "msg": "DEEPSEEK_API_KEY 未配置"}
    try:
        data = _http_get_json(DEEPSEEK_BALANCE_URL, key)
        infos = data.get("balance_infos") or []
        balance = float(infos[0].get("total_balance", 0)) if infos else 0.0
        return {"status": "ok", "balance": round(balance, 2),
                "currency": infos[0].get("currency", "CNY") if infos else "CNY"}
    except Exception as e:  # 网络/鉴权失败不泄密钥，只记类型
        return {"status": "error", "msg": type(e).__name__}


def calc_local_estimate(provider: str, pcfg: dict) -> dict:
    """GLM/Qwen 本地精算：本月 token × 单价 → 已估花费；预算 - 花费 → 剩余额度。"""
    try:
        import llm_gate
        usage = llm_gate.monthly_usage_by_provider().get(provider,
                                                         {"in_tok": 0, "out_tok": 0})
    except Exception:
        return {"status": "error", "msg": "本地账本读取失败"}
    cost = (usage["in_tok"] * pcfg.get("input_per_m", 0.0)
            + usage["out_tok"] * pcfg.get("output_per_m", 0.0)) / 1e6
    budget = float(pcfg.get("monthly_budget_yuan", 0.0))
    return {"status": "estimated",
            "used_this_month": round(cost, 4),   # 小额消耗不能被两位小数抹零
            "budget": budget,
            "balance": round(max(0.0, budget - cost), 2),
            "tokens": usage["in_tok"] + usage["out_tok"]}


def update_all() -> dict:
    """全量刷新并写缓存。DeepSeek 触网，GLM/Qwen 纯本地。"""
    pricing = load_pricing()
    ratio = float(pricing.get("budget_warn_ratio", 0.9))
    out = {"updated_at": time.strftime("%H:%M"), "providers": {}}
    for name, pcfg in pricing["providers"].items():
        if pcfg.get("mode") == "live":
            r = check_deepseek() if name == "deepseek" else {"status": "error",
                                                             "msg": "无直查实现"}
        else:
            r = calc_local_estimate(name, pcfg)
        r["mode"] = pcfg.get("mode", "estimate")
        r["label"] = pcfg.get("label", name)
        # 告警判定：直查看余额阈值，估算看预算占比
        if r.get("status") == "ok" and pcfg.get("low_balance_yuan") is not None:
            r["warn"] = r["balance"] < float(pcfg["low_balance_yuan"])
        elif r.get("status") == "estimated" and r.get("budget"):
            r["warn"] = r["used_this_month"] >= r["budget"] * ratio
        else:
            r["warn"] = False
        out["providers"][name] = r
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass
    return out


def status() -> dict:
    """控制台用：优先读缓存；缓存缺失时本地估算兜底（不触网）。"""
    try:
        cached = json.loads(CACHE_FILE.read_text("utf-8"))
        if cached.get("providers"):
            return cached
    except Exception:
        pass
    pricing = load_pricing()
    out = {"updated_at": "", "providers": {}}
    for name, pcfg in pricing["providers"].items():
        if pcfg.get("mode") == "live":
            r = {"status": "stale", "msg": "尚未直查（跑 update 刷新）"}
        else:
            r = calc_local_estimate(name, pcfg)
        r["mode"] = pcfg.get("mode", "estimate")
        r["label"] = pcfg.get("label", name)
        r["warn"] = False
        out["providers"][name] = r
    return out


def routing_hint() -> dict:
    """给 llm_client 的降级建议：{"avoid": [...], "reasons": {...}}。失败静默返回空。"""
    try:
        st = status()
    except Exception:
        return {"avoid": [], "reasons": {}}
    avoid, reasons = [], {}
    for name, r in st.get("providers", {}).items():
        if not r.get("warn"):
            continue
        if r["mode"] == "live":
            reasons[name] = "余额 ¥%.2f 低于阈值" % r.get("balance", 0)
        else:
            reasons[name] = "本月预估 ¥%.2f 逼近预算 ¥%.2f" % (
                r.get("used_this_month", 0), r.get("budget", 0))
        avoid.append(name)
    return {"avoid": avoid, "reasons": reasons}


def main(argv) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "update":
        print(json.dumps(update_all(), ensure_ascii=False, indent=2))
    elif cmd == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif cmd == "hint":
        print(json.dumps(routing_hint(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
