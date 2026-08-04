@echo off
chcp 65001 >nul
set PORT=3000
set HOST=::
set DATABASE_URL=file:./data/tagtime.db
set DATA_DIR=./data
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" apps/server/dist/index.js
