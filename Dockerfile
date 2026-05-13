# ── ビルドステージ ──────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

# ── 実行ステージ ────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# ffmpeg + yt-dlp（Python経由でアーキテクチャ非依存インストール）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

VOLUME ["/downloads"]
ENTRYPOINT ["node", "dist/index.js"]
