@echo off
chcp 65001 >nul
cd /d %~dp0
title 小鲸鱼控制台
echo 控制台启动后，请复制窗口里打印的完整链接（带 token）到浏览器打开。
echo.
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 console.py
) else (
    python console.py
)
pause
