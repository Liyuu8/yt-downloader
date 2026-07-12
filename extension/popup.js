const serverUrlInput = document.getElementById('serverUrl');
const qualitySelect = document.getElementById('quality');
const audioOnlyCheckbox = document.getElementById('audioOnly');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');

const loadSettings = async () => {
  const settings = await chrome.storage.sync.get({
    serverUrl: 'http://127.0.0.1:8765',
    quality: 'best',
    audioOnly: false,
  });
  serverUrlInput.value = settings.serverUrl;
  qualitySelect.value = settings.quality;
  audioOnlyCheckbox.checked = settings.audioOnly;
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

saveBtn.addEventListener('click', async () => {
  await chrome.storage.sync.set({
    serverUrl: serverUrlInput.value.trim(),
    quality: qualitySelect.value,
    audioOnly: audioOnlyCheckbox.checked,
  });
  await checkHealth();
});

loadSettings();
checkHealth();
