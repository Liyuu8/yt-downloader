const FEED_ITEM_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-video-renderer',
  'ytd-reel-item-renderer',
];

const LOCKUP_LINK_SELECTOR = 'a.yt-lockup-view-model__content-image, a.ytLockupViewModelContentImage';

const THUMBNAIL_SELECTORS = [
  'yt-thumbnail-view-model',
  'ytd-thumbnail',
  'a#thumbnail',
  '#thumbnail',
];

const PROCESSED_ATTR = 'data-yt-dl-processed';
const buttons = new Map();

const deepQueryAll = (root, selector) => {
  const results = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.matches(selector)) results.push(el);
    if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
  }
  return results;
};

const deepQueryOne = (root, selector) =>
  deepQueryAll(root, selector)[0] ?? null;

const isAdLink = (href) =>
  href.includes('googleadservices') || href.includes('pagead/aclk');

const extractVideoUrl = (root) => {
  const links = root.matches?.('a[href*="/watch?v="]')
    ? [root, ...deepQueryAll(root, 'a[href*="/watch?v="]')]
    : deepQueryAll(root, 'a[href*="/watch?v="]');
  for (const link of links) {
    const href = link.href || link.getAttribute('href');
    if (!href || isAdLink(href)) continue;

    const url = new URL(href, 'https://www.youtube.com');
    url.searchParams.delete('list');
    url.searchParams.delete('index');
    url.searchParams.delete('pp');
    return url.toString();
  }
  return null;
};

const extractTitle = (root) => {
  const titleEl =
    deepQueryOne(root, '#video-title') ??
    deepQueryOne(root, 'a#video-title-link') ??
    deepQueryOne(root, 'h3 a') ??
    deepQueryOne(root, 'h3');
  return titleEl?.textContent?.trim() || titleEl?.getAttribute('title') || '';
};

const findThumbnailHost = (root) => {
  for (const selector of THUMBNAIL_SELECTORS) {
    const el = deepQueryOne(root, selector);
    if (el) return el;
  }

  const lockupLink = deepQueryOne(root, LOCKUP_LINK_SELECTOR);
  if (lockupLink) return lockupLink;

  const watchLink = deepQueryAll(root, 'a[href*="/watch?v="]').find(
    (a) => !isAdLink(a.href || ''),
  );
  if (watchLink) {
    return (
      watchLink.querySelector('yt-thumbnail-view-model') ??
      watchLink.closest('ytd-thumbnail') ??
      watchLink
    );
  }

  return null;
};

const setButtonState = (btn, state, progress) => {
  btn.dataset.state = state;
  btn.classList.remove('yt-dl-loading', 'yt-dl-done', 'yt-dl-error');

  if (state === 'loading') {
    btn.classList.add('yt-dl-loading');
    btn.title = progress
      ? `ダウンロード中 ${Math.round(progress)}%`
      : 'ダウンロード中...';
    btn.innerHTML = `<span class="yt-dl-icon">${progress ? Math.round(progress) + '%' : '…'}</span>`;
  } else if (state === 'done') {
    btn.classList.add('yt-dl-done');
    btn.title = 'ダウンロード完了';
    btn.innerHTML = '<span class="yt-dl-icon">✓</span>';
  } else if (state === 'error') {
    btn.classList.add('yt-dl-error');
    btn.title = 'ダウンロード失敗（クリックで再試行）';
    btn.innerHTML = '<span class="yt-dl-icon">!</span>';
  } else {
    btn.title = 'ダウンロード';
    btn.innerHTML =
      '<span class="yt-dl-icon"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></span>';
  }
};

const showToast = (message) => {
  let toast = document.getElementById('yt-dl-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'yt-dl-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('yt-dl-toast-visible');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('yt-dl-toast-visible');
  }, 4000);
};

const startDownload = (btn, videoUrl, title) => {
  setButtonState(btn, 'loading');

  chrome.runtime.sendMessage(
    { type: 'DOWNLOAD', url: videoUrl, title, buttonId: btn.dataset.buttonId },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setButtonState(btn, 'error');
        showToast(response?.error ?? 'サーバーに接続できません');
      }
    },
  );
};

const attachButton = (root, videoUrl, title) => {
  if (root.hasAttribute(PROCESSED_ATTR)) return;

  const host = findThumbnailHost(root);
  if (!host) return;

  root.setAttribute(PROCESSED_ATTR, '1');

  const btn = document.createElement('button');
  btn.className = 'yt-dl-btn';
  btn.type = 'button';
  btn.dataset.buttonId = crypto.randomUUID();
  btn.setAttribute('aria-label', 'ダウンロード');
  setButtonState(btn, 'idle');

  buttons.set(btn.dataset.buttonId, { btn, videoUrl, title });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.state === 'loading') return;
    setButtonState(btn, 'idle');
    startDownload(btn, videoUrl, title);
  });

  host.classList.add('yt-dl-host');
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }
  host.appendChild(btn);
};

const injectFromLockupLinks = () => {
  for (const link of deepQueryAll(document, LOCKUP_LINK_SELECTOR)) {
    const videoUrl = extractVideoUrl(link);
    if (!videoUrl) continue;

    const item =
      link.closest('ytd-rich-item-renderer') ??
      link.closest('ytd-grid-video-renderer') ??
      link.closest('ytd-compact-video-renderer') ??
      link.closest('ytd-video-renderer') ??
      link;

    attachButton(item, videoUrl, extractTitle(item));
  }
};

const injectFromFeedItems = () => {
  for (const selector of FEED_ITEM_SELECTORS) {
    for (const item of document.querySelectorAll(selector)) {
      const videoUrl = extractVideoUrl(item);
      if (!videoUrl) continue;
      attachButton(item, videoUrl, extractTitle(item));
    }
  }
};

const processPage = () => {
  injectFromLockupLinks();
  injectFromFeedItems();
};

chrome.runtime.onMessage.addListener((message) => {
  const entry = buttons.get(message.buttonId);
  if (!entry) return;

  const { btn, title } = entry;

  if (message.type === 'JOB_PROGRESS') {
    setButtonState(btn, 'loading', message.progress);
  } else if (message.type === 'JOB_COMPLETE') {
    setButtonState(btn, 'done');
    showToast(`完了: ${message.title ?? title}`);
  } else if (message.type === 'JOB_ERROR') {
    setButtonState(btn, 'error');
    showToast(message.error ?? 'ダウンロード失敗');
  }
});

const init = () => {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }

  // フィードは頻繁に DOM を書き換えるため、変化が落ち着いてからまとめて1回スキャンする
  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      processPage();
    }, 200);
  };

  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  processPage();

  // YouTube SPA 遷移後に再スキャン
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(processPage, 300);
  });

  // 初回レンダリングが遅い場合のリトライ
  [500, 1500, 3000].forEach((ms) => setTimeout(processPage, ms));
};

init();
