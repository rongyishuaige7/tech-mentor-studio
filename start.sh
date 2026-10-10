#!/usr/bin/env bash
# start.sh - 一键启动 Tech Mentor Studio 并打开浏览器
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=3300

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo "📦 正在安装依赖..."
  npm install
fi

echo "🚀 正在启动 Tech Mentor Studio (http://localhost:$PORT)..."

# 如果已有旧进程占用该端口，提示或平滑杀死
PID=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "⚠️ 发现已有进程占用端口 $PORT (PID: $PID)，正在重启..."
  kill -9 "$PID" 2>/dev/null || true
  sleep 1
fi

# 后台启动或前台启动
# 启动并在 1 秒后自动打开浏览器
(sleep 1 && open "http://localhost:$PORT") &

exec node server.js
