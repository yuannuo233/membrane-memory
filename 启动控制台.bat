@echo off
chcp 936 >nul
title Membrane 记忆脑 - Web 控制台
setlocal

set "NODE=E:\开源盛世\tools\nodejs\node.exe"
set "CLI=E:\开源盛世\membrane\dist\cli.js"
set "DB=E:\开源盛世\membrane\data\membrane.db"

echo ============================================
echo   Membrane 记忆脑 - Web 控制台
echo ============================================
echo.
if not exist "%CLI%" (
    echo   还没有编译。请先双击运行"一键安装.bat"。
    pause
    exit /b 1
)
if not exist "%NODE%" (
    echo   找不到 node.exe：%NODE%
    pause
    exit /b 1
)
set "MEMBRANE_DB=%DB%"
set "MEMBRANE_PORT=8317"
echo   正在启动... 打开浏览器访问：
echo.
echo        http://127.0.0.1:8317/
echo.
echo   关闭此窗口即停止服务。
echo.
"%NODE%" "%CLI%" serve
