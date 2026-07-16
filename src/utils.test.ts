import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('isValidYouTubeUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PL1234567890',
  ])('valid: %s', async (url) => {
    const { isValidYouTubeUrl } = await import('./utils.js');
    expect(isValidYouTubeUrl(url)).toBe(true);
  });

  it.each([
    '',
    'not a url',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'ftp://youtu.be/dQw4w9WgXcQ',
  ])('invalid: %s', async (url) => {
    const { isValidYouTubeUrl } = await import('./utils.js');
    expect(isValidYouTubeUrl(url)).toBe(false);
  });
});

describe('isPlaylistUrl', () => {
  it('detects a playlist URL', async () => {
    const { isPlaylistUrl } = await import('./utils.js');
    expect(
      isPlaylistUrl('https://www.youtube.com/playlist?list=PL1234567890'),
    ).toBe(true);
  });

  it('rejects a normal video URL', async () => {
    const { isPlaylistUrl } = await import('./utils.js');
    expect(isPlaylistUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      false,
    );
  });
});

describe('buildFormatSelector', () => {
  it('audioOnly with ffmpeg returns bestaudio/best', async () => {
    const { buildFormatSelector } = await import('./utils.js');
    expect(buildFormatSelector('best', true, true)).toBe('bestaudio/best');
  });

  it('audioOnly without ffmpeg falls back to m4a/mp4/bestaudio chain', async () => {
    const { buildFormatSelector } = await import('./utils.js');
    expect(buildFormatSelector('best', false, false) !== undefined).toBe(true);
    expect(buildFormatSelector('1080', true, false)).toBe(
      'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio',
    );
  });

  it.each(['best', '1080', '720', '480', '360'] as const)(
    'quality=%s with ffmpeg selects height-capped avc/mp4 chain',
    async (quality) => {
      const { buildFormatSelector } = await import('./utils.js');
      const result = buildFormatSelector(quality, false, true);
      expect(result).toContain('bestvideo');
      expect(result).toContain('bestaudio');
      if (quality !== 'best') {
        expect(result).toContain(`height<=${quality}`);
      }
    },
  );

  it.each(['best', '1080', '720', '480', '360'] as const)(
    'quality=%s without ffmpeg selects https mp4 with format 18 fallback',
    async (quality) => {
      const { buildFormatSelector } = await import('./utils.js');
      const result = buildFormatSelector(quality, false, false);
      expect(result.endsWith('/18')).toBe(true);
      expect(result).toContain('protocol=https');
      if (quality !== 'best') {
        expect(result).toContain(`height<=${quality}`);
      }
    },
  );

  it('360 without ffmpeg falls back to raw format 18', async () => {
    const { buildFormatSelector } = await import('./utils.js');
    expect(buildFormatSelector('360', false, false)).toBe(
      'best[ext=mp4][protocol=https][height<=360]/18',
    );
  });
});

describe('checkYtDlp / checkFfmpeg', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('which');
  });

  it('checkYtDlp returns true when which.sync succeeds', async () => {
    vi.doMock('which', () => ({
      default: { sync: vi.fn(() => '/usr/bin/yt-dlp') },
    }));
    const { checkYtDlp } = await import('./utils.js');
    expect(checkYtDlp()).toBe(true);
  });

  it('checkYtDlp returns false when which.sync throws', async () => {
    vi.doMock('which', () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error('not found');
        }),
      },
    }));
    const { checkYtDlp } = await import('./utils.js');
    expect(checkYtDlp()).toBe(false);
  });

  it('checkFfmpeg returns true when which.sync succeeds', async () => {
    vi.doMock('which', () => ({
      default: { sync: vi.fn(() => '/usr/bin/ffmpeg') },
    }));
    const { checkFfmpeg } = await import('./utils.js');
    expect(checkFfmpeg()).toBe(true);
  });

  it('checkFfmpeg returns false when which.sync throws', async () => {
    vi.doMock('which', () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error('not found');
        }),
      },
    }));
    const { checkFfmpeg } = await import('./utils.js');
    expect(checkFfmpeg()).toBe(false);
  });
});

