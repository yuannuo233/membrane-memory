@echo off
chcp 936 >nul
title Membrane 记忆脑 - Web 控制台
setlocal enabledelayedexpansion

REM ============================================================
REM  Membrane 记忆脑 - Web 控制台
REM  路径自动定位（%~dp0），不写死盘符
REM  关闭此窗口 = 停止服务，不留后台进程
REM ============================================================

set "MEMDIR=%~dp0"
if "%MEMDIR:~-1%"=="\" set "MEMDIR=%MEMDIR:~0,-1%"
set "CLI=%MEMDIR%\dist\cli.js"
set "DATADIR=%MEMDIR%\data"
set "VER=未知"

REM ---------- 找 node ----------
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE (
    if exist "%MEMDIR%\..\tools\nodejs\node.exe" set "NODE=%MEMDIR%\..\tools\nodejs\node.exe"
)
if not defined NODE (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE (
    if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)
if not defined NODE (
    echo   [X] 找不到 Node.js，请先安装 Node.js 24+：https://nodejs.org
    pause
    exit /b 1
)

REM ---------- 读版本 ----------
cd /d "%MEMDIR%"
set "VFILE=%TEMP%\_membrane_ver.txt"
"%NODE%" -p "require('./package.json').version" > "%VFILE%" 2>nul
if exist "%VFILE%" (
    set /p VER=<"%VFILE%"
    del "%VFILE%" >nul 2>&1
)

REM ---------- 检查编译产物 ----------
if not exist "%CLI%" (
    echo   [!] 还没编译，正在自动构建...
    echo.
    call "%MEMDIR%\..\tools\nodejs\npm.cmd" --prefix "%MEMDIR%" run build 2>nul || call npm --prefix "%MEMDIR%" run build
    if errorlevel 1 (
        echo   [X] 构建失败。请双击"一键安装.bat"。
        pause
        exit /b 1
    )
)

REM ---------- 准备数据目录 ----------
if not exist "%DATADIR%" mkdir "%DATADIR%"
set "MEMBRANE_DB=%DATADIR%\membrane.db"
set "MEMBRANE_PORT=8317"

echo ============================================
echo   Membrane 记忆脑 - Web 控制台  v%VER%
echo ============================================
echo.
echo   数据库：%MEMBRANE_DB%
echo   控制台：http://127.0.0.1:8317/
echo.
echo   提示：关闭此窗口即停止服务（不占后台内存）
echo ============================================
echo.

start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8317/"

"%NODE%" "%CLI%" serve

echo.
echo   服务已停止。
pause
