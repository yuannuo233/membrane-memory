@echo off
chcp 936 >nul
title Membrane 记忆脑
setlocal enabledelayedexpansion

REM ============================================================
REM  Membrane 记忆脑 - 一键启动（应用窗口版 v%VER%）
REM  路径自动定位（%~dp0），不写死盘符
REM  行为：服务已在跑 → 直接开应用窗口；没在跑 → 后台启动服务再开窗
REM  应用窗口 = Edge --app 模式（无地址栏、独立窗口，像桌面软件）
REM  停止服务：关闭任务栏里的 "Membrane 服务" 最小化窗口
REM ============================================================

set "MEMDIR=%~dp0"
if "%MEMDIR:~-1%"=="\" set "MEMDIR=%MEMDIR:~0,-1%"
set "CLI=%MEMDIR%\dist\cli.js"
set "DATADIR=%MEMDIR%\data"
set "VER=未知"
set "PORT=8317"
set "URLFILE=%DATADIR%\membrane.db.url"
set "HEALTH=http://127.0.0.1:%PORT%/api/health"

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

echo ============================================
echo   Membrane 记忆脑  v%VER%
echo ============================================
echo.

REM ---------- 服务已在运行？直接开应用窗口 ----------
curl -s -o NUL -m 2 %HEALTH% >nul 2>nul
if not errorlevel 1 goto reuse

REM ---------- 后台启动服务（最小化窗口；关它即停服务） ----------
if exist "%URLFILE%" del "%URLFILE%" >nul 2>&1
start "Membrane 服务" /min "%NODE%" "%CLI%" serve
echo   服务正在启动……

REM ---------- 等服务写出带 token 的控制台地址（<db>.url） ----------
set /a WAITED=0
:waiturl
if exist "%URLFILE%" goto openurl
if %WAITED% GEQ 20 goto openplain
ping -n 2 127.0.0.1 >nul
set /a WAITED+=1
goto waiturl

:reuse
echo   检测到服务已在运行，直接打开应用窗口。

:openurl
if not exist "%URLFILE%" goto openplain
set /p MURL=<"%URLFILE%"
if "%MURL%"=="" goto openplain
goto launch

:openplain
set "MURL=http://127.0.0.1:%PORT%/"

:launch
REM ---------- Edge --app：无地址栏的独立应用窗口 ----------
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
    start "" "%EDGE%" --app="%MURL%"
) else (
    start "" "%MURL%"
)
echo   应用窗口已打开
echo   地址：%MURL%
echo   停止服务：关闭任务栏里的 "Membrane 服务" 最小化窗口
ping -n 5 127.0.0.1 >nul
exit /b 0
