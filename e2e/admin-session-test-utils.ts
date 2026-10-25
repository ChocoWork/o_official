/**
 * 管理 API の E2E の道具。本物の管理者の JWT（店長・サポーター、aal1・aal2）を手元の Supabase で作る。
 *
 * 手元の Supabase は2要素（TOTP）が無効なので、管理画面のログインは通れない。代わりに次の道を使う。
 * 1. auth.admin.createUser で利用者を作り、有効な user_roles（DB の ACL）を同じ役割で付ける
 * 2. 手元の Auth のパスワードのログインで session と aal1 の JWT を得る（アプリの OTP・Turnstile は通らない）
 * 3. aal2 が要る時は、その session の auth.mfa_amr_claims に totp の行を足して refresh する。
 *    Auth は session の amr から aal を数えるので、refresh で返る JWT が aal2 になる
 *    （auth.sessions の aal 列だけを書き換えても JWT は aal1 のまま）
 * 管理 API は Authorization: Bearer の JWT をそのまま読むので、Cookie もアプリのログインも要らない。
 * 作った利用者・session は消さない（db reset で消える）。JWT・パスワードは失敗の文面に出さない。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type Session } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';

/** 'user' は管理の役割を持たない一般の利用者（user_roles の行はある。管理 API が断ることを見せるための対照） */
export type AdminSessionRole = 'admin' | 'supporter' | 'user';
export type AdminSessionAal = 'aal1' | 'aal2';

export type AdminSessionActor = {
  userId: string;
  email: string;
  role: AdminSessionRole;
  aal: AdminSessionAal;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** accessToken の期限（UNIX 秒） */
  expiresAt: number;
};

type LocalAuthEnv = { url: string; anonKey: string; serviceRoleKey: string };

function localAuthEnv(): LocalAuthEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey || !isLocalUrl(url)) {
    throw new Error('管理者の JWT を作れるのは手元の Supabase だけ');
  }
  return { url, anonKey, serviceRoleKey };
}

type JwtClaims = { aal?: string; session_id?: string; sub?: string; exp?: number };

function readClaims(token: string): JwtClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT の形が正しくない');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
}

type TokenReply = { access_token?: string; refresh_token?: string };

/**
 * 呼ぶごとに別の送り元として数えさせる値。Auth（GoTrue）の回数の制限は送り元ごとに数える（supabase/config.toml の [auth.rate_limit]）ので、
 * 全部の E2E が共有する 1 つの送り元の枠を使い切らないよう x-forwarded-for を付ける。
 * これは x-forwarded-for を送り元に数える作りに頼る分離で、その作りが変わる（SEC-*-006 の食い違いが直る・Kong が値を捨てる）と効かなくなる。
 * その時は枠を数え直す仕組みか手元だけ緩い上限に替える。値が使われなくても害は無い。
 */
function uniqueSourceIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

async function requestToken(env: LocalAuthEnv, grantType: 'password' | 'refresh_token', body: Record<string, string>): Promise<Required<TokenReply>> {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: env.anonKey, 'content-type': 'application/json', 'x-forwarded-for': uniqueSourceIp() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(`手元の Auth の ${grantType} の要求に失敗した`);
  });
  if (!res.ok) throw new Error(`手元の Auth の ${grantType} が通らない: ${res.status}`);
  const reply = (await res.json().catch(() => ({}))) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) throw new Error(`手元の Auth の ${grantType} の応答に token が無い`);
  return { access_token: reply.access_token, refresh_token: reply.refresh_token };
}

/** session に totp の確認済みの印（amr の行）を足し、refresh で aal2 の JWT を出させる */
async function raiseSessionToAal2(db: PgClient, env: LocalAuthEnv, sessionId: string, refreshToken: string): Promise<Required<TokenReply>> {
  await db.query(
    `insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
     values (gen_random_uuid(), $1::uuid, now(), now(), 'totp')`,
    [sessionId],
  );
  return requestToken(env, 'refresh_token', { refresh_token: refreshToken });
}

/**
 * 役割つきの利用者を作り、その session の JWT を返す。
 * auth.users の role（app_metadata）と有効な user_roles（active・期限なし）を同じ役割で作る（createPermissionActor と同じ）。
 */
