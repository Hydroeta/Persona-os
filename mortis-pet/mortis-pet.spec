# -*- mode: python ; coding: utf-8 -*-


import os as _os

_ffmpeg = _os.path.join(_os.path.expanduser('~'), '.local', 'bin', 'ffmpeg.exe')
# 台词文件 config.json 用户自备、不入库：存在则捆绑，否则捆绑占位模板
_cfg = 'config.json' if _os.path.exists('config.json') else 'config.example.json'
_datas = [('videos', 'videos'), (_cfg, '.')]
if _os.path.exists(_ffmpeg):
    _datas.append((_ffmpeg, 'bin'))

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=_datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mortis-pet',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='mortis-pet',
)
