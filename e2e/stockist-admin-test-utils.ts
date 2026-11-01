/**
 * 取扱店の管理画面（FR-STOCKIST-013）の E2E の道具。本物の aal2 の店長・サポーターと、試験用の店の行を作る。
 *
 * ログインは本物の道を通す: 会員の作成（GoTrue） → 確認コードのログイン（/api/auth/login/resend・/api/auth/otp/verify）
 * → aal2 への昇格（下記） → /api/auth/refresh で aal2 のトークンを Cookie に受ける。窓口の認可・MFA の判定は差し替えない。
 *
 * aal2 への昇格だけは、本物の TOTP（/api/auth/mfa/enroll-totp・/api/auth/mfa/verify）を通さない。本物の流れは FR-LOGIN-032 が通す
 * （手元の Supabase は波 6 から supabase/config.toml の [auth.mfa.totp] を有効にしている）。
 * そこで、GoTrue が aal2 を数える根拠（auth.mfa_amr_claims に authentication_method = 'totp' の行がある session）を DB へ直に足し、
 * 本物の refresh で aal2 のトークンを発行させる（2026-10-25 に手元の GoTrue で aal1 → aal2 になることを確かめた）。
 * TOTP の入力の画面と /api/auth/mfa/* の窓口そのものは、この道具の範囲の外。
 *
 * この道具を呼ぶ spec は、ファイルの最上位に `test.use({ trace: 'off' })` が必須（member-session-helpers.ts と同じ理由）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Locator, Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';

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
 * 本物の aal2 の店長・サポーターとして、この page でログインする。終わったら removeStaff で消す。
 * label は小文字の英数字とハイフンだけ（createTestMember の決まり）。
 */
export async function loginAsStaffAal2(page: Page, role: StaffRole, label: string): Promise<TestMember> {
  const member = await createTestMember(label);

  // 役割は JWT の app_metadata.role（画面の出し分け）と user_roles（窓口の認可の ACL）の両方に要る
  const updated = await localAuthAdmin().auth.admin.updateUserById(member.userId, { app_metadata: { role } });
  if (updated.error) {
    throw new Error(`役割を付けられない（status: ${updated.error.status ?? '不明'}）`);
  }
  await withLocalDb(async (db) => {
    const assigned = await db.query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1::uuid, r.id, true, null from public.roles r where r.code = $2
       on conflict (user_id, role_id) do update set active = true, expires_at = null`,
      [member.userId, role],
    );
    if (assigned.rowCount !== 1) throw new Error(`役割 ${role} の行が手元の DB に無い`);
  });

  const sourceIp = randomSourceIp();
  await loginAsMember(page, member, sourceIp);
  // 以後のブラウザの要求（画面が撃つ /api/auth/refresh と、管理 API の変更の枠 20 回/600 秒）もこの送り元で数える。
  // 付けないと、FR-STOCKIST-013 の 3 つの幅の変更（1 つの幅で作成 2・更新 2・切り替え 2・削除 2 の 8 回、計 24 回）が
  // ip null の 1 つの枠（20 回）を使い切り、最後の幅（desktop）の更新・削除が 429 で落ちる。
  await page.setExtraHTTPHeaders({ 'x-real-ip': sourceIp });

  // aal2 の根拠を足す（先頭のコメントを参照）。ログインで出来た session だけが対象
  await withLocalDb(async (db) => {
    await db.query(
      `insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
       select gen_random_uuid(), s.id, now(), now(), 'totp' from auth.sessions s where s.user_id = $1::uuid
       on conflict do nothing`,
      [member.userId],
    );
    await db.query(`update auth.sessions set aal = 'aal2' where user_id = $1::uuid`, [member.userId]);
  });

  const origin = new URL(page.url()).origin;
  const refreshed = await page.request.post(new URL('/api/auth/refresh', origin).toString(), {
    headers: { origin, 'x-real-ip': sourceIp },
    maxRedirects: 0,
  });
  if (!refreshed.ok()) {
    throw new Error(`aal2 のトークンを受けられない: ${refreshed.status()}`);
  }
  const me = await page.request.get(new URL('/api/auth/me', origin).toString(), {
    headers: { 'x-real-ip': sourceIp },
    maxRedirects: 0,
  });
  const body = (await me.json().catch(() => ({}))) as {
    authenticated?: boolean;
    user?: { id?: string; role?: string; mfaVerified?: boolean };
  };
  if (body.authenticated !== true || body.user?.id !== member.userId || body.user.role !== role || body.user.mfaVerified !== true) {
    throw new Error(`${role} の aal2 のログインになっていない`);
  }
  return member;
}

/** 試験用の店長・サポーターを消す。消せなくても試験の結果は変えない（db reset で消える） */
export async function removeStaff(member: TestMember): Promise<void> {
  await localAuthAdmin().auth.admin.deleteUser(member.userId).catch(() => undefined);
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
