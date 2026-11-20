@echo off
chcp 936 >nul
title Membrane 记忆脑 - 命令行
setlocal enabledelayedexpansion

REM ============================================================
REM  Membrane 记忆脑 - 命令行终端
REM  纯命令行，完全不需要浏览器
REM  路径自动定位（%~dp0），不写死盘符
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

if not exist "%CLI%" (
    echo   [X] 还没编译，请先双击"一键安装.bat"
    pause
    exit /b 1
)

if not exist "%DATADIR%" mkdir "%DATADIR%"
set "MEMBRANE_DB=%DATADIR%\membrane.db"

echo ============================================================
echo    Membrane 记忆脑 - 命令行  v%VER%
echo ============================================================
echo.
echo   数据库：%MEMBRANE_DB%
echo.
echo   常用命令（直接输入，不用敲 node）：
echo.
echo     add "用户住在北京" --subject 用户    写入一条记忆
echo     search "用户住哪"                    召回（带 why 和分数）
echo     relations "张三"                     查关系
echo     link 张三 同学 李四                  建立关系
echo     entities                             列出实体
echo     list                                 列出全部记忆
echo     stats                                统计
echo     doctor                               自检
echo     serve                                启动 Web 控制台（需要浏览器）
echo     mcp-config cursor                    生成 AI 工具接入配置
echo.
echo   输入 exit 或直接关窗口退出
echo ============================================================
echo.

:loop
set "cmd="
set /p "cmd=记忆脑> "
if /i "!cmd!"=="exit" goto :eof
if "!cmd!"=="" goto loop
"%NODE%" "%CLI%" %cmd%
echo.
goto loop
