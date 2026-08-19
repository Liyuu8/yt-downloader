import { spawn } from 'child_process';
import { readFile, writeFile, unlink, readdir } from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import {
  buildFormatSelector,
  getYtDlpBaseArgs,
  type DownloadOptions,
} from './utils.js';

interface VideoInfo {
  title: string;
  duration: string;
  uploader: string;
  filesize?: number;
}

export interface PlaylistInfo {
  title: string;
  uploader: string;
  videoCount: number;
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('ダウンロードがキャンセルされました');
    this.name = 'DownloadCancelledError';
  }
}

// YouTube 側が web_safari/android_vr クライアント向けに実験的な SABR 配信への切り替えを
// ロールアウトしており、PO Token が有効でも実際のダウンロード URL のクライアント指定と
// 不整合が生じ 403 になることがある（https://github.com/yt-dlp/yt-dlp/issues/17456 ,
// https://github.com/yt-dlp/yt-dlp/issues/17232）。web_embedded は実測で 1080p (avc) まで
// 安定して取得できたため第一候補にし、それも失敗する場合の最後の手段として android
// （画質は 360p 相当の format 18 まで下がるが確実に取得できる）を試す
const FALLBACK_PLAYER_CLIENTS = ['web_embedded', 'android'];

// 埋め込み無効・年齢制限などクライアントを変えても解決しない失敗はエラー文言がそれぞれ
// 異なり、文字列で網羅的に判定するのは脆いため、ユーザーが明示的にキャンセルした場合を
// 除き基本的に再試行対象とする（無駄な再試行はあっても、リトライ回数は上限があるため
// 実害は待ち時間程度で済む）
const isRetryableError = (err: unknown): boolean =>
  !(err instanceof DownloadCancelledError);

// フォールバック後も、CDN 側のセッション単位の不安定さによりまれに失敗が続くことがある
// （同一 URL を手動で叩き直すと数回に1回成功する挙動を確認済み）。1回の切り替えだけでは
// 救えないため、候補クライアントを順に何度か試す
const MAX_FALLBACK_ATTEMPTS = 3;
const FALLBACK_RETRY_DELAY_MS = 2000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 403 等が起きた場合、候補クライアントに順に切り替えて数回まで再試行する共通ロジック */
const withPlayerClientFallback = async <T>(
  attempt: (playerClient: string | undefined) => Promise<T>,
): Promise<T> => {
  try {
    return await attempt(undefined);
  } catch (err) {
    if (!isRetryableError(err)) {
      throw err;
    }

    let lastError: unknown = err;
    for (let i = 0; i < MAX_FALLBACK_ATTEMPTS; i++) {
      if (i > 0) {
        await delay(FALLBACK_RETRY_DELAY_MS);
      }

      const playerClient =
        FALLBACK_PLAYER_CLIENTS[i % FALLBACK_PLAYER_CLIENTS.length];

      try {
        return await attempt(playerClient);
      } catch (fallbackErr) {
        if (!isRetryableError(fallbackErr)) {
          throw fallbackErr;
        }
        lastError = fallbackErr;
      }
    }

    throw lastError;
  }
};

/** youtube: の extractor-args は同じキーを複数回渡すと後から渡した方に完全に
 * 上書きされる（マージされない）ため、必ず 1 つの --extractor-args にまとめて渡す */
const buildYoutubeExtractorArgs = (options: string[]): string[] =>
  options.length > 0
    ? ['--extractor-args', `youtube:${options.join(';')}`]
    : [];

const fetchPlaylistInfoOnce = (
  url: string,
  playerClient: string | undefined,
): Promise<PlaylistInfo> => {
  return new Promise((resolve, reject) => {
    const args = [
      ...getYtDlpBaseArgs(),
      '--flat-playlist',
      '--dump-single-json',
      ...buildYoutubeExtractorArgs(
        playerClient ? [`player_client=${playerClient}`] : [],
      ),
      url,
    ];
    const proc = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`プレイリスト情報の取得に失敗しました: ${stderr}`));

        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: (info.title ?? 'Unknown') as string,
          uploader: (info.uploader ?? info.channel ?? 'Unknown') as string,
          videoCount: (info.playlist_count ??
            (info.entries as unknown[])?.length ??
            0) as number,
        });
      } catch {
        reject(new Error('プレイリスト情報のパースに失敗しました'));
      }
    });
  });
};

export const fetchPlaylistInfo = (url: string): Promise<PlaylistInfo> =>
  withPlayerClientFallback((playerClient) =>
    fetchPlaylistInfoOnce(url, playerClient),
  );

