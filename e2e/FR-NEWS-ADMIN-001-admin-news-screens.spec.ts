import { expect, test, type Locator, type Page } from '@playwright/test';
import { fulfillJson, mockAdminSession, viewports } from './order-fulfillment-test-utils';

// FR-ADMIN-003: 管理画面の NEWS タブで、記事の一覧・作成・編集・削除・公開の切り替えができる
// FREQ-14: News 管理でエラーが発生せず、登録・編集・削除が完了する
// FREQ-252: 作成と編集のフォームの画像の欄（有無・必須・種類と大きさ）
// SEC-NEWS-020 / SEC-NEWS-012: 一覧の取得の失敗の表示と、編集のページが窓口の外へ要求を送らないこと
//
// 管理者の本物のログイン（2要素認証 aal2）は E2E に無いので、管理画面の約束（mockAdminSession）と、
// メモリ上の記事の配列を持つ /api/admin/news の窓口の差し替えで確かめる（FR-ADMIN-108 と同じ手本）。
// SEC-NEWS-020-AC-01 は、今のコードでは満たさない（赤の予定。SEC-NEWS-020 の「今のコードは満たさない」）。

type MockArticle = {
  id: string;
  title: string;
  category: string;
  published_date: string;
  image_url: string;
  content: string;
  detailed_content: string;
  status: 'private' | 'published';
};

type NewsCall = { method: string; path: string; body: string };

const PUBLISHED_ARTICLE: MockArticle = {
  id: 'news-1',
  title: '秋冬コレクションのお知らせ',
  category: 'COLLECTION',
  published_date: '2026-10-01',
  image_url: '/news1.png',
  content: '秋冬の要約',
  detailed_content: '秋冬の詳細',
  status: 'published',
};

const PRIVATE_ARTICLE: MockArticle = {
  id: 'news-2',
  title: '下書きの店舗ニュース',
  category: 'STORE',
  published_date: '2026-10-15',
  image_url: '/news2.png',
  content: '店舗の要約',
  detailed_content: '店舗の詳細',
  status: 'private',
};

/** 1x1 の PNG（画像の添付に使う） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** multipart の本文から、その名前の欄の値を読む（無ければ null） */
function formField(body: string, name: string): string | null {
  const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  return match ? match[1] : null;
}

/**
 * 記事の窓口（一覧 GET・作成 POST、1件の GET・PUT・PATCH・DELETE）をメモリ上の配列で差し替える。
 * 受けた要求は calls に残す。一覧の GET を落としたい時は listStatus に 500 などを入れる。
 */
async function mockNewsApi(
  page: Page,
  seed: MockArticle[],
  options: { listStatus?: number } = {},
): Promise<{ articles: MockArticle[]; calls: NewsCall[] }> {
  const articles = [...seed];
  const calls: NewsCall[] = [];
  let sequence = seed.length;

  await page.route(
    (url) => url.pathname === '/api/admin/news',
    async (route) => {
      const request = route.request();
      const body = request.postDataBuffer()?.toString('utf8') ?? '';
      calls.push({ method: request.method(), path: new URL(request.url()).pathname, body });

      if (request.method() === 'POST') {
        sequence += 1;
        const created: MockArticle = {
          id: `news-${sequence}`,
          title: formField(body, 'title') ?? '',
          category: formField(body, 'category') ?? '',
          published_date: formField(body, 'date') ?? '',
          image_url: '/news1.png',
          content: formField(body, 'content') ?? '',
          detailed_content: formField(body, 'detailedContent') ?? '',
          status: formField(body, 'status') === 'published' ? 'published' : 'private',
        };
        articles.unshift(created);
        await fulfillJson(route, { data: { id: created.id } }, 201);
        return;
      }

      if (options.listStatus && options.listStatus >= 400) {
        await fulfillJson(route, { error: 'Failed to fetch news' }, options.listStatus);
        return;
      }
      await fulfillJson(route, { data: articles });
    },
  );

  await page.route(
    (url) => /^\/api\/admin\/news\/[^/]+$/.test(url.pathname),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const id = path.split('/').pop() ?? '';
      const body = request.postDataBuffer()?.toString('utf8') ?? '';
      calls.push({ method: request.method(), path, body });

      const index = articles.findIndex((article) => article.id === id);
      if (index < 0) {
        await fulfillJson(route, {}, 404);
        return;
      }

      switch (request.method()) {
        case 'PUT': {
          articles[index] = {
            ...articles[index],
            title: formField(body, 'title') ?? articles[index].title,
            category: formField(body, 'category') ?? articles[index].category,
            published_date: formField(body, 'date') ?? articles[index].published_date,
            content: formField(body, 'content') ?? articles[index].content,
            detailed_content: formField(body, 'detailedContent') ?? articles[index].detailed_content,
            status: formField(body, 'status') === 'published' ? 'published' : 'private',
          };
          await fulfillJson(route, { data: articles[index] });
          return;
        }
        case 'PATCH': {
          const patch = request.postDataJSON() as { status: MockArticle['status'] };
          articles[index] = { ...articles[index], status: patch.status };
          await fulfillJson(route, { data: articles[index] });
          return;
        }
        case 'DELETE': {
          articles.splice(index, 1);
          await fulfillJson(route, { ok: true });
          return;
        }
        default:
          await fulfillJson(route, { data: articles[index] });
      }
    },
  );

  return { articles, calls };
}