describe('getYtDlpVersion', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('child_process');
  });

  it('returns the trimmed version string on success', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(() => '2024.01.01\n'),
    }));
    const { getYtDlpVersion } = await import('./utils.js');
    expect(getYtDlpVersion()).toBe('2024.01.01');
  });

  it("returns 'unknown' when execSync throws", async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(() => {
        throw new Error('command not found');
      }),
    }));
    const { getYtDlpVersion } = await import('./utils.js');
    expect(getYtDlpVersion()).toBe('unknown');
  });
});

describe('getYtDlpBaseArgs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('which');
  });

  const mockWhich = (available: string[]): void => {
    vi.doMock('which', () => ({
      default: {
        sync: vi.fn((runtime: string) => {
          if (available.includes(runtime)) return `/usr/bin/${runtime}`;
          throw new Error('not found');
        }),
      },
    }));
  };

  it('includes both deno and node when both are available', async () => {
    mockWhich(['deno', 'node']);
    const { getYtDlpBaseArgs } = await import('./utils.js');
    const args = getYtDlpBaseArgs();
    expect(args).toEqual([
      '--remote-components',
      'ejs:github',
      '--js-runtimes',
      'deno',
      '--js-runtimes',
      'node',
    ]);
  });

  it('includes only deno when node is unavailable', async () => {
    mockWhich(['deno']);
    const { getYtDlpBaseArgs } = await import('./utils.js');
    const args = getYtDlpBaseArgs();
    expect(args).toEqual([
      '--remote-components',
      'ejs:github',
      '--js-runtimes',
      'deno',
    ]);
  });

  it('includes only node when deno is unavailable', async () => {
    mockWhich(['node']);
    const { getYtDlpBaseArgs } = await import('./utils.js');
    const args = getYtDlpBaseArgs();
    expect(args).toEqual([
      '--remote-components',
      'ejs:github',
      '--js-runtimes',
      'node',
    ]);
  });

  it('includes neither when both are unavailable', async () => {
    mockWhich([]);
    const { getYtDlpBaseArgs } = await import('./utils.js');
    const args = getYtDlpBaseArgs();
    expect(args).toEqual(['--remote-components', 'ejs:github']);
  });
});

describe('ensureOutputDir', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
  });

  it('does not create the directory when it already exists', async () => {
    const mkdirSync = vi.fn();
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => true),
      mkdirSync,
    }));
    const { ensureOutputDir } = await import('./utils.js');
    ensureOutputDir('/some/dir');
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('creates the directory recursively when it does not exist', async () => {
    const mkdirSync = vi.fn();
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => false),
      mkdirSync,
    }));
    const { ensureOutputDir } = await import('./utils.js');
    ensureOutputDir('/some/dir');
    expect(mkdirSync).toHaveBeenCalledWith('/some/dir', { recursive: true });
  });
});

describe('formatFileSize', () => {
  it('returns 不明 for undefined', async () => {
    const { formatFileSize } = await import('./utils.js');
    expect(formatFileSize(undefined)).toBe('不明');
  });

  it('returns 不明 for 0 bytes', async () => {
    const { formatFileSize } = await import('./utils.js');
    expect(formatFileSize(0)).toBe('不明');
  });

  it('formats sizes under 1024MB in MB', async () => {
    const { formatFileSize } = await import('./utils.js');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats sizes at or above 1024MB in GB', async () => {
    const { formatFileSize } = await import('./utils.js');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});

describe('isAllowedOrigin', () => {
  it('rejects undefined origin', async () => {
    const { isAllowedOrigin } = await import('./utils.js');
    expect(isAllowedOrigin(undefined)).toBe(false);
  });

  it('accepts a chrome-extension origin', async () => {
    const { isAllowedOrigin } = await import('./utils.js');
    expect(isAllowedOrigin('chrome-extension://abcdefg')).toBe(true);
  });

  it('rejects a plain http origin', async () => {
    const { isAllowedOrigin } = await import('./utils.js');
    expect(isAllowedOrigin('http://example.com')).toBe(false);
  });
});
