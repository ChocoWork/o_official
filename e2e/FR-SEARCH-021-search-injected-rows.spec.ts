/**
 * FR-SEARCH-021 手元の Supabase に直接入れた行で確かめる検索の守り（非公開の除外・HTML の文字扱い・画像の署名）
 * 対応: SEC-SEARCH-001-AC-01 / SEC-SEARCH-001-AC-02 / SEC-SEARCH-013-AC-01 / SEC-SEARCH-015-AC-01 / SEC-SEARCH-016-AC-01
 *
 * 試験ごとに、他と重ならない目印の語（marker）を題に含む行を手元の DB へ入れ、finally で消す（公開の行は他の試験の件数に響くので短く置く）。
 * 入れる公開の行は、他の試験の `q=a`（候補・件数）や /item の先頭に混ざらないよう、題・説明に母音の a を含めず、作成日を 2000-01-01 にする。
 * 画面と API は本物の窓口（/search・/api/search・/api/suggest）を叩く。画面を開く試験は 3 つの幅で流し、HTTP だけの試験（幅で結果が変わらない）は 1 回だけ流す。
 * 共有の送り元 127.0.0.1 の枠（search:public 120 回/600 秒）を他の検索の試験と取り合わないよう、このファイルだけの
 * x-forwarded-for を付ける（SEC-SEARCH-006 が直って x-forwarded-for を信用しなくなると、この分離は効かなくなる）。
 *
 * 人気商品（001-AC-02）: 非公開の商品に「購入数が一番多い入金済みの注文」を付ける。注文は削除禁止の仕掛けがあり通常は消せないので、
 * 注文の行だけは session_replication_role = replica の接続で入れて消す（仕掛けが動かず、会計や在庫に何も書かれない）。
 * 画像の署名（015・016）: 置き場 item-images に試験用の物を置き、終わりに消す。
 *
 * 015・016 は今のコードが満たさない要件（署名に失敗した時や外の道筋・外のホストの時に元の値を返す）で、直すまで赤になる。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { SEED_IMAGE_PNG_BASE64 } from '../scripts/e2e/seed-storage';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { insertLegacyImageRow } from './legacy-image-rows';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.use({ extraHTTPHeaders: { 'x-forwarded-for': '198.18.21.21' } });

const ITEM_IMAGES_BUCKET = 'item-images';
const XSS_TITLE_TAIL = '<img src=x onerror=window.__xss=1>';
const ROW = '[data-testid="search-result-row"]';

type SearchHit = { id: string; title: string; imageUrl: string | null };
type SearchPayload = { items: SearchHit[]; looks: SearchHit[]; news: SearchHit[]; popularItems: SearchHit[] };

// 他の試験が q=a などで数える件数に混ざらないよう、母音の a を含まない目印にする
function newMarker(): string {
  const alphabet = '0123456789bcdfghjklmnpqrstvwxz';
  const bytes = randomBytes(10);
  return `zq${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL) || !isLocalUrl(LOCAL_DB_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

async function connect(replica: boolean): Promise<Client> {
  const db = new Client({ connectionString: LOCAL_DB_URL });
  try {
    await db.connect();
  } catch {
    await db.end().catch(() => undefined);
    throw new Error('手元の DB へ接続できない');
  }
  if (replica) {
    await db.query('set session_replication_role = replica');
  }
  return db;
}

/** 試験が入れた行・物を覚えておき、cleanup() で全部消す */
class InjectedRows {
  private readonly itemIds: number[] = [];
  private readonly lookIds: number[] = [];
  private readonly newsIds: number[] = [];
  private readonly orderIds: string[] = [];
  private readonly objectPaths: string[] = [];
  private orderDb: Client | null = null;

  private constructor(
    private readonly db: Client,
    private readonly storage: SupabaseClient,
  ) {}

  static async open(): Promise<InjectedRows> {
    requireLocalEnv();
    const storage = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return new InjectedRows(await connect(false), storage);
  }

