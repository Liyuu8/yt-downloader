import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  formatDuration,
  formatComments,
  buildNotesText,
  parseYtDlpLine,
} from './downloader.js';

describe('parseYtDlpLine', () => {
  it('returns no events for an unrecognized line', () => {
    expect(parseYtDlpLine('[youtube] Extracting URL')).toEqual([]);
  });

  it('detects a playlist video switch', () => {
    expect(parseYtDlpLine('[download] Downloading video 2 of 5')).toEqual([
      { type: 'videoSwitch', currentVideo: 2, totalVideos: 5 },
    ]);
  });

  it.each([
    '[download] Destination: /out/My Video.mp4',
    '[Merger] Destination: /out/My Video.mp4',
    '[ExtractAudio] Destination: /out/My Video.mp4',
  ])('detects a destination line: %s', (line) => {
    expect(parseYtDlpLine(line)).toEqual([
      { type: 'destination', file: '/out/My Video.mp4' },
    ]);
  });

  it('detects an already-downloaded skip line as a destination', () => {
    expect(
      parseYtDlpLine('[download] /out/My Video.mp4 has already been downloaded'),
    ).toEqual([{ type: 'destination', file: '/out/My Video.mp4' }]);
  });

  it('detects a merged-formats line', () => {
    expect(
      parseYtDlpLine('[Merger] Merging formats into "/out/My Video.mp4"'),
    ).toEqual([{ type: 'merged', file: '/out/My Video.mp4' }]);
  });

  it('detects an info.json write line', () => {
    expect(
      parseYtDlpLine(
        '[info] Writing video metadata as JSON to: /out/My Video.info.json',
      ),
    ).toEqual([{ type: 'infoJson', file: '/out/My Video.info.json' }]);
  });

  it('converts an HLS item count into a progress percentage', () => {
    expect(parseYtDlpLine('[download] Downloading item 1 of 4')).toEqual([
      { type: 'progress', percent: 25 },
    ]);
  });

  it('emits no progress event when the HLS item total is zero', () => {
    expect(parseYtDlpLine('[download] Downloading item 0 of 0')).toEqual([]);
  });

  it('parses a plain download percentage', () => {
    expect(
      parseYtDlpLine('[download]  42.5% of 10.00MiB at 1.00MiB/s'),
    ).toEqual([{ type: 'progress', percent: 42.5 }]);
  });
});

describe('formatDuration', () => {
  it('formats 0 seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats seconds under a minute', () => {
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats exactly 60 seconds as 1:00', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  it('formats just under an hour (3599s) without an hour segment', () => {
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats exactly an hour (3600s) with an hour segment', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
  });

  it('formats multi-hour durations', () => {
    expect(formatDuration(7325)).toBe('2:02:05');
  });
});

describe('formatComments', () => {
  it('returns an empty string for no comments', () => {
    expect(formatComments([])).toBe('');
  });

  it('renders flat top-level comments', () => {
    const result = formatComments([
      { id: '1', text: 'hello', author: 'Alice', like_count: 3 },
      { id: '2', text: 'world', author: 'Bob' },
    ]);
    expect(result).toContain('Alice 👍3');
    expect(result).toContain('hello');
    expect(result).toContain('Bob');
    expect(result).toContain('world');
  });

  it('nests replies under their parent with indentation', () => {
    const result = formatComments([
      { id: '1', text: 'top', author: 'Alice', parent: 'root' },
      { id: '2', text: 'reply', author: 'Bob', parent: '1' },
    ]);
    const lines = result.split('\n');
    const replyLineIndex = lines.findIndex((l) => l.includes('Bob'));
    expect(replyLineIndex).toBeGreaterThan(-1);
    expect(lines[replyLineIndex].startsWith('    ')).toBe(true);
  });

  it('drops orphan replies whose parent is not in the list', () => {
    const result = formatComments([
      {
        id: '2',
        text: 'orphan reply',
        author: 'Bob',
        parent: 'missing-parent',
      },
    ]);
    expect(result).toBe('');
  });

  it('handles missing author and like_count', () => {
    const result = formatComments([{ id: '1', text: 'anonymous comment' }]);
    expect(result).toContain('(不明)');
    expect(result).toContain('anonymous comment');
    expect(result).not.toContain('👍');
  });

  it('preserves multi-line comment text', () => {
    const result = formatComments([
      { id: '1', text: 'line one\nline two', author: 'Alice' },
    ]);
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });
});

