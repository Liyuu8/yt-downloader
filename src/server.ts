import http from 'http';
import os from 'os';
import path from 'path';
import { createJobQueue, toPublicJob } from './jobQueue.js';
import {
  checkFfmpeg,
  checkYtDlp,
  ensureOutputDir,
  getYtDlpVersion,
  isAllowedOrigin,
  isValidYouTubeUrl,
  type Quality,
} from './utils.js';
import { isAutoUpdateEnabled, updateYtDlp } from './ytDlpUpdater.js';

const DEFAULT_PORT = 8765;
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Downloads', 'downloads');

const hasFfmpeg = checkFfmpeg();
const outputDir = process.env.YT_DL_OUTPUT ?? DEFAULT_OUTPUT_DIR;
ensureOutputDir(outputDir);

const { jobs, jobQueue, createJob } = createJobQueue({ outputDir, hasFfmpeg });

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  corsOrigin?: string,
): void => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const corsOrigin = isAllowedOrigin(req.headers.origin)
    ? req.headers.origin
    : undefined;
  const respond = (status: number, body: unknown): void =>
    sendJson(res, status, body, corsOrigin);

  if (req.method === 'OPTIONS') {
    respond(204, null);

    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost`);

  if (req.method === 'GET' && url.pathname === '/health') {
    respond(200, {
      ok: checkYtDlp(),
      ytDlpVersion: getYtDlpVersion(),
      hasFfmpeg,
      outputDir,
    });

    return;
  }

  if (req.method === 'GET' && url.pathname === '/jobs') {
    const list = [...jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map(toPublicJob);
    respond(200, { jobs: list });

    return;
  }

  const statusMatch = url.pathname.match(/^\/status\/(.+)$/);
  if (req.method === 'GET' && statusMatch) {
    const job = jobs.get(statusMatch[1]);
    if (!job) {
      respond(404, { error: 'ジョブが見つかりません' });

      return;
    }
    respond(200, toPublicJob(job));

    return;
  }

  const cancelMatch = url.pathname.match(/^\/cancel\/(.+)$/);
  if (req.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) {
      respond(404, { error: 'ジョブが見つかりません' });

      return;
    }

    if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      respond(400, { error: 'このジョブは既に終了しています' });

      return;
    }

    if (job.status === 'queued') {
      const idx = jobQueue.indexOf(job.id);
      if (idx !== -1) jobQueue.splice(idx, 1);
      job.status = 'cancelled';
    } else {
      job.abortController.abort();
    }

    respond(200, toPublicJob(job));

    return;
  }

  if (req.method === 'POST' && url.pathname === '/download') {
    if (!checkYtDlp()) {
      respond(503, { error: 'yt-dlp が見つかりません' });

      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      respond(400, {
        error: 'Content-Type は application/json である必要があります',
      });

      return;
    }

    let body: {
      url?: string;
      quality?: Quality;
      audioOnly?: boolean;
      saveDescription?: boolean;
      saveComments?: boolean;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      respond(400, { error: 'リクエストボディが不正です' });

      return;
    }

    if (!body.url || !isValidYouTubeUrl(body.url)) {
      respond(400, { error: '無効な YouTube URL です' });

      return;
    }

    const validQualities: Quality[] = ['best', '1080', '720', '480', '360'];
    const quality = validQualities.includes(body.quality as Quality)
      ? (body.quality as Quality)
      : 'best';

    const job = createJob(
      body.url,
      quality,
      body.audioOnly ?? false,
      body.saveDescription ?? false,
      body.saveComments ?? false,
    );
    respond(202, {
      jobId: job.id,
      status: job.status,
      title: job.title,
    });

    return;
  }

  respond(404, { error: 'Not found' });
});

const port = Number(process.env.YT_DL_PORT ?? DEFAULT_PORT);
// コンテナ内では 127.0.0.1 だとホストから届かないため、
// Docker 実行時のみ YT_DL_HOST=0.0.0.0 を指定して bind 先を切り替える
const host = process.env.YT_DL_HOST ?? '127.0.0.1';

if (!checkYtDlp()) {
  console.error('❌ yt-dlp が見つかりません。先にインストールしてください。');
  console.error('   macOS: brew install yt-dlp');
  process.exit(1);
}

// ダウンロード中に yt-dlp のファイルが差し替わらないよう、更新は待ち受け開始前に済ませる
if (isAutoUpdateEnabled(process.env)) {
  const before = getYtDlpVersion();
  console.log(`yt-dlp を更新しています（現在: ${before}）...`);
  const result = await updateYtDlp();
  if (result.ok) {
    console.log(`  yt-dlp: ${before} → ${getYtDlpVersion()}`);
  } else {
    console.warn(
      `⚠️ yt-dlp の更新に失敗しました（${before} のまま起動します）`,
    );
    console.warn(`   ${result.reason}`);
  }
}

server.listen(port, host, () => {
  console.log(`yt-downloader API server running at http://${host}:${port}`);
  console.log(`  出力先: ${outputDir}`);
  console.log(`  yt-dlp: ${getYtDlpVersion()}`);
  console.log(`  ffmpeg: ${hasFfmpeg ? 'あり' : 'なし（360p 上限）'}`);
});
