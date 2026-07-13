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

# 概要欄・コメントも一緒に取得（ローカルで閲覧可能）
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx" -d -c

# プレイリストを一括ダウンロード（URL が playlist?list= なら自動検出）
./yt-dl.sh -u "https://www.youtube.com/playlist?list=PLxxxxxxxxx"

# watch URL からプレイリスト全体をダウンロード
./yt-dl.sh -u "https://www.youtube.com/watch?v=xxxxxxxxx&list=PLxxxxxxxxx" -p

# shorts / live URL にも対応
./yt-dl.sh -u "https://www.youtube.com/shorts/xxxxxxxxx"
```

ダウンロード先はデフォルトで `~/Downloads/downloads/` です。  
プレイリストは `downloads/<プレイリスト名>/<連番> - <タイトル>.mp4` の形式で保存されます。

## オプション一覧

| オプション            | 短縮形 | 説明                                          | デフォルト   |
| --------------------- | ------ | --------------------------------------------- | ------------ |
| `--url <url>`         | `-u`   | YouTube の URL（必須）                        | -            |
| `--output <dir>`      | `-o`   | 出力ディレクトリ（コンテナ内パス）            | `/downloads` |
| `--quality <quality>` | `-q`   | 画質: `best` / `1080` / `720` / `480` / `360` | `best`       |
| `--audio-only`        | `-a`   | 音声のみ（MP3）でダウンロード                 | `false`      |
| `--playlist`          | `-p`   | プレイリスト全体をダウンロード                | `false`      |
| `--description`       | `-d`   | 概要欄を Markdown ファイルに含めて保存        | `false`      |
| `--comments`          | `-c`   | コメントを取得し Markdown ファイルに含めて保存 | `false`      |

## 概要欄・コメントの保存

`-d`（概要欄）/ `-c`（コメント）を指定すると、動画ファイルと同じ場所・同じファイル名で `<タイトル>.md` が保存され、指定したセクション（`## 概要欄` / `## コメント`）にまとまります。両方指定した場合は 1 つの Markdown ファイルに両方が収録されます。コメントは返信をインデントで表示し、上位 200 件まで取得します。

Markdown ファイルなのでエディタやターミナルでそのまま閲覧できます。コメント取得は動画によっては時間がかかる場合があります。

## 対応 URL 形式

- `https://www.youtube.com/watch?v=xxxxxxxxx`
- `https://youtu.be/xxxxxxxxx`
- `https://www.youtube.com/shorts/xxxxxxxxx`
- `https://www.youtube.com/live/xxxxxxxxx`
- `https://www.youtube.com/playlist?list=PLxxxxxxxxx`（自動でプレイリストモード）

## yt-dlp のアップデート

```bash
docker build --no-cache -t yt-downloader .
```

## トラブルシューティング

### `HTTP Error 403: Forbidden` / JS runtime が見つからない

YouTube は JS チャレンジ（n-parameter）の解決を要求します。Docker イメージには Deno と Node.js が含まれています。エラーが出た場合はイメージを再ビルドしてください。

```bash
docker build --no-cache -t yt-downloader .
```

ホストで直接 yt-dlp を使う場合は、Deno または Node.js をインストールし、yt-dlp も最新版に更新してください。

```bash
brew install deno yt-dlp
# または
pip install --upgrade 'yt-dlp[default]'
```

## 注意事項

- 著作権で保護されたコンテンツのダウンロードは、YouTube の利用規約に違反する可能性があります
- 自身がアップロードした動画、クリエイティブ・コモンズ動画、著作権フリーコンテンツのバックアップ用途でご使用ください
- 本ツールは個人学習・研究目的で作成されています

## Chrome 拡張機能

YouTube のフィード（登録チャンネル、ホーム、検索結果など）のサムネイル上から直接ダウンロードできる Chrome 拡張機能です。  
既存の yt-dlp ロジックをローカル API サーバー経由で利用します。

### 前提条件

- [Google Chrome](https://www.google.com/chrome/)
- ローカル API サーバーの実行環境（以下のどちらか）
  - **Docker**（推奨・ホストを汚さない）: [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - **ホスト直接実行**: yt-dlp・ffmpeg（任意）・deno（任意）

```bash
# ホスト直接実行する場合のみ必要
brew install yt-dlp ffmpeg deno
```

### セットアップ

**1. ローカル API サーバーを起動**

Docker の場合（yt-dlp・ffmpeg をホストにインストール不要）:

```bash
docker build -t yt-downloader .
chmod +x yt-dl-server.sh   # 初回のみ
./yt-dl-server.sh
```

ホストに直接インストールする場合:

```bash
npm install
npm run server
```

サーバーは `http://127.0.0.1:8765` で待ち受け（Docker の場合もホストのループバックにのみ公開）、ダウンロード先は `~/Downloads/downloads/` です。

**2. Chrome 拡張機能を読み込む**

1. Chrome で `chrome://extensions` を開く
2. 「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」
4. プロジェクト内の `extension/` フォルダを選択

**3. 使い方**

1. サーバー（`./yt-dl-server.sh` または `npm run server`）が起動していることを確認
2. [YouTube 登録チャンネル](https://www.youtube.com/feed/subscriptions) などを開く
3. 動画サムネイルにマウスを乗せると ⬇ ボタンが表示される
4. ボタンをクリックするとダウンロードが開始される

拡張機能のアイコンをクリックすると、画質・音声のみ・サーバー URL の設定ができます。

### 対応ページ

- `/feed/subscriptions`（登録チャンネル）
- `/`（ホーム）
- `/results`（検索結果）
- チャンネルの動画一覧
- サイドバーのおすすめ動画

### 環境変数（サーバー）

| 変数            | 説明               | デフォルト                    |
| --------------- | ------------------ | ----------------------------- |
| `YT_DL_PORT`    | サーバーポート     | `8765`                        |
| `YT_DL_OUTPUT`  | 出力ディレクトリ   | `~/Downloads/downloads`       |
