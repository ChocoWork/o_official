/**
 * FR-LOGIN-040（GoTrue のフックの拒否と更新）の場面を、画面を開かずに手元の Supabase の GoTrue へ直に当てる道具。手元の Supabase だけ。
 *
 * 各関数は、起きたこと（status・message・JWT のクレーム・行の数）を値で返すだけで、expect は spec が行う。
 * 店員の用意・パスキーのログインは scripts/e2e/passkey-staff.ts、店員のメールのコードは受け箱（Mailpit）の8桁のコード。
 * JWT・鍵・パスワード・token は失敗の文面に出さない。作った利用者・session は消さない（db reset で消える）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import { loginWithPasskey, provisionPasskeyUser } from '../scripts/e2e/passkey-staff';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bindAppSession, createAdminSessionActor } from './admin-session-test-utils';
import { withDummyCaptcha } from './captcha-test-utils';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';

type LocalEnv = { url: string; anonKey: string; serviceKey: string };

function localEnv(): LocalEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !anonKey || !serviceKey || !isLocalUrl(url)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
  return { url, anonKey, serviceKey };
}

/** Auth の回数の制限は送り元ごとに数える。呼ぶごとに別の送り元にする（admin-session-test-utils と同じ） */
function sourceIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

function client(key: string): SupabaseClient {
  return createClient(localEnv().url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-forwarded-for': sourceIp() } },
  });
}

export type JwtClaims = {
  sub?: string;
  aal?: string;
  session_id?: string;
  amr?: Array<{ method?: string; timestamp?: number }>;
  staff_passkeys_ok?: boolean;
};

export function claimsOf(accessToken: string): JwtClaims {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as JwtClaims;
}

export type TokenResult = {
  status: number;
  /** GoTrue の誤りの message（成功なら無い） */
  message?: string;
  accessToken?: string;
  refreshToken?: string;
};

async function postToken(path: string, body: Record<string, unknown>): Promise<TokenResult> {
  const env = localEnv();
  const response = await fetch(`${env.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: env.anonKey, 'content-type': 'application/json', 'x-forwarded-for': sourceIp() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    message?: string;
    msg?: string;
  };
  return {
    status: response.status,
    message: response.ok ? undefined : (reply.message ?? reply.msg),
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token,
  };
}

/** メールのコードでログインする（/auth/v1/otp → 受け箱の8桁 → /auth/v1/verify）。拒否も status・message で返す */
export async function signInWithEmailCode(email: string): Promise<TokenResult> {
  // 同じ利用者へのメールは GoTrue が最小の間隔（手元は auth.email.max_frequency = 1s）を空けないと 429 で断る。用意の magiclink の直後に呼ばれるので待つ
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const previous = new Set((await readMailpitMessages(email)).map((message) => message.ID));
  const sent = await postToken('otp', withDummyCaptcha({ email, create_user: false }));
  if (sent.status >= 400) return sent;
  const code = await readLatestCode(email, previous);
  return postToken('verify', { type: 'email', email, token: code });
}

/** パスワードでログインする。拒否も status・message で返す */
export function signInWithPasswordGrant(email: string, password: string): Promise<TokenResult> {
  return postToken('token?grant_type=password', withDummyCaptcha({ email, password }));
}

/** 更新（token_refresh）。拒否も status・message で返す */
export function refreshWith(refreshToken: string): Promise<TokenResult> {
  return postToken('token?grant_type=refresh_token', { refresh_token: refreshToken });
}

/** パスキーでログインし、トークンの中身を返す */
export async function passkeyLogin(email: string, authenticator: Parameters<typeof loginWithPasskey>[0]['authenticator']): Promise<TokenResult & { claims: JwtClaims }> {
  const { session } = await loginWithPasskey({ email, authenticator });
  return { status: 200, accessToken: session.access_token, refreshToken: session.refresh_token, claims: claimsOf(session.access_token) };
}

/** 役割の無い（お客さんの）利用者をパスワード付きで作る */
export async function createCustomerWithPassword(): Promise<{ userId: string; email: string; password: string }> {
  const env = localEnv();
  const email = `e2e-hook-customer-${randomUUID().slice(0, 8)}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const created = await client(env.serviceKey).auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`お客さんを作れない（status: ${created.error?.status ?? '不明'}）`);
  return { userId: created.data.user.id, email, password };
}

/** 店員にパスワードを付ける（パスワードのログインが拒否されることを確かめるため） */
export async function setStaffPassword(userId: string): Promise<string> {
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const updated = await client(localEnv().serviceKey).auth.admin.updateUserById(userId, { password });
  if (updated.error) throw new Error(`店員にパスワードを付けられない（status: ${updated.error.status ?? '不明'}）`);
  return password;
}

/** 窓を使って、役割の無い間にメールのコードで入った session を、役割を付けた後の更新で通し、窓を閉じた後の更新で拒否させる（案 B の順） */
export type WindowScenario = {
  userId: string;
  email: string;
  sessionId: string;
  /** ④ 窓が開いている間の更新 */
  refreshInsideWindow: TokenResult;
  /** ⑥ 窓を閉じた後の更新 */
  refreshAfterClose: TokenResult;
  /** ⑥ 同じ更新トークンをもう一度送った結果 */
  refreshAfterCloseAgain: TokenResult;
  /** ⑥ の後も auth.sessions の行が残っているか */
  sessionRowRemains: boolean;
  /** 拒否された後に、④ で得た前のアクセストークンで /auth/v1/user を呼んだ status */
  oldTokenUserStatus: number;
  /** 同じトークンで /rest/v1 の管理の表（非公開の記事）を読んだ時の行の数 */
  oldTokenAdminRows: number;
  /** 同じ古いトークンをアプリの sessions に結び付けた後の行の数（断る理由が amr だけの時も0） */
  oldTokenBoundAdminRows: number;
  /** 対照: パスキーでログインした認めた2本の店長が同じ行を読めた数（1以上） */
  controlAdminRows: number;
  /** auth.sessions.not_after の値（記録のため） */
  sessionNotAfter: string | null;
};

