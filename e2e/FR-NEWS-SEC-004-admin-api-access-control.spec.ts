/**
 * FR-NEWS-SEC-004 管理のお知らせの窓口（/api/admin/news/<id>）の Origin の確かめと認可
 * 対応: SEC-NEWS-014-AC-01・02 / SEC-NEWS-015-AC-01〜03
 *
 * 画面を描かない HTTP だけの試験なので、画面幅（390/768/1280）ごとには繰り返さない（FR-STOCKIST-014・FR-ADMIN-123 の
 * 本物の HTTP の試験と同じ扱い）。各 AC に1本。名前の先頭が AC の ID。
 *
 * - SEC-NEWS-014: 状態を変える要求の Origin・Referer の確かめは src/proxy.ts が窓口より前に行うので、ログインは要らない。
 * - SEC-NEWS-015: 本物の GoTrue のログインで得た access token を Authorization: Bearer で渡す（窓口の認可は token の署名・
 *   session の生存・DB の ACL・aal を本物のまま確かめる）。利用者と役割は試験ごとに作り、終わりに消す。
 *   015-AC-01・03 は AC のとおり aal2 の token（DB で session を aal2 に整えて refresh し、GoTrue に発行させる）で送る。
 *   窓口は権限の判定を MFA の判定より先にする（src/lib/auth/admin-rbac.ts）ので、拒否の理由が「権限が無い」であり
 *   「MFA が無い」でない（reason が無い）ことも確かめる。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { withLocalDb } from './order-email-test-utils';
import {
  createAdminWithPermissions,
  createNewsRow,
  localAdmin,
  readNewsRow,
  runCleanups,
  signInWithPassword,
  type Cleanups,
} from './news-test-utils';

test.use({ trace: 'off' });

const APP_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.example';
const NEWS_PATH = '/api/admin/news';
const TEST_TIMEOUT_MS = 120_000;

type Reply = { status: number; text: string; json: Record<string, unknown> | null };

/** 1回呼ぶ。headers に origin を入れなければ Origin は付かない（Playwright の request は既定で付けない） */
async function send(
  api: APIRequestContext,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { headers?: Record<string, string>; data?: unknown; multipart?: Record<string, string> } = {},
): Promise<Reply> {
  const response = await api.fetch(path, {
    method,
    headers: options.headers ?? {},
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.multipart === undefined ? {} : { multipart: options.multipart }),
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status(), text, json };
}

