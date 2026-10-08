@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul || (echo ثبّت Node.js أولاً من https://nodejs.org ثم أعد التشغيل & pause & exit)
if not exist node_modules call npm install
node src/index.js
pause
