import { spawn } from 'child_process';

// YouTube 側の仕様変更（n チャレンジ等）への追従はイメージのビルド時点で止まってしまい、
// 再ビルドを忘れると古い yt-dlp のままダウンロードが失敗し続ける。そのため API サーバー
// 起動時に nightly（--pre）の最新版へ更新する。Dockerfile のインストール方法と揃える
export const YT_DLP_UPDATE_COMMAND = 'python3';
export const YT_DLP_UPDATE_ARGS = [
  '-m',
  'pip',
  'install',
  '--quiet',
  '--disable-pip-version-check',
  '--break-system-packages',
  '--upgrade',
  '--pre',
  'yt-dlp[default]',
];

// PyPI に繋がらない等で更新が終わらない場合でも、サーバーの起動を長く待たせないための上限
export const YT_DLP_UPDATE_TIMEOUT_MS = 120_000;

export type UpdateResult = { ok: true } | { ok: false; reason: string };

export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<UpdateResult>;

/** ホストで直接実行したときに手元の Python 環境を書き換えないよう、
 * 明示的に YT_DL_AUTO_UPDATE=1 が指定された場合（Docker イメージ）だけ有効にする */
export const isAutoUpdateEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env.YT_DL_AUTO_UPDATE === '1';

const spawnRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let stderr = '';
    let settled = false;

    const finish = (result: UpdateResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const proc = spawn(command, args);

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({
        ok: false,
        reason: `${timeoutMs / 1000}秒以内に終わりませんでした`,
      });
    }, timeoutMs);

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => {
      finish({ ok: false, reason: err.message });
    });
    proc.on('close', (code) => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, reason: stderr.trim() || `終了コード ${code}` },
      );
    });
  });

/** yt-dlp を最新版へ更新する。失敗しても例外は投げず、既存の版で動作を続けられるようにする */
export const updateYtDlp = (
  runner: CommandRunner = spawnRunner,
): Promise<UpdateResult> =>
  runner(YT_DLP_UPDATE_COMMAND, YT_DLP_UPDATE_ARGS, YT_DLP_UPDATE_TIMEOUT_MS);