const fetchVideoInfoOnce = (
  url: string,
  playerClient: string | undefined,
): Promise<VideoInfo> => {
  return new Promise((resolve, reject) => {
    const args = [
      ...getYtDlpBaseArgs(),
      '--dump-json',
      '--no-playlist',
      ...buildYoutubeExtractorArgs(
        playerClient ? [`player_client=${playerClient}`] : [],
      ),
      url,
    ];
    const proc = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`動画情報の取得に失敗しました: ${stderr}`));

        return;
      }

      try {
        const info = JSON.parse(stdout);
        const duration = formatDuration(info.duration as number);
        resolve({
          title: info.title as string,
          duration,
          uploader: info.uploader as string,
          filesize: info.filesize_approx as number | undefined,
        });
      } catch {
        reject(new Error('動画情報のパースに失敗しました'));
      }
    });
  });
};

export const fetchVideoInfo = (url: string): Promise<VideoInfo> =>
  withPlayerClientFallback((playerClient) =>
    fetchVideoInfoOnce(url, playerClient),
  );

interface CommentEntry {
  id: string;
  text: string;
  author?: string;
  like_count?: number;
  time_text?: string;
  parent?: string;
}

/** yt-dlp の info.json 内のコメントをスレッド形式の読みやすいテキストに整形する */
export const formatComments = (comments: CommentEntry[]): string => {
  const repliesByParent = new Map<string, CommentEntry[]>();
  const topLevel: CommentEntry[] = [];

  for (const comment of comments) {
    if (comment.parent && comment.parent !== 'root') {
      const replies = repliesByParent.get(comment.parent) ?? [];
      replies.push(comment);
      repliesByParent.set(comment.parent, replies);
    } else {
      topLevel.push(comment);
    }
  }

  const lines: string[] = [];

  const renderComment = (comment: CommentEntry, indent: string): void => {
    const likes = comment.like_count ? ` 👍${comment.like_count}` : '';
    lines.push(`${indent}${comment.author ?? '(不明)'}${likes}`);
    for (const textLine of (comment.text ?? '').split('\n')) {
      lines.push(`${indent}${textLine}`);
    }
    lines.push('');

    for (const reply of repliesByParent.get(comment.id) ?? []) {
      renderComment(reply, `${indent}    `);
    }
  };

  for (const comment of topLevel) {
    renderComment(comment, '');
  }

  return lines.join('\n').trimEnd();
};

/** 概要欄・コメントを1つの txt ファイル用のテキストにまとめる */
export const buildNotesText = (
  title: string,
  description: string | undefined,
  comments: CommentEntry[] | undefined,
  saveDescription: boolean,
  saveComments: boolean,
): string => {
  const lines: string[] = [title, ''];

  if (saveDescription) {
    lines.push(
      '■ 概要欄',
      '',
      (description ?? '').trim() || '(概要欄なし)',
      '',
    );
  }

  if (saveComments) {
    const commentList = comments ?? [];
    lines.push(
      `■ コメント (${commentList.length}件)`,
      '',
      formatComments(commentList) || '(コメントなし)',
      '',
    );
  }

  return lines.join('\n').trimEnd() + '\n';
};

export const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return `${m}:${String(s).padStart(2, '0')}`;
};

export type YtDlpLineEvent =
  | { type: 'videoSwitch'; currentVideo: number; totalVideos: number }
  | { type: 'destination'; file: string }
  | { type: 'merged'; file: string }
  | { type: 'infoJson'; file: string }
  | { type: 'progress'; percent: number };

