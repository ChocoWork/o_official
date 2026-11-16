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
  csrfCookieMaxAgeSeconds,
} from '../../src/lib/cookie';
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

/** 呼び手が環境変数で渡した値を優先し、無ければ手元の `supabase status -o json` をプロセスの中で読む。DB の住所は status の値だけを使う */
function readLocalConnection(): LocalConnection {
  const raw = runSupabaseStatus();
  const status = parseSupabaseStatus(raw);
  const databaseUrl = (JSON.parse(raw) as Record<string, unknown>).DB_URL;
  const env: LocalConnection = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || status.apiUrl,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || status.anonKey,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || status.serviceRoleKey,
    databaseUrl: typeof databaseUrl === 'string' ? databaseUrl : '',
  };
  return env;
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
export async function main(argv: string[], deps: DevStaffDeps = defaultDeps): Promise<{ profileDir: string }> {
  const { values } = parseArgs({
    args: argv,
    options: { email: { type: 'string' }, role: { type: 'string' }, open: { type: 'boolean' } },
  });
  const role = values.role ?? 'admin';
  if (!(ROLES as readonly string[]).includes(role)) throw new Error('--role は admin か supporter だけ');
  const email = values.email ?? `dev-staff-${randomBytes(4).toString('hex')}@example.com`;

  const env = deps.readEnv();
  if (!isLocalUrl(env.url)) throw new Error('店員として入るスクリプトは手元の Supabase だけで使える');
  if (!env.databaseUrl || !isLocalUrl(env.databaseUrl)) throw new Error('手元の DB の住所を読めない（supabase start を確かめる）');
  // 共有の道具（provisionStaff・loginWithPasskey）は、環境変数が無ければ自分で status を読む。ここで読んだ値を渡して二重に読まない
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;

  const profileDir = path.resolve('.tmp-dev-staff', 'profile');
  const db = await deps.connectDb(env.databaseUrl);
  let cookies: BrowserCookie[];
  try {
    const staff = await deps.provisionStaff(db, { role: role as StaffRole, approvedPasskeys: 2, email });
    const { session } = await deps.loginWithPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
    const authSessionId = readSessionId(session.access_token);
    // 用意（provisionStaff）の magiclink の session が残る。実際のログインは1つの session だけなので、パスキーのログインの session 以外を消す
    await db.query('delete from auth.sessions where user_id = $1::uuid and id <> $2::uuid', [staff.userId, authSessionId]);

    const csrfToken = randomBytes(32).toString('hex');
    const inserted = await db.query(
      `insert into public.sessions (user_id, refresh_token_hash, csrf_token_hash, auth_session_id, expires_at, last_seen_at)
       values ($1::uuid, $2, $3, $4::uuid, now() + interval '7 days', now())`,
      [staff.userId, sha256Hex(session.refresh_token), sha256Hex(csrfToken), authSessionId],
    );
    if (inserted.rowCount !== 1) throw new Error('結び付けた sessions の行を作れない');

    const expires = Math.floor(Date.now() / 1000) + csrfCookieMaxAgeSeconds;
    const make = (name: string, value: string, httpOnly: boolean): BrowserCookie => ({
      name,
      value,
      url: APP_ORIGIN,
      httpOnly,
      sameSite: 'Lax',
      expires,
    });
    cookies = [
      make(accessCookieName, session.access_token, cookieOptionsForAccess(csrfCookieMaxAgeSeconds).httpOnly),
      make(refreshCookieName, session.refresh_token, cookieOptionsForRefresh(csrfCookieMaxAgeSeconds).httpOnly),
      make(csrfCookieName, csrfToken, cookieOptionsForCsrf(csrfCookieMaxAgeSeconds).httpOnly),
    ];
  } finally {
    await db.end();
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

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // 失敗の文面は、共有の道具が status・code だけにしてある。JWT・鍵は出さない
    console.error(error instanceof Error ? error.message : '店員として入る用意に失敗した');
    process.exitCode = 1;
  });
}
