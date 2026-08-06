#!/bin/bash
set -e

CONTAINER_NAME="yt-downloader-server"
DOWNLOADS_DIR="$HOME/Downloads/downloads"
mkdir -p "$DOWNLOADS_DIR"

# 前回のコンテナ（停止済み含む）が残っていると名前が衝突するため作り直す
if [ -n "$(docker ps -aq -f "name=^${CONTAINER_NAME}$")" ]; then
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -e YT_DL_HOST=0.0.0.0 \
  -e YT_DL_OUTPUT=/downloads \
  -v "$DOWNLOADS_DIR:/downloads" \
  --entrypoint node \
  yt-downloader dist/server.js