/** yt-dlp の標準出力1行を解析し、検出したイベントを返す（副作用なし） */
export const parseYtDlpLine = (line: string): YtDlpLineEvent[] => {
  const events: YtDlpLineEvent[] = [];

  // プレイリスト: 動画切り替え検出
  const videoMatch = line.match(
    /\[download\] Downloading video (\d+) of (\d+)/,
  );
  if (videoMatch) {
    events.push({
      type: 'videoSwitch',
      currentVideo: parseInt(videoMatch[1], 10),
      totalVideos: parseInt(videoMatch[2], 10),
    });
  }

  // 出力ファイルパスを捕捉
  const destMatch = line.match(
    /\[(?:download|Merger|ExtractAudio)\] Destination: (.+)/,
  );
  if (destMatch) {
    events.push({ type: 'destination', file: destMatch[1].trim() });
  }

  const mergedMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
  if (mergedMatch) {
    events.push({ type: 'merged', file: mergedMatch[1].trim() });
  }

  // 403 からの android クライアントへのフォールバック再試行時など、直前の試行で
  // 既に書き出し済みのファイルを yt-dlp がスキップする場合はこちらにパスが出る
  const alreadyDownloadedMatch = line.match(
    /\[download\] (.+) has already been downloaded/,
  );
  if (alreadyDownloadedMatch) {
    events.push({ type: 'destination', file: alreadyDownloadedMatch[1].trim() });
  }

  // メタデータJSON（概要欄・コメント含む）の出力先を捕捉
  const infoJsonMatch = line.match(
    /\[info\] Writing video metadata as JSON to: (.+)/,
  );
  if (infoJsonMatch) {
    events.push({ type: 'infoJson', file: infoJsonMatch[1].trim() });
  }

  // HLS: フラグメント進捗をパーセントに変換
  const itemMatch = line.match(/\[download\] Downloading item (\d+) of (\d+)/);
  if (itemMatch) {
    const current = parseInt(itemMatch[1], 10);
    const total = parseInt(itemMatch[2], 10);
    if (total > 0) {
      events.push({ type: 'progress', percent: (current / total) * 100 });
    }
  }

  // 通常ダウンロード: [download]  xx.x% of ...
  const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
  if (progressMatch) {
    events.push({ type: 'progress', percent: parseFloat(progressMatch[1]) });
  }

  return events;
};

export interface DownloadResult {
  outputFile: string;
  notesFiles: string[];
}

