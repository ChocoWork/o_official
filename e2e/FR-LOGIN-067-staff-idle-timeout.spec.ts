/**
 * FR-LOGIN-067 店員の無操作1時間（管理の画面・管理 API・店員のパスキーの窓口）
 * 対応: FR-AUTH-044-AC-01〜06（設計: DD-AUTH-081、SEC-AUTH-055）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase で通しで確かめる。店員は e2e/admin-session-test-utils.ts の createAdminSessionActor
 * （login/finish を通らない。最後の操作の行が無いセッション）で作り、無操作の時刻は DB の `private.staff_session_activity` を直に書いて作る。
 * 認証のトークン・鍵は、失敗の文面に出さない。
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { bearerHeaders, createAdminSessionActor, placeAdminCookies, type AdminSessionActor } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const IDLE_MESSAGE = 'しばらく操作がなかったため、ログアウトしました。';

/**
 * 最後の操作の時刻を書く API（管理 API・店員のパスキーの窓口）と、通行証の更新（`/api/auth/refresh`。更新の途中で静かと見なさないため）の呼び出しを追う。
 * /admin の読み込みは KPI の後に続けて API を呼ぶので、呼び出しの一覧は決め打ちにせず、「飛んでいる呼び出しが無く、しばらく静か」を待つ。
 * 応答は 'response' で数える（サーバーは答える前に時刻を書く。本文を読まない no-store の応答は requestfinished が来ない）。
 */
function trackActivityCalls(page: Page) {
  const isActivityApi = (url: string) => {
    const path = new URL(url).pathname;
    return path.startsWith('/api/admin/') || path.startsWith('/api/auth/passkey') || path === '/api/auth/refresh';
  };
  const open = new Set<Request>();
  const startedPaths: string[] = [];
  let lastChange = Date.now();
  const close = (request: Request) => {
    if (open.delete(request)) lastChange = Date.now();
  };
  page.on('request', (request) => {
    if (!isActivityApi(request.url())) return;
    open.add(request);
    startedPaths.push(new URL(request.url()).pathname);
    lastChange = Date.now();
  });
  page.on('response', (response) => close(response.request()));
  page.on('requestfailed', close);
  const isQuiet = () => open.size === 0 && startedPaths.length > 0 && Date.now() - lastChange >= 1_000;
  return {
    /** 時間切れの時に、止まっている呼び出しの道が分かるよう、今の状態を文で返す。 */
    describeState: () =>
      isQuiet()
        ? '静か'
        : `静かではない（飛んでいる呼び出し: [${[...open].map((request) => new URL(request.url()).pathname).join(', ')}]、始まった呼び出し: ${startedPaths.length}件、最後の変化から ${Date.now() - lastChange}ms）`,
    startedCount: () => startedPaths.length,
    startedSince: (mark: number) => startedPaths.slice(mark),
  };
}

/** 画面が静まるまで待ってから最後の操作の時刻を戻す。戻している間に管理 API が呼ばれたら、上書きの競りとして名指しで落とす。 */
async function backdateWhenQuiet(page: Page, calls: ReturnType<typeof trackActivityCalls>, actor: AdminSessionActor, minutes: number): Promise<void> {
  await expect
    .poll(() => calls.describeState(), { timeout: 30_000, message: '/admin の管理 API の読み込みが静まる（飛んでいる呼び出しが無く、1秒静か）' })
    .toBe('静か');
  const mark = calls.startedCount();
  await setLastSeen(actor, minutes);
  expect(calls.startedSince(mark), '時刻を戻している間に管理 API が呼ばれた（最後の操作の時刻を上書きされる競り）').toEqual([]);
}

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

    test(`FR-AUTH-044-AC-06 ${viewport.name}: /admin を開いたままで無操作が61分になり、管理の操作をすると /login?reason=idle へ送られ、ログアウトの文が出る`, async ({ page }) => {
      test.setTimeout(120_000);
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await placeAdminCookies(page, actor, uniqueIp());
      const calls = trackActivityCalls(page);
      await page.goto('/admin');
      await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible({ timeout: 30_000 });

      await backdateWhenQuiet(page, calls, actor, 61);
      // 画面の最初の読み込み（KPI・要対応の件数）が先に 401 を受けて送ることがあり、その時はクリックの前に画面が替わる。どちらでも同じ終わりになる
      await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'USER' }).click({ timeout: 20_000 }).catch(() => undefined);

      await expect(page).toHaveURL(/\/login\?reason=idle$/, { timeout: 30_000 });
      await expect(page.getByText(IDLE_MESSAGE)).toBeVisible();
      expect(await sessionExists(actor)).toBe(false);
    });

    test(`FR-AUTH-044-AC-06 ${viewport.name} (アクセストークンの Cookie が無い・更新を通る経路): 開いたままの画面で、通行証が無く更新が通った後の再送が無操作で 401 になっても /login?reason=idle へ送られ、ログアウトの文が出る`, async ({ page }) => {
      test.setTimeout(120_000);
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      await placeAdminCookies(page, actor, uniqueIp());
      const calls = trackActivityCalls(page);
      await page.goto('/admin');
      await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible({ timeout: 30_000 });

      // 更新の Cookie だけを残す。API は 401（期限切れと同じ）→ 更新は通る → 再送が無操作で 401 session_idle になる
      await page.context().clearCookies({ name: 'sb-access-token' });
      await backdateWhenQuiet(page, calls, actor, 61);
      await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'USER' }).click({ timeout: 20_000 }).catch(() => undefined);

      await expect(page).toHaveURL(/\/login\?reason=idle$/, { timeout: 30_000 });
      await expect(page.getByText(IDLE_MESSAGE)).toBeVisible();
      expect(await sessionExists(actor)).toBe(false);
    });
  });
}
