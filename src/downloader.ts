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

export const fetchPlaylistInfo = (url: string): Promise<PlaylistInfo> => {
  return new Promise((resolve, reject) => {
    const args = [
      ...getYtDlpBaseArgs(),
      '--flat-playlist',
      '--dump-single-json',
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

export const fetchVideoInfo = (url: string): Promise<VideoInfo> => {
  return new Promise((resolve, reject) => {
    const args = [...getYtDlpBaseArgs(), '--dump-json', '--no-playlist', url];
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

export class DownloadCancelledError extends Error {
  constructor() {
    super('ダウンロードがキャンセルされました');
    this.name = 'DownloadCancelledError';
  }
}

export const downloadVideo = (
  options: DownloadOptions,
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

    const args = [
      ...getYtDlpBaseArgs(),
      '--format',
      format,
      '--output',
      outputTemplate,
      '--newline',
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
      args.push(
        '--write-comments',
        '--extractor-args',
        'youtube:max_comments=200;comment_sort=top',
      );
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
        reject(new Error(`ダウンロードに失敗しました:\n${stderr}`));

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
