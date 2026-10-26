/**
 * FR-HOME-023 ホームが公開済みの物だけを出すことと、中身の安全・件数・画像の署名を、利用者の受け取る画面と HTML で確かめる
 * 対応: SEC-HOME-001-AC-01 / SEC-HOME-001-AC-02 / SEC-HOME-002-AC-01 / SEC-HOME-004-AC-02 /
 *       SEC-HOME-006-AC-01 / SEC-HOME-006-AC-02 / SEC-HOME-007-AC-01 / SEC-HOME-008-AC-01 / SEC-HOME-013-AC-01
 *
 * 手元の Supabase と手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）だけで流す。道具は e2e/home-test-utils.ts。
 * - 下書き（status='private'）の行は、漏れればホームの先頭に出る位置で入れる。公開の行は、見本でいちばん新しい日付より
 *   古い日付で入れる（他の試験の「いちばん新しい商品」を動かさない）。足した行は finally で消す。
 * - 管理者の session は aal2 の session を Google OAuth と同じ Cookie（sb-<ref>-auth-token）で持たせる（メールとパスワードの
 *   ログインではホームの読みが anon の権限のままで、管理者の権限で読む場面を作れない）。Cookie が管理者として読めることは
 *   @supabase/ssr の同じ読み方で先に確かめる（ホームの画面は管理者かどうかを出さないので、サーバー側の読みは直接は見えない）。
 * - 公開の行を足す試験（006-AC-02・008-AC-01・013-AC-01）は withHomeCatalogLock('exclusive')、公開の並びを比べる試験
 *   （002-AC-01）は 'shared' で、ファイルをまたいで直列にする（ホームは新しい順の先頭 8 件しか描かないため）。
 * - SEC-HOME-006-AC-02（外の画像の住所）・SEC-HOME-007-AC-01（署名の期限）は、今のコードが満たさない（TM-HOME-34・35）ので、
 *   test.fail で印を付けてある（直ると「想定外の成功」で知らせる）。skip しない。SEC-HOME-013-AC-01（取る件数）は商品を8件だけ取るようにしたので印を外した。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  PUBLISHED_ITEM_TOP_AT,
  PUBLISHED_NEWS_DATE,
  SEEDED_ITEM_IMAGE,
  authCookies,
  containsStandaloneNumber,
  countItemCards,
  countItemRecords,
  countPublishedItems,
  deleteHomeAdminUsers,
  deleteHomeRows,
  emptyHomeRows,
  expectCookieSessionActsAsAdmin,
  homeAdminSession,
  homeTag,
  insertDraftContent,
  insertDraftItemWithStock,
  insertPublishedItem,
  insertPublishedNews,
  linkedItemImageUrls,
  originalImageUrl,
  readSignedToken,
  withHomeCatalogLock,
  withLocalDb,
  type DraftNames,
  type HomeRows,
} from './home-test-utils';

test.use({ trace: 'off' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const ITEM_CARD = '#items [data-testid="item-card-link"]';
const ITEM_NAME = '#items [data-testid="item-name"]';
const STOCKIST_ARTICLE = 'section#stockist article';

test.afterAll(async () => {
  await deleteHomeAdminUsers();
});

/** 行を入れて場面を流し、finally で必ず消す。入れる途中で失敗しても、入れ終えた分は消える */
async function withHomeRows<T>(
  seed: (db: PgClient, rows: HomeRows) => Promise<T>,
  run: (seeded: T) => Promise<void>,
): Promise<void> {
  const rows = emptyHomeRows();
  try {
    const seeded = await withLocalDb((db) => seed(db, rows));
    await run(seeded);
  } finally {
    await withLocalDb((db) => deleteHomeRows(db, rows));
  }
}

/** 公開の行を足す場面。ホームの公開の行の lock を排他で持ったまま、足す・流す・消すまでを行う */
async function withPublishedHomeRows<T>(
  seed: (db: PgClient, rows: HomeRows) => Promise<T>,
  run: (seeded: T) => Promise<void>,
): Promise<void> {
  await withHomeCatalogLock('exclusive', () => withHomeRows(seed, run));
}

async function openHome(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const response = await page.goto('/');
  expect(response?.ok(), 'ホームが開く').toBe(true);
}

/** ホームの商品・LOOK・取扱店の節が実際に描かれていること（「出ない」の確かめが空振りにならないため） */
async function expectSectionsRendered(page: Page): Promise<void> {
  await expect(page.locator(ITEM_CARD).first()).toBeAttached();
  await expect(page.locator('#look [data-testid="look-card"]').first()).toBeAttached();
  await expect(page.locator(STOCKIST_ARTICLE).first()).toBeAttached();
}

