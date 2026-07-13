import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { Command } from 'commander';
import ora from 'ora';
import {
  downloadVideo,
  fetchPlaylistInfo,
  fetchVideoInfo,
  type DownloadResult,
} from './downloader.js';
import {
  checkFfmpeg,
  checkYtDlp,
  ensureOutputDir,
  getYtDlpVersion,
  isPlaylistUrl,
  isValidYouTubeUrl,
  type Quality,
} from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const printBanner = (): void => {
  console.log(
    chalk.red(`
  ╔═══════════════════════════════╗
  ║   ${chalk.bold.white('yt-downloader')}  📥             ║
  ║   YouTube → MP4 Converter     ║
  ╚═══════════════════════════════╝
`),
  );
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '不明';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  return `${mb.toFixed(1)} MB`;
};

const main = async (): Promise<void> => {
  printBanner();

  // yt-dlp の存在確認
  if (!checkYtDlp()) {
    console.error(chalk.red('❌ yt-dlp が見つかりません。'));
    console.error(
      chalk.yellow(
        '   インストール方法: https://github.com/yt-dlp/yt-dlp#installation',
      ),
    );
    console.error(chalk.yellow('   macOS:   brew install yt-dlp'));
    console.error(chalk.yellow('   Ubuntu:  sudo apt install yt-dlp'));
    console.error(chalk.yellow('   pip:     pip install yt-dlp'));
    process.exit(1);
  }

  const hasFfmpeg = checkFfmpeg();
  const version = getYtDlpVersion();
  console.log(chalk.gray(`  yt-dlp version: ${version}`));
  if (hasFfmpeg) {
    console.log(chalk.gray(`  ✅ ffmpeg 検出済み（高画質モード）\n`));
  } else {
    console.log(
      chalk.yellow(`  ⚠️  ffmpeg が見つかりません。最大 360p に制限されます。`),
    );
    console.log(
      chalk.yellow(`     高画質ダウンロードには: brew install ffmpeg\n`),
    );
  }

  const program = new Command();

  program
    .name('yt-downloader')
    .description('YouTube の動画を MP4 ファイルとしてダウンロードします')
    .version('1.0.0')
    .requiredOption('-u, --url <url>', 'YouTube の URL')
    .option(
      '-o, --output <dir>',
      '出力ディレクトリ',
      path.join(__dirname, '../../downloads'),
    )
    .option<Quality>(
      '-q, --quality <quality>',
      '画質: best / 1080 / 720 / 480 / 360',
      (val) => {
        const valid: Quality[] = ['best', '1080', '720', '480', '360'];
        if (!valid.includes(val as Quality)) {
          console.error(chalk.red(`❌ 無効な画質指定: ${val}`));
          console.error(chalk.yellow(`   使用可能: ${valid.join(' / ')}`));
          process.exit(1);
        }

        return val as Quality;
      },
      'best',
    )
    .option('-a, --audio-only', '音声のみを MP3 としてダウンロード', false)
    .option('-p, --playlist', 'プレイリスト全体をダウンロード', false)
    .option(
      '-d, --description',
      '概要欄を Markdown ファイルに含めて取得',
      false,
    )
    .option(
      '-c, --comments',
      'コメントを取得し Markdown ファイルに含めて保存',
      false,
    );

  program.parse(process.argv);

  const opts = program.opts<{
    url: string;
    output: string;
    quality: Quality;
    audioOnly: boolean;
    playlist: boolean;
    description: boolean;
    comments: boolean;
  }>();

  // URL バリデーション
  if (!isValidYouTubeUrl(opts.url)) {
    console.error(chalk.red(`❌ 無効な YouTube URL です: ${opts.url}`));
    process.exit(1);
  }

  // プレイリストURLは自動的にプレイリストモードに
  const playlist = opts.playlist || isPlaylistUrl(opts.url);

  // 出力先ディレクトリの作成
  const outputDir = path.resolve(opts.output);
  ensureOutputDir(outputDir);

  const qualityLabel = opts.audioOnly
    ? hasFfmpeg
      ? 'MP3（音声のみ）'
      : 'M4A（音声のみ）'
    : opts.quality === 'best'
      ? hasFfmpeg
        ? '最高画質'
        : '最高画質（360p 上限）'
      : `${opts.quality}p`;

  const extrasParts: string[] = [];
  if (opts.description) extrasParts.push('概要欄');
  if (opts.comments) extrasParts.push('コメント');
  const extrasLabel = extrasParts.length > 0 ? extrasParts.join(' + ') : 'なし';

  // 情報取得・表示
  const infoSpinner = ora({ text: '情報を取得中...', color: 'cyan' }).start();

  if (playlist) {
    let playlistInfo;
    try {
      playlistInfo = await fetchPlaylistInfo(opts.url);
      infoSpinner.succeed(chalk.green('プレイリスト情報を取得しました'));
    } catch (err) {
      infoSpinner.fail(chalk.red('プレイリスト情報の取得に失敗しました'));
      console.error(chalk.red(`  ${(err as Error).message}`));
      process.exit(1);
    }

    console.log(`
  ${chalk.bold('📋 プレイリスト情報')}
  ${chalk.gray('─────────────────────────────────')}
  ${chalk.white('タイトル :')} ${chalk.yellow(playlistInfo.title)}
  ${chalk.white('投稿者   :')} ${playlistInfo.uploader}
  ${chalk.white('動画数   :')} ${playlistInfo.videoCount} 本
  ${chalk.white('画質     :')} ${qualityLabel}
  ${chalk.white('追加取得 :')} ${extrasLabel}
  ${chalk.white('出力先   :')} ${chalk.cyan(outputDir)}
  ${chalk.gray('─────────────────────────────────')}
`);
  } else {
    let info;
    try {
      info = await fetchVideoInfo(opts.url);
      infoSpinner.succeed(chalk.green('動画情報を取得しました'));
    } catch (err) {
      infoSpinner.fail(chalk.red('動画情報の取得に失敗しました'));
      console.error(chalk.red(`  ${(err as Error).message}`));
      process.exit(1);
    }

    console.log(`
  ${chalk.bold('📹 動画情報')}
  ${chalk.gray('─────────────────────────────────')}
  ${chalk.white('タイトル :')} ${chalk.yellow(info.title)}
  ${chalk.white('投稿者   :')} ${info.uploader}
  ${chalk.white('長さ     :')} ${info.duration}
  ${chalk.white('サイズ   :')} ${formatFileSize(info.filesize)}
  ${chalk.white('画質     :')} ${qualityLabel}
  ${chalk.white('追加取得 :')} ${extrasLabel}
  ${chalk.white('出力先   :')} ${chalk.cyan(outputDir)}
  ${chalk.gray('─────────────────────────────────')}
`);
  }

  // ダウンロード実行
  console.log(chalk.bold('  ⬇️  ダウンロード中...\n'));

  let result: DownloadResult;
  try {
    result = await downloadVideo({
      url: opts.url,
      outputDir,
      quality: opts.quality,
      audioOnly: opts.audioOnly,
      hasFfmpeg,
      playlist,
      saveDescription: opts.description,
      saveComments: opts.comments,
    });
  } catch (err) {
    console.error(chalk.red(`\n❌ ダウンロードに失敗しました`));
    console.error(chalk.red(`  ${(err as Error).message}`));
    process.exit(1);
  }

  console.log(`
  ${chalk.bold.green('✅ ダウンロード完了！')}
  ${chalk.white('保存先:')} ${chalk.cyan(playlist ? outputDir : result.outputFile || outputDir)}`);

  if (result.notesFiles.length > 0) {
    console.log(
      `  ${chalk.white(`${extrasLabel}:`)} ${chalk.cyan(`${result.notesFiles.length} 件の Markdown ファイルを保存`)}`,
    );
  }
  console.log('');
};

main().catch((err: unknown) => {
  console.error(chalk.red('予期しないエラーが発生しました:'), err);
  process.exit(1);
});
