const DEFAULT_SERVER = 'http://127.0.0.1:8765';

const activePolls = new Map();

const getSettings = async () => {
  return chrome.storage.sync.get({
    serverUrl: DEFAULT_SERVER,
    quality: 'best',
    audioOnly: false,
    saveDescription: false,
    saveComments: false,
  });
};

const notifyTab = (tabId, message) => {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
};

// popup で表示するダウンロード履歴。完了/失敗分が無限に溜まらないよう上限を設ける
const MAX_STORED_DOWNLOADS = 30;

// removeJobId を渡すと、置き換え対象のレコード削除と新規追加を同一の read-modify-write
// にまとめる。popup.js の再ダウンロードのように「古いレコードの削除」と「新しいレコードの
// 追加」を別々の呼び出し元から行うと、chrome.storage への書き込みが競合し、後勝ちの書き込みが
// もう一方の変更ごと上書きしてしまうため
const upsertDownload = async (record, { removeJobId } = {}) => {
  const { downloads: stored = [] } = await chrome.storage.local.get({ downloads: [] });
  const downloads = removeJobId ? stored.filter((d) => d.jobId !== removeJobId) : stored;
  const idx = downloads.findIndex((d) => d.jobId === record.jobId);

  if (idx >= 0) {
    downloads[idx] = { ...downloads[idx], ...record };
  } else {
    downloads.unshift({ ...record });
  }

  const isActive = (d) => d.status === 'queued' || d.status === 'downloading';
  const active = downloads.filter(isActive);
  const finished = downloads.filter((d) => !isActive(d)).slice(0, MAX_STORED_DOWNLOADS);

  await chrome.storage.local.set({ downloads: [...active, ...finished] });
};

const removeDownload = async (jobId) => {
  const { downloads = [] } = await chrome.storage.local.get({ downloads: [] });

  await chrome.storage.local.set({ downloads: downloads.filter((d) => d.jobId !== jobId) });
};

const clearFailedDownloads = async () => {
  const { downloads = [] } = await chrome.storage.local.get({ downloads: [] });

  await chrome.storage.local.set({
    downloads: downloads.filter((d) => d.status !== 'failed'),
  });
};

// 4K など大きい動画や低速回線では10分を超えることがあるため、余裕を持った上限にする
const MAX_POLL_SECONDS = 3600;

// MV3 の service worker は使われていないと途中で終了させられ、setTimeout によるポーリングの
// ループもそのまま消えてしまう。サーバー側は完了していても、拡張機能側がそれを二度と確認しに
// 行かず「ダウンロード中」のまま固まって見える不具合の原因になるため、tabId/buttonId も
// 保存しておき、service worker が再起動した際に未完了分のポーリングを再開できるようにする
const pollJob = async (
  serverUrl,
  jobId,
  tabId,
  buttonId,
  videoUrl,
  initialTitle,
  { resume = false, previousJobId } = {},
) => {
  const pollKey = `${tabId}:${buttonId}`;
  activePolls.set(pollKey, jobId);

  if (!resume) {
    await upsertDownload(
      {
        jobId,
        url: videoUrl,
        title: initialTitle,
        status: 'queued',
        progress: 0,
        tabId,
        buttonId,
        updatedAt: Date.now(),
      },
      { removeJobId: previousJobId },
    );
  }

  for (let i = 0; i < MAX_POLL_SECONDS; i++) {
    if (activePolls.get(pollKey) !== jobId) return;

    await new Promise((r) => setTimeout(r, 1000));

    try {
      const res = await fetch(`${serverUrl}/status/${jobId}`);

      if (res.status === 404) {
        // サーバーがこのジョブを認識できない(サーバー再起動でジョブ情報が消えた等)。
        // 無視して延々リトライすると「ダウンロード中」のまま固まって見えるので、失敗として確定させる
        const error = 'サーバーがこのジョブを認識できませんでした（サーバーが再起動された可能性があります）';

        notifyTab(tabId, { type: 'JOB_ERROR', buttonId, error });
        await upsertDownload({ jobId, status: 'failed', error, updatedAt: Date.now() });
        activePolls.delete(pollKey);

        return;
      }

      if (!res.ok) continue;

      const job = await res.json();
      const title = job.title ?? initialTitle;

      if (job.status === 'downloading' || job.status === 'queued') {
        notifyTab(tabId, {
          type: 'JOB_PROGRESS',
          buttonId,
          progress: job.progress,
          title: job.title,
        });
        await upsertDownload({
          jobId,
          title,
          status: job.status,
          progress: job.progress,
          updatedAt: Date.now(),
        });
      } else if (job.status === 'completed') {
        notifyTab(tabId, {
          type: 'JOB_COMPLETE',
          buttonId,
          title: job.title,
        });
        chrome.notifications.create(`yt-dl-${jobId}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'ダウンロード完了',
          message: job.title ?? '動画',
        });
        await upsertDownload({
          jobId,
          title,
          status: 'completed',
          progress: 100,
          updatedAt: Date.now(),
        });
        activePolls.delete(pollKey);

        return;
      } else if (job.status === 'failed') {
        notifyTab(tabId, {
          type: 'JOB_ERROR',
          buttonId,
          error: job.error ?? '不明なエラー',
        });
        chrome.notifications.create(`yt-dl-${jobId}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'ダウンロード失敗',
          message: job.error ?? '不明なエラー',
        });
        await upsertDownload({
          jobId,
          title,
          status: 'failed',
          error: job.error,
          updatedAt: Date.now(),
        });
        activePolls.delete(pollKey);

        return;
      } else if (job.status === 'cancelled') {
        notifyTab(tabId, { type: 'JOB_CANCELLED', buttonId });
        await removeDownload(jobId);
        activePolls.delete(pollKey);

        return;
      }
    } catch {
      // retry
    }
  }

  // ポーリング上限に達しただけではサーバー側のジョブが失敗したとは限らない
  // （実際は継続中/完了している可能性がある）ため、失敗として通知はしない
  activePolls.delete(pollKey);
};

