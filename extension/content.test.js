// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// YouTube のケバブ(⋮)メニューは実際の DOM 構造がとても頻繁に変わる(2026年時点では
// aria-label="その他の操作" の <button> + yt-contextual-sheet-layout / yt-list-view-model という
// 新UI(view model 系)。以前は ytd-menu-renderer / ytd-menu-popup-renderer という Polymer 系の
// 構造だった)。content.js は document レベルの click リスナー + composedPath() でクリックを検出し、
// クリック後にポップアップを探して(YouTube はこの要素自体を動画をまたいで再利用するため、
// 新規ノード追加ではなくクリックごとのポーリングで検出する)ダウンロード項目を差し込む。
// この仕組みは DOM 構造の変化にとても弱いため、実際のイベント/DOM 操作を通した振る舞い
// レベルのテストで保証する。

let sendMessageMock;
let onMessageHandlers;

beforeAll(async () => {
  onMessageHandlers = [];
  sendMessageMock = vi.fn((_message, callback) => {
    callback?.({ ok: true });
  });

  globalThis.chrome = {
    runtime: {
      sendMessage: (message, callback) => sendMessageMock(message, callback),
      lastError: undefined,
      onMessage: {
        addListener: (handler) => onMessageHandlers.push(handler),
      },
    },
  };

  let uuidCounter = 0;
  globalThis.crypto.randomUUID = () => `uuid-${++uuidCounter}`;

  await import('./content.js');
});

