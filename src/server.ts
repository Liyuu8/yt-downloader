import http from 'http';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { downloadVideo, fetchVideoInfo } from './downloader.js';
import {
  checkFfmpeg,
  checkYtDlp,
  ensureOutputDir,
  getYtDlpVersion,
  isValidYouTubeUrl,
  type Quality,
} from './utils.js';

const DEFAULT_PORT = 8765;
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Downloads', 'downloads');

type JobStatus = 'queued' | 'downloading' | 'completed' | 'failed';

interface Job {
  id: string;
  url: string;
  status: JobStatus;
  progress: number;
  title?: string;
  outputFile?: string;
  error?: string;
  createdAt: number;
  quality: Quality;
  audioOnly: boolean;
  saveDescription: boolean;
  saveComments: boolean;
}

const jobs = new Map<string, Job>();
const jobQueue: string[] = [];
let isProcessing = false;

const hasFfmpeg = checkFfmpeg();
const outputDir = process.env.YT_DL_OUTPUT ?? DEFAULT_OUTPUT_DIR;
ensureOutputDir(outputDir);

// 拡張機能(chrome-extension://)以外のオリジンからの CORS を許可すると、
// このローカルサーバー起動中に開いた任意の Web ページから /download を
// 叩かれてダウンロードを勝手に開始されてしまうため、Origin を検証する
const isAllowedOrigin = (origin: string | undefined): boolean =>
  origin != null && origin.startsWith('chrome-extension://');

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

const toPublicJob = (job: Job) => ({
  id: job.id,
  url: job.url,
  status: job.status,
  progress: job.progress,
  title: job.title,
  outputFile: job.outputFile,
  error: job.error,
  createdAt: job.createdAt,
});

const processQueue = async (): Promise<void> => {
  if (isProcessing || jobQueue.length === 0) return;

  isProcessing = true;
  const jobId = jobQueue.shift()!;
  const job = jobs.get(jobId);

  if (!job) {
    isProcessing = false;
    await processQueue();

    return;
  }

  job.status = 'downloading';

  try {
    const info = await fetchVideoInfo(job.url);
    job.title = info.title;

    const result = await downloadVideo({
      url: job.url,
      outputDir,
      quality: job.quality,
      audioOnly: job.audioOnly,
      hasFfmpeg,
      playlist: false,
      saveDescription: job.saveDescription,
      saveComments: job.saveComments,
      onProgress: (progress) => {
        job.progress = progress.percent;
        if (progress.title) {
          job.title = progress.title;
        }
      },
    });

    job.status = 'completed';
    job.progress = 100;
    job.outputFile = result.outputFile;
  } catch (err) {
    job.status = 'failed';
    job.error = (err as Error).message;
  }

  isProcessing = false;
  await processQueue();
};

const createJob = (
  url: string,
  quality: Quality,
  audioOnly: boolean,
  saveDescription: boolean,
  saveComments: boolean,
): Job => {
  const job: Job = {
    id: randomUUID(),
    url,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    quality,
    audioOnly,
    saveDescription,
    saveComments,
  };
  jobs.set(job.id, job);
  jobQueue.push(job.id);
  void processQueue();

  return job;
};

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

  if (req.method === 'POST' && url.pathname === '/download') {
    if (!checkYtDlp()) {
      respond(503, { error: 'yt-dlp が見つかりません' });

      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      respond(400, { error: 'Content-Type は application/json である必要があります' });

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

server.listen(port, host, () => {
  console.log(`yt-downloader API server running at http://${host}:${port}`);
  console.log(`  出力先: ${outputDir}`);
  console.log(`  yt-dlp: ${getYtDlpVersion()}`);
  console.log(`  ffmpeg: ${hasFfmpeg ? 'あり' : 'なし（360p 上限）'}`);
});
