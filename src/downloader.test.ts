import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  formatDuration,
  formatComments,
  buildNotesText,
} from './downloader.js';

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
