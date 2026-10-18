@echo off
chcp 65001 >nul
title 漫画阅读器 · 安装
cd /d "%~dp0"

echo.
echo   正在启动安装程序...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装.ps1"

if errorlevel 1 (
    echo.
    echo   安装过程出现问题，请截图反馈。
    pause
)