const runYtDlpDownload = (
  options: DownloadOptions,
  playerClient: string | undefined,
): Promise<DownloadResult> => {
  return new Promise((resolve, reject) => {
    const {
      url,
      outputDir,
      quality,
      audioOnly,
      hasFfmpeg,
      playlist,
      saveDescription,
      saveComments,
      onProgress,
      signal,
    } = options;

    if (signal?.aborted) {
      reject(new DownloadCancelledError());

      return;
    }
    const format = buildFormatSelector(quality, audioOnly, hasFfmpeg);
    const outputTemplate = playlist
      ? path.join(
          outputDir,
          '%(playlist_title)s',
          '%(playlist_index)s - %(title)s.%(ext)s',
        )
      : path.join(outputDir, '%(title)s.%(ext)s');

    // youtube: の extractor-args は同じキーを複数回渡すと後勝ちで上書きされ、
    // player_client の指定が消えてしまうため、必ず1つにまとめる
    const youtubeExtractorOptions: string[] = [];
    if (playerClient) {
      youtubeExtractorOptions.push(`player_client=${playerClient}`);
    }
    if (saveComments) {
      youtubeExtractorOptions.push('max_comments=200', 'comment_sort=top');
    }

    const args = [
      ...getYtDlpBaseArgs(),
      '--format',
      format,
      '--output',
      outputTemplate,
      '--newline',
      // Range ヘッダなしの一括リクエストは YouTube 側に bot 判定され 403 になりやすい
      // (5MB は成功・10MB は 403 になることを確認済み)。実プレイヤーの挙動に近い
      // 小さめのチャンク単位に分割してリクエストすることで回避する
      '--http-chunk-size',
      '3M',
      ...buildYoutubeExtractorArgs(youtubeExtractorOptions),
    ];

    if (!playlist) {
      args.push('--no-playlist');
    }

    if (audioOnly && hasFfmpeg) {
      args.push('--extract-audio', '--audio-format', 'mp3');
    }

    if (saveDescription || saveComments) {
      args.push('--write-info-json');
    }

    if (saveComments) {
      args.push('--write-comments');
    }

    args.push(url);

    const proc = spawn('yt-dlp', args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort);

    const useCliProgress = !onProgress;
    const progressBar = useCliProgress
      ? new cliProgress.SingleBar(
          {
            format: `  ${chalk.cyan('{bar}')} ${chalk.yellow('{percentage}%')} | {eta_formatted} 残り`,
            barCompleteChar: '█',
            barIncompleteChar: '░',
            hideCursor: true,
          },
          cliProgress.Presets.shades_classic,
        )
      : null;

    let progressStarted = false;
    let outputFile = '';
    let stderr = '';
    let currentVideo = 0;
    let totalVideos = 0;
    const infoJsonFiles: string[] = [];
    const downloadTargets = new Set<string>();

    const reportProgress = (percent: number, title?: string): void => {
      if (onProgress) {
        onProgress({
          percent,
          title,
          currentVideo: totalVideos > 0 ? currentVideo : undefined,
          totalVideos: totalVideos > 0 ? totalVideos : undefined,
        });
      }
    };

    const handleProgressPercent = (percent: number): void => {
      if (useCliProgress && progressBar) {
        if (!progressStarted) {
          progressBar.start(100, 0);
          progressStarted = true;
        }
        progressBar.update(percent);
      } else {
        reportProgress(percent);
      }
    };

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        for (const event of parseYtDlpLine(line)) {
          switch (event.type) {
            case 'videoSwitch':
              if (progressStarted && progressBar) {
                progressBar.update(100);
                progressBar.stop();
                progressStarted = false;
              }
              currentVideo = event.currentVideo;
              totalVideos = event.totalVideos;
              break;

            case 'destination': {
              outputFile = event.file;
              downloadTargets.add(outputFile);
              const title = path
                .basename(outputFile, path.extname(outputFile))
                .replace(/^\d+ - /, '');
              if (totalVideos > 0) {
                if (useCliProgress) {
                  process.stdout.write(
                    `\n  [${currentVideo}/${totalVideos}] ${chalk.yellow(title)}\n`,
                  );
                }
                reportProgress(0, title);
              }
              break;
            }

            case 'merged':
              outputFile = event.file;
              downloadTargets.add(outputFile);
              break;

            case 'infoJson':
              infoJsonFiles.push(event.file);
              break;

            case 'progress':
              handleProgressPercent(event.percent);
              break;
          }
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    /** キャンセル時、途中まで書き出された動画・info.json 等をディレクトリごとに掃除する */
    const cleanupPartialFiles = async (): Promise<void> => {
      const dirs = new Set<string>();
      const bases = new Set<string>();
      for (const target of [...downloadTargets, ...infoJsonFiles]) {
        dirs.add(path.dirname(target));
        bases.add(path.basename(target));
      }

      for (const dir of dirs) {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          const isMatch = [...bases].some(
            (base) => entry === base || entry.startsWith(`${base}.`),
          );
          if (!isMatch) continue;

          try {
            await unlink(path.join(dir, entry));
          } catch {
            // 既に存在しない場合は無視
          }
        }
      }
    };

    /** 403 等での失敗後、android クライアントへのフォールバック再試行前に、直前の
     * 試行が残した未完成の .part ファイルだけを掃除する。個別フォーマットが既に
     * 完了して確定ファイル名にリネーム済みの場合はそれを誤って消さないよう、
     * .part / .ytdl の未完成マーカーが付いたものだけを対象にする */
    const cleanupIncompletePartFiles = async (): Promise<void> => {
      const dirs = new Set<string>();
      const bases = new Set<string>();
      for (const target of [...downloadTargets, ...infoJsonFiles]) {
        dirs.add(path.dirname(target));
        bases.add(path.basename(target));
      }

      for (const dir of dirs) {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          const isIncomplete = [...bases].some(
            (base) => entry === `${base}.part` || entry === `${base}.ytdl`,
          );
          if (!isIncomplete) continue;

          try {
            await unlink(path.join(dir, entry));
          } catch {
            // 既に存在しない場合は無視
          }
        }
      }
    };

    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);

      if (progressStarted && progressBar) {
        progressBar.update(100);
        progressBar.stop();
      }

      if (cancelled) {
        void cleanupPartialFiles().finally(() => {
          reject(new DownloadCancelledError());
        });

        return;
      }

      if (code !== 0) {
        void cleanupIncompletePartFiles().finally(() => {
          reject(new Error(`ダウンロードに失敗しました:\n${stderr}`));
        });

        return;
      }

      void (async () => {
        const notesFiles: string[] = [];

        if (saveDescription || saveComments) {
          for (const infoJsonFile of infoJsonFiles) {
            try {
              const raw = await readFile(infoJsonFile, 'utf-8');
              const info = JSON.parse(raw) as {
                title?: string;
                description?: string;
                comments?: CommentEntry[];
              };
              const notesFile = infoJsonFile.replace(/\.info\.json$/, '.txt');
              await writeFile(
                notesFile,
                buildNotesText(
                  info.title ?? 'Unknown',
                  info.description,
                  info.comments,
                  saveDescription,
                  saveComments,
                ),
                'utf-8',
              );
              notesFiles.push(notesFile);
              // 概要欄・コメント抽出後は生のinfo.jsonを削除（メタデータは.txtで閲覧可能）
              await unlink(infoJsonFile);
            } catch {
              // 概要欄・コメント取得・整形に失敗した場合は info.json をそのまま残す
            }
          }
        }

        resolve({
          outputFile,
          notesFiles,
        });
      })();
    });
  });
};

export const downloadVideo = (
  options: DownloadOptions,
): Promise<DownloadResult> =>
  withPlayerClientFallback((playerClient) =>
    runYtDlpDownload(options, playerClient),
  );
