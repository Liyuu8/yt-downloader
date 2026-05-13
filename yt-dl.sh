#!/bin/bash
set -e

DOWNLOADS_DIR="$HOME/Downloads/downloads"
mkdir -p "$DOWNLOADS_DIR"

docker run --rm -it \
  -v "$DOWNLOADS_DIR:/downloads" \
  yt-downloader "$@"
