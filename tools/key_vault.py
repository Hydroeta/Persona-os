# -*- coding: utf-8 -*-
"""小鲸鱼 · 密钥保险库（Windows DPAPI）

用 CryptProtectData 加密密钥，密文绑定当前 Windows 用户，换机/换用户解不开。
解决 .env、connection.env 明文落盘的问题；控制台启动服务时解密注入环境变量。

CLI：
    python tools/key_vault.py set DEEPSEEK_API_KEY        # 回车后隐蔽输入
    python tools/key_vault.py list                        # 只显示是否已存与长度
    python tools/key_vault.py inject                      # 输出 {KEY: 明文} JSON（供启动脚本）
    python tools/key_vault.py remove KEY
    python tools/key_vault.py migrate                     # 明文 .env → 保险库，文件改写为占位符
    python tools/key_vault.py materialize                 # 应急：从保险库把真值写回 .env（用完请 scrub）
    python tools/key_vault.py scrub                       # 把 .env 里的真值改回占位符

占位符机制：.env / connection.env 里写成 ${VAULT:KEY}。控制台启动服务时把保险库
明文注入子进程环境变量（ohwhale 的 secret() 环境变量优先；Node --env-file 不覆盖
已有环境变量），明文不再落盘。绕过控制台直接跑脚本时，先 materialize、用完 scrub。
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import getpass
import json
import sys
from pathlib import Path

VAULT_FILE = Path(__file__).resolve().parent / "keys.dpapi.json"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _crypt(data: bytes, protect: bool) -> bytes:
    blob_in = _Blob(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)),
                                           ctypes.POINTER(ctypes.c_char)))
    blob_out = _Blob()
    func = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not func(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError("DPAPI 调用失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def encrypt(text: str) -> str:
    return base64.b64encode(_crypt(text.encode("utf-8"), True)).decode()


def decrypt(blob: str) -> str:
    return _crypt(base64.b64decode(blob), False).decode("utf-8")


def _load() -> dict:
    if VAULT_FILE.is_file():
        try:
            return json.loads(VAULT_FILE.read_text("utf-8"))
        except Exception:
            return {}
    return {}


def _save(data: dict) -> None:
    VAULT_FILE.write_text(json.dumps(data, indent=2), "utf-8")


def set_key(key: str, value: str) -> None:
    d = _load()
    d[key] = encrypt(value)
    _save(d)


def get_key(key: str):
    blob = _load().get(key)
    return decrypt(blob) if blob else None


def remove_key(key: str) -> bool:
    d = _load()
    if key in d:
        del d[key]
        _save(d)
        return True
    return False


def all_keys() -> dict:
    """解密全部，供启动服务时注入环境变量。"""
    out = {}
    for k, blob in _load().items():
        try:
            out[k] = decrypt(blob)
        except Exception:
            pass
    return out


def status() -> list:
    return [{"key": k, "len": len(get_key(k) or "")} for k in _load()]


# ---------- 明文 .env 迁移（消灭落盘明文） ----------

ROOT = VAULT_FILE.resolve().parent.parent
PLACEHOLDER = "${VAULT:%s}"

# 密钥 → 它可能出现的明文文件（相对项目根）
SECRET_FILES = {
    "DEEPSEEK_API_KEY": ["ohwhale-deploy/.env", "dsh/connection.env"],
    "DASHSCOPE_API_KEY": ["ohwhale-deploy/.env"],
    "ASTRBOT_DASHBOARD_PASSWORD": ["ohwhale-deploy/.env"],
    "ONEBOT_ACCESS_TOKEN": ["ohwhale-deploy/.env"],
}


def _file_value(path: Path, key: str):
    try:
        for line in path.read_text("utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def _file_write(path: Path, key: str, value: str) -> None:
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


def migrate() -> list:
    """明文 → 保险库，文件改为占位符。返回动作日志。"""
    log = []
    for key, files in SECRET_FILES.items():
        for rel in files:
            f = ROOT / rel
            v = _file_value(f, key)
            if v and not v.startswith("${VAULT:"):
                set_key(key, v)
                _file_write(f, key, PLACEHOLDER % key)
                log.append("已迁移 %s ← %s（文件已改占位符）" % (key, rel))
    return log


def materialize() -> list:
    """应急：把保险库真值写回文件（绕过控制台直接跑脚本时用）。"""
    log = []
    for key, files in SECRET_FILES.items():
        v = get_key(key)
        if not v:
            continue
        for rel in files:
            f = ROOT / rel
            if f.exists():
                _file_write(f, key, v)
                log.append("已写回 %s → %s" % (key, rel))
    return log


def scrub() -> list:
    """把文件里的真值改回占位符。"""
    log = []
    for key, files in SECRET_FILES.items():
        for rel in files:
            f = ROOT / rel
            v = _file_value(f, key)
            if v and not v.startswith("${VAULT:"):
                _file_write(f, key, PLACEHOLDER % key)
                log.append("已擦除 %s 于 %s" % (key, rel))
    return log


def plaintext_remaining() -> list:
    """仍存在明文密钥的文件列表（自检/告警用）。"""
    bad = []
    for key, files in SECRET_FILES.items():
        for rel in files:
            v = _file_value(ROOT / rel, key)
            if v and not v.startswith("${VAULT:"):
                bad.append("%s (%s)" % (rel, key))
    return bad


def main(argv) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "set" and len(argv) >= 3:
        v = getpass.getpass("输入 %s 的值（不显示）：" % argv[2])
        if len(v) < 4:
            print("值太短")
            return 1
        set_key(argv[2], v)
        print("已加密存入", VAULT_FILE.name)
    elif cmd == "list":
        for it in status():
            print("%s  (长度 %d)" % (it["key"], it["len"]))
    elif cmd == "remove" and len(argv) >= 3:
        print("已删除" if remove_key(argv[2]) else "不存在")
    elif cmd == "inject":
        # 明文只进内存/管道，不落盘
        sys.stdout.write(json.dumps(all_keys()))
    elif cmd == "migrate":
        log = migrate()
        print("\n".join(log) if log else "没有发现明文密钥，无需迁移")
    elif cmd == "materialize":
        log = materialize()
        print("\n".join(log) if log else "保险库为空")
        print("提醒：用完请执行 scrub 恢复占位符")
    elif cmd == "scrub":
        log = scrub()
        print("\n".join(log) if log else "文件已是占位符状态")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