describe('buildNotesText', () => {
  it('includes only the title when neither flag is set', () => {
    const result = buildNotesText('My Video', 'desc', [], false, false);
    expect(result).toBe('My Video\n');
  });

  it('includes the description section when saveDescription is true', () => {
    const result = buildNotesText(
      'My Video',
      'This is the description',
      undefined,
      true,
      false,
    );
    expect(result).toContain('■ 概要欄');
    expect(result).toContain('This is the description');
    expect(result).not.toContain('■ コメント');
  });

  it('shows a placeholder when description is missing', () => {
    const result = buildNotesText(
      'My Video',
      undefined,
      undefined,
      true,
      false,
    );
    expect(result).toContain('(概要欄なし)');
  });

  it('includes the comments section when saveComments is true', () => {
    const result = buildNotesText(
      'My Video',
      undefined,
      [{ id: '1', text: 'nice', author: 'Alice' }],
      false,
      true,
    );
    expect(result).toContain('■ コメント (1件)');
    expect(result).toContain('nice');
    expect(result).not.toContain('■ 概要欄');
  });

  it('shows a placeholder when there are no comments', () => {
    const result = buildNotesText('My Video', undefined, [], false, true);
    expect(result).toContain('■ コメント (0件)');
    expect(result).toContain('(コメントなし)');
  });

  it('includes both sections when both flags are true', () => {
    const result = buildNotesText(
      'My Video',
      'desc text',
      [{ id: '1', text: 'nice', author: 'Alice' }],
      true,
      true,
    );
    expect(result).toContain('■ 概要欄');
    expect(result).toContain('■ コメント (1件)');
  });
});

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('fetchVideoInfo / fetchPlaylistInfo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('child_process');
  });

  const mockSpawn = (): FakeChildProcess => {
    const fake = new FakeChildProcess();
    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => fake),
      execSync: vi.fn(),
    }));

    return fake;
  };

  it('fetchVideoInfo maps a successful JSON response', async () => {
    const fake = mockSpawn();
    const { fetchVideoInfo } = await import('./downloader.js');
    const promise = fetchVideoInfo('https://youtu.be/abc');

    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          title: 'Test Video',
          uploader: 'Test Channel',
          duration: 125,
          filesize_approx: 1024 * 1024 * 10,
        }),
      ),
    );
    fake.emit('close', 0);

    await expect(promise).resolves.toEqual({
      title: 'Test Video',
      duration: '2:05',
      uploader: 'Test Channel',
      filesize: 1024 * 1024 * 10,
    });
  });

  it('fetchVideoInfo rejects when yt-dlp exits non-zero', async () => {
    const fake = mockSpawn();
    const { fetchVideoInfo } = await import('./downloader.js');
    const promise = fetchVideoInfo('https://youtu.be/abc');

    fake.stderr.emit('data', Buffer.from('some error'));
    fake.emit('close', 1);

    await expect(promise).rejects.toThrow('動画情報の取得に失敗しました');
  });

  it('fetchVideoInfo rejects on invalid JSON', async () => {
    const fake = mockSpawn();
    const { fetchVideoInfo } = await import('./downloader.js');
    const promise = fetchVideoInfo('https://youtu.be/abc');

    fake.stdout.emit('data', Buffer.from('not json'));
    fake.emit('close', 0);

    await expect(promise).rejects.toThrow('動画情報のパースに失敗しました');
  });

  const mockSpawnQueue = (procs: FakeChildProcess[]) => {
    const spawnMock = vi.fn();
    for (const proc of procs) {
      spawnMock.mockImplementationOnce(() => proc);
    }
    vi.doMock('child_process', () => ({
      spawn: spawnMock,
      execSync: vi.fn(),
    }));

    return spawnMock;
  };

  it('fetchVideoInfo retries with the android player client on a PO token subprocess timeout', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawnMock = mockSpawnQueue([first, second]);
    const { fetchVideoInfo } = await import('./downloader.js');

    const promise = fetchVideoInfo('https://youtu.be/abc');

    first.stderr.emit(
      'data',
      Buffer.from(
        "ERROR: Command '[...]' timed out after 15.0 seconds\n",
      ),
    );
    first.emit('close', 1);

    await Promise.resolve();
    await Promise.resolve();

    second.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          title: 'Test Video',
          uploader: 'Test Channel',
          duration: 65,
        }),
      ),
    );
    second.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ title: 'Test Video' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const secondArgs = spawnMock.mock.calls[1][1] as string[];
    expect(secondArgs).toEqual(
      expect.arrayContaining([
        '--extractor-args',
        'youtube:player_client=android',
      ]),
    );
  });

  it('fetchPlaylistInfo maps title/uploader fallback chain and videoCount from entries', async () => {
    const fake = mockSpawn();
    const { fetchPlaylistInfo } = await import('./downloader.js');
    const promise = fetchPlaylistInfo(
      'https://www.youtube.com/playlist?list=PL123',
    );

    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          channel: 'Fallback Channel',
          entries: [{}, {}, {}],
        }),
      ),
    );
    fake.emit('close', 0);

    await expect(promise).resolves.toEqual({
      title: 'Unknown',
      uploader: 'Fallback Channel',
      videoCount: 3,
    });
  });

  it('fetchPlaylistInfo prefers playlist_count over entries length', async () => {
    const fake = mockSpawn();
    const { fetchPlaylistInfo } = await import('./downloader.js');
    const promise = fetchPlaylistInfo(
      'https://www.youtube.com/playlist?list=PL123',
    );

    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          title: 'My Playlist',
          uploader: 'Uploader Name',
          playlist_count: 42,
          entries: [{}, {}],
        }),
      ),
    );
    fake.emit('close', 0);

    await expect(promise).resolves.toEqual({
      title: 'My Playlist',
      uploader: 'Uploader Name',
      videoCount: 42,
    });
  });

  it('fetchPlaylistInfo rejects when yt-dlp exits non-zero', async () => {
    const fake = mockSpawn();
    const { fetchPlaylistInfo } = await import('./downloader.js');
    const promise = fetchPlaylistInfo(
      'https://www.youtube.com/playlist?list=PL123',
    );

    fake.stderr.emit('data', Buffer.from('boom'));
    fake.emit('close', 1);

    await expect(promise).rejects.toThrow(
      'プレイリスト情報の取得に失敗しました',
    );
  });
});

