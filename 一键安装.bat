@echo off
chcp 936 >nul
title Membrane 记忆脑 一键安装
setlocal

echo ============================================
echo   Membrane 记忆脑 - 一键安装
echo   时间感知 / 本地优先 / 可解释 的 Agent 记忆
echo ============================================
echo.

set "NODE=E:\开源盛世\tools\nodejs\node.exe"
set "NPMCMD=E:\开源盛世\tools\nodejs\npm.cmd"
set "MEMDIR=E:\开源盛世\membrane"
set "DATADIR=%MEMDIR%\data"
set "DBPATH=%DATADIR%\membrane.db"

echo [1/4] 检查 Node 是否就绪...
if not exist "%NODE%" (
    echo   错误：没找到 node.exe：%NODE%
    echo   请确认 tools\nodejs 目录存在。
    goto :fail
)
echo   OK：%NODE%

echo.
echo [2/4] 建立数据目录...
if not exist "%DATADIR%" mkdir "%DATADIR%"
echo   OK：%DATADIR%

echo.
echo [3/4] 编译源码（生成 dist 目录）...
cd /d "%MEMDIR%"
set "NPM_CONFIG_CACHE=E:\开源盛世\tools\npm-cache"
set "PATH=E:\开源盛世\tools\nodejs;%PATH%"
call "%NPMCMD%" run build
if errorlevel 1 (
    echo   编译失败，请看上面的红色报错。
    goto :fail
)
echo   OK：编译完成

echo.
echo [4/4] 自检：打印库况...
set "MEMBRANE_DB=%DBPATH%"
"%NODE%" "%MEMDIR%\dist\cli.js" stats
if errorlevel 1 (
    echo   库况检查失败。
    goto :fail
)
echo   OK：记忆库正常

echo.
echo ============================================
echo   安装完成！
echo ============================================
echo.
echo   记忆数据库：%DBPATH%
echo.
echo   下一步：把下面这段加到你的 Agent 工具
echo   （WorkBuddy / Claude / Cline / Cursor / 反重力 等）的 MCP 配置里：
echo.
echo   "membrane": {
echo     "command": "%NODE%",
echo     "args": ["%MEMDIR%\dist\cli.js", "mcp"],
echo     "env": { "MEMBRANE_DB": "%DBPATH%" }
echo   }
echo.
echo   详细图文教程见：适配配置\各工具接入配置.md
echo.
pause
exit /b 0

:fail
echo.
echo 安装未完成，请把上面的报错发给 AI 助手。
pause
exit /b 1
