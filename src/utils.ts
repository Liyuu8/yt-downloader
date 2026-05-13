import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import which from 'which';

export type Quality = 'best' | '1080' | '720' | '480' | '360';

export interface DownloadOptions {
  url: string;
  outputDir: string;
  quality: Quality;
  audioOnly: boolean;
  hasFfmpeg: boolean;
  playlist: boolean;
}

export const isValidYouTubeUrl = (url: string): boolean => {
  const patterns = [
    /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/,
    /^https?:\/\/youtu\.be\/[\w-]+/,
    /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]+/,
    /^https?:\/\/(www\.)?youtube\.com\/live\/[\w-]+/,
    /^https?:\/\/(www\.)?youtube\.com\/playlist\?list=[\w-]+/,
  ];

  return patterns.some((pattern) => pattern.test(url));
};

export const isPlaylistUrl = (url: string): boolean =>
  /youtube\.com\/playlist\?/.test(url);

export const ensureOutputDir = (dir: string): void => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const checkYtDlp = (): boolean => {
  try {
    which.sync('yt-dlp');

    return true;
  } catch {
    return false;
  }
};

export const checkFfmpeg = (): boolean => {
  try {
    which.sync('ffmpeg');

    return true;
  } catch {
    return false;
  }
};

export const getYtDlpVersion = (): string => {
  try {
    const version = execSync('yt-dlp --version', { encoding: 'utf-8' }).trim();

    return version;
  } catch {
    return 'unknown';
  }
};

export const buildFormatSelector = (
  quality: Quality,
  audioOnly: boolean,
  hasFfmpeg: boolean,
): string => {
  if (audioOnly) {
    if (hasFfmpeg) {
      // ffmpeg あり: bestaudio を mp3 に変換
      return 'bestaudio/best';
    }

    // ffmpeg なし: m4a をそのままダウンロード
    return 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio';
  }

  if (hasFfmpeg) {
    // ffmpeg あり: 映像・音声を別々にダウンロードして結合（最高画質）
    const qualityMap: Record<Quality, string> = {
      best: 'bestvideo[vcodec^=avc][ext=mp4]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo[ext=mp4]+bestaudio/best',
      '1080':
        'bestvideo[vcodec^=avc][ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc][height<=1080]+bestaudio/bestvideo[ext=mp4][height<=1080]+bestaudio/best[height<=1080]',
      '720':
        'bestvideo[vcodec^=avc][ext=mp4][height<=720]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc][height<=720]+bestaudio/bestvideo[ext=mp4][height<=720]+bestaudio/best[height<=720]',
      '480':
        'bestvideo[vcodec^=avc][ext=mp4][height<=480]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc][height<=480]+bestaudio/bestvideo[ext=mp4][height<=480]+bestaudio/best[height<=480]',
      '360':
        'bestvideo[vcodec^=avc][ext=mp4][height<=360]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc][height<=360]+bestaudio/bestvideo[ext=mp4][height<=360]+bestaudio/best[height<=360]',
    };

    return qualityMap[quality];
  }

  // ffmpeg なし: https 直配信の統合 mp4 のみ（HLS/dash 除外）
  // YouTube では最大 360p (format 18) が再生可能な統合 mp4
  const qualityMap: Record<Quality, string> = {
    best: 'best[ext=mp4][protocol=https]/18',
    '1080': 'best[ext=mp4][protocol=https][height<=1080]/18',
    '720': 'best[ext=mp4][protocol=https][height<=720]/18',
    '480': 'best[ext=mp4][protocol=https][height<=480]/18',
    '360': 'best[ext=mp4][protocol=https][height<=360]/18',
  };

  return qualityMap[quality];
};
