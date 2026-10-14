#!/usr/bin/env bash
# start.sh - 一键启动 Tech Mentor Studio 并打开浏览器
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

exec node scripts/start.js