  async insertItem(input: { name: string; status: 'published' | 'private'; imageUrl: string; description?: string }): Promise<number> {
    const result = await this.db.query(
      `insert into public.items (name, description, price, category, image_url, status, created_at)
       values ($1, $2, 1000, 'TOPS', $3, $4, '2000-01-01') returning id`,
      [input.name, input.description ?? 'zq', input.imageUrl, input.status],
    );
    const id = Number(result.rows[0].id);
    this.itemIds.push(id);
    return id;
  }

  /** legacyImageUrls が true なら、imageUrls を DB の CHECK（looks/ の下だけ）に合わない旧い行として入れる（ADR-0162） */
  async insertLook(input: {
    theme: string;
    status: 'published' | 'private';
    imageUrls?: string[];
    legacyImageUrls?: boolean;
  }): Promise<number> {
    const sql = `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at)
       values (2026, 'SS', $1, 'zq', $2::text[], $3, '2000-01-01') returning id`;
    const params = [input.theme, input.imageUrls ?? [], input.status];
    const id = input.legacyImageUrls
      ? await insertLegacyImageRow(this.db as unknown as PgClient, 'looks', 'looks_image_urls_path_check', sql, params)
      : Number((await this.db.query(sql, params)).rows[0].id);
    this.lookIds.push(id);
    return id;
  }

  /** image_url が空の記事は DB の CHECK（news/ の下だけ）より前からある旧い形なので、旧い行として入れる（ADR-0162） */
  async insertNews(input: { title: string; status: 'published' | 'private' }): Promise<number> {
    const id = await insertLegacyImageRow(
      this.db as unknown as PgClient,
      'news_articles',
      'news_articles_image_url_path_check',
      `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'STORE', '2000-01-01', '', $2, 'zq', $3) returning id`,
      [input.title, input.title, input.status],
    );
    this.newsIds.push(id);
    return id;
  }

  /** 置き場 item-images に実在の画像を置く（署名が「物が無いから失敗」にならないようにする） */
  async uploadItemImage(path: string): Promise<void> {
    const { error } = await this.storage
      .storage.from(ITEM_IMAGES_BUCKET)
      .upload(path, Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64'), { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`試験用の画像を置けなかった: ${path}（${error.message}）`);
    this.objectPaths.push(path);
  }

  /** 購入数が全商品で一番多くなる入金済みの注文を、その商品に付ける */
  async giveTopPurchaseCount(itemId: number, marker: string): Promise<void> {
    this.orderDb ??= await connect(true);
    const quantity = 1_000_000;
    const order = await this.orderDb.query(
      `insert into public.orders (session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, paid_amount, currency)
       values ($1, $2, 'paid'::public.order_status, $3, 0, $3, $3, 'jpy') returning id`,
      [`e2e-search021-${marker}`, `pi_e2e_search021_${marker}`, quantity],
    );
    const orderId = order.rows[0].id as string;
    this.orderIds.push(orderId);
    await this.orderDb.query(
      `insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total)
       values ($1, $2, 'zq popular', 1, $3, $3)`,
      [orderId, itemId, quantity],
    );
  }

  /** 入金済みの注文の購入数が一番多い商品の id（人気商品の並びの元） */
  async topPurchasedItemId(): Promise<number | null> {
    const result = await this.db.query(
      `select oi.item_id from public.order_items oi join public.orders o on o.id = oi.order_id
       where o.status = 'paid' and oi.line_kind = 'order'
       group by oi.item_id order by sum(oi.quantity) desc limit 1`,
    );
    return result.rows.length > 0 ? Number(result.rows[0].item_id) : null;
  }

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (this.orderDb) {
      const orderDb = this.orderDb;
      await attempt('注文の削除', async () => {
        if (this.orderIds.length > 0) {
          await orderDb.query('delete from public.order_items where order_id = any($1::uuid[])', [this.orderIds]);
          await orderDb.query('delete from public.orders where id = any($1::uuid[])', [this.orderIds]);
        }
      });
      await attempt('注文用の接続を閉じる', () => orderDb.end());
    }
    await attempt('商品の削除', async () => {
      if (this.itemIds.length > 0) await this.db.query('delete from public.items where id = any($1::bigint[])', [this.itemIds]);
    });
    await attempt('ルックの削除', async () => {
      if (this.lookIds.length > 0) await this.db.query('delete from public.looks where id = any($1::bigint[])', [this.lookIds]);
    });
    await attempt('ニュースの削除', async () => {
      if (this.newsIds.length > 0) await this.db.query('delete from public.news_articles where id = any($1::bigint[])', [this.newsIds]);
    });
    await attempt('置き場の画像の削除', async () => {
      if (this.objectPaths.length > 0) {
        const { error } = await this.storage.storage.from(ITEM_IMAGES_BUCKET).remove(this.objectPaths);
        if (error) throw new Error(error.message);
      }
    });
    await attempt('DB の接続を閉じる', () => this.db.end());

    if (failures.length > 0) {
      throw new Error(`試験用の行の後始末に失敗した: ${failures.join(' / ')}`);
    }
  }
}

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `${path} の状態`).toBe(200);
  return (await response.json()) as T;
}

