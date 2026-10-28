@echo off
chcp 65001 >nul
title Whale AI Ecosystem Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\安装.ps1"
