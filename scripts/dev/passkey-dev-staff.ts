/**
 * 手元の開発で、店員（admin・supporter）としてパスキーで /admin に入るための専用のブラウザを用意するコマンド。
 * `npm run dev:staff -- [--email <メール>] [--role admin|supporter] [--open]`
 *
 * 新しい店員を1人作り（provisionStaff。既にいる店員は再利用しない）、ソフトの認証器でパスキーのログインをし、アプリのログインと同じ形で
 * public.sessions の行（csrf_token_hash つき）を作る。--open で、専用のプロファイルの Chromium を見える形で開き、Cookie を入れて /admin を開く。
 * 手元の Supabase だけ。パスキーのログインは24時間で切れるので、毎日と `db reset` の後に流し直す。
 * Cookie・token・JWT・鍵は、ファイルにも標準出力にも出さない（.tmp-dev-staff/ にはブラウザのプロファイルだけ）。
 *
 * @packageDocumentation
 * @remarks アプリ（src/）はこのファイルを読まない。接続情報は手元の `supabase status -o json` をプロセスの中で読む（.env* は読まない）。
 * public.sessions の行の作りは src/features/auth/services/session.ts の persistNewSession と同じ（csrf_token_hash は CSRF の値の SHA-256）。
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  cookieOptionsForAccess,
  cookieOptionsForCsrf,
  cookieOptionsForRefresh,
  accessCookieName,
  csrfCookieName,
  refreshCookieName,
} from '../../src/lib/cookie';
import { REFRESH_TOKEN_MAX_AGE_SECONDS } from '../../src/features/auth/services/session';
import { isLocalUrl, parseSupabaseStatus, runSupabaseStatus } from '../e2e/environment';
import { loginWithPasskey, provisionStaff } from '../e2e/passkey-staff';
import type { PgClient } from '../../tests/integration/db/helpers/local-db';

const APP_ORIGIN = 'http://localhost:3000';
const ROLES = ['admin', 'supporter'] as const;
type StaffRole = (typeof ROLES)[number];

type LocalConnection = { url: string; anonKey: string; serviceRoleKey: string; databaseUrl: string };

export type BrowserCookie = { name: string; value: string; url: string; httpOnly: boolean; sameSite: 'Lax'; expires: number };

export type DevStaffDeps = {
  readEnv: () => LocalConnection;
  connectDb: (databaseUrl: string) => Promise<PgClient>;
  provisionStaff: typeof provisionStaff;
  loginWithPasskey: typeof loginWithPasskey;
  openBrowser: (input: { profileDir: string; cookies: BrowserCookie[]; startUrl: string }) => Promise<void>;
  print: (line: string) => void;
};

/** 住所・鍵・DB の住所は、全部、手元の `supabase status -o json` だけから読む（環境変数・.env* は読まない） */
function readLocalConnection(): LocalConnection {
  let raw: string;
  try {
    raw = runSupabaseStatus();
  } catch {
    throw new Error('手元の Supabase の状態を読めません。Docker を起動し、npx supabase start で手元の Supabase を起動してください。');
  }
  const status = parseSupabaseStatus(raw);
  const databaseUrl = (JSON.parse(raw) as Record<string, unknown>).DB_URL;
  return {
    url: status.apiUrl,
    anonKey: status.anonKey,
    serviceRoleKey: status.serviceRoleKey,
    databaseUrl: typeof databaseUrl === 'string' ? databaseUrl : '',
  };
}

/** DB の住所が手元か。pg は接続文字列の ?host=・?hostaddr= で接続先を替えられるので、それがあれば断る */
function isLocalDatabaseUrl(raw: string): boolean {
  if (!isLocalUrl(raw)) return false;
  const params = new URL(raw).searchParams;
  return !params.has('host') && !params.has('hostaddr');
}

async function connectDb(databaseUrl: string): Promise<PgClient> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client as PgClient;
}

async function openBrowser(input: { profileDir: string; cookies: BrowserCookie[]; startUrl: string }): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const context = await chromium.launchPersistentContext(input.profileDir, { headless: false });
  await context.clearCookies();
  await context.addCookies(input.cookies);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(input.startUrl);
}

const defaultDeps: DevStaffDeps = {
  readEnv: readLocalConnection,
  connectDb,
  provisionStaff,
  loginWithPasskey,
  openBrowser,
  print: (line) => console.log(line),
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JWT の session_id を読む（検証はしない。いま Auth が返した値を、結び付ける行の印に使うだけ） */
function readSessionId(accessToken: string): string {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { session_id?: string };
    if (claims.session_id) return claims.session_id;
  } catch {
    // 下で投げる
  }
  throw new Error('パスキーのログインの JWT に session_id が無い');
}