/** 一覧の 1 件ぶんのカード（題の見出しで探す） */
function cardOf(page: Page, title: string): Locator {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { level: 4, name: title, exact: true }) });
}

/** 作成と編集のフォームの欄に値を入れる（画像と状態は別に扱う） */
async function fillArticleForm(
  page: Page,
  values: { title: string; date: string; content: string; detailedContent: string },
): Promise<void> {
  await page.getByRole('textbox', { name: 'タイトル' }).fill(values.title);
  await page.getByLabel('公開日').fill(values.date);
  await page.getByRole('textbox', { name: '本文（要約）' }).fill(values.content);
  await page.getByRole('textbox', { name: '本文（詳細）' }).fill(values.detailedContent);
}

async function chooseCategory(page: Page, category: string): Promise<void> {
  await page.getByRole('combobox', { name: 'カテゴリー' }).click();
  await page.getByRole('listbox').getByRole('option', { name: category, exact: true }).click();
}

/** ステータスの「公開」を選ぶ（「非公開」と取り違えないよう文字の全体で選ぶ） */
async function choosePublishedStatus(page: Page): Promise<void> {
  await page.locator('[data-ui-radio-item]').filter({ hasText: /^公開$/ }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-NEWS-ADMIN-001 admin news screens (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminSession(page);
    });

    test('FR-ADMIN-003-AC-01 NEWS タブに公開・非公開の記事が題・公開日・分類・状態つきで一覧に出る', async ({ page }) => {
      await mockNewsApi(page, [PUBLISHED_ARTICLE, PRIVATE_ARTICLE]);
      await page.goto('/admin?tab=NEWS');

      const published = cardOf(page, PUBLISHED_ARTICLE.title);
      await expect(published).toBeVisible();
      await expect(published.getByText(PUBLISHED_ARTICLE.published_date, { exact: true })).toBeVisible();
      await expect(published.getByText(PUBLISHED_ARTICLE.category, { exact: true })).toBeVisible();
      await expect(published.getByText('公開中', { exact: true })).toBeVisible();

      const privateCard = cardOf(page, PRIVATE_ARTICLE.title);
      await expect(privateCard).toBeVisible();
      await expect(privateCard.getByText(PRIVATE_ARTICLE.published_date, { exact: true })).toBeVisible();
      await expect(privateCard.getByText(PRIVATE_ARTICLE.category, { exact: true })).toBeVisible();
      await expect(privateCard.getByText('非公開', { exact: true })).toBeVisible();
      await expect(privateCard.getByText('公開中', { exact: true })).toHaveCount(0);
    });

    test('FR-ADMIN-003-AC-02 新規作成で保存すると「保存しました」が出て、NEWS タブの一覧にその記事が出る', async ({ page }) => {
      const { calls } = await mockNewsApi(page, [PUBLISHED_ARTICLE]);
      await page.goto('/admin/news/create');

      await fillArticleForm(page, {
        title: '冬の新作の発売のお知らせ',
        date: '2026-11-01',
        content: '冬の新作の要約',
        detailedContent: '冬の新作の詳細な本文',
      });
      await chooseCategory(page, 'EVENT');
      await choosePublishedStatus(page);
      await page.locator('input[type="file"]').setInputFiles({
        name: 'news.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      });
      await expect(page.getByText('news.png (新規)')).toBeVisible();

      await page.getByRole('button', { name: '保存', exact: true }).click();

      await expect(page.getByText('保存しました', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/admin\?tab=NEWS$/);

      const posts = calls.filter((call) => call.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(formField(posts[0].body, 'title')).toBe('冬の新作の発売のお知らせ');
      expect(formField(posts[0].body, 'category')).toBe('EVENT');
      expect(formField(posts[0].body, 'date')).toBe('2026-11-01');
      expect(formField(posts[0].body, 'content')).toBe('冬の新作の要約');
      expect(formField(posts[0].body, 'detailedContent')).toBe('冬の新作の詳細な本文');
      expect(formField(posts[0].body, 'status')).toBe('published');
      expect(posts[0].body).toContain('name="image"');

      const created = cardOf(page, '冬の新作の発売のお知らせ');
      await expect(created).toBeVisible();
      await expect(created.getByText('2026-11-01', { exact: true })).toBeVisible();
      await expect(created.getByText('EVENT', { exact: true })).toBeVisible();
      await expect(created.getByText('公開中', { exact: true })).toBeVisible();
    });

    test('FR-ADMIN-003-AC-03 編集で題を変えて更新すると「更新しました」が出て、NEWS タブの一覧に新しい題が出る', async ({ page }) => {
      const { calls } = await mockNewsApi(page, [PUBLISHED_ARTICLE, PRIVATE_ARTICLE]);
      await page.goto('/admin?tab=NEWS');

      await cardOf(page, PUBLISHED_ARTICLE.title).getByRole('link', { name: '編集', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/news\/edit\/news-1$/);

      const titleBox = page.getByRole('textbox', { name: 'タイトル' });
      await expect(titleBox).toHaveValue(PUBLISHED_ARTICLE.title);
      await titleBox.fill('秋冬コレクションの発売日のお知らせ');
      await page.getByRole('button', { name: '更新', exact: true }).click();

      await expect(page.getByText('更新しました', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/admin\?tab=NEWS$/);

      const puts = calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0].path).toBe('/api/admin/news/news-1');
      expect(formField(puts[0].body, 'title')).toBe('秋冬コレクションの発売日のお知らせ');

      await expect(cardOf(page, '秋冬コレクションの発売日のお知らせ')).toBeVisible();
      await expect(cardOf(page, PUBLISHED_ARTICLE.title)).toHaveCount(0);
      await expect(cardOf(page, PRIVATE_ARTICLE.title)).toBeVisible();
    });

    test('FR-ADMIN-003-AC-04 削除を押して確かめに同意すると、NEWS タブの一覧からその記事が表示されなくなる', async ({ page }) => {
      const { calls } = await mockNewsApi(page, [PUBLISHED_ARTICLE, PRIVATE_ARTICLE]);
      await page.goto('/admin?tab=NEWS');

      const target = cardOf(page, PUBLISHED_ARTICLE.title);
      await expect(target).toBeVisible();

      // 同意しない時は消えない
      const dialogMessages: string[] = [];
      page.once('dialog', (dialog) => {
        dialogMessages.push(dialog.message());
        void dialog.dismiss();
      });
      await target.getByRole('button', { name: '削除', exact: true }).click();
      await expect.poll(() => dialogMessages.length).toBe(1);
      expect(dialogMessages[0]).toContain('削除');
      await expect(target).toBeVisible();
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

      // 同意すると消える
      page.once('dialog', (dialog) => {
        void dialog.accept();
      });
      await target.getByRole('button', { name: '削除', exact: true }).click();

      await expect(cardOf(page, PUBLISHED_ARTICLE.title)).toHaveCount(0);
      expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
        '/api/admin/news/news-1',
      ]);
      await expect(cardOf(page, PRIVATE_ARTICLE.title)).toBeVisible();
    });

    test('FR-ADMIN-003-AC-05 非公開で「公開」を押すと「公開中」に、公開中で「非公開」を押すと「非公開」に変わる', async ({ page }) => {
      const { calls } = await mockNewsApi(page, [PRIVATE_ARTICLE]);
      await page.goto('/admin?tab=NEWS');

      const card = cardOf(page, PRIVATE_ARTICLE.title);
      await expect(card.getByText('非公開', { exact: true })).toBeVisible();
      await expect(card.getByText('公開中', { exact: true })).toHaveCount(0);

      await card.getByRole('button', { name: '公開', exact: true }).click();
      await expect(card.getByText('公開中', { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: '非公開', exact: true })).toBeVisible();

      await card.getByRole('button', { name: '非公開', exact: true }).click();
      await expect(card.getByText('公開中', { exact: true })).toHaveCount(0);
      await expect(card.getByText('非公開', { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: '公開', exact: true })).toBeVisible();

      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches.map((call) => call.path)).toEqual([
        '/api/admin/news/news-2',
        '/api/admin/news/news-2',
      ]);
      expect(patches.map((call) => JSON.parse(call.body))).toEqual([
        { status: 'published' },
        { status: 'private' },
      ]);
    });

    test('FREQ-14-AC-01 News 管理で登録・編集・削除を通して、エラーの文も pageerror も出ずに完了する', async ({ page }) => {
      const pageErrors: string[] = [];
      const unexpectedDialogs: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('dialog', (dialog) => {
        // 削除の確かめ（confirm）には同意する。失敗を知らせる alert が出たら記録する
        if (dialog.type() === 'confirm') {
          void dialog.accept();
          return;
        }
        unexpectedDialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const errorText = page.getByText(/失敗|エラー/);

      await mockNewsApi(page, []);
      await page.goto('/admin?tab=NEWS');
      await expect(page.getByText('ニュース記事がありません', { exact: true })).toBeVisible();

      // 登録
      await page.getByRole('link', { name: '新規作成', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/news\/create$/);
      await fillArticleForm(page, {
        title: '登録した記事',
        date: '2026-11-02',
        content: '登録した要約',
        detailedContent: '登録した詳細',
      });
      await page.locator('input[type="file"]').setInputFiles({
        name: 'news.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('保存しました', { exact: true })).toBeVisible();
      await expect(errorText).toHaveCount(0);
      await expect(page).toHaveURL(/\/admin\?tab=NEWS$/);
      await expect(cardOf(page, '登録した記事')).toBeVisible();

      // 編集
      await cardOf(page, '登録した記事').getByRole('link', { name: '編集', exact: true }).click();
      const titleBox = page.getByRole('textbox', { name: 'タイトル' });
      await expect(titleBox).toHaveValue('登録した記事');
      await titleBox.fill('編集した記事');
      await page.getByRole('button', { name: '更新', exact: true }).click();
      await expect(page.getByText('更新しました', { exact: true })).toBeVisible();
      await expect(errorText).toHaveCount(0);
      await expect(page).toHaveURL(/\/admin\?tab=NEWS$/);
      await expect(cardOf(page, '編集した記事')).toBeVisible();

      // 削除
      await cardOf(page, '編集した記事').getByRole('button', { name: '削除', exact: true }).click();
      await expect(cardOf(page, '編集した記事')).toHaveCount(0);
      await expect(page.getByText('ニュース記事がありません', { exact: true })).toBeVisible();
      await expect(errorText).toHaveCount(0);

      expect(pageErrors).toEqual([]);
      expect(unexpectedDialogs).toEqual([]);
    });

    test('FREQ-252-AC-01 News の作成フォームと編集フォームの両方に「画像」欄と file 入力がある', async ({ page }) => {
      await mockNewsApi(page, [PUBLISHED_ARTICLE]);

      await page.goto('/admin/news/create');
      await expect(page.getByRole('textbox', { name: 'タイトル' })).toBeVisible();
      await expect(page.getByText('画像', { exact: true })).toBeVisible();
      await expect(page.locator('input[type="file"]')).toHaveCount(1);
      await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', /image\/jpeg/);

      await page.goto('/admin/news/edit/news-1');
      await expect(page.getByRole('textbox', { name: 'タイトル' })).toHaveValue(PUBLISHED_ARTICLE.title);
      await expect(page.getByText('画像', { exact: true })).toBeVisible();
      await expect(page.locator('input[type="file"]')).toHaveCount(1);
      await expect(page.locator('input[type="file"]')).toHaveAttribute('accept', /image\/jpeg/);
    });

    test('FREQ-252-AC-02 作成で画像を付けずに送ると「画像を添付してください」が出て送信されず、編集では画像なしで更新できる', async ({ page }) => {
      const { calls } = await mockNewsApi(page, [PUBLISHED_ARTICLE]);

      // 作成モード: 画像なしでは送らない
      await page.goto('/admin/news/create');
      await fillArticleForm(page, {
        title: '画像のない記事',
        date: '2026-11-03',
        content: '要約',
        detailedContent: '詳細',
      });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('画像を添付してください', { exact: true })).toBeVisible();
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      await expect(page).toHaveURL(/\/admin\/news\/create$/);

      // 編集モード: 画像を選ばなくても更新できる
      await page.goto('/admin/news/edit/news-1');
      const titleBox = page.getByRole('textbox', { name: 'タイトル' });
      await expect(titleBox).toHaveValue(PUBLISHED_ARTICLE.title);
      await titleBox.fill('画像を変えずに直した題');
      await page.getByRole('button', { name: '更新', exact: true }).click();

      await expect(page.getByText('更新しました', { exact: true })).toBeVisible();
      await expect(page.getByText('画像を添付してください', { exact: true })).toHaveCount(0);
      const puts = calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(formField(puts[0].body, 'title')).toBe('画像を変えずに直した題');
      expect(puts[0].body).not.toContain('name="image"');
    });

    test('FREQ-252-AC-03 対象外の MIME と 5MB 超の画像は、それぞれの文言で断られる', async ({ page }) => {
      const { calls } = await mockNewsApi(page, []);
      await page.goto('/admin/news/create');
      const fileInput = page.locator('input[type="file"]');

      const typeMessage = page.getByText('画像は JPEG / PNG / WebP / GIF を選択してください', { exact: true });
      const sizeMessage = page.getByText('画像サイズは5MB以下にしてください', { exact: true });

      await fileInput.setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not an image'),
      });
      await expect(typeMessage).toBeVisible();
      await expect(sizeMessage).toHaveCount(0);
      await expect(page.getByAltText('画像プレビュー')).toHaveCount(0);

      await fileInput.setInputFiles({
        name: 'huge.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      });
      await expect(sizeMessage).toBeVisible();
      await expect(typeMessage).toHaveCount(0);
      await expect(page.getByAltText('画像プレビュー')).toHaveCount(0);

      expect(calls).toHaveLength(0);
    });

    test('SEC-NEWS-020-AC-01 一覧の取得が失敗した時、「ニュース記事がありません」ではなく取得に失敗したことを伝える文が出る', async ({ page }) => {
      test.fail(true, 'SEC-NEWS-020 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
      // 今のコードは失敗を 0 件と同じ「ニュース記事がありません」で見せるので、この試験は赤になる予定
      const { calls } = await mockNewsApi(page, [PUBLISHED_ARTICLE], { listStatus: 500 });
      await page.goto('/admin?tab=NEWS');

      await expect.poll(() => calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(0);
      await expect(page.getByText('読み込み中...', { exact: true })).toHaveCount(0);

      await expect(page.getByText(/(取得|読み込み)に失敗/).first()).toBeVisible();
      await expect(page.getByText('ニュース記事がありません', { exact: true })).toHaveCount(0);
    });

    test('SEC-NEWS-012-AC-03 編集のページは数でない id で /api/admin/news/ の外へ要求を送らず、読み込みの失敗の文を出す', async ({ page }) => {
      const apiPaths: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/api/')) {
          apiPaths.push(pathname);
        }
      });
      // 窓口の外へ出た要求が本物の窓口に届かないよう、/api は先に全部 404 で受ける（後から登録した窓口が先に効く）
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => fulfillJson(route, {}, 404),
      );
      await mockAdminSession(page);
      await mockNewsApi(page, [PUBLISHED_ARTICLE]);

      // 正しい id の編集のページが送る /api の道（ヘッダーの /api/cart・/api/wishlist や認証の確かめ）を先に記録し、
      // 細工した id の時に増えた道だけを見る。ブラウザが実際に送った pathname のまま判定し、復号やたたみはしない
      await page.goto(`/admin/news/edit/${PUBLISHED_ARTICLE.id}`);
      await expect(page.getByRole('textbox', { name: 'タイトル' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const baseline = new Set(apiPaths);

      for (const id of ['..%2F..%2Fnews', 'abc']) {
        apiPaths.length = 0;
        await page.goto(`/admin/news/edit/${id}`);

        await expect(page.getByText(/読み込みに失敗/)).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'タイトル' })).toHaveCount(0);
        await page.waitForLoadState('networkidle');

        const outside = apiPaths.filter(
          (pathname) => !baseline.has(pathname) && !pathname.startsWith('/api/admin/news/'),
        );
        expect(outside, `id=${id} で窓口の外へ出た要求`).toEqual([]);
      }
    });
  });
}
