const FEED_ITEM_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-video-renderer',
  'ytd-reel-item-renderer',
];

const ITEM_ROOT_SELECTOR = [...FEED_ITEM_SELECTORS, 'yt-lockup-view-model'].join(',');

// 旧UI (Polymer) では ytd-menu-renderer 配下の button だったが、新UI (view model 系) では
// ytd-menu-renderer 自体が存在せず、aria-label のみが手がかりになる
const MORE_ACTIONS_ARIA_LABELS = ['その他の操作', '操作', 'more actions', 'more options'];

const isMoreActionsButton = (el) => {
  if (el?.tagName !== 'BUTTON') return false;

  const label = (el.getAttribute('aria-label') || '').toLowerCase();

  return MORE_ACTIONS_ARIA_LABELS.some((known) => label === known.toLowerCase());
};

const PENDING_CONTEXT_TTL_MS = 2000;

const deepQueryAll = (root, selector) => {
  const results = [];
  // root 自身がカスタム要素で、内容を自前の shadowRoot にまとめて持つ場合
  // （子要素を辿るだけでは見えない）もあるため、root の shadowRoot も直接見る
  if (root.shadowRoot) results.push(...deepQueryAll(root.shadowRoot, selector));

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

// videoUrl をキーに、開いたり閉じたりする YouTube 純正メニューを跨いで進行状況を保持する
const jobs = new Map();
const buttonIdToUrl = new Map();

// 実際の YouTube メニュー項目 (viewBox 0 0 24 24 の細身の独自アイコンセット) に合わせる
const MENU_ICONS = {
  idle: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L11 13.586V4a1 1 0 0 1 1-1ZM5 19a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"/></svg>',
  done: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M9.55 17.65 4.4 12.5a1 1 0 1 1 1.4-1.42l3.75 3.7 8.65-8.6a1 1 0 1 1 1.4 1.42l-9.35 9.3a1 1 0 0 1-1.4 0Z"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 13a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0-8v5a1 1 0 1 1-2 0V7a1 1 0 1 1 2 0Z"/></svg>',
};

const renderMenuItemState = (item, state, progress) => {
  item.dataset.state = state;
  item.classList.toggle('yt-dl-menu-item-error', state === 'error');

  let label = 'ダウンロード';
  let iconHtml = MENU_ICONS.idle;

  if (state === 'loading') {
    label = progress ? `ダウンロード中… ${Math.round(progress)}%` : 'ダウンロード中…';
    iconHtml = '<span class="yt-dl-menu-spinner"></span>';
  } else if (state === 'done') {
    label = 'ダウンロード完了';
    iconHtml = MENU_ICONS.done;
  } else if (state === 'error') {
    label = 'ダウンロード失敗（クリックで再試行）';
    iconHtml = MENU_ICONS.error;
  }

  item.innerHTML = `<span class="yt-dl-menu-icon">${iconHtml}</span><span class="yt-dl-menu-label">${label}</span>`;
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

const startDownload = (item, videoUrl, title) => {
  const buttonId = crypto.randomUUID();
  buttonIdToUrl.set(buttonId, videoUrl);
  jobs.set(videoUrl, { buttonId, state: 'loading', title, item });
  renderMenuItemState(item, 'loading');

  chrome.runtime.sendMessage(
    { type: 'DOWNLOAD', url: videoUrl, title, buttonId },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        const job = jobs.get(videoUrl);
        if (job) job.state = 'error';
        renderMenuItemState(item, 'error');
        showToast(response?.error ?? 'サーバーに接続できません');
      }
    },
  );
};

const cancelDownload = (item, videoUrl) => {
  const job = jobs.get(videoUrl);
  if (!job) return;

  chrome.runtime.sendMessage(
    { type: 'CANCEL', buttonId: job.buttonId },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showToast(response?.error ?? 'キャンセルに失敗しました');

        return;
      }
      jobs.delete(videoUrl);
      buttonIdToUrl.delete(job.buttonId);
      renderMenuItemState(item, 'idle');
      showToast('キャンセルしました');
    },
  );
};

const closeMenu = (listbox) => {
  // 旧UI (tp-yt-iron-dropdown) 向け
  const dropdown = listbox.closest('tp-yt-iron-dropdown');
  if (dropdown && 'opened' in dropdown) {
    dropdown.opened = false;
  }
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    }),
  );
};

