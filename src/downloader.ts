import { spawn } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import { buildFormatSelector, type DownloadOptions } from './utils.js';

interface VideoInfo {
  title: string;
  duration: string;
  uploader: string;
  filesize?: number;
}

export const fetchVideoInfo = (url: string): Promise<VideoInfo> => {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', url];
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

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return `${m}:${String(s).padStart(2, '0')}`;
};

export const downloadVideo = (options: DownloadOptions): Promise<string> => {
  return new Promise((resolve, reject) => {
    const { url, outputDir, quality, audioOnly, hasFfmpeg } = options;
    const format = buildFormatSelector(quality, audioOnly, hasFfmpeg);
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

    const args = [
      '--format',
      format,
      '--output',
      outputTemplate,
      '--newline',
      '--no-playlist',
    ];

    if (audioOnly && hasFfmpeg) {
      args.push('--extract-audio', '--audio-format', 'mp3');
    }

    args.push(url);

    // PYTHONUNBUFFERED=1 でPythonのstdoutバッファリングを無効化し、リアルタイム進捗を受信する
    const proc = spawn('yt-dlp', args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const progressBar = new cliProgress.SingleBar(
      {
        format: `  ${chalk.cyan('{bar}')} ${chalk.yellow('{percentage}%')} | {eta_formatted} 残り`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic,
    );

    let progressStarted = false;
    let outputFile = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // HLS: フラグメント数取得 → フラグメント進捗をパーセントに変換
        const itemMatch = line.match(
          /\[download\] Downloading item (\d+) of (\d+)/,
        );
        if (itemMatch) {
          const current = parseInt(itemMatch[1], 10);
          const total = parseInt(itemMatch[2], 10);
          if (total > 0) {
            const percent = (current / total) * 100;
            if (!progressStarted) {
              progressBar.start(100, 0);
              progressStarted = true;
            }
            progressBar.update(percent);
          }
        }

        // 通常ダウンロード: [download]  xx.x% of ...
        const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          if (!progressStarted) {
            progressBar.start(100, 0);
            progressStarted = true;
          }
          progressBar.update(percent);
        }

        // 出力ファイルパスを捕捉
        const destMatch = line.match(
          /\[(?:download|Merger|ExtractAudio)\] Destination: (.+)/,
        );
        if (destMatch) {
          outputFile = destMatch[1].trim();
        }

        const mergedMatch = line.match(
          /\[Merger\] Merging formats into "(.+)"/,
        );
        if (mergedMatch) {
          outputFile = mergedMatch[1].trim();
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (progressStarted) {
        progressBar.update(100);
        progressBar.stop();
      }

      if (code !== 0) {
        reject(new Error(`ダウンロードに失敗しました:\n${stderr}`));

        return;
      }

      resolve(outputFile);
    });
  });
};
