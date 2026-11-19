@echo off
chcp 936 >nul
title Membrane 记忆脑 - Web 控制台
setlocal enabledelayedexpansion

REM ============================================================
REM  Membrane 记忆脑 - 控制台启动器
REM  路径自动定位（用 %~dp0），不写死盘符，换机器也能用
REM ============================================================

set "MEMDIR=%~dp0"
if "%MEMDIR:~-1%"=="\" set "MEMDIR=%MEMDIR:~0,-1%"
set "CLI=%MEMDIR%\dist\cli.js"
set "DATADIR=%MEMDIR%\data"

echo ============================================
echo    Membrane 记忆脑 - Web 控制台
echo ============================================
echo.

REM ---------- 1. 找 node ----------
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE (
    if exist "%MEMDIR%\..\tools\nodejs\node.exe" set "NODE=%MEMDIR%\..\tools\nodejs\node.exe"
)
if not defined NODE (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE (
    echo   [X] 找不到 Node.js
    echo.
    echo   请先安装 Node.js 24 或更高版本： https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM ---------- 2. 检查编译产物 ----------
if not exist "%CLI%" (
    echo   [!] 还没编译，正在自动构建...
    echo.
    if exist "%MEMDIR%\..\tools\nodejs\npm.cmd" (
        call "%MEMDIR%\..\tools\nodejs\npm.cmd" --prefix "%MEMDIR%" run build
    ) else (
        call npm --prefix "%MEMDIR%" run build
    )
    if errorlevel 1 (
        echo.
        echo   [X] 构建失败。请双击"一键安装.bat"或手动执行 npm install ^&^& npm run build
        pause
        exit /b 1
    )
)

REM ---------- 3. 准备数据目录 ----------
if not exist "%DATADIR%" mkdir "%DATADIR%"
set "MEMBRANE_DB=%DATADIR%\membrane.db"
set "MEMBRANE_PORT=8317"

echo   数据库：%MEMBRANE_DB%
echo   控制台：http://127.0.0.1:8317/
echo.
echo   提示：关闭此窗口即停止服务（不占后台内存）
echo ============================================
echo.

REM ---------- 4. 稍后自动打开浏览器 ----------
start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8317/"

REM ---------- 5. 前台运行（关窗口即退出）----------
"%NODE%" "%CLI%" serve

echo.
echo   服务已停止。
pause