test('SEC-NEWS-014-AC-01 Origin: https://evil.example を付けた PUT /api/admin/news/<id> は 403 で、error が Forbidden origin であり、記事が変わらない', async ({ request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const cleanups: Cleanups = [];
  try {
    const admin = localAdmin();
    const row = await createNewsRow(admin, cleanups, '014-01');
    const before = await readNewsRow(admin, row.id);
    expect(before).not.toBeNull();

    const reply = await send(request, 'PUT', `${NEWS_PATH}/${row.id}`, {
      headers: { origin: FOREIGN_ORIGIN },
      multipart: {
        title: `${row.title}-attempt`,
        category: 'STORE',
        date: '2026-12-31',
        content: '他のサイトから書き換え',
        detailedContent: '他のサイトから書き換え',
        status: 'published',
      },
    });

    expect(reply.status).toBe(403);
    expect(reply.json?.error).toBe('Forbidden origin');
    expect(await readNewsRow(admin, row.id)).toEqual(before);
  } finally {
    await runCleanups(cleanups);
  }
});

test('SEC-NEWS-014-AC-02 Origin も Referer も無い DELETE /api/admin/news/<id> は 403 で、記事が残る', async ({ request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const cleanups: Cleanups = [];
  try {
    const admin = localAdmin();
    const row = await createNewsRow(admin, cleanups, '014-02');
    const before = await readNewsRow(admin, row.id);
    expect(before).not.toBeNull();

    // headers を渡さない = origin も referer も付かない
    const reply = await send(request, 'DELETE', `${NEWS_PATH}/${row.id}`);

    expect(reply.status).toBe(403);
    expect(reply.json?.error).toBe('Forbidden origin');
    expect(await readNewsRow(admin, row.id)).toEqual(before);
  } finally {
    await runCleanups(cleanups);
  }
});

test('SEC-NEWS-015-AC-01 admin.news.read を持たないサポーターの aal2 の利用者の GET /api/admin/news は 403 で、permission が admin.news.read であり、下書きが応答に出ない', async ({ request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const cleanups: Cleanups = [];
  await withLocalDb(async (db) => {
    try {
      const admin = localAdmin();
      const row = await createNewsRow(admin, cleanups, '015-01');
      // お知らせの権限は持たず、ほかの権限（注文の閲覧）だけを持つサポーター
      const supporter = await createAdminWithPermissions(db, admin, cleanups, '015-01', ['admin.orders.read'], 'supporter');
      const session = await signInWithPassword(supporter.email, supporter.password, { elevateWith: db });
      expect(session.aal).toBe('aal2');

      const reply = await send(request, 'GET', NEWS_PATH, { headers: { authorization: `Bearer ${session.accessToken}` } });

      expect(reply.status).toBe(403);
      expect(reply.json?.error).toBe('Forbidden');
      expect(reply.json?.permission).toBe('admin.news.read');
      // 拒否の理由は権限の不足であって、MFA の不足ではない
      expect(reply.json?.reason).toBeUndefined();
      expect(reply.text).not.toContain(row.title);
    } finally {
      // 接続を閉じる前に片づける（役割の片づけが db を使う）
      await runCleanups(cleanups);
    }
  });
});

test('SEC-NEWS-015-AC-02 admin.news.manage を持つ利用者の aal1 の session の PATCH /api/admin/news/<id> は 403 で、reason が MFA required であり、記事の状態が変わらない', async ({ request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const cleanups: Cleanups = [];
  await withLocalDb(async (db) => {
    try {
      const admin = localAdmin();
      const row = await createNewsRow(admin, cleanups, '015-02', 'private');
      const before = await readNewsRow(admin, row.id);
      expect(before).not.toBeNull();
      expect(before?.status).toBe('private');
      const manager = await createAdminWithPermissions(
        db, admin, cleanups, '015-02', ['admin.news.read', 'admin.news.manage'], 'admin',
      );
      const session = await signInWithPassword(manager.email, manager.password);
      expect(session.aal).toBe('aal1');

      const reply = await send(request, 'PATCH', `${NEWS_PATH}/${row.id}`, {
        headers: { authorization: `Bearer ${session.accessToken}`, origin: APP_ORIGIN },
        data: { status: 'published' },
      });

      expect(reply.status).toBe(403);
      expect(reply.json?.reason).toBe('MFA required');
      expect(await readNewsRow(admin, row.id)).toEqual(before);
    } finally {
      // 接続を閉じる前に片づける（役割の片づけが db を使う）
      await runCleanups(cleanups);
    }
  });
});

test('SEC-NEWS-015-AC-03 admin.news.read だけを持つ aal2 の利用者の DELETE /api/admin/news/<id> は 403 で、permission が admin.news.manage であり、記事が残る', async ({ request }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const cleanups: Cleanups = [];
  await withLocalDb(async (db) => {
    try {
      const admin = localAdmin();
      const row = await createNewsRow(admin, cleanups, '015-03');
      const before = await readNewsRow(admin, row.id);
      expect(before).not.toBeNull();
      const reader = await createAdminWithPermissions(db, admin, cleanups, '015-03', ['admin.news.read'], 'supporter');
      const session = await signInWithPassword(reader.email, reader.password, { elevateWith: db });
      expect(session.aal).toBe('aal2');

      const reply = await send(request, 'DELETE', `${NEWS_PATH}/${row.id}`, {
        headers: { authorization: `Bearer ${session.accessToken}`, origin: APP_ORIGIN },
      });

      expect(reply.status).toBe(403);
      expect(reply.json?.error).toBe('Forbidden');
      expect(reply.json?.permission).toBe('admin.news.manage');
      // aal2 なので MFA の不足ではなく、変える権限の不足で断られる
      expect(reply.json?.reason).toBeUndefined();
      expect(await readNewsRow(admin, row.id)).toEqual(before);
    } finally {
      // 接続を閉じる前に片づける（役割の片づけが db を使う）
      await runCleanups(cleanups);
    }
  });
});
