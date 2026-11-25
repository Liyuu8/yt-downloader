import { randomUUID } from 'crypto';
import {
  DownloadCancelledError,
  downloadVideo,
  fetchVideoInfo,
} from './downloader.js';
import type { Quality } from './utils.js';

type JobStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Job {
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
  abortController: AbortController;
}

interface JobQueueConfig {
  outputDir: string;
  hasFfmpeg: boolean;
}

export const toPublicJob = (job: Job) => ({
  id: job.id,
  url: job.url,
  status: job.status,
  progress: job.progress,
  title: job.title,
  outputFile: job.outputFile,
  error: job.error,
  createdAt: job.createdAt,
});

/** ダウンロードジョブを 1 件ずつ順番に処理するキューを作る */
export const createJobQueue = ({ outputDir, hasFfmpeg }: JobQueueConfig) => {
  const jobs = new Map<string, Job>();
  const jobQueue: string[] = [];
  let isProcessing = false;

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

    if (job.abortController.signal.aborted) {
      job.status = 'cancelled';
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
        signal: job.abortController.signal,
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
      if (err instanceof DownloadCancelledError) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = (err as Error).message;
      }
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
      abortController: new AbortController(),
    };
    jobs.set(job.id, job);
    jobQueue.push(job.id);
    void processQueue();

    return job;
  };

  return { jobs, jobQueue, createJob };
};
