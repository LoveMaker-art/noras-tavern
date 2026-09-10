@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Nora-Tavern.ps1" %*
set STATUS=%ERRORLEVEL%
echo.
if "%STATUS%"=="0" (
  echo [nora-tavern-launcher] 安装完成。请运行 hermes model 配置模型，重启 Hermes，然后让 Nora 检查 Tavern 状态。
) else (
  echo [nora-tavern-launcher] 安装失败。请保留上方错误信息。
)
pause
exit /b %STATUS%
