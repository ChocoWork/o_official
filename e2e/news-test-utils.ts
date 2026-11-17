/**
 * NEWS（お知らせ）の管理の窓口（/api/admin/news）を HTTP で確かめる E2E の道具。手元の Supabase だけで使う。
 *
 * 管理の入口はパスキーのログイン＋認めたパスキー2本以上（SR-AUTH-014）なので、次の道で token を得る。
 * 1. 利用者を作り（パスワード無し）、パスキーを1本登録して認め（scripts/e2e/passkey-staff.ts の provisionPasskeyUser）、
 *    試験用の役割を DB へ割り当てる（権限は役割の ACL で決まる）。この間は認めたパスキー1本（古い名前の aal1）。
 * 2. 本物の GoTrue にパスキーでログインして access token を得る。
 * 3. 古い名前の aal2 が要る時（elevateWith）は、同じ session で2本目を登録して認める（elevateAdminSessionToAal2 と同じ。認めたパスキー2本）。
 * 窓口の認可は token の署名・session の生存・DB の ACL・パスキーの条件を本物のまま確かめる（差し替えない）。
 * 通行証は既定でアプリの sessions に結び付ける（signInWithPassword の bindApp。DD-AUTH-039）。
 * 関数の名前 signInWithPassword と AdminUser.password は、呼び手を変えないために残す（中身はパスキー。password は空）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import { addApprovedPasskey, loginWithPasskey, provisionPasskeyUser, skipPasskeyNotificationsOfUser } from '../scripts/e2e/passkey-staff';
import { bindAppSession } from './admin-session-test-utils';
import type { SoftAuthenticator } from './passkey-soft-authenticator';
import { withLocalDb } from './order-email-test-utils';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } };

/** 片づけの一覧。後に登録したものから先に流す */
export type Cleanups = Array<() => Promise<void>>;

export type NewsRow = { id: number; title: string };
export type AdminUser = { userId: string; email: string; password: string; authenticators: SoftAuthenticator[] };
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

/** メール → 認証器。signInWithPassword が、createAdminWithPermissions で作った利用者のパスキーを引くための控え */
const authenticatorsByEmail = new Map<string, SoftAuthenticator[]>();

/**
 * 与えた権限だけを持つ試験用の役割を作り、パスキー1本の利用者へ割り当てる。
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
  const provisioned = await provisionPasskeyUser(db, { approvedPasskeys: 1, email, appRole });
  const userId = provisioned.userId;
  authenticatorsByEmail.set(email, provisioned.authenticators);
  cleanups.push(async () => {
    // public.user_roles は利用者の削除で連鎖して消える
    const removed = await admin.auth.admin.deleteUser(userId);
    // 利用者の削除で鍵が消える時の引き金が積む知らせの行（店長あて）を、定期処理に送らせない
    await skipPasskeyNotificationsOfUser(userId).catch(() => console.warn('知らせの行を取り下げられなかった（試験の結果は変えない）'));
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
  return { userId, email, password: '', authenticators: provisioned.authenticators };
}

/**
 * 本物の GoTrue にパスキーでログインして access token を得る（認めたパスキー1本。古い名前の aal1）。password は使わない（呼び手を変えないために残した引数）。
 * elevateWith に DB の接続を渡すと、同じ session で2本目のパスキーを登録して認め、refresh して認めたパスキー2本の token を得る（古い名前の aal2）。
 * 返す aal は、JWT の aal クレームではなく、頼んだ側の名前（elevateWith あり → aal2）。
 */
export async function signInWithPassword(
  email: string,
  _password: string,
  options: { elevateWith?: PgClient; bindApp?: boolean } = {},
): Promise<SignedInSession> {
  requireLocalEnv();
  const authenticators = authenticatorsByEmail.get(email);
  if (!authenticators?.[0]) throw new Error('この利用者のパスキーの控えが無い（createAdminWithPermissions で作った利用者だけ）');
  const { session: loggedIn } = await loginWithPasskey({ email, authenticator: authenticators[0] });
  let session = loggedIn;
  const userId = session.user?.id ?? '';
  if (options.elevateWith) {
    const db = options.elevateWith;
    const added = await addApprovedPasskey(db, { userId, accessToken: session.access_token, refreshToken: session.refresh_token });
    authenticators.push(added.authenticator);
    session = added.session;
    // 独自の役割（admin・supporter 以外）には hook が staff_passkeys_ok を付けないので、JWT の印ではなく DB で数えた認めた本数を見る
    const counted = await db.query('select public.passkey_approved_count($1::uuid) as n', [userId]);
    if (Number(counted.rows[0]?.n) !== 2) throw new Error('2本目の後に DB で数えた認めたパスキーが2本ではない');
  }
  // アプリの sessions に結び付ける（DD-AUTH-039）。アプリは結び付かない session の通行証を 401 にする。
  // 結び付けない通行証（攻撃側の対照）は bindApp: false。行を作る処理は admin-session-test-utils の bindAppSession に 1 つだけ置く
  if (options.bindApp ?? true) {
    const binding = { userId, accessToken: session.access_token, refreshToken: session.refresh_token };
    if (options.elevateWith) await bindAppSession(options.elevateWith, binding);
    else await withLocalDb((db) => bindAppSession(db, binding));
  }
  return { accessToken: session.access_token, aal: options.elevateWith ? 'aal2' : 'aal1' };
}