describe('downloadVideo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('child_process');
    vi.doUnmock('fs/promises');
  });

  const mockSpawnQueue = (procs: FakeChildProcess[]) => {
    const spawnMock = vi.fn();
    for (const proc of procs) {
      spawnMock.mockImplementationOnce(() => proc);
    }
    vi.doMock('child_process', () => ({
      spawn: spawnMock,
      execSync: vi.fn(),
    }));

    return spawnMock;
  };

  const baseOptions = () => ({
    url: 'https://youtu.be/abc',
    outputDir: '/downloads',
    quality: 'best' as const,
    audioOnly: false,
    hasFfmpeg: true,
    playlist: false,
    saveDescription: false,
    saveComments: false,
  });

  it('retries with the android player client when the default attempt gets a 403', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawnMock = mockSpawnQueue([first, second]);
    const { downloadVideo } = await import('./downloader.js');

    const promise = downloadVideo(baseOptions());

    first.stderr.emit(
      'data',
      Buffer.from(
        'ERROR: unable to download video data: HTTP Error 403: Forbidden\n',
      ),
    );
    first.emit('close', 1);

    // downloadVideo の catch ブロックが再試行の spawn を呼ぶまでマイクロタスクを流す
    await Promise.resolve();
    await Promise.resolve();

    second.stdout.emit(
      'data',
      Buffer.from('[download] Destination: /downloads/video.mp4\n'),
    );
    second.emit('close', 0);

    const result = await promise;
    expect(result.outputFile).toBe('/downloads/video.mp4');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const secondArgs = spawnMock.mock.calls[1][1] as string[];
    expect(secondArgs).toEqual(
      expect.arrayContaining([
        '--extractor-args',
        'youtube:player_client=android',
      ]),
    );
  });

  it('cleans up the incomplete .part file left by a failed attempt before retrying', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawnMock = mockSpawnQueue([first, second]);
    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    const readdirMock = vi
      .fn()
      .mockResolvedValue([
        'video.f137.mp4.part',
        'video.f137.mp4', // 別ジョブの完成済みファイル。誤って消してはいけない
      ]);
    vi.doMock('fs/promises', () => ({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      unlink: unlinkMock,
      readdir: readdirMock,
    }));

    const { downloadVideo } = await import('./downloader.js');
    const promise = downloadVideo(baseOptions());

    first.stdout.emit(
      'data',
      Buffer.from('[download] Destination: /downloads/video.f137.mp4\n'),
    );
    first.stderr.emit(
      'data',
      Buffer.from(
        'ERROR: unable to download video data: HTTP Error 403: Forbidden\n',
      ),
    );
    first.emit('close', 1);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

    second.stdout.emit(
      'data',
      Buffer.from('[download] Destination: /downloads/video.mp4\n'),
    );
    second.emit('close', 0);

    await promise;

    expect(unlinkMock).toHaveBeenCalledWith('/downloads/video.f137.mp4.part');
    expect(unlinkMock).not.toHaveBeenCalledWith('/downloads/video.f137.mp4');
  });

  it('does not retry when the failure is not a 403', async () => {
    const first = new FakeChildProcess();
    const spawnMock = mockSpawnQueue([first]);
    const { downloadVideo } = await import('./downloader.js');

    const promise = downloadVideo(baseOptions());
    first.stderr.emit('data', Buffer.from('ERROR: some other failure\n'));
    first.emit('close', 1);

    await expect(promise).rejects.toThrow('ダウンロードに失敗しました');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  const forbidden = (proc: FakeChildProcess): void => {
    proc.stderr.emit(
      'data',
      Buffer.from(
        'ERROR: unable to download video data: HTTP Error 403: Forbidden\n',
      ),
    );
    proc.emit('close', 1);
  };

  it('retries the android client multiple times when it also keeps hitting 403', async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeChildProcess();
      const second = new FakeChildProcess();
      const third = new FakeChildProcess();
      const spawnMock = mockSpawnQueue([first, second, third]);
      const { downloadVideo } = await import('./downloader.js');

      const promise = downloadVideo(baseOptions());

      forbidden(first);
      // 1回目の android フォールバックは遅延なしで即座に再試行される
      await vi.advanceTimersByTimeAsync(0);

      forbidden(second);
      // 2回目の android フォールバックはリトライ間隔だけ待ってから再試行される
      await vi.advanceTimersByTimeAsync(2000);

      third.stdout.emit(
        'data',
        Buffer.from('[download] Destination: /downloads/video.mp4\n'),
      );
      third.emit('close', 0);

      const result = await promise;
      expect(result.outputFile).toBe('/downloads/video.mp4');
      expect(spawnMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after exhausting all fallback attempts', async () => {
    vi.useFakeTimers();
    try {
      const procs = [
        new FakeChildProcess(),
        new FakeChildProcess(),
        new FakeChildProcess(),
        new FakeChildProcess(),
      ];
      const spawnMock = mockSpawnQueue(procs);
      const { downloadVideo } = await import('./downloader.js');

      const promise = downloadVideo(baseOptions());
      const assertion = expect(promise).rejects.toThrow(
        'ダウンロードに失敗しました',
      );

      for (const proc of procs) {
        forbidden(proc);
        await vi.advanceTimersByTimeAsync(2000);
      }

      await assertion;
      expect(spawnMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
