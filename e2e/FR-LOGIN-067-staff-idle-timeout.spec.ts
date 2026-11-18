/**
 * FR-LOGIN-067 店員の無操作1時間（管理の画面・管理 API・店員のパスキーの窓口）
 * 対応: FR-AUTH-044-AC-01〜05（設計: DD-AUTH-081・DD-AUTH-082、SEC-AUTH-055）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase で通しで確かめる。店員は e2e/admin-session-test-utils.ts の createAdminSessionActor
 * （login/finish を通らない。最後の操作の行が無いセッション）で作り、無操作の時刻は DB の `private.staff_session_activity` を直に書いて作る。
 * 認証のトークン・鍵は、失敗の文面に出さない。
 */
import { expect, test } from '@playwright/test';
import { bearerHeaders, createAdminSessionActor, placeAdminCookies, type AdminSessionActor } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const IDLE_MESSAGE = 'しばらく操作がなかったため、ログアウトしました。';

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** 最後の操作の時刻を、今から minutes 分前にする（行が無ければ作る）。 */
async function setLastSeen(actor: AdminSessionActor, minutes: number): Promise<void> {
  await withLocalDb(async (db) => {
    await db.query(
      `insert into private.staff_session_activity (session_id, user_id, last_seen_at)
       values ($1::uuid, $2::uuid, now() - make_interval(mins => $3::int))
       on conflict (session_id) do update set last_seen_at = excluded.last_seen_at`,
      [actor.sessionId, actor.userId, minutes],
    );
  });
}

async function minutesSinceLastSeen(actor: AdminSessionActor): Promise<number | null> {
  return withLocalDb(async (db) => {
    const res = await db.query(
      'select extract(epoch from (now() - last_seen_at)) / 60 as minutes from private.staff_session_activity where session_id = $1::uuid',
      [actor.sessionId],
    );
    return res.rows.length === 0 ? null : Number(res.rows[0].minutes);
  });
}

async function sessionExists(actor: AdminSessionActor): Promise<boolean> {
  return withLocalDb(async (db) => {
    const res = await db.query('select 1 from auth.sessions where id = $1::uuid', [actor.sessionId]);
    return res.rows.length > 0;
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-067 staff idle timeout (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FR-AUTH-044-AC-01 ${viewport.name}: 無操作が61分の店員が /admin を開くと /login?reason=idle へ送られ、「しばらく操作がなかったため、ログアウトしました」が出る`, async ({ page }) => {
      test.setTimeout(120_000);
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await placeAdminCookies(page, actor, uniqueIp());
      await setLastSeen(actor, 61);

      await page.goto('/admin');

      await expect(page).toHaveURL(/\/login\?reason=idle$/, { timeout: 30_000 });
      await expect(page.getByText(IDLE_MESSAGE)).toBeVisible();
      // 画面を開き直しただけでは、無操作の時刻は進まない（peek は書かない）
      expect(await minutesSinceLastSeen(actor)).toBeGreaterThan(60);
    });

    test(`FR-AUTH-044-AC-02 ${viewport.name}: 無操作が59分の店員は /admin に入れ、その画面の操作で最後の操作の時刻が更新される`, async ({ page }) => {
      test.setTimeout(120_000);
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await placeAdminCookies(page, actor, uniqueIp());
      await setLastSeen(actor, 59);

      await page.goto('/admin');

      await expect(page).toHaveURL(/\/admin/);
      await expect.poll(async () => await minutesSinceLastSeen(actor), { timeout: 30_000 }).toBeLessThan(5);
      expect(page.url()).not.toContain('reason=idle');
    });

    test(`FR-AUTH-044-AC-03 ${viewport.name}: 管理 API は、無操作が61分なら 401 session_idle でセッションを終わらせ、59分なら通って時刻を進める`, async ({ request }) => {
      test.setTimeout(120_000);
      const fresh = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await setLastSeen(fresh, 59);
      const ok = await request.get('/api/admin/users', { headers: { ...bearerHeaders(fresh), 'x-real-ip': uniqueIp() } });
      expect(ok.status()).toBe(200);
      expect(await minutesSinceLastSeen(fresh)).toBeLessThan(5);

      const idle = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await setLastSeen(idle, 61);
      const denied = await request.get('/api/admin/users', { headers: { ...bearerHeaders(idle), 'x-real-ip': uniqueIp() } });
      expect(denied.status()).toBe(401);
      expect(await denied.json()).toEqual({ error: 'session_idle' });
      expect(await sessionExists(idle)).toBe(false);
      const after = await request.get('/api/admin/users', { headers: { ...bearerHeaders(idle), 'x-real-ip': uniqueIp() } });
      expect(after.status()).toBe(401);
    });

    test(`FR-AUTH-044-AC-04 ${viewport.name}: login/finish を通らず最後の操作の行が無い店員のセッションも、作られてから1時間の中は管理 API を通る`, async ({ request }) => {
      test.setTimeout(120_000);
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      expect(await minutesSinceLastSeen(actor)).toBeNull();

      const res = await request.get('/api/admin/users', { headers: { ...bearerHeaders(actor), 'x-real-ip': uniqueIp() } });

      expect(res.status()).toBe(200);
      expect(await minutesSinceLastSeen(actor)).not.toBeNull();
    });

    test(`FR-AUTH-044-AC-05 ${viewport.name}: 店員のパスキーの窓口（一覧）は無操作が61分なら 401 で終わらせ、お客さんは通る`, async ({ request }) => {
      test.setTimeout(120_000);
      const staff = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await setLastSeen(staff, 59);
      const ok = await request.get('/api/auth/passkey', { headers: { ...bearerHeaders(staff), 'x-real-ip': uniqueIp() } });
      expect(ok.status()).toBe(200);

      await setLastSeen(staff, 61);
      const denied = await request.get('/api/auth/passkey', { headers: { ...bearerHeaders(staff), 'x-real-ip': uniqueIp() } });
      expect(denied.status()).toBe(401);
      expect(await denied.json()).toEqual({ error: 'session_idle' });
      expect(await sessionExists(staff)).toBe(false);

      const customer = await withLocalDb((db) => createAdminSessionActor(db, 'user', 'aal1'));
      const customerRes = await request.get('/api/auth/passkey', { headers: { ...bearerHeaders(customer), 'x-real-ip': uniqueIp() } });
      expect(customerRes.status()).toBe(200);
    });
  });
}