beforeEach(() => {
  sendMessageMock.mockClear();
  sendMessageMock.mockImplementation((_message, callback) => {
    callback?.({ ok: true });
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const dispatchToContentScript = (message) => {
  for (const handler of onMessageHandlers) handler(message);
};

const lastDownloadMessage = () => {
  const call = sendMessageMock.mock.calls.findLast(([msg]) => msg.type === 'DOWNLOAD');

  return call?.[0];
};

const clickKebab = (kebabButton) => {
  kebabButton.dispatchEvent(
    new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }),
  );
};

// ytd-rich-item-renderer > (shadow) > 動画リンク + その他の操作ボタン、という
// 2026年時点の実際の YouTube フィード項目 (view model 系 UI) を模した構造を組み立てる
const createFeedItem = ({ videoUrl, title = 'テスト動画', extraLinks = [] } = {}) => {
  const item = document.createElement('ytd-rich-item-renderer');
  const itemShadow = item.attachShadow({ mode: 'open' });

  for (const href of extraLinks) {
    const link = document.createElement('a');
    link.href = href;
    itemShadow.appendChild(link);
  }

  const link = document.createElement('a');
  link.href = videoUrl;
  itemShadow.appendChild(link);

  const titleEl = document.createElement('a');
  titleEl.id = 'video-title';
  titleEl.textContent = title;
  itemShadow.appendChild(titleEl);

  const kebabButton = document.createElement('button');
  kebabButton.setAttribute('aria-label', 'その他の操作');
  itemShadow.appendChild(kebabButton);

  document.body.appendChild(item);

  return { item, kebabButton };
};

// 実際の YouTube が生成する yt-contextual-sheet-layout > yt-list-view-model[role="menu"] >
// yt-list-item-view-model というポップアップ構造を模して body へ追加する
const openNativeMenu = ({ withListbox = true } = {}) => {
  const sheet = document.createElement('yt-contextual-sheet-layout');
  const listModel = document.createElement('yt-list-view-model');

  listModel.setAttribute('role', 'menu');

  if (withListbox) {
    const nativeItem = document.createElement('yt-list-item-view-model');

    nativeItem.textContent = 'キューに追加';
    listModel.appendChild(nativeItem);
    sheet.appendChild(listModel);
  }

  document.body.appendChild(sheet);

  return { sheet, listbox: sheet.querySelector('yt-list-view-model') ?? sheet };
};

const openMenuForVideo = async (kebabButton, options) => {
  clickKebab(kebabButton);
  const menu = openNativeMenu(options);

  await vi.waitFor(() => {
    expect(menu.listbox.querySelector('.yt-dl-menu-item')).toBeTruthy();
  });

  return menu;
};

describe('ケバブメニューへのダウンロード項目の挿入', () => {
  it('shadow DOM 越しでもケバブクリックを検出し、開いたポップアップにダウンロード項目を挿入する', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=insert1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox } = await openMenuForVideo(kebabButton);

    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    expect(menuItem).toBeTruthy();
    expect(menuItem.tagName).toBe('BUTTON');
    expect(menuItem.textContent).toContain('ダウンロード');
    // 既存のネイティブ項目より前に挿入される
    expect(listbox.firstElementChild).toBe(menuItem);
  });

  it('広告リンクを無視して本来の動画リンクから URL を抽出する', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=realvideo';
    const adLink = 'https://www.youtube.com/pagead/aclk?adurl=https://www.youtube.com/watch?v=advideo';
    const { kebabButton } = createFeedItem({ videoUrl, extraLinks: [adLink] });

    const { listbox } = await openMenuForVideo(kebabButton);

    listbox.querySelector('.yt-dl-menu-item').click();

    expect(lastDownloadMessage().url).toBe(videoUrl);
  });

  it('list/index/pp のトラッキング用クエリパラメータを取り除く', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=trackedvideo&list=PL123&index=3&pp=abc';
    const { kebabButton } = createFeedItem({ videoUrl });

    const { listbox } = await openMenuForVideo(kebabButton);

    listbox.querySelector('.yt-dl-menu-item').click();

    const sentUrl = new URL(lastDownloadMessage().url);

    expect(sentUrl.searchParams.get('v')).toBe('trackedvideo');
    expect(sentUrl.searchParams.has('list')).toBe(false);
    expect(sentUrl.searchParams.has('index')).toBe(false);
    expect(sentUrl.searchParams.has('pp')).toBe(false);
  });

  it('yt-list-view-model が見つからない場合は yt-contextual-sheet-layout 自体に挿入する', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=fallback1';
    const { kebabButton } = createFeedItem({ videoUrl });

    const { sheet } = await openMenuForVideo(kebabButton, { withListbox: false });

    expect(sheet.querySelector('.yt-dl-menu-item')).toBeTruthy();
  });

  it('挿入先に既に(古い)ダウンロード項目がある場合は差し替えて重複させない', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=duplicate1';
    const { kebabButton } = createFeedItem({ videoUrl });

    clickKebab(kebabButton);

    const sheet = document.createElement('yt-contextual-sheet-layout');
    const listbox = document.createElement('yt-list-view-model');
    const stale = document.createElement('button');

    stale.className = 'yt-dl-menu-item';
    listbox.appendChild(stale);
    sheet.appendChild(listbox);
    document.body.appendChild(sheet);

    await vi.waitFor(() => {
      expect(listbox.querySelector('.yt-dl-menu-item')).not.toBe(stale);
    });

    expect(listbox.querySelectorAll('.yt-dl-menu-item')).toHaveLength(1);
  });

  it('YouTube がポップアップ要素を動画をまたいで再利用しても、開いた動画に応じて項目を差し替える', async () => {
    // 実機で確認済みの実際の挙動: YouTube はケバブメニューのポップアップ要素(DOM)を
    // 動画をまたいで再利用する。閉じても DOM から消えず、別の動画のケバブを開くと
    // 同じ要素が使い回される。以前はこれにより「動画Aが完了→動画Bのメニューを開くと
    // 古い『完了』表示が残る」という不具合が起きていた
    const videoUrlA = 'https://www.youtube.com/watch?v=reuseA';
    const videoUrlB = 'https://www.youtube.com/watch?v=reuseB';
    const { kebabButton: kebabA } = createFeedItem({ videoUrl: videoUrlA, title: '動画A' });
    const { kebabButton: kebabB } = createFeedItem({ videoUrl: videoUrlB, title: '動画B' });

    const { listbox } = await openMenuForVideo(kebabA);

    listbox.querySelector('.yt-dl-menu-item').click();
    const buttonIdA = lastDownloadMessage().buttonId;

    dispatchToContentScript({ type: 'JOB_COMPLETE', buttonId: buttonIdA, title: '動画A' });
    expect(listbox.querySelector('.yt-dl-menu-item').dataset.state).toBe('done');

    // ポップアップの DOM 要素はそのまま(閉じても消えない想定)で、別の動画Bのケバブを開く
    clickKebab(kebabB);

    await vi.waitFor(() => {
      expect(listbox.querySelector('.yt-dl-menu-item').dataset.state).toBe('idle');
    });

    const menuItemB = listbox.querySelector('.yt-dl-menu-item');

    expect(menuItemB.textContent).not.toContain('完了');

    menuItemB.click();
    expect(lastDownloadMessage().url).toBe(videoUrlB);
  });

  it('ケバブをクリックしていない状態でポップアップらしき要素が現れても何も挿入しない', async () => {
    const { sheet } = openNativeMenu();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sheet.querySelector('.yt-dl-menu-item')).toBeNull();
  });

  it('aria-label が一致しないボタンのクリックには反応しない', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=notkebab1';
    const { item } = createFeedItem({ videoUrl });
    const unrelatedButton = document.createElement('button');

    unrelatedButton.setAttribute('aria-label', 'チャンネル登録');
    item.shadowRoot.appendChild(unrelatedButton);

    clickKebab(unrelatedButton);
    const { sheet } = openNativeMenu();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sheet.querySelector('.yt-dl-menu-item')).toBeNull();
  });

  it('ケバブクリックから一定時間が経過した後に現れたポップアップには挿入しない', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=stale1';
    const { kebabButton } = createFeedItem({ videoUrl });

    // 素朴に Date.now を差し替えると jsdom 内部が余分に呼び出すため回数の想定が狂う。
    // vi.useFakeTimers + setSystemTime で確定的に時刻を進める
    vi.useFakeTimers();
    try {
      clickKebab(kebabButton);
      vi.setSystemTime(Date.now() + 5000);
      const { sheet } = openNativeMenu();

      // ポーリング(setTimeout)はフェイクタイマーに置き換わるため、明示的に進める
      await vi.advanceTimersByTimeAsync(200);

      expect(sheet.querySelector('.yt-dl-menu-item')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ダウンロード操作とメッセージ処理', () => {
  it('項目をクリックするとダウンロードを開始し、進捗メッセージでラベルが更新される', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=progress1';
    const { kebabButton } = createFeedItem({ videoUrl, title: '進捗テスト' });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    menuItem.click();

    expect(lastDownloadMessage()).toMatchObject({
      type: 'DOWNLOAD',
      url: videoUrl,
      title: '進捗テスト',
    });
    expect(menuItem.dataset.state).toBe('loading');

    const buttonId = lastDownloadMessage().buttonId;

    dispatchToContentScript({ type: 'JOB_PROGRESS', buttonId, progress: 42.4 });

    expect(menuItem.textContent).toContain('42%');
  });

  it('進行中に項目をクリックするとキャンセルする', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=cancel1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    menuItem.click();
    expect(menuItem.dataset.state).toBe('loading');

    sendMessageMock.mockClear();
    menuItem.click();

    const cancelCall = sendMessageMock.mock.calls.find(([msg]) => msg.type === 'CANCEL');

    expect(cancelCall).toBeTruthy();
    expect(menuItem.dataset.state).toBe('idle');
  });

  it('完了メッセージを受け取ると完了表示になる', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=complete1';
    const { kebabButton } = createFeedItem({ videoUrl, title: '完了テスト' });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    menuItem.click();
    const buttonId = lastDownloadMessage().buttonId;

    dispatchToContentScript({ type: 'JOB_COMPLETE', buttonId, title: '完了テスト' });

    expect(menuItem.dataset.state).toBe('done');
    expect(menuItem.textContent).toContain('完了');
  });

  it('エラーメッセージを受け取ると失敗表示になる', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=error1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    menuItem.click();
    const buttonId = lastDownloadMessage().buttonId;

    dispatchToContentScript({ type: 'JOB_ERROR', buttonId, error: '失敗しました' });

    expect(menuItem.dataset.state).toBe('error');
    expect(menuItem.textContent).toContain('失敗');
  });

  it('サーバー接続に失敗した場合はすぐに失敗表示になる', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=connectfail1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    sendMessageMock.mockImplementation((_message, callback) => {
      callback?.({ ok: false, error: '接続できません' });
    });

    menuItem.click();

    expect(menuItem.dataset.state).toBe('error');
  });

  it('項目クリック後、Escape キーを送出してメニューを閉じようとする', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=closemenu1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox } = await openMenuForVideo(kebabButton);
    const menuItem = listbox.querySelector('.yt-dl-menu-item');

    const keydownSpy = vi.fn();

    document.addEventListener('keydown', keydownSpy);

    menuItem.click();

    expect(keydownSpy).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));

    document.removeEventListener('keydown', keydownSpy);
  });
});