async function expectNoDraftOnHome(page: Page, names: DraftNames, rawHtml: string): Promise<void> {
  const rendered = await page.content();
  for (const [kind, name] of Object.entries(names)) {
    await expect(page.getByText(name), `下書きの${kind}の名前が画面の字に出ない`).toHaveCount(0);
    expect(rendered, `下書きの${kind}の名前が開いた後の HTML に含まれない`).not.toContain(name);
    expect(rawHtml, `下書きの${kind}の名前が応答の HTML に含まれない`).not.toContain(name);
  }
}

type HomeSnapshot = { itemNames: string[]; viewAllVisible: boolean; stockistNames: string[] };

async function readSnapshot(page: Page): Promise<HomeSnapshot> {
  await page.goto('/');
  await expect(page.locator(ITEM_CARD).first()).toBeAttached();
  await expect(page.locator(STOCKIST_ARTICLE).first()).toBeAttached();
  return {
    itemNames: await page.locator(ITEM_NAME).allTextContents(),
    viewAllVisible: await page.locator('#items [data-testid="home-section-view-all"]').isVisible(),
    stockistNames: await page.locator(`${STOCKIST_ARTICLE} h3`).allTextContents(),
  };
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-HOME-023 ホームが出す物 (${vp.name})`, () => {
    test(`SEC-HOME-001-AC-01 ${vp.name}: 下書きの商品・LOOK・NEWS・取扱店を1件ずつ入れて未ログインでホームを開くと、4件の名前・題のどれも表示されない`, async ({ page, request }) => {
      await withHomeRows((db, rows) => insertDraftContent(db, rows, homeTag('s001a1')), async (names) => {
        await openHome(page, vp);
        await expectSectionsRendered(page);
        const raw = await (await request.get('/')).text();
        await expectNoDraftOnHome(page, names, raw);
      });
    });

    test(`SEC-HOME-001-AC-02 ${vp.name}: 下書きを読める管理者（Google OAuth の Cookie）でホームを開くと、下書きの4件の名前・題のどれも表示されない`, async ({ page, baseURL }) => {
      expect(baseURL).toBeTruthy();
      const session = await homeAdminSession();
      await withHomeRows((db, rows) => insertDraftContent(db, rows, homeTag('s001a2')), async (names) => {
        await page.context().addCookies(authCookies(baseURL as string, session));
        const cookies = await page.context().cookies();
        expect(cookies.some((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name)), 'sb-<ref>-auth-token の Cookie を持たせた').toBe(true);
        await expectCookieSessionActsAsAdmin(cookies, session, names);

        await openHome(page, vp);
        await expectSectionsRendered(page);
        // page.request は page と同じ Cookie（管理者の session）で応答の HTML を読む
        const raw = await (await page.request.get('/')).text();
        await expectNoDraftOnHome(page, names, raw);
      });
    });

    test(`SEC-HOME-002-AC-01 ${vp.name}: 未ログインと管理者で、ホームの ITEM の節のカードの名前の並び・VIEW ALL の表示の有無・STOCKIST の節の店の名前の並びが同じ`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      expect(baseURL).toBeTruthy();
      const session = await homeAdminSession();
      await withHomeRows((db, rows) => insertDraftContent(db, rows, homeTag('s002a1')), async (names) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const context = page.context();
        await context.addCookies(authCookies(baseURL as string, session));
        await expectCookieSessionActsAsAdmin(await context.cookies(), session, names);
        await context.clearCookies();

        // 公開の商品・取扱店を足し引きする試験（排他）と重ならないよう、読む間は共有の lock を持つ
        const { anonymous, admin } = await withHomeCatalogLock('shared', async () => {
          const anonymousSnapshot = await readSnapshot(page);
          await context.addCookies(authCookies(baseURL as string, session));
          const adminSnapshot = await readSnapshot(page);
          await context.clearCookies();
          return { anonymous: anonymousSnapshot, admin: adminSnapshot };
        });

        expect(anonymous.itemNames.length, 'ITEM の節にカードがある').toBeGreaterThan(0);
        expect(admin.itemNames, 'ITEM の節のカードの名前の並びが同じ').toEqual(anonymous.itemNames);
        expect(admin.viewAllVisible, 'VIEW ALL の表示の有無が同じ').toBe(anonymous.viewAllVisible);
        expect(admin.stockistNames, 'STOCKIST の節の店の名前の並びが同じ').toEqual(anonymous.stockistNames);
        expect(admin.itemNames, '管理者の ITEM の節に下書きの商品が出ない').not.toContain(names.item);
        expect(admin.stockistNames, '管理者の STOCKIST の節に下書きの店が出ない').not.toContain(names.stockist);
      });
    });

    test(`SEC-HOME-004-AC-02 ${vp.name}: 未ログインでホームを開くと、ITEM の節に公開済みの商品のカードが1件以上表示される`, async ({ page }) => {
      await openHome(page, vp);
      const cards = page.locator(`${ITEM_CARD}:visible`);
      await expect(cards.first()).toBeVisible();
      expect(await cards.count()).toBeGreaterThanOrEqual(1);
      await expect(page.locator(`${ITEM_NAME}:visible`).first()).not.toHaveText('');
      await expect(page.getByText('公開中のITEMがありません')).toHaveCount(0);
    });

    test(`SEC-HOME-006-AC-01 ${vp.name}: 在庫を入れた下書きの商品の名前と在庫の数が、ホームの HTML に含まれない`, async ({ page, request }) => {
      const stock = 73519;
      await withHomeRows((db, rows) => insertDraftItemWithStock(db, rows, stock), async (draftName) => {
        await openHome(page, vp);
        await expectSectionsRendered(page);
        const rendered = await page.content();
        const raw = await (await request.get('/')).text();
        await expect(page.getByText(draftName)).toHaveCount(0);
        expect(raw, '応答の HTML に下書きの商品の名前が含まれない').not.toContain(draftName);
        expect(rendered, '開いた後の HTML に下書きの商品の名前が含まれない').not.toContain(draftName);
        expect(containsStandaloneNumber(raw, stock), '応答の HTML に在庫の数が含まれない').toBe(false);
        expect(containsStandaloneNumber(rendered, stock), '開いた後の HTML に在庫の数が含まれない').toBe(false);
      });
    });

    test(`SEC-HOME-006-AC-02 ${vp.name}: image_url を外の住所にした公開の商品のカードの画像の src に、入れた外の住所が含まれない`, async ({ page }) => {
      test.fail(true, 'SEC-HOME-006 今のコードは満たさない（docs/02_Requirements/areas/home.md）');
      test.setTimeout(120_000);
      const name = homeTag('s006a2-evil');
      const evilUrl = 'https://evil.example/x.png';
      await withPublishedHomeRows(
        (db, rows) => insertPublishedItem(db, rows, { name, imageUrl: evilUrl, createdAt: PUBLISHED_ITEM_TOP_AT }),
        async () => {
          await openHome(page, vp);
          const card = page.locator(ITEM_CARD, { hasText: name });
          await expect(card, '前提: 入れた商品のカードがホームに出ている').toHaveCount(1);
          const attributes = await card.locator('img').evaluateAll((images) =>
            images.map((image) => `${image.getAttribute('src') ?? ''} ${image.getAttribute('srcset') ?? ''}`),
          );
          for (const attribute of attributes) {
            expect(attribute, 'カードの画像の src・srcset に外の住所が含まれない').not.toContain('evil.example');
          }
          expect(await card.evaluate((element) => element.outerHTML), 'カードの HTML に外の住所が含まれない').not.toContain('evil.example');
        },
      );
    });

    test(`SEC-HOME-007-AC-01 ${vp.name}: ホームの商品のカードの画像と、LOOK のカードの関連商品の画像の署名つき URL の期限が、開いた時から1時間以内`, async ({ page, request, baseURL }) => {
      test.fail(true, 'SEC-HOME-007 今のコードは満たさない（docs/02_Requirements/areas/home.md）');
      expect(baseURL).toBeTruthy();
      await openHome(page, vp);
      const cardImageSrcs = await page
        .locator(`${ITEM_CARD} img`)
        .evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
      const raw = await (await request.get('/')).text();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const limitSeconds = 60 * 60;

      const cardTokens = cardImageSrcs
        .map((src) => readSignedToken(originalImageUrl(src, baseURL as string)))
        .filter((token) => token !== null)
        .filter((token) => token.path.startsWith('item-images/'));
      expect(cardTokens.length, '前提: ITEM のカードの画像が署名つきの URL で出ている（手元の Storage に見本の画像がある）').toBeGreaterThan(0);
      for (const token of cardTokens) {
        expect(token.exp - nowSeconds, `ITEM のカードの画像の署名の期限（${token.path}）が1時間以内`).toBeLessThanOrEqual(limitSeconds);
      }

      const linkedTokens = linkedItemImageUrls(raw)
        .map((url) => readSignedToken(url))
        .filter((token) => token !== null)
        .filter((token) => token.path.startsWith('item-images/'));
      expect(linkedTokens.length, '前提: LOOK のカードの関連商品の画像が署名つきの URL で渡っている').toBeGreaterThan(0);
      for (const token of linkedTokens) {
        expect(token.exp - nowSeconds, `LOOK の関連商品の画像の署名の期限（${token.path}）が1時間以内`).toBeLessThanOrEqual(limitSeconds);
      }
    });

    test(`SEC-HOME-008-AC-01 ${vp.name}: 商品名と NEWS の題に入れた <img onerror> の文が、カードに字のまま表示され、ダイアログも window.__xss も端末の記録の変化も起きない`, async ({ page }) => {
      test.setTimeout(120_000);
      const tag = homeTag('s008a1');
      const payload = `<img src=x onerror=window.__xss=1> ${tag}`;
      const dialogs: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const payloadRequests: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`${message.text()} ${message.location().url}`);
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      // 入れた文の img（src=x）が要素になって読み込まれたなら、/x への要求が出る
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/x') payloadRequests.push(request.url());
      });
      await withPublishedHomeRows(
        async (db, rows) => {
          await insertPublishedItem(db, rows, { name: payload, imageUrl: SEEDED_ITEM_IMAGE, createdAt: PUBLISHED_ITEM_TOP_AT });
          await insertPublishedNews(db, rows, { title: payload, publishedDate: PUBLISHED_NEWS_DATE });
        },
        async () => {
          await openHome(page, vp);
          await page.waitForLoadState('load');
          await expect(page.locator(ITEM_NAME, { hasText: tag }), '商品名が字のまま表示される').toHaveText(payload);
          await expect(page.locator('#news h3', { hasText: tag }), 'NEWS の題が字のまま表示される').toHaveText(payload);
          await expect(page.locator('#items img[src="x"], #news img[src="x"]'), '入れた文から img の要素が作られない').toHaveCount(0);
          await page.waitForLoadState('networkidle');
          expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss), 'onerror が動かない').toBeUndefined();
          expect(dialogs, 'ダイアログが開かない').toEqual([]);
          expect(payloadRequests, '入れた文の img（src=x）の読み込みが起きない').toEqual([]);
          const fromPayload = (text: string) => text.includes(tag) || /onerror|__xss/.test(text);
          expect(consoleErrors.filter(fromPayload), '入れた文に由来する端末の記録（error）が出ない').toEqual([]);
          expect(pageErrors.filter(fromPayload), '入れた文に由来する実行時の誤りが出ない').toEqual([]);
        },
      );
    });
  });
}

// SEC-HOME-013-AC-01 はホームの HTML だけを読み、画面の幅に依存しない。幅ごとに流すと公開の商品を足す回数が増えて
// 他の試験との干渉が増えるだけなので、1 回だけ流す。
// カードの枚数（今のコードは満たす）と HTML に渡る商品の記録の数（今のコードは満たさない）は、片方の失敗がもう片方を隠さないよう別の試験にする。
async function readHomeHtmlWithTenPublishedItems(request: APIRequestContext): Promise<string> {
  let html = '';
  await withPublishedHomeRows(
    async (db, rows) => {
      for (let n = 1; n <= 5; n += 1) {
        await insertPublishedItem(db, rows, {
          name: homeTag(`s013a1-${n}`),
          imageUrl: SEEDED_ITEM_IMAGE,
          createdAt: `2026-06-06T12:00:0${n}Z`,
        });
      }
      return countPublishedItems(db);
    },
    async (published) => {
      expect(published, '前提: 公開の商品が10件以上ある').toBeGreaterThanOrEqual(10);
      const response = await request.get('/');
      expect(response.ok()).toBe(true);
      html = await response.text();
    },
  );
  return html;
}

test('SEC-HOME-013-AC-01 公開の商品を10件以上にしてホームの HTML を読むと、含まれる商品のカードの数が ITEM の節で描く上限（8件）以下', async ({ request }) => {
  test.setTimeout(120_000);
  const html = await readHomeHtmlWithTenPublishedItems(request);
  const cards = countItemCards(html);
  expect(cards, 'HTML の商品のカードが1枚以上ある').toBeGreaterThan(0);
  expect(cards, 'HTML の商品のカードが ITEM の節で描く上限（8件）以下').toBeLessThanOrEqual(8);
});

test('SEC-HOME-013-AC-01 公開の商品を10件以上にしてホームの HTML を読むと、HTML に渡る商品の記録の数が ITEM の節で描く上限（8件）以下', async ({ request }) => {
  test.setTimeout(120_000);
  const html = await readHomeHtmlWithTenPublishedItems(request);
  const records = countItemRecords(html);
  // 記録の鍵の名前（madeToOrder）が変わると 0 件になって黙って通るので、1 件以上あることも確かめる
  expect(records, 'HTML に商品の記録（madeToOrder）が渡っている').toBeGreaterThan(0);
  expect(records, 'HTML に渡っている商品の記録が ITEM の節で描く上限（8件）以下').toBeLessThanOrEqual(8);
});
