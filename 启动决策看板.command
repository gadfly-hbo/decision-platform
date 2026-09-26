#!/bin/bash
# 一键启动决策看板（双击运行）：安装依赖（首次）→ 起后端 + 前端 → 打开浏览器。
cd "$(dirname "$0")"
exec bash scripts/dev-all.sh
