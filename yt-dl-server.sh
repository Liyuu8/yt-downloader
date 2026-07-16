#!/bin/bash
set -e

DOWNLOADS_DIR="$HOME/Downloads/downloads"
mkdir -p "$DOWNLOADS_DIR"

docker run -d \
  --name yt-downloader-server \
  --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -e YT_DL_HOST=0.0.0.0 \
  -e YT_DL_OUTPUT=/downloads \
  -v "$DOWNLOADS_DIR:/downloads" \
  --entrypoint node \
  yt-downloader dist/server.js
