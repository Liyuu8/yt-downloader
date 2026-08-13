const serverUrlInput = document.getElementById('serverUrl');
const qualitySelect = document.getElementById('quality');
const audioOnlyCheckbox = document.getElementById('audioOnly');
const saveDescriptionCheckbox = document.getElementById('saveDescription');
const saveCommentsCheckbox = document.getElementById('saveComments');
const statusEl = document.getElementById('status');
const queuedListEl = document.getElementById('queuedDownloads');
const activeListEl = document.getElementById('activeDownloads');
const completedListEl = document.getElementById('completedDownloads');
const failedListEl = document.getElementById('failedDownloads');

const loadSettings = async () => {
  const settings = await chrome.storage.sync.get({
    serverUrl: 'http://127.0.0.1:8765',
    quality: 'best',
    audioOnly: false,
    saveDescription: false,
    saveComments: false,
  });
  serverUrlInput.value = settings.serverUrl;
  qualitySelect.value = settings.quality;
  audioOnlyCheckbox.checked = settings.audioOnly;
  saveDescriptionCheckbox.checked = settings.saveDescription;
  saveCommentsCheckbox.checked = settings.saveComments;
};

const checkHealth = async () => {
  statusEl.className = 'loading';
  statusEl.textContent = 'サーバー確認中...';

  chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      statusEl.className = 'error';
      statusEl.textContent = 'サーバー未接続 — npm run server を実行してください';

      return;
    }

    statusEl.className = 'ok';
    const ffmpegNote = response.hasFfmpeg ? '' : '（ffmpeg なし: 360p 上限）';
    statusEl.textContent = `接続 OK — yt-dlp ${response.ytDlpVersion} ${ffmpegNote}`;
  });
};

const saveSettings = async () => {
  await chrome.storage.sync.set({
    serverUrl: serverUrlInput.value.trim(),
    quality: qualitySelect.value,
    audioOnly: audioOnlyCheckbox.checked,
    saveDescription: saveDescriptionCheckbox.checked,
    saveComments: saveCommentsCheckbox.checked,
  });
  await checkHealth();
};

for (const el of [
  serverUrlInput,
  qualitySelect,
  audioOnlyCheckbox,
  saveDescriptionCheckbox,
  saveCommentsCheckbox,
]) {
  el.addEventListener('change', saveSettings);
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const renderDownloadList = (listEl, downloads, { showProgress, showRetry }) => {
  if (downloads.length === 0) {
    listEl.innerHTML = '<li class="empty">なし</li>';

    return;
  }

  listEl.innerHTML = downloads
    .map((d) => {
      const title = escapeHtml(d.title || d.url || '不明な動画');
      const progress = `${Math.round(d.progress ?? 0)}%`;
      const progressHtml = showProgress ? `<span class="download-progress">${progress}</span>` : '';
      const retryHtml = showRetry
        ? `<button
            type="button"
            class="retry-btn"
            data-job-id="${escapeHtml(d.jobId ?? '')}"
            data-url="${escapeHtml(d.url ?? '')}"
            data-title="${escapeHtml(d.title ?? '')}"
          >再ダウンロード</button>`
        : '';

      return `<li><span class="download-title">${title}</span>${progressHtml}${retryHtml}</li>`;
    })
    .join('');
};

const renderDownloads = (downloads = []) => {
  const queued = downloads.filter((d) => d.status === 'queued');
  const active = downloads.filter((d) => d.status === 'downloading');
  const completed = downloads.filter((d) => d.status === 'completed');
  const failed = downloads.filter((d) => d.status === 'failed');

  renderDownloadList(queuedListEl, queued, { showProgress: false });
  renderDownloadList(activeListEl, active, { showProgress: true });
  renderDownloadList(completedListEl, completed, { showProgress: false });
  renderDownloadList(failedListEl, failed, { showRetry: true });
};

const removeDownloadRecord = async (jobId) => {
  const { downloads = [] } = await chrome.storage.local.get({ downloads: [] });

  await chrome.storage.local.set({ downloads: downloads.filter((d) => d.jobId !== jobId) });
};

const retryDownload = ({ jobId, url, title }) => {
  chrome.runtime.sendMessage(
    { type: 'DOWNLOAD', url, title, buttonId: crypto.randomUUID() },
    (response) => {
      // 再送に失敗した場合は元の失敗表示をそのまま残す
      if (chrome.runtime.lastError || !response?.ok) return;
      removeDownloadRecord(jobId);
    },
  );
};

failedListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.retry-btn');
  if (!btn) return;

  retryDownload({ jobId: btn.dataset.jobId, url: btn.dataset.url, title: btn.dataset.title });
});

const loadDownloads = async () => {
  const { downloads = [] } = await chrome.storage.local.get({ downloads: [] });

  renderDownloads(downloads);
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.downloads) {
    renderDownloads(changes.downloads.newValue ?? []);
  }
});

loadSettings();
checkHealth();
loadDownloads();
