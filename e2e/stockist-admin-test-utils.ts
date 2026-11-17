/**
 * 取扱店の管理画面（FR-STOCKIST-013）の E2E の道具。管理の入口を通る店長・サポーター（認めたパスキー2本の店員）と、試験用の店の行を作る。
 *
 * 管理の入口はパスキーのログイン＋認めたパスキー2本以上（SR-AUTH-014）で、アプリの画面からは店員が入れない（1b でパスキーの画面ができるまで。
 * SEC-AUTH-040）。そこで共有の道具 createAdminSessionActor（provisionStaff → パスキーのログイン → アプリの sessions に結び付ける）で
 * 店員の JWT を作り、その access・refresh token を Cookie に置く。窓口の認可・管理の入口の判定は差し替えない。
 *
 * この道具を呼ぶ spec は、ファイルの最上位に `test.use({ trace: 'off' })` が必須（member-session-helpers.ts と同じ理由）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Locator, Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor } from './admin-session-test-utils';
import type { TestMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { skipPasskeyNotificationsOfUser } from '../scripts/e2e/passkey-staff';

export type StaffRole = 'admin' | 'supporter';

function localAuthAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('店長・サポーターを作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * 試験ごとに別の送り元として数えさせる値（見出しの無い要求が集まる ip null の 1 つの枠を使い切らない）。
 * 回数の制限と監査の IP は x-real-ip を送り元に数える（src/lib/request-ip.ts の getClientIp。E2E の固定の環境の
 * CLIENT_IP_HEADER=x-real-ip で有効になる。x-forwarded-for は読まない。SEC-AUTH-013）。
 */
function randomSourceIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

/**
 * 管理の入口を通る店長・サポーター（認めたパスキー2本。古い名前の aal2）として、この page に Cookie を置く。終わったら removeStaff で消す。
 * label は呼び手の区別のための印（メールには入らない。互換のために残した引数）。
 */
export async function loginAsStaffAal2(page: Page, role: StaffRole, label: string): Promise<TestMember> {
  void label;
  const actor = await withLocalDb((db) => createAdminSessionActor(db, role, 'aal2'));
  const sourceIp = randomSourceIp();
  // 以後のブラウザの要求（画面が撃つ /api/auth/refresh と、管理 API の変更の枠 20 回/600 秒）もこの送り元で数える。
  // 付けないと、FR-STOCKIST-013 の 3 つの幅の変更（1 つの幅で作成 2・更新 2・切り替え 2・削除 2 の 8 回、計 24 回）が
  // ip null の 1 つの枠（20 回）を使い切り、最後の幅（desktop）の更新・削除が 429 で落ちる。
  await page.setExtraHTTPHeaders({ 'x-real-ip': sourceIp });
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  if (!isLocalUrl(origin)) throw new Error('ブラウザへのログインは手元のアプリだけ');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: 'sb-access-token', value: actor.accessToken, url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-refresh-token', value: actor.refreshToken, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
  const me = await page.request.get(new URL('/api/auth/me', origin).toString(), {
    headers: { 'x-real-ip': sourceIp },
    maxRedirects: 0,
  });
  const body = (await me.json().catch(() => ({}))) as {
    authenticated?: boolean;
    user?: { id?: string; role?: string; mfaVerified?: boolean };
  };
  if (body.authenticated !== true || body.user?.id !== actor.userId || body.user.role !== role || body.user.mfaVerified !== true) {
    throw new Error(`${role} の管理の入口を通るログインになっていない`);
  }
  return { userId: actor.userId, email: actor.email };
}

/** 試験用の店長・サポーターを消す。消せなくても試験の結果は変えない（db reset で消える） */
export async function removeStaff(member: TestMember): Promise<void> {
  await localAuthAdmin().auth.admin.deleteUser(member.userId).catch(() => undefined);
  // 消した鍵の知らせの行（店長あて）を、定期処理に送らせない
  await skipPasskeyNotificationsOfUser(member.userId);
}

/** 試験用の取扱店の行（type は DB の NOT NULL の列なので入れる）。名前は E2E-STK- で始める */
export async function insertStockist(
  db: PgClient,
  input: { name: string; status: 'published' | 'private' },
): Promise<number> {
  if (!input.name.startsWith('E2E-STK-')) throw new Error('試験用の店の名前は E2E-STK- で始める');
  const res = await db.query(
    `insert into public.stockists (type, name, address, phone, time, holiday, status)
     values ('STORE', $1, $2, $3, $4, $5, $6) returning id`,
    [input.name, '東京都港区E2E 1-2-3', '03-0000-0000', '11:00-19:00', '水曜日', input.status],
  );
  return Number(res.rows[0].id);
}

/** この試験の名前の頭で始まる行を全部消す（画面から作った行・名前を直した行も含む） */
export async function deleteStockistsByPrefix(db: PgClient, prefix: string): Promise<void> {
  if (!prefix.startsWith('E2E-STK-')) throw new Error('消せるのは E2E-STK- で始まる店だけ');
  await db.query(`delete from public.stockists where name like $1 || '%'`, [prefix]);
}

/** 管理の STOCKIST タブ（と公開の /stockist）で、その名前の店のカード */
export function stockistCard(page: Page, name: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}
