/**
 * FR-STOCKIST-012 取扱店の公開の画面と読み出しを、手元の Supabase に足した行で確かめる
 * 対応: FR-STOCKIST-003-AC-01 / FR-STOCKIST-008-AC-01 / FR-STOCKIST-010-AC-02 /
 *       SEC-STOCKIST-001-AC-01 / SEC-STOCKIST-001-AC-02 / SEC-STOCKIST-016-AC-01 / SEC-STOCKIST-016-AC-02
 * （FR-STOCKIST-003-AC-02 と SEC-STOCKIST-018-AC-01 は、全部の公開の店を巻き込むので FR-STOCKIST-017 に分けてある）
 *
 * 手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）に `E2E-STK-<uuid>` の名前の店舗を足し、終わったら finally で消す。
 * 他のファイルの試験と並行に流れても揺れないよう、次の決まりで書く。
 * - 公開の画面の出方を確かめる必要が無い行は非公開で足す（公開の行は、他の試験の件数の数えに入るため）。
 * - 非公開の行はホームの「最初の 6 件」に入る小さい id で足す（randomLowId）。ホームの取扱店の節は id の小さい公開の 6 件を出すので、
 *   公開の絞りが壊れた時にだけ、その行がホームに出る。大きい id では絞りが壊れても出ないので、確かめにならない。
 * - 件数を数える時は、足した行の名前で絞る。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import {
  openFilterScope,
  randomLowId,
  requireLocalSupabaseEnv,
  SEED_STOCKISTS,
  STOCKIST_VIEWPORTS as VIEWPORTS,
  stockistCardByName,
  stockistTag as tag,
  withStockists,
} from './stockist-test-utils';

test.use({ trace: 'off' });

const MAPS_SEARCH_PREFIX = 'https://www.google.com/maps/search/?api=1&query=';
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

// 一般会員は worker ごとに1回だけ、既知のパスワードで作ってログインする（ログインの回数の制限を使い切らない）
let memberPromise: Promise<{ userId: string; accessToken: string }> | null = null;

function memberSession(): Promise<{ userId: string; accessToken: string }> {
  memberPromise ??= (async () => {
    const { url, anonKey, serviceKey } = requireLocalSupabaseEnv();
    const email = `e2e-stockist012-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
    const password = `E2e-${randomBytes(12).toString('hex')}!`;
    const admin = createClient(url, serviceKey, clientOptions);
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) {
      throw new Error(`手元の一般会員を作れない（status: ${created.error?.status ?? '不明'}）`);
    }
    const signedIn = await createClient(url, anonKey, clientOptions).auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) {
      throw new Error(`手元の一般会員でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
    }
    return { userId: created.data.user.id, accessToken: signedIn.data.session.access_token };
  })();
  return memberPromise;
}

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  if (!memberPromise) return;
  const member = await memberPromise.catch(() => null);
  memberPromise = null;
  if (!member) return;
  const { url, serviceKey } = requireLocalSupabaseEnv();
  await createClient(url, serviceKey, clientOptions).auth.admin.deleteUser(member.userId);
});

async function useViewport(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-STOCKIST-012 非公開の店が公開の画面に出ない (${vp.name})`, () => {
    test(`FR-STOCKIST-003-AC-01 ${vp.name}: 非公開の店を1件置いても /stockist とホームの取扱店の節にその店の名前が出ない`, async ({ page }) => {
      await useViewport(page, vp);
      const privateName = tag();
      await withStockists([{ name: privateName, status: 'private', id: randomLowId() }], async () => {
        await page.goto('/stockist');
        // 取り出しが動いている（見本の公開の店は出ている）うえで、非公開の店だけが出ない
        await expect(page.locator('article', { hasText: SEED_STOCKISTS[0].name })).toHaveCount(1);
        await expect(page.locator('article', { hasText: privateName })).toHaveCount(0);
        await expect(page.getByText(privateName)).toHaveCount(0);
        expect(await page.content()).not.toContain(privateName);

        await page.goto('/');
        const section = page.locator('section#stockist');
        await expect(section.locator('article').first()).toBeAttached();
        await expect(section.getByText(privateName)).toHaveCount(0);
        expect(await page.content()).not.toContain(privateName);
      });
    });

    test(`SEC-STOCKIST-001-AC-02 ${vp.name}: 非公開の店を1件置いても /stockist とホームの取扱店の節にその店の名前が表示されない`, async ({ page }) => {
      await useViewport(page, vp);
      const privateName = tag();
      await withStockists([{ name: privateName, status: 'private', id: randomLowId() }], async () => {
        await page.goto('/stockist');
        await expect(page.locator('article').first()).toBeVisible();
        await expect(page.getByText(privateName)).toHaveCount(0);
        await expect(page.locator('article', { hasText: privateName })).toHaveCount(0);

        await page.goto('/');
        const section = page.locator('section#stockist');
        await expect(section.locator('article').first()).toBeAttached();
        await expect(section.getByText(privateName)).toHaveCount(0);
      });
    });
  });
}

// 画面を描かない HTTP だけの試験なので、画面幅ごとには繰り返さない（FR-STOCKIST-014・FR-ADMIN-123 と同じ扱い）
test.describe('FR-STOCKIST-012 直接の読み出し', () => {
  test('SEC-STOCKIST-001-AC-01 非公開の店を1件入れた状態で、anon の鍵と一般会員の JWT の select の結果にその店が含まれない', async ({ request }) => {
    const { url, anonKey } = requireLocalSupabaseEnv();
    const member = await memberSession();
    const privateName = tag();
    await withStockists([{ name: privateName, status: 'private', id: randomLowId() }], async ([privateId]) => {
      const credentials = [
        { label: 'anon の鍵', bearer: anonKey },
        { label: '一般会員の JWT', bearer: member.accessToken },
      ];
      for (const credential of credentials) {
        const response = await request.get(`${url}/rest/v1/stockists?select=id,name,status`, {
          headers: { apikey: anonKey, Authorization: `Bearer ${credential.bearer}` },
          failOnStatusCode: false,
        });
        expect(response.status(), `${credential.label}: select の状態`).toBe(200);
        const rows = (await response.json()) as Array<{ id: number; name: string; status: string }>;
        // 公開の行（見本の店）は読めている（読み出しが動いている）うえで、非公開の行は含まれない
        expect(rows.map((row) => row.name), `${credential.label}: 見本の公開の行`).toContain(SEED_STOCKISTS[0].name);
        expect(rows.map((row) => row.id), `${credential.label}: 非公開の行の id`).not.toContain(privateId);
        expect(rows.map((row) => row.name), `${credential.label}: 非公開の行の名前`).not.toContain(privateName);
        expect(rows.every((row) => row.status === 'published'), `${credential.label}: 返る行は全部 published`).toBe(true);
      }
    });
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`FR-STOCKIST-012 カードの区別と絞り込み (${vp.name})`, () => {
    test(`FR-STOCKIST-008-AC-01 ${vp.name}: 同じ店舗名の公開の店を2件置くと、/stockist にその名前のカードが2枚出る`, async ({ page }) => {
      await useViewport(page, vp);
      const sameName = tag();
      await withStockists(
        [
          { name: sameName, status: 'published', address: '東京都港区0-0-1' },
          { name: sameName, status: 'published', address: '大阪府大阪市中央区0-0-2' },
        ],
        async () => {
          await page.goto('/stockist');
          const cards = page.locator('article', { hasText: sameName });
          await expect(cards).toHaveCount(2);
          await expect(cards.nth(0)).toBeVisible();
          await expect(cards.nth(1)).toBeVisible();
        },
      );
    });

    test(`FR-STOCKIST-010-AC-02 ${vp.name}: 北海道の公開の店があると、「北海道」が開け閉めのボタンを持たない1つのチェックボックスで出て、選ぶと北海道の店だけが出る`, async ({ page }) => {
      await useViewport(page, vp);
      const name = tag();
      await withStockists([{ name, status: 'published', address: '北海道札幌市中央区0-0-1' }], async () => {
        await page.goto('/stockist');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('article', { hasText: name })).toHaveCount(1);

        const scope = await openFilterScope(page, vp.drawer);
        const hokkaido = scope.getByRole('checkbox', { name: '北海道', exact: true });
        await expect(hokkaido).toHaveCount(1);
        await expect(scope.getByRole('button', { name: /北海道の都道府県を/ })).toHaveCount(0);
        await expect(hokkaido).not.toBeChecked();

        await scope.getByText('北海道', { exact: true }).click();
        await expect(page).toHaveURL(/pref=/);
        await expect(hokkaido).toBeChecked();
        if (vp.drawer) {
          await page.getByRole('dialog').getByLabel('Close filter drawer').click();
        }

        // 北海道の店だけが出る（見本の東京・大阪・京都・兵庫の店は消える）。
        // 他の画面幅の試験が足した北海道の店が同時に出ることがあるので、全体の件数は数えず、足した行・見本・住所の頭で確かめる
        const own = stockistCardByName(page, name);
        await expect(own).toHaveCount(1);
        await expect(own.locator('a[href^="https://www.google.com/maps"]')).toHaveText(/^北海道/);
        for (const seed of SEED_STOCKISTS) {
          await expect(stockistCardByName(page, seed.name), seed.name).toHaveCount(0);
        }
        // 出ているカードのうち、住所が北海道で始まらないものは 0 枚
        const hokkaidoAddress = page.locator('a[href^="https://www.google.com/maps"]', { hasText: /^北海道/ });
        await expect(page.locator('article').filter({ hasNot: hokkaidoAddress })).toHaveCount(0);
      });
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-STOCKIST-012 店舗の値の出し方 (${vp.name})`, () => {
    test(`SEC-STOCKIST-016-AC-01 ${vp.name}: 店名と住所に入れた <img onerror> が動かず（dialog が出ず）、入れた字がそのまま文字として表示される`, async ({ page }) => {
      await useViewport(page, vp);
      const id = tag();
      const name = `${id}<img src=x onerror="window.__e2eStockistXss=1;alert('name')">`;
      const address = `東京都港区<img src=x onerror="window.__e2eStockistXss=2;alert('address')">0-0-1`;
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await withStockists([{ name, status: 'published', address }], async () => {
        await page.goto('/stockist');
        await page.waitForLoadState('networkidle');

        const card = page.locator('article', { hasText: id });
        await expect(card).toHaveCount(1);
        await expect(card.getByRole('heading', { level: 3 })).toHaveText(name);
        await expect(card.locator('a[href^="https://www.google.com/maps"]')).toHaveText(address);

        // 入れた字が要素として解釈されていない
        await expect(card.locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __e2eStockistXss?: number }).__e2eStockistXss)).toBeUndefined();
        expect(dialogs).toEqual([]);
      });
    });

    test(`SEC-STOCKIST-016-AC-02 ${vp.name}: 住所のリンクの href が Google Maps の検索の固定の頭で始まり rel に noopener と noreferrer を含み、電話のリンクの href が tel: と数字・+ だけでできている`, async ({ page }) => {
      await useViewport(page, vp);
      const name = tag();
      const address = 'https://example.com/&query=x';
      await withStockists([{ name, status: 'published', address, phone: '+81 (0)3-1234-5678 ext.9' }], async () => {
        await page.goto('/stockist');
        const card = page.locator('article', { hasText: name });
        await expect(card).toHaveCount(1);

        const addressLink = card.locator('a', { hasText: address });
        await expect(addressLink).toHaveCount(1);
        const href = await addressLink.getAttribute('href');
        expect(href?.startsWith(MAPS_SEARCH_PREFIX), `住所のリンクの href: ${href}`).toBe(true);
        expect(href).toBe(`${MAPS_SEARCH_PREFIX}${encodeURIComponent(address)}`);
        const rel = ((await addressLink.getAttribute('rel')) ?? '').split(/\s+/);
        expect(rel).toContain('noopener');
        expect(rel).toContain('noreferrer');

        // 電話の行は狭い幅では隠れるため、href は属性で確かめる
        const telLink = card.locator('a[href^="tel:"]');
        await expect(telLink).toHaveCount(1);
        const telHref = await telLink.getAttribute('href');
        expect(telHref, '電話のリンクの href').toMatch(/^tel:[\d+]+$/);
        expect(telHref).toBe('tel:+8103123456789');
      });
    });
  });
}
