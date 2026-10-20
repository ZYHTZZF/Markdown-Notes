@echo off
chcp 65001 >nul
if exist "%~dp0release\知页-win-x64\知页.exe" (
  start "" "%~dp0release\知页-win-x64\知页.exe"
) else (
  echo 请先解压Windows成品包，或在源码目录执行 npm run package。
  pause
)
