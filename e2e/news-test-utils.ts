/**
 * NEWS（お知らせ）の管理の窓口（/api/admin/news）を HTTP で確かめる E2E の道具。手元の Supabase だけで使う。
 *
 * 本物の管理者のログイン（2段階認証が要る）は E2E の道具に無いので、次の道で token を得る。
 * 1. service role で利用者を作り（パスワード付き）、試験用の役割を DB へ割り当てる（権限は役割の ACL で決まる）。
 * 2. 本物の GoTrue にパスワードでログインして aal1 の access token を得る。
 * 3. aal2 が要る時は、その session の auth.mfa_amr_claims に totp の行を足してから refresh し、
 *    GoTrue に aal2 の token を発行させる（署名は本物の GoTrue の鍵）。
 * 窓口の認可は token の署名・session の生存・DB の ACL・aal を本物のまま確かめる（差し替えない）。
 * 通行証は既定でアプリの sessions に結び付ける（signInWithPassword の bindApp。DD-AUTH-039）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import { bindAppSession } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } };

/** 片づけの一覧。後に登録したものから先に流す */
export type Cleanups = Array<() => Promise<void>>;

export type NewsRow = { id: number; title: string };
export type AdminUser = { userId: string; email: string; password: string };
export type SignedInSession = { accessToken: string; aal: string };

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

/** 手元の Supabase の service role の client（RLS を通さない。試験の準備と確かめだけに使う） */
export function localAdmin(): SupabaseClient {
  requireLocalEnv();
  return createClient(SUPABASE_URL, SERVICE_KEY, AUTH_OPTIONS);
}

/** 片づけを、登録の逆順に全部流す。1つ失敗しても残りは流し、最初の失敗を投げる */
export async function runCleanups(cleanups: Cleanups): Promise<void> {
  let failure: unknown = null;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/** 記事を1件、service role で作る（既定は private）。終わりに消す片づけを登録する */
export async function createNewsRow(
  admin: SupabaseClient,
  cleanups: Cleanups,
  label: string,
  status: 'private' | 'published' = 'private',
): Promise<NewsRow> {
  const title = `E2E-NEWS-SEC-${label}-${randomUUID()}`;
  const inserted = await admin
    .from('news_articles')
    .insert({
      title,
      category: 'EVENT',
      published_date: '2000-01-01',
      image_url: 'news/e2e/placeholder.jpg',
      content: `${title} 概要`,
      detailed_content: `${title} 本文`,
      status,
    })
    .select('id')
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(`手元の記事を作れない（${inserted.error?.message ?? '不明'}）`);
  }
  const id = Number(inserted.data.id);
  cleanups.push(async () => {
    const removed = await admin.from('news_articles').delete().eq('id', id);
    if (removed.error) throw new Error(`手元の記事を消せない（${removed.error.message}）`);
  });
  return { id, title };
}

/** 記事の行を全列読む（updated_at まで比べて「行が変わらない」を確かめる）。無ければ null */
export async function readNewsRow(admin: SupabaseClient, id: number): Promise<Record<string, unknown> | null> {
  const result = await admin.from('news_articles').select('*').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`手元の記事を読めない（${result.error.message}）`);
  return result.data;
}

/**
 * 与えた権限だけを持つ試験用の役割を作り、パスワード付きの利用者へ割り当てる。
 * 権限は役割の ACL（user_roles → role_permissions → permissions）で決まる。終わりに利用者と役割を消す片づけを登録する。
 */
