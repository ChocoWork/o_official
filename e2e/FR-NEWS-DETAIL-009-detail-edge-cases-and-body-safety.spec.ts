import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Dialog, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';

// NEWS 詳細の端のケース（無い記事・非公開の記事・数でない id の 404、正しくない category、title の中身、本文の段落）と、
// 本文の安全（HTML の印・Markdown の javascript: のリンクが動かない）を確かめる。
// 前提: 手元の Supabase。記事は service role で入れ、試験ごとに自分の行だけを消す。
// 公開の行は公開日を 2000-01-01 にして、一覧の先頭を取る既存の試験や一覧の件数を崩さない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const NOT_FOUND_TEXT = 'This page could not be found';

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('記事を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function uniqueTitle(label: string): string {
  return `E2E news009 ${label} ${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 記事を1件入れて id を返す。終わりに消す関数も返す。 */
async function createArticle(input: {
  title: string;
  detailedContent: string;
  status: 'published' | 'private';
}): Promise<{ id: number; remove: () => Promise<void> }> {
  const admin = localAdmin();
  const { data, error } = await admin
    .from('news_articles')
    .insert({
      title: input.title,
      category: 'EVENT',
      published_date: '2000-01-01',
      image_url: 'e2e/news-1.png',
      content: 'E2E news009 summary.',
      detailed_content: input.detailedContent,
      status: input.status,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`記事を作れない（code: ${error?.code ?? '不明'}）`);
  }
  const id = (data as { id: number }).id;
  return {
    id,
    remove: async () => {
      await admin.from('news_articles').delete().eq('id', id);
    },
  };
}

/** 詳細の本文の入れ物（見出し h1 を含む塊の次の塊）。PREV/NEXT の p を数えないために範囲を絞る。 */
function bodyContainer(page: Page) {
  return page.locator('h1').locator('xpath=../following-sibling::div[1]');
}

/** ダイアログが出たら記録して閉じる（閉じないと頁が止まる）。 */
function collectDialogs(page: Page): string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog: Dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  return messages;
}

async function expectNotFound(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `${path} の状態`).toBe(404);
  await expect(page.getByText(NOT_FOUND_TEXT)).toBeVisible();
  await expect(page.locator('h1').filter({ hasNotText: /^404$/ })).toHaveCount(0);
}

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`FR-NEWS-DETAIL-009 NEWS 詳細の端のケースと本文の安全 (${name} ${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test(`FR-NEWS-DETAIL-001-AC-02 ${name}: 存在しない id と非公開の記事の詳細は 404 で、題と本文が表示されない`, async ({ page }) => {
      const title = uniqueTitle('private-title');
      const bodyText = `private-body-${randomBytes(4).toString('hex')}`;
      const privateArticle = await createArticle({ title, detailedContent: bodyText, status: 'private' });

      try {
        // 存在しない id
        await expectNotFound(page, '/news/999999');

        // 非公開の記事
        await expectNotFound(page, `/news/${privateArticle.id}`);
        await expect(page.getByText(title)).toHaveCount(0);
        await expect(page.getByText(bodyText)).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(title);
        expect(html).not.toContain(bodyText);
      } finally {
        await privateArticle.remove();
      }
    });

    test(`FR-NEWS-DETAIL-004-AC-02 ${name}: category=INVALID_CATEGORY を付けて詳細を開くと記事が表示され、VIEW ALL のリンク先が /news になる`, async ({ page }) => {
      const title = uniqueTitle('invalid-category');
      const article = await createArticle({ title, detailedContent: '甲', status: 'published' });

      try {
        const response = await page.goto(`/news/${article.id}?category=INVALID_CATEGORY`, { waitUntil: 'domcontentloaded' });
        expect(response?.status()).toBe(200);

        // 記事が表示される（404 や空の頁ではない）
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        await expect(bodyContainer(page).locator('p')).toHaveText(['甲']);

        // VIEW ALL は category の無い /news を指す
        const viewAll = page.getByRole('link', { name: 'VIEW ALL' });
        await expect(viewAll).toHaveCount(1);
        await expect(viewAll).toHaveAttribute('href', '/news');
      } finally {
        await article.remove();
      }
    });

    test(`FR-NEWS-DETAIL-005-AC-01 ${name}: 詳細の title に記事の題と NEWS が含まれ、meta の description が空でない`, async ({ page }) => {
      const title = uniqueTitle('metadata');
      const article = await createArticle({ title, detailedContent: '甲\n\n乙\n\n丙', status: 'published' });

      try {
        await page.goto(`/news/${article.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

        await expect(page).toHaveTitle(new RegExp(escapeRegExp(title)));
        await expect(page).toHaveTitle(/NEWS/);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S/);
      } finally {
        await article.remove();
      }
    });

    test(`FR-NEWS-DETAIL-008-AC-01 ${name}: 空行で区切った本文が、区切りごとに別の p 要素として表示される`, async ({ page }) => {
      const title = uniqueTitle('paragraphs');
      const article = await createArticle({ title, detailedContent: '甲\n\n乙\n\n丙', status: 'published' });

      try {
        await page.goto(`/news/${article.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

        // 3つの区切りが3つの p になり、1つの塊にならない
        const paragraphs = bodyContainer(page).locator('p');
        await expect(paragraphs).toHaveCount(3);
        await expect(paragraphs).toHaveText(['甲', '乙', '丙']);
      } finally {
        await article.remove();
      }
    });

    test(`SEC-NEWS-012-AC-02 ${name}: /news/abc と /news/1.5 を開くと 404 の画面が表示される`, async ({ page }) => {
      await expectNotFound(page, '/news/abc');
      await expectNotFound(page, '/news/1.5');
    });

    test(`SEC-NEWS-013-AC-01 ${name}: 本文の <img src=x onerror=alert(1)> がそのままの文字で表示され、img が作られず、ダイアログが出ない`, async ({ page }) => {
      const title = uniqueTitle('html-body');
      const rawBody = '<img src=x onerror=alert(1)>';
      const article = await createArticle({ title, detailedContent: rawBody, status: 'published' });
      const dialogs = collectDialogs(page);

      try {
        await page.goto(`/news/${article.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

        // 印がそのままの文字として表示される
        await expect(bodyContainer(page).locator('p')).toHaveText([rawBody]);

        // 読み込みが終わった後も、img の要素が無く、ダイアログが出ていない
        await page.waitForLoadState('load');
        await expect(page.locator('img[src="x"]')).toHaveCount(0);
        await expect(bodyContainer(page).locator('img')).toHaveCount(0);
        expect(dialogs).toEqual([]);
      } finally {
        await article.remove();
      }
    });

    test(`SEC-NEWS-013-AC-02 ${name}: 本文の Markdown のリンクの先が javascript:alert(1) でも、href が javascript: で始まる a の要素が無い`, async ({ page }) => {
      const title = uniqueTitle('markdown-link');
      const rawBody = '前文 [x](javascript:alert(1)) 後文';
      const article = await createArticle({ title, detailedContent: rawBody, status: 'published' });
      const dialogs = collectDialogs(page);

      try {
        await page.goto(`/news/${article.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        // 頁が描かれた後（本文が出た後）に数える
        await expect(bodyContainer(page).locator('p')).toHaveCount(1);

        await page.waitForLoadState('load');
        await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
        expect(dialogs).toEqual([]);
      } finally {
        await article.remove();
      }
    });
  });
}
