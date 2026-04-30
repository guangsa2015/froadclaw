@echo off
chcp 65001 >nul
title FroadClaw-Agent

:menu
echo.
echo ========================================
echo        FroadClaw-Agent 控制台
echo ========================================
echo.
echo   1. 编译 (pnpm build)
echo   2. 启动 (pnpm start)
echo   3. 开发模式 (pnpm dev)
echo   4. 类型检查 (pnpm lint)
echo   5. 安装依赖 (pnpm install)
echo   6. 手动输入模式
echo   0. 退出
echo.
set /p choice=请选择操作 [0-6]: 

if "%choice%"=="1" goto build
if "%choice%"=="2" goto start
if "%choice%"=="3" goto dev
if "%choice%"=="4" goto lint
if "%choice%"=="5" goto install
if "%choice%"=="6" goto manual
if "%choice%"=="0" goto end
echo 无效选项，请重新选择
goto menu

:build
echo.
echo [编译中...]
call pnpm build
echo.
echo [编译完成]
pause
goto menu

:start
echo.
echo [启动服务...]
call pnpm start
pause
goto menu

:dev
echo.
echo [开发模式启动中... Ctrl+C 停止]
call pnpm dev
pause
goto menu

:lint
echo.
echo [类型检查中...]
call pnpm lint
echo.
echo [检查完成]
pause
goto menu

:install
echo.
echo [安装依赖中...]
call pnpm install
echo.
echo [安装完成]
pause
goto menu

:manual
echo.
echo 手动输入模式 (输入 exit 返回菜单)
echo ----------------------------------------
:manual_loop
set /p cmd=^> 
if /i "%cmd%"=="exit" goto menu
if "%cmd%"=="" goto manual_loop
call %cmd%
goto manual_loop

:end
exit /b 0
