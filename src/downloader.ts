import { spawn } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
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
const formatComments = (comments: CommentEntry[]): string => {
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
const buildNotesText = (
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

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return `${m}:${String(s).padStart(2, '0')}`;
};

export interface DownloadResult {
  outputFile: string;
  notesFiles: string[];
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
    } = options;
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

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // プレイリスト: 動画切り替え検出
        const videoMatch = line.match(
          /\[download\] Downloading video (\d+) of (\d+)/,
        );
        if (videoMatch) {
          if (progressStarted && progressBar) {
            progressBar.update(100);
            progressBar.stop();
            progressStarted = false;
          }
          currentVideo = parseInt(videoMatch[1], 10);
          totalVideos = parseInt(videoMatch[2], 10);
        }

        // 出力ファイルパスを捕捉（プレイリスト時はタイトルも表示）
        const destMatch = line.match(
          /\[(?:download|Merger|ExtractAudio)\] Destination: (.+)/,
        );
        if (destMatch) {
          outputFile = destMatch[1].trim();
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
        }

        const mergedMatch = line.match(
          /\[Merger\] Merging formats into "(.+)"/,
        );
        if (mergedMatch) {
          outputFile = mergedMatch[1].trim();
        }

        // メタデータJSON（概要欄・コメント含む）の出力先を捕捉
        const infoJsonMatch = line.match(
          /\[info\] Writing video metadata as JSON to: (.+)/,
        );
        if (infoJsonMatch) {
          infoJsonFiles.push(infoJsonMatch[1].trim());
        }

        // HLS: フラグメント進捗をパーセントに変換
        const itemMatch = line.match(
          /\[download\] Downloading item (\d+) of (\d+)/,
        );
        if (itemMatch) {
          const current = parseInt(itemMatch[1], 10);
          const total = parseInt(itemMatch[2], 10);
          if (total > 0) {
            const percent = (current / total) * 100;
            if (useCliProgress && progressBar) {
              if (!progressStarted) {
                progressBar.start(100, 0);
                progressStarted = true;
              }
              progressBar.update(percent);
            } else {
              reportProgress(percent);
            }
          }
        }

        // 通常ダウンロード: [download]  xx.x% of ...
        const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          if (useCliProgress && progressBar) {
            if (!progressStarted) {
              progressBar.start(100, 0);
              progressStarted = true;
            }
            progressBar.update(percent);
          } else {
            reportProgress(percent);
          }
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (progressStarted && progressBar) {
        progressBar.update(100);
        progressBar.stop();
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
              const notesFile = infoJsonFile.replace(
                /\.info\.json$/,
                '.txt',
              );
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