export async function createAdminWithPermissions(
  db: PgClient,
  admin: SupabaseClient,
  cleanups: Cleanups,
  label: string,
  permissions: readonly PermissionCode[],
  appRole?: 'admin' | 'supporter',
): Promise<AdminUser> {
  const email = `e2e-news-${label}-${randomBytes(6).toString('hex')}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ...(appRole ? { app_metadata: { role: appRole } } : {}),
  });
  if (created.error || !created.data.user) {
    throw new Error(`手元の利用者を作れない（status: ${created.error?.status ?? '不明'}）`);
  }
  const userId = created.data.user.id;
  cleanups.push(async () => {
    // public.user_roles は利用者の削除で連鎖して消える
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error) throw new Error(`手元の利用者を消せない（status: ${removed.error.status ?? '不明'}）`);
  });

  const role = await db.query(
    'insert into public.roles (code, name) values ($1, $2) returning id',
    [`e2e-news-${label}-${randomBytes(6).toString('hex')}`, `E2E NEWS ${label}`],
  );
  const roleId: number = role.rows[0].id;
  cleanups.push(async () => {
    await db.query('delete from public.user_roles where role_id = $1', [roleId]);
    await db.query('delete from public.role_permissions where role_id = $1', [roleId]);
    await db.query('delete from public.roles where id = $1', [roleId]);
  });
  const granted = await db.query(
    `insert into public.role_permissions (role_id, permission_id)
     select $1, p.id from public.permissions p where p.code = any($2::text[])`,
    [roleId, [...permissions]],
  );
  if (granted.rowCount !== permissions.length) {
    throw new Error(`権限 ${permissions.join('・')} の行が手元の DB に足りない`);
  }
  await db.query(
    'insert into public.user_roles (user_id, role_id, active, expires_at) values ($1::uuid, $2, true, null)',
    [userId, roleId],
  );
  return { userId, email, password };
}

function decodeClaims(accessToken: string): { aal?: string; session_id?: string } {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
}

/**
 * 本物の GoTrue にパスワードでログインして access token を得る（aal1）。
 * elevateWith に DB の接続を渡すと、session を DB で aal2 に整えて refresh し、aal2 の token を得る。
 */
export async function signInWithPassword(
  email: string,
  password: string,
  options: { elevateWith?: PgClient; bindApp?: boolean } = {},
): Promise<SignedInSession> {
  requireLocalEnv();
  // Auth の回数の制限を他の試験と取り合わないよう、この呼び出しだけの送り元（x-forwarded-for）を付ける。
  // x-forwarded-for を送り元に数える作りに頼る分離で、その作りが変わる（SEC-*-006 の食い違いが直る）と効かなくなる。値が使われなくても害は無い。
  const [a, b, c] = randomBytes(3);
  const gotrue = createClient(SUPABASE_URL, ANON_KEY, { ...AUTH_OPTIONS, global: { headers: { 'x-forwarded-for': `10.${a}.${b}.${c}` } } });
  const signedIn = await gotrue.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`手元の利用者でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
  }
  let session = signedIn.data.session;
  if (options.elevateWith) {
    const sessionId = decodeClaims(session.access_token).session_id;
    if (!sessionId) throw new Error('access token に session_id が無い');
    await options.elevateWith.query(
      `insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
       values ($1::uuid, now(), now(), 'totp', gen_random_uuid())`,
      [sessionId],
    );
    const refreshed = await gotrue.auth.refreshSession({ refresh_token: session.refresh_token });
    if (refreshed.error || !refreshed.data.session) {
      throw new Error(`aal2 の token を発行させられない（status: ${refreshed.error?.status ?? '不明'}）`);
    }
    session = refreshed.data.session;
    if (decodeClaims(session.access_token).aal !== 'aal2') throw new Error('refresh した token の aal が aal2 ではない');
  }
  // アプリの sessions に結び付ける（DD-AUTH-039）。アプリは結び付かない session の通行証を 401 にする。
  // 結び付けない通行証（攻撃側の対照）は bindApp: false。行を作る処理は admin-session-test-utils の bindAppSession に 1 つだけ置く
  if (options.bindApp ?? true) {
    const binding = { userId: signedIn.data.user?.id ?? '', accessToken: session.access_token, refreshToken: session.refresh_token };
    if (options.elevateWith) await bindAppSession(options.elevateWith, binding);
    else await withLocalDb((db) => bindAppSession(db, binding));
  }
  return { accessToken: session.access_token, aal: decodeClaims(session.access_token).aal ?? '不明' };
}
