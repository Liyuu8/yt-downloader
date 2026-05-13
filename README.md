# yt-downloader

YouTube の URL を指定して MP4（または MP3）に変換・ダウンロードする CLI ツールです。  
Docker コンテナで動作するため、yt-dlp・ffmpeg のホストへのインストールは不要です。

## 前提条件

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## セットアップ

```bash
# イメージをビルド（初回のみ）
docker build -t yt-downloader .

# 起動スクリプトに実行権限を付与（初回のみ）
chmod +x yt-dl.sh
```

どこからでも呼び出せるようにする場合（任意）：

```bash
sudo ln -s "$(pwd)/yt-dl.sh" /usr/local/bin/yt-dl
```

## 使い方

```bash
# 基本（最高画質で MP4 ダウンロード）
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx"

# 画質を指定してダウンロード（720p）
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx" -q 720

# 出力ディレクトリを指定
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx" -o ~/Videos

# 音声のみ MP3 でダウンロード
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx" -a

# shorts / live URL にも対応
./yt-dl.sh -u "https://www.youtube.com/shorts/xxxxxxxxx"
```

ダウンロード先はデフォルトで `~/Downloads/downloads/` です。

## オプション一覧

| オプション | 短縮形 | 説明 | デフォルト |
|-----------|--------|------|-----------|
| `--url <url>` | `-u` | YouTube の URL（必須） | - |
| `--output <dir>` | `-o` | 出力ディレクトリ（コンテナ内パス） | `/downloads` |
| `--quality <quality>` | `-q` | 画質: `best` / `1080` / `720` / `480` / `360` | `best` |
| `--audio-only` | `-a` | 音声のみ（MP3）でダウンロード | `false` |

## 対応 URL 形式

- `https://www.youtube.com/watch?v=xxxxxxxxx`
- `https://youtu.be/xxxxxxxxx`
- `https://www.youtube.com/shorts/xxxxxxxxx`
- `https://www.youtube.com/live/xxxxxxxxx`

## yt-dlp のアップデート

```bash
docker build --no-cache -t yt-downloader .
```

## 注意事項

- 著作権で保護されたコンテンツのダウンロードは、YouTube の利用規約に違反する可能性があります
- 自身がアップロードした動画、クリエイティブ・コモンズ動画、著作権フリーコンテンツのバックアップ用途でご使用ください
- 本ツールは個人学習・研究目的で作成されています
