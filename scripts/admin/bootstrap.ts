/**
 * 新しい環境で最初の店長を作るコマンド（npm run admin:bootstrap -- --email <メール> [--name <表示名>]）。
 *
 * @packageDocumentation
 * @remarks 判断は bootstrap-core、Supabase への書き込みは bootstrap-deps に分け、ここは引数・環境変数・パスワードの入力と出力だけを持つ。.env は読まず、環境変数 SUPABASE_URL（無ければ NEXT_PUBLIC_SUPABASE_URL）と SUPABASE_SERVICE_ROLE_KEY を使う。パスワード・鍵・Supabase の誤りの文は出さない。TOTP はここで作らず、最初のログインで登録してもらう。
 */
import { parseArgs } from 'node:util';
import { bootstrapFirstAdmin, type BootstrapDeps } from './bootstrap-core';

export type CliIo = {
  env: NodeJS.ProcessEnv;
  argv: string[];
  isTTY: boolean;
  readHidden(prompt: string): Promise<string>;
  print(line: string): void;
};

/**
 * コマンドの入口。引数・環境変数・パスワードの入力を受け、判断は bootstrap-core に渡す。
 *
 * @impl IMPL-ADMIN-302
 * @design DD-ADMIN-017
 * @remarks 向け先の取り違えに気づけるよう、パスワードを聞く前にホスト名を出す。端末でない時はパスワードを隠せないので止める。
 */
export async function runBootstrapCli(io: CliIo, makeDeps?: (url: string, key: string) => BootstrapDeps): Promise<number> {
  let values: { email?: string; name?: string };
  try {
    values = parseArgs({ args: io.argv, options: { email: { type: 'string' }, name: { type: 'string' } } }).values;
  } catch {
    io.print('引数が正しくありません。使い方: npm run admin:bootstrap -- --email <メール> [--name <表示名>]');
    return 1;
  }
  if (!values.email) {
    io.print('--email が必要です。使い方: npm run admin:bootstrap -- --email <メール> [--name <表示名>]');
    return 1;
  }

  const url = io.env.SUPABASE_URL || io.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = io.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    io.print('環境変数 SUPABASE_URL（または NEXT_PUBLIC_SUPABASE_URL）と SUPABASE_SERVICE_ROLE_KEY が必要です');
    return 1;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    io.print('SUPABASE_URL の形式が正しくありません');
    return 1;
  }
  io.print(`向ける先: ${host}`);

  if (!io.isTTY) {
    io.print('パスワードを隠して入力するため、端末（TTY）から流してください');
    return 1;
  }

  try {
    const deps = makeDeps ? makeDeps(url, key) : await defaultDeps(url, key);
    if ((await deps.countActiveAdmins()) > 0) {
      io.print('有効な店長がすでにいるため、作りません');
      return 1;
    }
    const password = await io.readHidden('パスワード: ');
    const passwordConfirmation = await io.readHidden('パスワード（確認）: ');
    const result = await bootstrapFirstAdmin({ email: values.email, password, passwordConfirmation, displayName: values.name }, deps);
    if (!result.ok) {
      io.print(`作れませんでした: ${result.message}`);
      return 1;
    }
    if (result.pwnedCheck === 'unavailable') {
      io.print('警告: 漏洩パスワードの照合先に届かず、照合せずに作りました。監査ログに残しています');
    }
    io.print(`最初の店長を作りました。id: ${result.userId}  メール: ${result.email}`);
    io.print('次の手順: このメールとパスワードでログインし、最初のログインで TOTP を登録してください');
    return 0;
  } catch {
    io.print('処理の途中で失敗しました。店長がすでに作られていないか、Supabase の Auth と user_roles を確かめてください');
    return 1;
  }
}

async function defaultDeps(url: string, key: string): Promise<BootstrapDeps> {
  const { createClient } = await import('@supabase/supabase-js');
  const { createBootstrapDeps } = await import('./bootstrap-deps');
  return createBootstrapDeps(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
}

/** 打った字を出さずに1行読む（node 標準だけ。raw モードで1字ずつ受ける） */
function readHiddenFromStdin(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

if (require.main === module) {
  runBootstrapCli({
    env: process.env,
    argv: process.argv.slice(2),
    isTTY: Boolean(process.stdin.isTTY),
    readHidden: readHiddenFromStdin,
    print: (line) => console.log(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
