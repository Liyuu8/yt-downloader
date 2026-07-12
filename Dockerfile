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

# ffmpeg + yt-dlp + Deno（YouTube JS チャレンジ解決に必要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && pip3 install --break-system-packages --upgrade 'yt-dlp[default]' \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get purge -y python3-pip curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

VOLUME ["/downloads"]
EXPOSE 8765
ENTRYPOINT ["node", "dist/index.js"]
