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

// 4K など大きい動画や低速回線では10分を超えることがあるため、余裕を持った上限にする
const MAX_POLL_SECONDS = 3600;

const pollJob = async (serverUrl, jobId, tabId, buttonId) => {
  const pollKey = `${tabId}:${buttonId}`;
  activePolls.set(pollKey, jobId);

  for (let i = 0; i < MAX_POLL_SECONDS; i++) {
    if (activePolls.get(pollKey) !== jobId) return;

    await new Promise((r) => setTimeout(r, 1000));

    try {
      const res = await fetch(`${serverUrl}/status/${jobId}`);
      if (!res.ok) continue;

      const job = await res.json();

      if (job.status === 'downloading' || job.status === 'queued') {
        notifyTab(tabId, {
          type: 'JOB_PROGRESS',
          buttonId,
          progress: job.progress,
          title: job.title,
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
        void pollJob(serverUrl, data.jobId, sender.tab?.id, message.buttonId);
      } catch {
        sendResponse({
          ok: false,
          error: 'ローカルサーバーに接続できません。npm run server を起動してください。',
        });
      }
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