export async function runWindowScenario(db: PgClient): Promise<WindowScenario> {
  const env = localEnv();
  // ① 役割の無い間にメールのコードで入る（session_id が分かる）
  const provisioned = await provisionPasskeyUser(db, { approvedPasskeys: 2 });
  const first = await signInWithEmailCode(provisioned.email);
  if (!first.accessToken || !first.refreshToken) throw new Error(`役割の無い間のメールのコードのログインに失敗した（status: ${first.status}）`);
  const sessionId = claimsOf(first.accessToken).session_id;
  if (!sessionId) throw new Error('JWT に session_id が無い');

  // ② 窓を開ける ③ 役割を有効にする
  await db.query('select public.passkey_window_open($1::uuid, $2::uuid)', [provisioned.userId, sessionId]);
  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = 'admin'`,
    [provisioned.userId],
  );
  if (assigned.rowCount !== 1) throw new Error('役割 admin の行が手元の DB に無い');

  // ④ 窓が開いている間は更新が通る
  const inside = await refreshWith(first.refreshToken);
  if (!inside.accessToken || !inside.refreshToken) throw new Error(`窓の中の更新が通らない（status: ${inside.status}）`);

  // ⑤ 窓を閉じる ⑥ 更新が拒否される（同じ更新トークンでも同じ拒否）
  await db.query('select public.passkey_window_close($1::uuid)', [sessionId]);
  const afterClose = await refreshWith(inside.refreshToken);
  const afterCloseAgain = await refreshWith(inside.refreshToken);
  const remains = await db.query('select count(*)::int as n, max(not_after)::text as not_after from auth.sessions where id = $1::uuid', [sessionId]);

  // ⑦ 拒否の後、前のアクセストークンで /auth/v1/user と /rest/v1 を呼ぶ
  const userResponse = await fetch(`${env.url}/auth/v1/user`, {
    headers: { apikey: env.anonKey, authorization: `Bearer ${inside.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const marker = `e2e-hook-private-${randomUUID()}`;
  const news = await db.query(
    `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
     values ($1, 'EVENT', '2000-01-01', 'news/e2e/placeholder.jpg', 'c', 'd', 'private') returning id::text as id`,
    [marker],
  );
  try {
    const rest = await fetch(`${env.url}/rest/v1/news_articles?select=id&id=eq.${news.rows[0].id}`, {
      headers: { apikey: env.anonKey, authorization: `Bearer ${inside.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const rows = (await rest.json().catch(() => [])) as unknown[];

    // 0行がパスキーの amr の門で断られた結果だと言えるよう、他の条件を揃える。
    // (1) 古い通行証（メールのコードの amr）をアプリの sessions に結び付ける（役割・認めた2本・session の生存は揃っている）。残る断りの理由は amr だけ
    await bindAppSession(db, { userId: provisioned.userId, accessToken: inside.accessToken, refreshToken: inside.refreshToken });
    const boundRest = await fetch(`${env.url}/rest/v1/news_articles?select=id&id=eq.${news.rows[0].id}`, {
      headers: { apikey: env.anonKey, authorization: `Bearer ${inside.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const boundRows = (await boundRest.json().catch(() => [])) as unknown[];
    // (2) 対照: パスキーでログインした認めた2本の店長（アプリの sessions に結び付き済み）は同じ行が読める
    const control = await createAdminSessionActor(db, 'admin', 'aal2');
    const controlRest = await fetch(`${env.url}/rest/v1/news_articles?select=id&id=eq.${news.rows[0].id}`, {
      headers: { apikey: env.anonKey, authorization: `Bearer ${control.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const controlRows = (await controlRest.json().catch(() => [])) as unknown[];
    return {
      userId: provisioned.userId,
      email: provisioned.email,
      sessionId,
      refreshInsideWindow: inside,
      refreshAfterClose: afterClose,
      refreshAfterCloseAgain: afterCloseAgain,
      sessionRowRemains: remains.rows[0].n === 1,
      oldTokenUserStatus: userResponse.status,
      oldTokenAdminRows: Array.isArray(rows) ? rows.length : -1,
      oldTokenBoundAdminRows: Array.isArray(boundRows) ? boundRows.length : -1,
      controlAdminRows: Array.isArray(controlRows) ? controlRows.length : -1,
      sessionNotAfter: remains.rows[0].not_after as string | null,
    };
  } finally {
    await db.query('delete from public.news_articles where id = $1::bigint', [news.rows[0].id]);
  }
}

/** 店員に認めた鍵を GoTrue の auth.passkey.delete で1本消す（更新を待たない確かめ用）。消した鍵の数を返す */
export async function deleteOnePasskeyViaGoTrue(input: { accessToken: string; refreshToken: string }): Promise<number> {
  const env = localEnv();
  const user = client(env.anonKey);
  const set = await user.auth.setSession({ access_token: input.accessToken, refresh_token: input.refreshToken });
  if (set.error) throw new Error(`session の読み込みに失敗した（status: ${set.error.status ?? '不明'}）`);
  const listed = await user.auth.passkey.list();
  const first = listed.data?.[0];
  if (listed.error || !first) throw new Error('パスキーの一覧を読めない');
  const removed = await user.auth.passkey.delete({ passkeyId: first.id });
  if (removed.error) throw new Error(`パスキーを消せない（status: ${removed.error.status ?? '不明'}）`);
  return 1;
}
