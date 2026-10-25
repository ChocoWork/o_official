import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { csrfCookieName } from '../src/lib/cookie';
import type { AdminSessionActor } from './admin-session-test-utils';
import {
  countLooksByTheme,
  createLookAdmin,
  insertPrivateLook,
  lookIdByTheme,
  purgeLooksByThemePrefix,
  signInAsLookAdmin,
  sinkLook,
  tinyPng,
  useOwnClientAddress,
} from './look-admin-test-utils';

/**
 * 管理画面の LOOK タブ（一覧・作成・編集・削除・商品の紐づけ）の受け付け基準。
 * FR-ADMIN-005-AC-01〜05 と、それを束ねる FREQ-17-AC-01。
 *
 * 管理者は本物の aal2 の店長（admin.looks.manage）。JWT を Cookie に入れて、画面も窓口（/api/admin/looks）も
 * 本物の認可で動かす（look-admin-test-utils.ts）。作った LOOK は DB のテーマの前方一致で、置き場の画像と一緒に毎回消す。
 * JWT の Cookie が通信記録に残らないよう、trace は切る。
 *
 * 試験は互いに独立（各試験が自分の LOOK を作る）。1つが落ちても、ほかの AC の確かめは止まらない。
 */
test.use({ trace: 'off' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** seed の LOOK 1（supabase/seed.sql）。公開・2026 SS */
const SEED_LOOK = { id: 1, theme: 'Aoi Weekend Layers', season: '2026 SS' } as const;
/** seed の公開の商品 1（supabase/seed.sql） */
const LINKED_ITEM = 'Aoi Linen Tunic';
const CONFIRM_MESSAGE = 'このLOOKを削除してもよろしいですか？';
const FAILURE_WORD = '失敗しました';
const LOOK_TAB_URL = /\/admin\?tab=LOOK/;
/** この実行（この worker）の LOOK だけを見つけて消すための印。テーマの先頭に付ける */
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

const FALLBACK_BASE_URL = 'http://localhost:3000';

/** LOOK タブの一覧の1枚（テーマの文字が入ったカード） */
const lookCard = (page: Page, theme: string): Locator =>
  page.getByRole('article').filter({ has: page.getByText(theme, { exact: true }) });

/** カードの画像が実際に読み込めている（非公開の置き場の署名付きの URL が通っている） */
async function expectImageLoaded(card: Locator, theme: string): Promise<void> {
  const image = card.getByRole('img', { name: theme, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
}

type CreateInput = { theme: string; seasonYear: number; seasonType: 'SS' | 'AW'; status: 'private' | 'published' };

/** 作成の頁で、画像・シーズン・テーマ・紐づける商品を入れて保存し、LOOK タブへ戻るまで進める */
async function createLookThroughForm(page: Page, input: CreateInput): Promise<void> {
  await page.goto('/admin/look/create');

  // 商品の一覧が出たら、頁は画面側で動いている（この前に画像を選ぶと、動き出す前の操作が落ちる）
  const item = page.getByText(LINKED_ITEM, { exact: true });
  await expect(item).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({ name: 'e2e-look.png', mimeType: 'image/png', buffer: tinyPng() });
  await expect(page.getByRole('img', { name: 'プレビュー 1' })).toBeVisible();

  const seasonSelects = page.locator('form').getByRole('combobox');
  await seasonSelects.nth(0).click();
  await page.getByRole('option', { name: String(input.seasonYear), exact: true }).click();
  await seasonSelects.nth(1).click();
  await page.getByRole('option', { name: input.seasonType, exact: true }).click();

  await page.getByPlaceholder('例: Effortless Elegance').fill(input.theme);
  await page.getByPlaceholder('このシーズンテーマの説明文を入力してください').fill('E2E の LOOK の説明文');
  await item.click();
  if (input.status === 'published') {
    await page.locator('input[name="status"][value="published"]').check();
  }

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(LOOK_TAB_URL);
}

/** 編集の頁で、テーマを直して更新し、LOOK タブへ戻るまで進める（頁は呼ぶ側が開く） */
async function changeThemeThroughForm(page: Page, from: string, to: string): Promise<void> {
  const theme = page.getByPlaceholder('例: Effortless Elegance');
  // 今の値が入るまで待つ（取り出しが済み、画面側が動いている印）
  await expect(theme).toHaveValue(from);
  await theme.fill(to);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page).toHaveURL(LOOK_TAB_URL);
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-LOOK-ADMIN-001 管理画面の LOOK タブ ${vp.name}`, () => {
    const prefix = `E2E-LOOK-ADMIN-${RUN}-${vp.name}`;
    // 回数の制限は操作者ごとにも数えるので、worker ごとに1人の店長を作る
    let admin: AdminSessionActor;
    const seasonYear = new Date().getFullYear() + 2;

    test.beforeAll(async () => {
      admin = await createLookAdmin();
    });

    test.beforeEach(async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signInAsLookAdmin(context, admin, baseURL ?? FALLBACK_BASE_URL);
      // 画面の clientFetch は、書き込みの前に読める CSRF の Cookie が無いとセッションの更新を撃ち、refresh token の無いこの試験の session を「失効」と見なす。
      // refresh token の無い session ではサーバーは CSRF を求めない（requireCsrfOrDeny）ので、値はなんでもよい。
      await context.addCookies([
        { name: csrfCookieName, value: 'e2e-look-admin', url: baseURL ?? FALLBACK_BASE_URL, httpOnly: false, sameSite: 'Lax' },
      ]);
      await useOwnClientAddress(page);
    });

    // 途中で落ちても、作った LOOK と置き場の画像を残さない
    test.afterEach(async () => {
      await purgeLooksByThemePrefix(prefix);
    });

    test(`FR-ADMIN-005-AC-01 ${vp.name} LOOK タブに画像・公開の状態・シーズン・テーマつきで LOOK の一覧が出る`, async ({ page }) => {
      const privateTheme = `${prefix}-ac01-private`;
      await insertPrivateLook(privateTheme);

      await page.goto('/admin?tab=LOOK');

      // 登録済みの公開の LOOK（seed の LOOK 1）
      const published = lookCard(page, SEED_LOOK.theme);
      await expect(published).toHaveCount(1);
      await expectImageLoaded(published, SEED_LOOK.theme);
      await expect(published.locator('[data-ui-tag-label]')).toHaveText('公開中');
      await expect(published.getByText(SEED_LOOK.season, { exact: true })).toBeVisible();
      await expect(published.getByText(SEED_LOOK.theme, { exact: true })).toBeVisible();

      // 非公開の LOOK は「非公開」の状態で出る
      const hidden = lookCard(page, privateTheme);
      await expect(hidden).toHaveCount(1);
      await expectImageLoaded(hidden, privateTheme);
      await expect(hidden.locator('[data-ui-tag-label]')).toHaveText('非公開');
      await expect(hidden.getByText('2026 SS', { exact: true })).toBeVisible();
      await expect(hidden.getByText(privateTheme, { exact: true })).toBeVisible();
    });

    test(`FR-ADMIN-005-AC-02 ${vp.name} 作成の頁で画像・シーズン・テーマ・商品を入れて保存すると一覧にその LOOK が出る`, async ({ page }) => {
      const theme = `${prefix}-ac02`;

      await createLookThroughForm(page, { theme, seasonYear, seasonType: 'SS', status: 'private' });

      const card = lookCard(page, theme);
      await expect(card).toHaveCount(1);
      await expectImageLoaded(card, theme);
      await expect(card.getByText(`${seasonYear} SS`, { exact: true })).toBeVisible();
      await expect(card.getByText(theme, { exact: true })).toBeVisible();
      await expect(card.locator('[data-ui-tag-label]')).toHaveText('非公開');
    });

    test(`FR-ADMIN-005-AC-03 ${vp.name} 編集の頁でテーマを直して保存すると一覧に直したテーマが出る`, async ({ page }) => {
      const before = `${prefix}-ac03-before`;
      const after = `${prefix}-ac03-after`;
      const id = await insertPrivateLook(before);

      await page.goto(`/admin/look/edit/${id}`);
      await changeThemeThroughForm(page, before, after);

      await expect(lookCard(page, after)).toHaveCount(1);
      await expect(lookCard(page, after).getByText(after, { exact: true })).toBeVisible();
      await expect(lookCard(page, before)).toHaveCount(0);
    });

    test(`FR-ADMIN-005-AC-04 ${vp.name} LOOK タブで削除を押して確かめに同意するとその LOOK が一覧から無くなる`, async ({ page }) => {
      const theme = `${prefix}-ac04`;
      await insertPrivateLook(theme);

      await page.goto('/admin?tab=LOOK');
      const card = lookCard(page, theme);
      await expect(card).toHaveCount(1);

      const dialogs: string[] = [];
      page.once('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
      });
      await card.getByRole('button', { name: '削除', exact: true }).click();

      await expect(lookCard(page, theme)).toHaveCount(0);
      // 確かめの文が出て、同意した後に消えた
      expect(dialogs).toEqual([CONFIRM_MESSAGE]);
      // 画面だけでなく、窓口が実際に消している
      expect(await countLooksByTheme(theme)).toBe(0);
    });

    test(`FR-ADMIN-005-AC-05 ${vp.name} 公開の商品を紐づけて公開にした LOOK の /look/{id} に、その商品が関連商品として出る`, async ({ page }) => {
      const theme = `${prefix}-ac05`;

      // 非公開で作り、並びの最後へ送ってから、LOOK タブの「公開」で公開にする。
      // 新しい LOOK を公開のまま作ると、送るまでの間 /look とホームの先頭の LOOK になり、同時に流れる他の spec の「最初の LOOK」を奪う
      await createLookThroughForm(page, { theme, seasonYear, seasonType: 'SS', status: 'private' });
      const id = await lookIdByTheme(theme);
      await sinkLook(id);

      await page.goto('/admin?tab=LOOK');
      const card = lookCard(page, theme);
      await expect(card.locator('[data-ui-tag-label]')).toHaveText('非公開');
      await card.getByRole('button', { name: '公開', exact: true }).click();
      await expect(card.locator('[data-ui-tag-label]')).toHaveText('公開中');

      await page.goto(`/look/${id}`);

      await expect(page.getByRole('heading', { level: 1, name: theme })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Look not found' })).toHaveCount(0);
      const layout = page.locator('[data-testid="look-detail-layout"]');
      await expect(layout.locator('a[href="/item/1"]').filter({ hasText: LINKED_ITEM }).first()).toBeVisible();
      await expect(layout.getByText('紐づけ商品はありません')).toHaveCount(0);
    });

    test(`FREQ-17-AC-01 ${vp.name} Look 管理でエラーが出ず、登録・編集・削除が完了する`, async ({ page }) => {
      test.setTimeout(90_000);
      const created = `${prefix}-freq17`;
      const edited = `${prefix}-freq17-edited`;

      // 失敗の知らせは、頁の文でも alert でも出る。どちらも拾う
      const dialogs: string[] = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
      });
      const noFailureShown = () => expect(page.getByText(FAILURE_WORD)).toHaveCount(0);

      // 登録
      await createLookThroughForm(page, { theme: created, seasonYear, seasonType: 'AW', status: 'private' });
      await expect(lookCard(page, created)).toHaveCount(1);
      await noFailureShown();

      // 編集（一覧の「編集」から入る）
      await lookCard(page, created).getByRole('link', { name: '編集', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/look\/edit\/\d+/);
      await changeThemeThroughForm(page, created, edited);
      await expect(lookCard(page, edited)).toHaveCount(1);
      await expect(lookCard(page, created)).toHaveCount(0);
      await noFailureShown();

      // 削除
      await lookCard(page, edited).getByRole('button', { name: '削除', exact: true }).click();
      await expect(lookCard(page, edited)).toHaveCount(0);
      await noFailureShown();

      // 確かめの文だけが出て、失敗の alert は出ていない
      expect(dialogs).toEqual([CONFIRM_MESSAGE]);
      expect(dialogs.some((message) => message.includes(FAILURE_WORD))).toBe(false);
      expect(await countLooksByTheme(edited)).toBe(0);
    });
  });
}