export async function createAdminSessionActor(db: PgClient, role: AdminSessionRole, aal: AdminSessionAal): Promise<AdminSessionActor> {
  const env = localAuthEnv();
  const email = `e2e-admin-session-${role}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;

  const admin = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const created = await admin.auth.admin
    .createUser({ email, password, email_confirm: true, app_metadata: { role } })
    .catch(() => {
      throw new Error('手元の管理者を作る要求に失敗した');
    });
  if (created.error || !created.data.user) {
    throw new Error(`手元の管理者を作れない（status: ${created.error?.status ?? '不明'}, code: ${created.error?.code ?? '不明'}）`);
  }
  const userId = created.data.user.id;

  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = $2`,
    [userId, role],
  );
  if (assigned.rowCount !== 1) throw new Error(`役割 ${role} の行が手元の DB に無い`);

  let tokens = await requestToken(env, 'password', { email, password });
  const sessionId = readClaims(tokens.access_token).session_id;
  if (!sessionId) throw new Error('JWT に session_id が無い');

  if (aal === 'aal2') tokens = await raiseSessionToAal2(db, env, sessionId, tokens.refresh_token);

  const claims = readClaims(tokens.access_token);
  if (claims.sub !== userId || claims.session_id !== sessionId) throw new Error('作った JWT の利用者か session が合わない');
  if (claims.aal !== aal) throw new Error(`作った JWT の aal が ${aal} ではない（${claims.aal ?? '無し'}）`);
  if (!claims.exp) throw new Error('JWT に exp が無い');
  return { userId, email, role, aal, sessionId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: claims.exp };
}

/**
 * aal1 の利用者の同じ session を aal2 に上げ、aal2 の JWT を持つ利用者を返す（同じ人の aal1・aal2 の JWT を並べたい時に使う）。
 * 先に出した aal1 の JWT は、期限まで aal1 のクレームのまま使える。
 */
export async function elevateAdminSessionToAal2(db: PgClient, actor: AdminSessionActor): Promise<AdminSessionActor> {
  if (actor.aal !== 'aal1') throw new Error('aal1 の利用者だけを aal2 に上げられる');
  const env = localAuthEnv();
  const tokens = await raiseSessionToAal2(db, env, actor.sessionId, actor.refreshToken);
  const claims = readClaims(tokens.access_token);
  if (claims.sub !== actor.userId || claims.session_id !== actor.sessionId) throw new Error('上げた JWT の利用者か session が合わない');
  if (claims.aal !== 'aal2' || !claims.exp) throw new Error(`上げた JWT の aal が aal2 ではない（${claims.aal ?? '無し'}）`);
  return { ...actor, aal: 'aal2', accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: claims.exp };
}

/** 2要素の登録（検証済みの totp）を1件足す。強制失効・MFA のリセットが「消さなかった」ことを数えるための材料 */
export async function seedVerifiedMfaFactor(db: PgClient, userId: string): Promise<void> {
  await db.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1::uuid, 'e2e-admin-session', 'totp', 'verified', now(), now(), 'e2e-not-a-real-secret')`,
    [userId],
  );
}

/** アプリ側の sessions 表に、まだ失効していない行を1件足す（強制失効が revoked_at を入れないことを数えるための材料） */
export async function seedAppSession(db: PgClient, userId: string): Promise<void> {
  await db.query(
    `insert into public.sessions (user_id, refresh_token_hash) values ($1::uuid, $2)`,
    [userId, `e2e-${randomBytes(8).toString('hex')}`],
  );
}

/**
 * 役割つきの利用者の JWT から、supabase-js の session 全体（access_token・refresh_token・user）を作る。
 * 画面の Cookie（sb-<ref>-auth-token）に載せる時に使う。user は手元の Auth に JWT で問い合わせて得る。
 */
export async function toSupabaseSession(actor: AdminSessionActor): Promise<Session> {
  const env = localAuthEnv();
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(actor.accessToken);
  if (error || !data.user || data.user.id !== actor.userId) {
    throw new Error(`作った JWT の利用者を手元の Auth から読めない（status: ${error?.status ?? '不明'}）`);
  }
  return {
    access_token: actor.accessToken,
    refresh_token: actor.refreshToken,
    token_type: 'bearer',
    expires_in: Math.max(actor.expiresAt - Math.floor(Date.now() / 1000), 0),
    expires_at: actor.expiresAt,
    user: data.user,
  };
}

export function bearerHeaders(actor: AdminSessionActor): Record<string, string> {
  return { authorization: `Bearer ${actor.accessToken}` };
}
