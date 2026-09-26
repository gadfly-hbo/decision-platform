#!/bin/bash
# 一键启动决策看板（前端 + 后端）；被「启动决策看板.command」与 npm run dev:all 共用。
# 端口约定（避开兄弟项目 5173/4173/8787/8080/5021/2122/1234）：
#   后端 8642（可用 PORT 覆盖）、前端 5180（可用 FRONT_PORT 覆盖）。
# NO_OPEN=1 时不自动打开浏览器（供脚本化验证使用）。
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_PORT="${PORT:-8642}"
FRONT_PORT="${FRONT_PORT:-5180}"

echo "== 决策看板（前端 :${FRONT_PORT} / 后端 :${BACKEND_PORT}） =="

if [ ! -d node_modules ]; then
  echo "[首次运行] 安装依赖…"
  npm install --no-audit --no-fund
fi

BACKEND_PID=""
FRONT_PID=""
cleanup() {
  [ -n "$FRONT_PID" ] && kill "$FRONT_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[启动] 后端 http://127.0.0.1:$BACKEND_PORT"
PORT="$BACKEND_PORT" npm run server &
BACKEND_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null; then break; fi
  sleep 1
done

echo "[启动] 前端 http://127.0.0.1:$FRONT_PORT"
npm run dev:front -- --port "$FRONT_PORT" --strictPort &
FRONT_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$FRONT_PORT" >/dev/null; then break; fi
  sleep 1
done

if [ "${NO_OPEN:-0}" != "1" ]; then
  open "http://127.0.0.1:$FRONT_PORT"
fi

echo "[就绪] Ctrl+C 退出（前后端同时停止）"
wait "$FRONT_PID"