const injectMenuItem = (listbox, videoUrl, title) => {
  // YouTube はケバブメニューのポップアップ要素を動画をまたいで再利用するため、
  // 別の動画を開いたときに前回分の古い項目が残っていたら差し替える
  listbox.querySelector(':scope > .yt-dl-menu-item')?.remove();

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'yt-dl-menu-item';
  item.setAttribute('role', 'menuitem');

  const existing = jobs.get(videoUrl);
  if (existing) {
    existing.item = item;
    existing.title = title;
    renderMenuItemState(item, existing.state, existing.progress);
  } else {
    renderMenuItemState(item, 'idle');
  }

  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const job = jobs.get(videoUrl);
    if (job?.state === 'loading') {
      cancelDownload(item, videoUrl);
    } else {
      startDownload(item, videoUrl, title);
    }
    closeMenu(listbox);
  });

  listbox.prepend(item);
};

// 新UI: yt-contextual-sheet-layout > yt-list-view-model[role="menu"] > yt-list-item-view-model
// 旧UI: tp-yt-iron-dropdown > ytd-menu-popup-renderer > tp-yt-paper-listbox > ytd-menu-service-item-renderer
//
// YouTube はこのポップアップ要素自体を動画をまたいで再利用する（Escape で閉じても DOM から
// 消えず、別の動画のケバブを開くと同じ要素が使い回される）。そのため新規ノードの追加を待つ
// MutationObserver では2回目以降検知できず、クリックごとに直接ポップアップを探す方式にする
const findOpenListbox = () =>
  document.querySelector('yt-list-view-model[role="menu"]') ??
  document.querySelector('yt-list-view-model') ??
  document.querySelector('ytd-menu-popup-renderer tp-yt-paper-listbox') ??
  document.querySelector('ytd-menu-popup-renderer') ??
  document.querySelector('yt-contextual-sheet-layout') ??
  null;

let pendingContext = null;

const tryInjectPendingContext = () => {
  if (!pendingContext) return;
  if (Date.now() - pendingContext.ts > PENDING_CONTEXT_TTL_MS) {
    pendingContext = null;

    return;
  }

  const listbox = findOpenListbox();
  if (!listbox) {
    setTimeout(tryInjectPendingContext, 100);

    return;
  }

  injectMenuItem(listbox, pendingContext.videoUrl, pendingContext.title);
  pendingContext = null;
};

// YouTube 純正のケバブ(⋮)メニューはクリック対象の動画と無関係な場所（body 直下）に
// ポップアップを生成するため、クリック時点で対象動画を控えておき、直後に現れる
// ポップアップへダウンロード項目を差し込む
const handleKebabClick = (e) => {
  // YouTube の各要素は Shadow DOM で多層に入れ子になっているため、document で listen すると
  // e.target は外側の要素にリターゲットされてしまう。closest() では内側の要素を辿れないので
  // composedPath() でシャドウ境界をまたいだ実際の経路を見る
  const path = e.composedPath();
  const isKebabClick =
    path.some((el) => el.tagName?.toLowerCase() === 'ytd-menu-renderer') ||
    path.some((el) => isMoreActionsButton(el));
  if (!isKebabClick) return;

  const item = path.find((el) => el.matches?.(ITEM_ROOT_SELECTOR));
  if (!item) return;

  const videoUrl = extractVideoUrl(item);
  if (!videoUrl) return;

  pendingContext = { videoUrl, title: extractTitle(item), ts: Date.now() };
  setTimeout(tryInjectPendingContext, 30);
};

chrome.runtime.onMessage.addListener((message) => {
  const videoUrl = buttonIdToUrl.get(message.buttonId);
  if (!videoUrl) return;
  const job = jobs.get(videoUrl);
  if (!job) return;

  if (message.type === 'JOB_PROGRESS') {
    job.state = 'loading';
    job.progress = message.progress;
    renderMenuItemState(job.item, 'loading', message.progress);
  } else if (message.type === 'JOB_COMPLETE') {
    job.state = 'done';
    renderMenuItemState(job.item, 'done');
    showToast(`完了: ${message.title ?? job.title}`);
  } else if (message.type === 'JOB_ERROR') {
    job.state = 'error';
    renderMenuItemState(job.item, 'error');
    showToast(message.error ?? 'ダウンロード失敗');
  } else if (message.type === 'JOB_CANCELLED') {
    jobs.delete(videoUrl);
    buttonIdToUrl.delete(message.buttonId);
    renderMenuItemState(job.item, 'idle');
  }
});

const init = () => {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });

    return;
  }

  document.addEventListener('click', handleKebabClick, true);
};

init();
