/**
 * FR-LOGIN-065 招待の窓の中の人（役割が無い案 B）の、パスキー登録の窓口（短い。窓口だけ）
 * 対応: FR-AUTH-042-AC-01・02（設計: DD-AUTH-079、SEC-AUTH-057）
 *
 * 招待の POST（/api/auth/staff/invite/start）でセッションを作り、そのセッションの Cookie で登録の窓口を呼ぶ。
 * 役割は有効にしない（案 B）ので、窓口は「お客さん」ではなく window として扱う。窓が閉じたらお客さんの道に落ちず 403 window_closed。
 */
import { randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { provisionPasskeyUser } from '../scripts/e2e/passkey-staff';
import { startRegisterViaApp } from './passkey-app-api';
import { createOtherSessionForUser } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const uniqueIp = (): string => `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;

/** DB の窓口で合言葉を作り、POST で招待のセッションと窓を作る。Cookie は `request` に入る。 */
async function enterInviteWindow(request: APIRequestContext): Promise<{ userId: string; email: string; sessionId: string; csrfToken: string }> {
  const issued = await withLocalDb(async (db) => {
    const user = await provisionPasskeyUser(db, { approvedPasskeys: 0 });
    const result = await db.query('select private.staff_invite_issue_manual($1, $2, $3) as token', [user.email, 'admin', 3600]);
    return { token: result.rows[0].token as string, userId: user.userId, email: user.email };
  });
  const started = await request.post('/api/auth/staff/invite/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { token: issued.token },
  });
  expect(started.status()).toBe(200);
  const cookies = await request.storageState();
  const csrfToken = cookies.cookies.find((cookie) => cookie.name === 'sb-csrf-token')?.value;
  expect(csrfToken).toBeTruthy();
  const sessionId = await withLocalDb(
    async (db) =>
      (await db.query('select session_id::text as id from private.staff_invites where user_id = $1::uuid order by created_at desc limit 1', [issued.userId]))
        .rows[0].id as string,
  );
  return { userId: issued.userId, email: issued.email, sessionId, csrfToken: csrfToken as string };
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-065 staff register window (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-042-AC-01 ${viewport.name}: 役割が無くても、招待の窓の中の人は登録の始めが 200 で mode は window`, async ({ request }) => {
      test.setTimeout(120_000);
      const { csrfToken } = await enterInviteWindow(request);
      const start = await startRegisterViaApp(request, { ip: uniqueIp(), csrfToken });
      expect(start.status).toBe(200);
      expect((start.body as { mode: string }).mode).toBe('window');
    });

    test(`FR-AUTH-042-AC-02 ${viewport.name}: 窓が閉じた人は、お客さんの道に落ちず 403 window_closed`, async ({ request }) => {
      test.setTimeout(120_000);
      const { csrfToken, sessionId } = await enterInviteWindow(request);
      await withLocalDb((db) => db.query('select public.passkey_window_close($1::uuid)', [sessionId]));
      const start = await startRegisterViaApp(request, { ip: uniqueIp(), csrfToken });
      expect(start.status).toBe(403);
      expect(start.body).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
    });

    test(`FR-AUTH-042-AC-02 ${viewport.name}: 同じ人の別の session の通行証では、招待の窓が開いていても 403 window_closed（窓を開けた session だけが通る）`, async ({ request, playwright, baseURL }) => {
      test.setTimeout(120_000);
      const { csrfToken, userId, email } = await enterInviteWindow(request);
      const other = await withLocalDb((db) => createOtherSessionForUser(db, { userId, email }));
      const bare = await playwright.request.newContext({ baseURL: baseURL as string });
      try {
        const crossed = await startRegisterViaApp(bare, { ip: uniqueIp(), authorization: `Bearer ${other.accessToken}` });
        expect(crossed.status).toBe(403);
        expect(crossed.body).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
      } finally {
        await bare.dispose();
      }
      const own = await startRegisterViaApp(request, { ip: uniqueIp(), csrfToken });
      expect(own.status).toBe(200);
      expect((own.body as { mode: string }).mode).toBe('window');
    });
  });
}