async function readXssFlag(page: Page): Promise<string> {
  return page.evaluate(() => typeof (window as unknown as { __xss?: unknown }).__xss);
}

test.describe('FR-SEARCH-021 直接入れた行で確かめる検索の守り', () => {
  // 公開の行を入れる試験を同時に流さない（1本ずつ順に流す）。serial だと赤の試験の後が飛ばされるので default にする
  test.describe.configure({ mode: 'default' });

  test('SEC-SEARCH-003-AC-01: 記号だけの語で全件が返らず、/search?q=% は「検索結果はありません」になる', async ({ page, request }) => {
    const marker = newMarker();
    const rows = await InjectedRows.open();
    try {
      // 題に \ を含む公開の商品を 1 件（ほかの題・説明・本文には %・_・\ を含めない）
      const backslashTitle = `${marker} A\\B`;
      await rows.insertItem({ name: backslashTitle, status: 'published', imageUrl: '' });

      for (const q of ['%', '_', '\\%', '\\_', 'a,b).or(', "'--"]) {
        const body = await getJson<SearchPayload & { counts: { all: number } }>(request, `/api/search?q=${encodeURIComponent(q)}`);
        expect(body.counts.all, `q=${q}`).toBe(0);
      }

      await page.goto('/search?q=%25');
      await expect(page.getByText(/検索結果はありません/)).toBeVisible();
    } finally {
      await rows.cleanup();
    }
  });

  test('SEC-SEARCH-003-AC-01: バックスラッシュ 1 字の語は題にそれを含む 1 件だけを返す', async ({ request }) => {
    const marker = newMarker();
    const rows = await InjectedRows.open();
    try {
      // 題に \ を含む公開の商品を 1 件（ほかの題・説明・本文には %・_・\ を含めない）
      const backslashTitle = `${marker} A\\B`;
      const backslashId = await rows.insertItem({ name: backslashTitle, status: 'published', imageUrl: '' });

      const backslash = await getJson<SearchPayload & { counts: { all: number } }>(request, `/api/search?q=${encodeURIComponent('\\')}`);
      expect(backslash.counts.all, 'q=バックスラッシュ の件数').toBe(1);
      expect(backslash.items.map((hit) => hit.id)).toEqual([String(backslashId)]);
      expect(backslash.items[0]?.title).toBe(backslashTitle);
    } finally {
      await rows.cleanup();
    }
  });

  test(`SEC-SEARCH-001-AC-02: 購入数が一番多い非公開の商品の id が /api/search?q= の popularItems に含まれない`, async ({ request }) => {
    const marker = newMarker();
    const rows = await InjectedRows.open();
    try {
      const privateId = await rows.insertItem({ name: `${marker} private-popular`, status: 'private', imageUrl: '' });
      await rows.giveTopPurchaseCount(privateId, marker);
      // 前提: その商品が入金済みの購入数で全商品の一番になっている（公開なら人気商品の先頭に来る形）
      expect(await rows.topPurchasedItemId()).toBe(privateId);

      const payload = await getJson<SearchPayload>(request, '/api/search?q=');
      expect(payload.popularItems.length, '人気商品が空だと除外の確かめにならない').toBeGreaterThan(0);
      expect(payload.popularItems.map((hit) => hit.id)).not.toContain(String(privateId));
    } finally {
      await rows.cleanup();
    }
  });

  test(`SEC-SEARCH-016-AC-01: 置き場の決まった場所の外の道筋の商品は、物が実在しても imageUrl が null`, async ({ request }) => {
    const marker = newMarker();
    const rows = await InjectedRows.open();
    try {
      // 置き場の別の場所（other/）に実在する物を指す道筋。今のコードは署名して配ってしまう
      const outsidePath = `other/${marker}.png`;
      await rows.uploadItemImage(outsidePath);
      const outsideTitle = `${marker} outside-spot-item`;
      await rows.insertItem({ name: outsideTitle, status: 'published', imageUrl: outsidePath });

      // 同じ要件の「URL のホストが自分の Supabase」: 別のホストの URL の形でも、置き場の実在の物（items/ の下）を指す値は署名しない
      const hostPath = `items/${marker}-host.png`;
      await rows.uploadItemImage(hostPath);
      const hostTitle = `${marker} foreign-host-item`;
      await rows.insertItem({
        name: hostTitle,
        status: 'published',
        imageUrl: `https://example.com/storage/v1/object/public/${ITEM_IMAGES_BUCKET}/${hostPath}`,
      });

      const payload = await getJson<SearchPayload>(request, `/api/search?q=${encodeURIComponent(marker)}`);
      const outside = payload.items.find((hit) => hit.title === outsideTitle);
      const foreignHost = payload.items.find((hit) => hit.title === hostTitle);
      expect(outside, '決まった場所の外の商品が検索に出ること').toBeDefined();
      expect(foreignHost, '別のホストの商品が検索に出ること').toBeDefined();
      expect(outside?.imageUrl).toBeNull();
      expect(foreignHost?.imageUrl).toBeNull();
    } finally {
      await rows.cleanup();
    }
  });

  for (const viewport of viewports) {
    test.describe(`${viewport.name}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      });

      test(`SEC-SEARCH-001-AC-01 ${viewport.name}: 同じ語を題に含む非公開の商品・ルック・ニュースが、検索の画面・/api/search・/api/suggest のどれにも出ない`, async ({ page, request }) => {
        const marker = newMarker();
        const rows = await InjectedRows.open();
        try {
          const publicTitle = `${marker} published-item`;
          const privateItem = `${marker} private-item`;
          const privateLook = `${marker} private-look`;
          const privateNews = `${marker} private-news`;
          const privateTitles = [privateItem, privateLook, privateNews];
          // 対照: 公開の商品は同じ語で必ず出る（絞りではなく検索そのものが壊れていて何も出ない、を見分ける）
          await rows.insertItem({ name: publicTitle, status: 'published', imageUrl: '' });
          await rows.insertItem({ name: privateItem, status: 'private', imageUrl: '' });
          await rows.insertLook({ theme: privateLook, status: 'private' });
          await rows.insertNews({ title: privateNews, status: 'private' });

          await page.goto(`/search?q=${encodeURIComponent(marker)}`);
          const resultRows = page.locator(ROW);
          await expect(resultRows.filter({ hasText: publicTitle })).toHaveCount(1);
          await expect(resultRows).toHaveCount(1);
          for (const title of privateTitles) {
            await expect(resultRows.filter({ hasText: title })).toHaveCount(0);
          }

          const search = await getJson<SearchPayload>(request, `/api/search?q=${encodeURIComponent(marker)}`);
          expect(search.items.map((hit) => hit.title)).toContain(publicTitle);
          expect(search.items.map((hit) => hit.title)).not.toContain(privateItem);
          expect(search.looks.map((hit) => hit.title)).not.toContain(privateLook);
          expect(search.news.map((hit) => hit.title)).not.toContain(privateNews);

          const suggest = await getJson<{ suggestions: Array<{ label: string }> }>(
            request,
            `/api/suggest?q=${encodeURIComponent(marker)}`,
          );
          const labels = suggest.suggestions.map((suggestion) => suggestion.label);
          expect(labels).toContain(publicTitle);
          for (const title of privateTitles) {
            expect(labels).not.toContain(title);
          }
        } finally {
          await rows.cleanup();
        }
      });

      test(`SEC-SEARCH-013-AC-01 ${viewport.name}: 題に HTML を含む商品と q の HTML が文字として表示され、window.__xss が未定義のまま`, async ({ page }) => {
        const marker = newMarker();
        const rows = await InjectedRows.open();
        try {
          const title = `${marker} ${XSS_TITLE_TAIL}`;
          await rows.insertItem({ name: title, status: 'published', imageUrl: '' });

          // 保存された値: その題の一部で開くと、結果の題に <img の字がそのまま出る
          await page.goto(`/search?q=${encodeURIComponent(`${marker} <img src=x`)}`);
          const storedRow = page.locator(ROW).filter({ hasText: marker });
          await expect(storedRow).toHaveCount(1);
          await expect(storedRow).toContainText(XSS_TITLE_TAIL);
          await expect(storedRow).toContainText('<img');
          await expect(page.locator('img[src="x"]')).toHaveCount(0);
          expect(await readXssFlag(page)).toBe('undefined');

          // URL の値: q が HTML そのものでも動かず、文字として出る
          await page.goto(`/search?q=${encodeURIComponent(XSS_TITLE_TAIL)}`);
          const urlRow = page.locator(ROW).filter({ hasText: marker });
          await expect(urlRow).toHaveCount(1);
          await expect(urlRow).toContainText('<img');
          await expect(page.locator('img[src="x"]')).toHaveCount(0);
          expect(await readXssFlag(page)).toBe('undefined');
        } finally {
          await rows.cleanup();
        }
      });

      test(`SEC-SEARCH-015-AC-01 ${viewport.name}: 置き場に無い道筋の商品と https://example.com/x.jpg のルックは imageUrl が null で、行に画像が出ない`, async ({ page, request }) => {
        const marker = newMarker();
        const rows = await InjectedRows.open();
        try {
          const itemTitle = `${marker} missing-img-item`;
          const lookTitle = `${marker} foreign-img-look`;
          // 決まった場所（items/）の下だが、置き場に物が無い道筋
          await rows.insertItem({ name: itemTitle, status: 'published', imageUrl: `items/${marker}-missing.png` });
          await rows.insertLook({ theme: lookTitle, status: 'published', imageUrls: ['https://example.com/x.jpg'], legacyImageUrls: true });

          const payload = await getJson<SearchPayload>(request, `/api/search?q=${encodeURIComponent(marker)}`);
          const item = payload.items.find((hit) => hit.title === itemTitle);
          const look = payload.looks.find((hit) => hit.title === lookTitle);
          expect(item, '商品が検索に出ること').toBeDefined();
          expect(look, 'ルックが検索に出ること').toBeDefined();
          expect(item?.imageUrl).toBeNull();
          expect(look?.imageUrl).toBeNull();

          await page.goto(`/search?q=${encodeURIComponent(marker)}`);
          const itemRow = page.locator(ROW).filter({ hasText: itemTitle });
          const lookRow = page.locator(ROW).filter({ hasText: lookTitle });
          await expect(itemRow).toHaveCount(1);
          await expect(lookRow).toHaveCount(1);
          await expect(itemRow.locator('img')).toHaveCount(0);
          await expect(lookRow.locator('img')).toHaveCount(0);
        } finally {
          await rows.cleanup();
        }
      });

    });
  }
});