/**
 * 店員を用意してパスキーでログインし、アプリの sessions に結び付け、--open ならブラウザを開く。
 * 手元の Supabase の住所でなければ、何も書かずに投げる。
 *
 * @impl IMPL-AUTH-247
 * @design DD-AUTH-049
 */
export async function main(argv: string[], overrides: Partial<DevStaffDeps> = {}): Promise<{ profileDir: string }> {
  const deps: DevStaffDeps = { ...defaultDeps, ...overrides };
  const { values } = parseArgs({
    args: argv,
    options: { email: { type: 'string' }, role: { type: 'string' }, open: { type: 'boolean' } },
  });
  const role = values.role ?? 'admin';
  if (!(ROLES as readonly string[]).includes(role)) throw new Error('--role は admin か supporter だけ');
  const email = values.email ?? `dev-staff-${randomBytes(4).toString('hex')}@example.com`;

  const env = deps.readEnv();
  if (!isLocalUrl(env.url)) throw new Error('店員として入るスクリプトは手元の Supabase だけで使える');
  if (!env.databaseUrl || !isLocalDatabaseUrl(env.databaseUrl)) throw new Error('手元の DB の住所を読めない（supabase start を確かめる）');

  // リポジトリの根（このファイルの2つ上）から決める。cwd で決めると、下のフォルダーから流した時に git が無視しない場所にできる
  const profileDir = path.resolve(__dirname, '..', '..', '.tmp-dev-staff', 'profile');
  // 共有の道具（provisionStaff・loginWithPasskey）は接続情報を環境変数から読む。使う間だけ status の値を置き、終わったら元に戻す
  // （ブラウザの子のプロセスに手元の鍵を渡さない・同じプロセスの後の処理に効かせない）
  const envKeys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
  const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
  let db: PgClient | undefined;
  let cookies: BrowserCookie[];
  try {
    db = await deps.connectDb(env.databaseUrl);
    const staff = await deps.provisionStaff(db, { role: role as StaffRole, approvedPasskeys: 2, email });
    const { session } = await deps.loginWithPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
    const authSessionId = readSessionId(session.access_token);
    // 用意（provisionStaff）の magiclink の session が残る。実際のログインは1つの session だけなので、パスキーのログインの session 以外を消す
    await db.query('delete from auth.sessions where user_id = $1::uuid and id <> $2::uuid', [staff.userId, authSessionId]);

    const csrfToken = randomBytes(32).toString('hex');
    const inserted = await db.query(
      `insert into public.sessions (user_id, refresh_token_hash, csrf_token_hash, auth_session_id, expires_at, last_seen_at)
       values ($1::uuid, $2, $3, $4::uuid, now() + make_interval(secs => $5::double precision), now())`,
      [staff.userId, sha256Hex(session.refresh_token), sha256Hex(csrfToken), authSessionId, REFRESH_TOKEN_MAX_AGE_SECONDS],
    );
    if (inserted.rowCount !== 1) throw new Error('結び付けた sessions の行を作れない');

    const expires = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_MAX_AGE_SECONDS;
    const make = (name: string, value: string, httpOnly: boolean): BrowserCookie => ({
      name,
      value,
      url: APP_ORIGIN,
      httpOnly,
      sameSite: 'Lax',
      expires,
    });
    cookies = [
      make(accessCookieName, session.access_token, cookieOptionsForAccess(REFRESH_TOKEN_MAX_AGE_SECONDS).httpOnly),
      make(refreshCookieName, session.refresh_token, cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE_SECONDS).httpOnly),
      make(csrfCookieName, csrfToken, cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE_SECONDS).httpOnly),
    ];
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (db) await db.end();
  }

  deps.print(`店員を用意した: ${email}（役割 ${role}）`);
  deps.print('パスキーのログインは24時間で切れる。切れたら、または db reset の後は、新しいメールで流し直す');
  if (values.open) {
    deps.print(`専用のブラウザを開く: ${APP_ORIGIN}/admin（プロファイル ${profileDir}）`);
    await deps.openBrowser({ profileDir, cookies, startUrl: `${APP_ORIGIN}/admin` });
  } else {
    deps.print('ブラウザは開いていない。--open を付けると、専用のブラウザで /admin を開く');
  }
  return { profileDir };
}

/** 失敗の文面は共有の道具が status・code だけにしてある。Error の message だけを出し、それ以外は決まった文にする（JWT・鍵は出さない）
 *
 * @impl IMPL-AUTH-248
 * @design DD-AUTH-049
 */
export async function run(
  argv: string[],
  overrides: Partial<DevStaffDeps> = {},
  printError: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  try {
    await main(argv, overrides);
    return 0;
  } catch (error: unknown) {
    printError(error instanceof Error ? error.message : '店員として入る用意に失敗した');
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