// service worker が起動する度に呼ばれる。前回の service worker 終了時にポーリングが
// 途中で止まってしまった「queued/downloading」のままの履歴があれば、ポーリングを再開する
const resumeIncompleteDownloads = async () => {
  const { downloads = [] } = await chrome.storage.local.get({ downloads: [] });
  const incomplete = downloads.filter(
    (d) => (d.status === 'queued' || d.status === 'downloading') && d.jobId,
  );

  if (incomplete.length === 0) return;

  const settings = await getSettings();
  const serverUrl = settings.serverUrl.replace(/\/$/, '');
  const alreadyPolling = new Set(activePolls.values());

  for (const d of incomplete) {
    // このアラーム発火時点で既にポーリング中のジョブは二重起動しない
    if (alreadyPolling.has(d.jobId)) continue;

    // 今回の修正より前に作られた履歴には buttonId が保存されていないことがあるため、
    // ポーリング管理用の一意キーとして必要なだけの buttonId をその場で補う
    const buttonId = d.buttonId ?? crypto.randomUUID();

    void pollJob(serverUrl, d.jobId, d.tabId, buttonId, d.url, d.title, { resume: true });
  }
};

// MV3 の service worker は setTimeout によるポーリングループの途中でも約30秒操作がないと
// 強制終了されるため、resumeIncompleteDownloads を起動時に一度呼ぶだけでは、ユーザーが
// ポップアップを開くなど拡張機能を操作しない限り二度と再開されず「ダウンロード中」のまま
// 固まって見える。chrome.alarms は service worker 終了後も確実に発火するため、これで
// 定期的に service worker を起こして未完了ジョブのポーリングを再開させる
const RESUME_POLL_ALARM = 'yt-dl-resume-poll';
chrome.alarms.create(RESUME_POLL_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_POLL_ALARM) {
    void resumeIncompleteDownloads();
  }
});

void resumeIncompleteDownloads();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD') {
    (async () => {
      const settings = await getSettings();
      const serverUrl = settings.serverUrl.replace(/\/$/, '');

      try {
        const health = await fetch(`${serverUrl}/health`);
        if (!health.ok) {
          sendResponse({
            ok: false,
            error: 'ローカルサーバーに接続できません。npm run server を起動してください。',
          });

          return;
        }

        const res = await fetch(`${serverUrl}/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: message.url,
            quality: settings.quality,
            audioOnly: settings.audioOnly,
            saveDescription: settings.saveDescription,
            saveComments: settings.saveComments,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error ?? 'リクエスト失敗' });

          return;
        }

        sendResponse({ ok: true, jobId: data.jobId, status: 'queued' });
        void pollJob(
          serverUrl,
          data.jobId,
          sender.tab?.id,
          message.buttonId,
          message.url,
          message.title,
          { previousJobId: message.previousJobId },
        );
      } catch {
        sendResponse({
          ok: false,
          error: 'ローカルサーバーに接続できません。npm run server を起動してください。',
        });
      }
    })();

    return true;
  }

  if (message.type === 'CANCEL') {
    (async () => {
      const settings = await getSettings();
      const serverUrl = settings.serverUrl.replace(/\/$/, '');
      const pollKey = `${sender.tab?.id}:${message.buttonId}`;
      const jobId = activePolls.get(pollKey);

      if (!jobId) {
        sendResponse({ ok: false, error: 'ジョブが見つかりません' });

        return;
      }

      try {
        const res = await fetch(`${serverUrl}/cancel/${jobId}`, {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error ?? 'キャンセルに失敗しました' });

          return;
        }

        activePolls.delete(pollKey);
        await removeDownload(jobId);
        sendResponse({ ok: true });
      } catch {
        sendResponse({
          ok: false,
          error: 'ローカルサーバーに接続できません。',
        });
      }
    })();

    return true;
  }

  if (message.type === 'CLEAR_FAILED') {
    (async () => {
      await clearFailedDownloads();
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (message.type === 'CHECK_HEALTH') {
    (async () => {
      const settings = await getSettings();
      const serverUrl = settings.serverUrl.replace(/\/$/, '');
      try {
        const res = await fetch(`${serverUrl}/health`);
        if (!res.ok) {
          sendResponse({ ok: false });

          return;
        }
        const data = await res.json();
        sendResponse({ ok: true, ...data });
      } catch {
        sendResponse({ ok: false });
      }
    })();

    return true;
  }
});
