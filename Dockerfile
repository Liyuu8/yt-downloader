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
# + bgutil-ytdlp-pot-provider（YouTube の PO Token 要求への対応。413/403 の主因になりやすいため導入）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && pip3 install --break-system-packages --upgrade 'yt-dlp[default]' bgutil-ytdlp-pot-provider \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/1.3.1.tar.gz \
        | tar xz -C /opt \
    && mv /opt/bgutil-ytdlp-pot-provider-1.3.1 /opt/bgutil-ytdlp-pot-provider \
    && (cd /opt/bgutil-ytdlp-pot-provider/server && npm ci && npx tsc) \
    && apt-get purge -y python3-pip curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

VOLUME ["/downloads"]
EXPOSE 8765
ENTRYPOINT ["node", "dist/index.js"]
