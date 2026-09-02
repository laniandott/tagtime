@echo off
chcp 65001 >nul
set PORT=3000
set HOST=::
cd /d "%~dp0"
set "DATA_DIR=%~dp0data"
set "NOTES_DIR=%~dp0data\notes"
set "DB_FILE=%~dp0data\tagtime.db"
set "DATABASE_URL=file:%DB_FILE:\=/%"
"C:\Program Files\nodejs\node.exe" apps/server/dist/index.js
