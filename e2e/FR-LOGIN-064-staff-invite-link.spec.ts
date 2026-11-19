/**
 * FR-LOGIN-064 店員の招待のリンクの受け口 /staff/invite（案 B: セッションを先に作り、session_id に窓を結ぶ）
 * 対応: FR-AUTH-041-AC-01〜04（設計: SCR-AUTH-013、API-AUTH-037、DD-AUTH-078）
 *
 * 手元の Supabase とアプリ（本番ビルド）で、メールのリンクを HTTP とブラウザで開いて確かめる。メールは手元の Mailpit（expect.poll で待つ）。
 * 合言葉は URL の # にあり、サーバーに届かない。開いただけでは何も起きず、ボタンの POST で初めて使い切られる。
 * 役割は有効にしない（案 B。画面の中身は Task 7）ので、/api/auth/me は role: user のまま。
 */
import { randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { provisionPasskeyUser } from '../scripts/e2e/passkey-staff';
import { bearerHeaders, createAdminSessionActor } from './admin-session-test-utils';
import { mailBodies, uniqueEmail, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const INVITE_SUBJECT = '店員のアカウントの登録のご案内';
const INVITE_LINK = /(\/staff\/invite)#([A-Za-z0-9_-]{43})/;
const UNUSABLE = 'このリンクは使えません';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function sessionIdOf(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('JWT の形が正しくない');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { session_id?: string };
  if (!claims.session_id) throw new Error('JWT に session_id が無い');
  return claims.session_id;
}

const uniqueIp = (): string => `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;

async function issueMailedInvite(request: APIRequestContext, origin: string): Promise<{ token: string; userId: string; email: string }> {
  const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
  const email = uniqueEmail('invite-link');
  const issued = await request.post('/api/admin/staff/invites', {
    headers: { ...bearerHeaders(admin), origin, 'x-real-ip': uniqueIp() },
    data: { email, role: 'supporter' },
  });
  expect(issued.status()).toBe(200);
  let text = '';
  await expect
    .poll(
      async () => {
        const bodies = await mailBodies(request, email, INVITE_SUBJECT);
        text = bodies[0]?.Text ?? '';
        return bodies.length;
      },
      { timeout: 15_000, message: '招待のメールが1通届く' },
    )
    .toBe(1);
  const match = INVITE_LINK.exec(text);
  if (!match) throw new Error('メールにリンクの合言葉が無い');
  const userId = await withLocalDb(
    async (db) => (await db.query('select id::text as id from auth.users where lower(email) = lower($1)', [email])).rows[0].id as string,
  );
  return { token: match[2], userId, email };
}

/** DB の窓口 private.staff_invite_issue_manual（postgres 専用）が返す合言葉。メールは送らない */
async function issueManual(ttlSeconds = 3600): Promise<{ token: string; userId: string }> {
  return withLocalDb(async (db) => {
    const user = await provisionPasskeyUser(db, { approvedPasskeys: 0 });
    const result = await db.query('select private.staff_invite_issue_manual($1, $2, $3) as token', [user.email, 'admin', ttlSeconds]);
    return { token: result.rows[0].token as string, userId: user.userId };
  });
}

async function inviteRow(userId: string): Promise<{ consumed_at: string | null; bound_at: string | null; session_id: string | null }> {
  return withLocalDb(
    async (db) =>
      (await db.query('select consumed_at, bound_at, session_id::text as session_id from private.staff_invites where user_id = $1::uuid order by created_at desc limit 1', [userId]))
        .rows[0],
  );
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-064 staff invite link (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-041-AC-01 ${viewport.name}: メールのリンクを GET しても合言葉は使い切られず、Cookie も付かない`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const invite = await issueMailedInvite(request, origin);

      const got = await request.get(`/staff/invite#${invite.token}`, { headers: { 'x-real-ip': uniqueIp() } });

      expect(got.status()).toBe(200);
      expect(got.headers()['set-cookie'] ?? '').not.toMatch(/sb-|access|refresh/i);
      const row = await inviteRow(invite.userId);
      expect(row.consumed_at).toBeNull();
      expect(row.bound_at).toBeNull();
    });

    test(`FR-AUTH-041-AC-02 ${viewport.name}: ボタンで /staff/register へ移り、窓が開き、役割はお客さんのまま。同じリンクは2度目に使えない`, async ({ request, baseURL, browser }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const invite = await issueMailedInvite(request, origin);
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        const page = await context.newPage();
        await page.goto(`/staff/invite#${invite.token}`);
        await expect(page.getByRole('heading', { name: '店員のパスキーを登録します' })).toBeVisible();
        // 合言葉は読んだらすぐ URL から消える
        await expect.poll(() => new URL(page.url()).hash).toBe('');
        expect(page.url()).not.toContain(invite.token);

        const mailsBefore = (await mailBodies(request, invite.email)).length;
        expect(mailsBefore).toBe(1);
        await page.getByRole('button', { name: '登録を始める' }).click();
        await expect(page).toHaveURL(/\/staff\/register$/);
        // generateLink（magiclink）はメールを送らない。POST の後も、招待の人に届いたメールは増えない
        await expect
          .poll(async () => (await mailBodies(request, invite.email)).length, { timeout: 3_000, intervals: [500] })
          .toBe(mailsBefore);
        // poll は一致した時点で終わるので、短く待った後にもう一度数える
        await page.waitForTimeout(1_500);
        expect((await mailBodies(request, invite.email)).length).toBe(mailsBefore);

        const me = await page.request.get('/api/auth/me');
        expect(me.status()).toBe(200);
        const body = await me.json();
        expect(body.authenticated).toBe(true);
        expect(body.user.id).toBe(invite.userId);
        expect(body.user.role).toBe('user');
        const row = await inviteRow(invite.userId);
        expect(row.consumed_at).not.toBeNull();
        expect(row.bound_at).not.toBeNull();
        expect(row.session_id).not.toBeNull();
        // 窓が結ばれた session_id は、このブラウザの通行証の session_id と同じ（DB の行の値だけを見ない）
        const browserAccess = (await context.cookies()).find((cookie) => cookie.name === 'sb-access-token')?.value;
        expect(browserAccess).toBeTruthy();
        expect(sessionIdOf(browserAccess as string)).toBe(row.session_id);

        // 同じ URL をもう一度開いて押すと使えない
        const second = await context.newPage();
        await second.goto(`/staff/invite#${invite.token}`);
        await second.getByRole('button', { name: '登録を始める' }).click();
        await expect(second.getByText(UNUSABLE)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test(`FR-AUTH-041-AC-03 ${viewport.name}: 取り消された招待・期限が過ぎた招待・知らない合言葉は、同じ文で断られる`, async ({ browser }) => {
      test.setTimeout(120_000);
      const cancelled = await issueManual();
      await withLocalDb((db) => db.query('update private.staff_invites set cancelled_at = now() where user_id = $1::uuid', [cancelled.userId]));
      const expired = await issueManual();
      await withLocalDb((db) =>
        db.query("update private.staff_invites set expires_at = now() - interval '1 minute' where user_id = $1::uuid", [expired.userId]),
      );
      const unknown = 'z'.repeat(43);

      for (const token of [cancelled.token, expired.token, unknown]) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        try {
          const page = await context.newPage();
          await page.goto(`/staff/invite#${token}`);
          await page.getByRole('button', { name: '登録を始める' }).click();
          await expect(page.getByText(UNUSABLE)).toBeVisible();
          await expect(page).toHaveURL(/\/staff\/invite$/);
        } finally {
          await context.close();
        }
      }
      expect((await inviteRow(cancelled.userId)).bound_at).toBeNull();
      expect((await inviteRow(expired.userId)).bound_at).toBeNull();
    });

    test(`FR-AUTH-041-AC-04 ${viewport.name}: private.staff_invite_issue_manual の合言葉（43字）で POST が通り窓が開く。Origin が違うと403`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const manual = await issueManual();
      expect(manual.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const forbidden = await request.post('/api/auth/staff/invite/start', {
        headers: { origin: 'https://evil.example', 'x-real-ip': uniqueIp() },
        data: { token: manual.token },
        failOnStatusCode: false,
      });
      expect(forbidden.status()).toBe(403);
      expect((await inviteRow(manual.userId)).consumed_at).toBeNull();

      const response = await request.post('/api/auth/staff/invite/start', {
        headers: { origin, 'x-real-ip': uniqueIp() },
        data: { token: manual.token },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ redirectTo: '/staff/register' });
      expect(response.headers()['cache-control']).toContain('no-store');
      const row = await inviteRow(manual.userId);
      expect(row.consumed_at).not.toBeNull();
      expect(row.bound_at).not.toBeNull();
      const open = await withLocalDb(async (db) =>
        (await db.query('select public.passkey_window_is_open($1::uuid, $2::uuid) as open', [manual.userId, row.session_id])).rows[0].open as boolean,
      );
      expect(open).toBe(true);

      const again = await request.post('/api/auth/staff/invite/start', {
        headers: { origin, 'x-real-ip': uniqueIp() },
        data: { token: manual.token },
        failOnStatusCode: false,
      });
      expect(again.status()).toBe(400);
      expect(await again.json()).toEqual({ error: 'invite_invalid' });
    });
  });
}
