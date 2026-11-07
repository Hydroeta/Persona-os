@echo off
rem audio-cover 微服务启动器（带 RVC worker 环境变量）
set AUDIO_COVER_PORT=8005
set RVC_NO_WARMUP=1
set RVC_LOAD_TIMEOUT=60
set RVC_WORKER_TIMEOUT=3
"C:\Users\79365\Documents\douyin-whale\.venv-tts\Scripts\python.exe" -u "C:\Users\79365\Desktop\新建文件夹 (2)\github-release\persona-os\core-services\audio-cover\main.py"