describe('メニューの開閉をまたいだジョブの状態保持', () => {
  it('ダウンロード中にメニューを閉じて同じ動画で再度開くと、進行中の状態が復元される', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=persist1';
    const { kebabButton } = createFeedItem({ videoUrl });
    const { listbox: firstListbox, sheet: firstSheet } = await openMenuForVideo(kebabButton);

    firstListbox.querySelector('.yt-dl-menu-item').click();
    const buttonId = lastDownloadMessage().buttonId;

    dispatchToContentScript({ type: 'JOB_PROGRESS', buttonId, progress: 55 });

    // ポップアップが閉じられ、DOM から取り除かれる
    firstSheet.remove();

    const { listbox: secondListbox } = await openMenuForVideo(kebabButton);
    const secondMenuItem = secondListbox.querySelector('.yt-dl-menu-item');

    expect(secondMenuItem.dataset.state).toBe('loading');
    expect(secondMenuItem.textContent).toContain('55%');
  });
});

describe('旧UI (Polymer: ytd-menu-renderer / ytd-menu-popup-renderer) との後方互換', () => {
  const createLegacyFeedItem = ({ videoUrl, title = 'レガシー動画' } = {}) => {
    const item = document.createElement('ytd-rich-item-renderer');
    const itemShadow = item.attachShadow({ mode: 'open' });

    const link = document.createElement('a');
    link.href = videoUrl;
    itemShadow.appendChild(link);

    const titleEl = document.createElement('a');
    titleEl.id = 'video-title';
    titleEl.textContent = title;
    itemShadow.appendChild(titleEl);

    const menuRenderer = document.createElement('ytd-menu-renderer');
    const menuShadow = menuRenderer.attachShadow({ mode: 'open' });
    const kebabButton = document.createElement('button');

    menuShadow.appendChild(kebabButton);
    itemShadow.appendChild(menuRenderer);
    document.body.appendChild(item);

    return { kebabButton };
  };

  const openLegacyNativeMenu = () => {
    const dropdown = document.createElement('tp-yt-iron-dropdown');

    dropdown.opened = true;

    const popup = document.createElement('ytd-menu-popup-renderer');
    const listbox = document.createElement('tp-yt-paper-listbox');
    const nativeItem = document.createElement('ytd-menu-service-item-renderer');

    nativeItem.textContent = '後で見る';
    listbox.appendChild(nativeItem);
    popup.appendChild(listbox);
    dropdown.appendChild(popup);
    document.body.appendChild(dropdown);

    return { dropdown, listbox };
  };

  it('ytd-menu-renderer 配下のクリックと tp-yt-paper-listbox への挿入に対応する', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=legacy1';
    const { kebabButton } = createLegacyFeedItem({ videoUrl });

    clickKebab(kebabButton);
    const { listbox } = openLegacyNativeMenu();

    await vi.waitFor(() => {
      expect(listbox.querySelector('.yt-dl-menu-item')).toBeTruthy();
    });
  });

  it('項目クリック後、tp-yt-iron-dropdown の opened を false にする', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=legacy2';
    const { kebabButton } = createLegacyFeedItem({ videoUrl });

    clickKebab(kebabButton);
    const { dropdown, listbox } = openLegacyNativeMenu();

    await vi.waitFor(() => {
      expect(listbox.querySelector('.yt-dl-menu-item')).toBeTruthy();
    });

    listbox.querySelector('.yt-dl-menu-item').click();

    expect(dropdown.opened).toBe(false);
  });
});
