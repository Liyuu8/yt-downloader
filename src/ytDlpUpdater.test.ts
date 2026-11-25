import { describe, expect, it, vi } from 'vitest';
import {
  isAutoUpdateEnabled,
  updateYtDlp,
  YT_DLP_UPDATE_ARGS,
  YT_DLP_UPDATE_COMMAND,
  YT_DLP_UPDATE_TIMEOUT_MS,
  type CommandRunner,
} from './ytDlpUpdater.js';

describe('isAutoUpdateEnabled', () => {
  it('YT_DL_AUTO_UPDATE=1 のときだけ有効になる', () => {
    expect(isAutoUpdateEnabled({ YT_DL_AUTO_UPDATE: '1' })).toBe(true);
  });

  it.each([undefined, '0', 'true', ''])(
    'YT_DL_AUTO_UPDATE=%s では無効になる',
    (value) => {
      expect(isAutoUpdateEnabled({ YT_DL_AUTO_UPDATE: value })).toBe(false);
    },
  );
});

describe('updateYtDlp', () => {
  it('nightly 版を pip で更新するコマンドを実行する', async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({ ok: true });

    await expect(updateYtDlp(runner)).resolves.toEqual({ ok: true });
    expect(runner).toHaveBeenCalledWith(
      YT_DLP_UPDATE_COMMAND,
      YT_DLP_UPDATE_ARGS,
      YT_DLP_UPDATE_TIMEOUT_MS,
    );
    expect(YT_DLP_UPDATE_ARGS).toEqual(
      expect.arrayContaining(['--upgrade', '--pre', 'yt-dlp[default]']),
    );
  });

  it('更新に失敗しても例外を投げず理由を返す', async () => {
    const runner = vi
      .fn<CommandRunner>()
      .mockResolvedValue({ ok: false, reason: 'network unreachable' });

    await expect(updateYtDlp(runner)).resolves.toEqual({
      ok: false,
      reason: 'network unreachable',
    });
  });
});
