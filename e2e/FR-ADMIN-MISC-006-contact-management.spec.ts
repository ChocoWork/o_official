/**
 * FR-ADMIN-MISC-006 問い合わせの管理（FR-ADMIN-009 の受け入れ条件と、SEC-ADMIN-019・020・021 の問い合わせ・色見本の部分）
 * 対応: FR-ADMIN-009-AC-01〜06、SEC-ADMIN-019-AC-01、SEC-ADMIN-020-AC-01、SEC-ADMIN-021-AC-01
 *
 * 道具立て
 * - 管理者・サポーターは、手元の Supabase に本物の利用者を作り、本物の aal2 のトークンを持たせる（e2e/admin-session-test-utils.ts。
 *   GoTrue が署名した本物の aal2 の JWT で、アプリの窓口は他の管理者と同じ道で検証する。トークンの偽造はしない）。
 * - 窓口の呼び出しは Playwright の request に Bearer で載せる（Cookie を持たない）。書き込み（GET 以外）には、proxy の Origin の検査を通すため許可の Origin を付ける。画面の確かめは同じトークンをブラウザの Cookie に置く。
 * - 問い合わせ・やり取り・テンプレートは PgClient で入れ、試験ごとの印（tag）で他の試験の行と混ざらないようにして、終わりに自分の行を消す。
 * - 権限の表は共有の状態: 権限を変えない試験は鍵（190520, 0）を共有で持ち、権限を外す試験（FR-ADMIN-009-AC-06）だけが
 *   withPermissionScenario（排他の鍵と差分の復元）の上で動く。
 *
 * 画面（CONTACT のタブ）が要る確かめは、mobile 390・tablet 768・desktop 1280 の3つの幅で流す。窓口の確かめは幅に依らないので1回だけ流す。
 *
 * 直した確かめ（印を外して通る）:
 * - FR-ADMIN-009-AC-01・AC-05 の画面の側: 管理画面に CONTACT のタブを足した（波 4。src/app/admin/page.tsx が ContactSection を開く）。
 *   画面の文言と部品は ContactSection.tsx の作りに合わせた（一覧の項目＝件名の文字、「テンプレートを選択」の combobox、「返信内容」の欄）。
 * - SEC-ADMIN-020-AC-01: 詳細は submitted_ip・user_agent を返さない（TM-ADMIN-61）。
 * - SEC-ADMIN-021-AC-01: 存在しない id は 404 を返し、監査に success を残さない（TM-ADMIN-62）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createPaidOrder, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import {
  createPermissionActor,
  deactivatePermissionActor,
  readRolePermissionState,
  saveRolePermissionsInDb,
  withPermissionScenario,
} from './permission-settings-test-utils';

test.describe.configure({ timeout: 120_000 });
// 本物の aal2 のトークンをブラウザの Cookie に載せるので、通信記録（trace）を残さない（worker 単位の設定なのでファイルの最上位に置く）
test.use({ trace: 'off' });

// ---- 型 ----

type InquiryRow = {
  id: string;
  status: string;
  inquiry_type: string;
  name: string;
  email: string;
  subject: string;
  last_message_at: string;
  order_id: string | null;
};
type ListBody = { data: InquiryRow[]; page: number; pageSize: number; totalPages: number; totalCount: number };
type MessageRow = { sender_role: string; body: string; created_at: string };
type DetailBody = { data: InquiryRow & { orderNumber: string | null; messages: MessageRow[] } & Record<string, unknown> };
type TemplateRow = { id: string; title: string; category: string | null; body: string; sort_order: number };
type TemplatesBody = { data: TemplateRow[] };
type Reply<T = unknown> = { status: number; body: T };

type InquiryStatus = 'open' | 'pending' | 'answered' | 'closed';
type InquiryType = 'product' | 'order' | 'other';
const STATUSES: readonly InquiryStatus[] = ['open', 'pending', 'answered', 'closed'];
const TYPES: readonly InquiryType[] = ['product', 'order', 'other'];
const DENIED = [401, 403];

// ---- 本物の aal2 の利用者 ----

type Actor = AdminSessionActor;
type Actors = { admin: Actor; supporter: Actor; noPermission: Actor };

// worker ごとに1回だけ作る（トークンの寿命は1時間。残り5分を切ったら作り直す）
let actorsPromise: Promise<Actors> | null = null;
async function getActors(): Promise<Actors> {
  if (actorsPromise) {
    const current = await actorsPromise.catch(() => null);
    if (current && current.admin.expiresAt - 300 > Date.now() / 1000) return current;
  }
  actorsPromise = withLocalDb(async (db) => {
    const admin = await createAdminSessionActor(db, 'admin', 'aal2');
    const supporter = await createAdminSessionActor(db, 'supporter', 'aal2');
    // 役割名はあるが有効な割り当てが無い「権限なし」の人（ACL の権限が空）
    const noPermission = await createAdminSessionActor(db, 'supporter', 'aal2');
    await deactivatePermissionActor(db, noPermission.userId);
    return { admin, supporter, noPermission };
  });
  return actorsPromise;
}

/** 本物の aal2 のトークンを、ブラウザの文脈の Cookie に置く（管理画面はこの Cookie で /api/auth/me を読む） */
async function signInBrowser(page: Page, baseURL: string | undefined, actor: Actor): Promise<void> {
  if (!baseURL || !isLocalUrl(baseURL)) throw new Error('ブラウザへのログインは手元のアプリだけ');
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: 'sb-access-token', value: actor.accessToken, url: baseURL, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-refresh-token', value: actor.refreshToken, url: baseURL, httpOnly: true, sameSite: 'Lax' },
  ]);
}

// ---- 窓口の呼び出し ----

let currentBaseURL: string | undefined;
test.beforeEach(({ baseURL }) => {
  currentBaseURL = baseURL;
});

function appOrigin(): string {
  expect(currentBaseURL, 'baseURL').toBeTruthy();
  return new URL(currentBaseURL as string).origin;
}

async function call<T = unknown>(
  request: APIRequestContext,
  token: string | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<Reply<T>> {
  // proxy は /api の書き込みに Origin か Referer を求める（Playwright の request は付けない）。ログインしていない要求にも付ける
  const headers: Record<string, string> = method === 'GET' ? {} : { origin: appOrigin() };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await request.fetch(path, {
    method,
    headers,
    data,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status(), body: body as T };
}

const listPath = (query: Record<string, string | number>): string =>
  `/api/admin/contact?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}`;

// ---- 材料 ----

type Created = { inquiries: string[]; templates: string[] };
type Ctx = { db: PgClient; actors: Actors; created: Created; tag: string };

function newTag(): string {
  return `e2ecm${randomBytes(4).toString('hex')}`;
}

function fieldsOf(tag: string, key: string): { name: string; email: string; subject: string } {
  return { name: `${tag}-name-${key}`, email: `${tag}-${key}@example.com`, subject: `${tag}-subject-${key}` };
}

type InquiryInput = {
  tag: string;
  key: string;
  status?: InquiryStatus;
  type?: InquiryType;
  /** last_message_at・created_at を、DB の今からこれだけずらす（interval の文字） */
  offset?: string;
  orderId?: string | null;
  submittedIp?: string;
  userAgent?: string;
};

async function insertInquiry(ctx: Ctx, input: InquiryInput): Promise<string> {
  const f = fieldsOf(input.tag, input.key);
  const result = await ctx.db.query(
    `insert into public.contact_inquiries
       (name, email, inquiry_type, subject, message, status, order_id, submitted_ip, user_agent, last_message_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $9, now() + $10::interval, now() + $10::interval, now() + $10::interval)
     returning id::text as id`,
    [
      f.name, f.email, input.type ?? 'other', f.subject, `${input.tag} の最初のお問い合わせ`, input.status ?? 'open',
      input.orderId ?? null, input.submittedIp ?? null, input.userAgent ?? null, input.offset ?? '0 seconds',
    ],
  );
  const id = result.rows[0].id as string;
  ctx.created.inquiries.push(id);
  return id;
}

async function insertMessage(ctx: Ctx, inquiryId: string, role: 'user' | 'admin', body: string, offset: string): Promise<void> {
  await ctx.db.query(
    `insert into public.contact_messages (inquiry_id, sender_role, author_id, body, channel, created_at)
     values ($1::uuid, $2, null, $3, 'web', now() + $4::interval)`,
    [inquiryId, role, body, offset],
  );
}

async function insertTemplate(
  ctx: Ctx,
  input: { title: string; body: string; category?: string | null; sortOrder?: number },
): Promise<string> {
  const result = await ctx.db.query(
    `insert into public.contact_reply_templates (title, category, body, sort_order)
     values ($1, $2, $3, $4) returning id::text as id`,
    [input.title, input.category ?? null, input.body, input.sortOrder ?? 0],
  );
  const id = result.rows[0].id as string;
  ctx.created.templates.push(id);
  return id;
}

async function cleanup(db: PgClient, created: Created): Promise<void> {
  try {
    await db.query('delete from public.contact_inquiries where id = any($1::uuid[])', [created.inquiries]);
    await db.query('delete from public.contact_reply_templates where id = any($1::uuid[])', [created.templates]);
  } catch {
    // 後始末の失敗は試験の結果にしない（行は試験ごとの印で分かれていて、db reset で消える）
  }
}

/**
 * 試験の場面。既定は権限の鍵（190520, 0）を共有で持つ（権限を外す試験が排他で動く間は待つ）。
 * 権限を外す試験は changesPermissions を付け、withPermissionScenario（排他の鍵と終わりの差分の復元）の上で動く。
 */
async function scenario(run: (ctx: Ctx) => Promise<void>, options: { changesPermissions?: boolean } = {}): Promise<void> {
  const body = async (db: PgClient): Promise<void> => {
    const created: Created = { inquiries: [], templates: [] };
    try {
      await run({ db, actors: await getActors(), created, tag: newTag() });
    } finally {
      await cleanup(db, created);
    }
  };
  if (options.changesPermissions) {
    await withPermissionScenario(body);
    return;
  }
  await withLocalDb(async (db) => {
    await db.query('select pg_catalog.pg_advisory_lock_shared(190520, 0)');
    try {
      await body(db);
    } finally {
      await db.query('select pg_catalog.pg_advisory_unlock_shared(190520, 0)');
    }
  });
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

// ---- FR-ADMIN-009-AC-01・AC-05（画面。mobile・tablet・desktop） ----

for (const viewport of viewports) {
  test(`FR-ADMIN-009-AC-01 ${viewport.name}: 店長とサポーターで /admin を開くと CONTACT のタブが表示され、押すと問い合わせの一覧が表示される`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await scenario(async (ctx) => {
      const tag = ctx.tag;
      // 一覧の1ページ目（最後のやり取りの新しい順）に必ず載るよう、1日先の時刻で入れる
      await insertInquiry(ctx, { tag, key: 'ui', offset: '1 day', type: 'product' });
      for (const role of ['admin', 'supporter'] as const) {
        await signInBrowser(page, baseURL, ctx.actors[role]);
        await page.goto('/admin');
        const menu = page.getByRole('navigation', { name: '管理メニュー', exact: true });
        const tab = menu.getByRole('button', { name: 'CONTACT', exact: true });
        await expect(tab, `${role} の管理メニューに CONTACT のタブが出る`).toBeVisible();
        await tab.click();
        await expect(tab).toHaveAttribute('aria-current', 'page');
        await expect(page.getByText(fieldsOf(tag, 'ui').subject, { exact: false }).first(), `${role} が押すと問い合わせの一覧に件名が出る`).toBeVisible();
      }
    });
  });

  test(`FR-ADMIN-009-AC-05 ${viewport.name}: 返信のテンプレートを選ぶと、その本文が返信の欄に入る（画面）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await scenario(async (ctx) => {
      const tag = ctx.tag;
      await insertInquiry(ctx, { tag, key: 'ui', offset: '1 day', type: 'product' });
      const templateBody = `${tag} テンプレートの本文。お問い合わせありがとうございます。`;
      const templateTitle = `${tag} 挨拶`;
      await insertTemplate(ctx, { title: templateTitle, body: templateBody, category: null, sortOrder: 0 });

      await signInBrowser(page, baseURL, ctx.actors.admin);
      await page.goto('/admin');
      const tab = page.getByRole('navigation', { name: '管理メニュー', exact: true }).getByRole('button', { name: 'CONTACT', exact: true });
      await expect(tab, '管理メニューに CONTACT のタブが出る').toBeVisible();
      await tab.click();
      await page.getByText(fieldsOf(tag, 'ui').subject, { exact: false }).first().click();
      await page.getByRole('combobox', { name: 'テンプレートを選択' }).click();
      await page.getByRole('option', { name: templateTitle, exact: true }).click();
      await expect(page.getByRole('textbox', { name: '返信内容' })).toHaveValue(templateBody);
    });
  });
}

// ---- FR-ADMIN-009-AC-02 ----

test('FR-ADMIN-009-AC-02 一覧が最後のやり取りの新しい順に1ページ20件で出て、総数とページ数が分かり、状態・種別・検索語で絞れる', async ({ request }) => {
  await scenario(async (ctx) => {
    const { actors, tag } = ctx;
    const token = actors.admin.accessToken;
    const COUNT = 25;
    // i が小さいほど新しい（i 分前）。状態と種別は i で巡らせる
    const rows: Array<{ id: string; i: number; status: InquiryStatus; type: InquiryType }> = [];
    for (let i = 0; i < COUNT; i += 1) {
      const status = STATUSES[i % STATUSES.length];
      const type = TYPES[i % TYPES.length];
      rows.push({ id: await insertInquiry(ctx, { tag, key: pad2(i), status, type, offset: `-${i} minutes` }), i, status, type });
    }
    const seededIds = new Set(rows.map((row) => row.id));

    // 絞らない一覧: 1ページ20件、総数とページ数、新しい順
    const all = await call<ListBody>(request, token, 'GET', listPath({}));
    expect(all.status).toBe(200);
    expect(all.body.page).toBe(1);
    expect(all.body.pageSize).toBe(20);
    expect(all.body.data).toHaveLength(20);
    expect(all.body.totalCount).toBeGreaterThanOrEqual(COUNT);
    expect(all.body.totalPages).toBe(Math.ceil(all.body.totalCount / 20));
    const times = all.body.data.map((row) => new Date(row.last_message_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // この試験の印で絞る: 25 件が 20 件 + 5 件の2ページ。並びは新しい順（i の小さい順）
    const page1 = await call<ListBody>(request, token, 'GET', listPath({ q: tag }));
    expect(page1.status).toBe(200);
    expect(page1.body.totalCount).toBe(COUNT);
    expect(page1.body.totalPages).toBe(2);
    expect(page1.body.data.map((row) => row.id)).toEqual(rows.slice(0, 20).map((row) => row.id));
    const page2 = await call<ListBody>(request, token, 'GET', listPath({ q: tag, page: 2 }));
    expect(page2.status).toBe(200);
    expect(page2.body.page).toBe(2);
    expect(page2.body.data.map((row) => row.id)).toEqual(rows.slice(20).map((row) => row.id));

    // 状態で絞る: その状態の問い合わせだけが表示される
    for (const status of STATUSES) {
      const expected = rows.filter((row) => row.status === status);
      const filtered = await call<ListBody>(request, token, 'GET', listPath({ q: tag, status, pageSize: 100 }));
      expect(filtered.status).toBe(200);
      expect(filtered.body.totalCount, `状態 ${status} の総数`).toBe(expected.length);
      expect(filtered.body.data.map((row) => row.id)).toEqual(expected.map((row) => row.id));
      expect(filtered.body.data.every((row) => row.status === status && seededIds.has(row.id))).toBe(true);
    }

    // 種別で絞る
    for (const type of TYPES) {
      const expected = rows.filter((row) => row.type === type);
      const filtered = await call<ListBody>(request, token, 'GET', listPath({ q: tag, type, pageSize: 100 }));
      expect(filtered.status).toBe(200);
      expect(filtered.body.totalCount, `種別 ${type} の総数`).toBe(expected.length);
      expect(filtered.body.data.map((row) => row.id)).toEqual(expected.map((row) => row.id));
      expect(filtered.body.data.every((row) => row.inquiry_type === type)).toBe(true);
    }

    // 名前・メール・件名の一部を入れると、それを含む問い合わせだけが表示される
    const target = rows[7];
    const f = fieldsOf(tag, pad2(target.i));
    for (const term of [f.name, f.email, f.subject]) {
      const found = await call<ListBody>(request, token, 'GET', listPath({ q: term }));
      expect(found.status).toBe(200);
      expect(found.body.totalCount, `検索語 ${term}`).toBe(1);
      expect(found.body.data.map((row) => row.id)).toEqual([target.id]);
    }
    const none = await call<ListBody>(request, token, 'GET', listPath({ q: `${tag}-nothing-matches` }));
    expect(none.status).toBe(200);
    expect(none.body.totalCount).toBe(0);
    expect(none.body.data).toEqual([]);
  });
});

// ---- FR-ADMIN-009-AC-03 ----

test('FR-ADMIN-009-AC-03 詳細に名前・メール・種別・件名・注文番号とやり取りが古い順に出て、無い問い合わせは 404 になる', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, db, actors } = ctx;
    const token = actors.admin.accessToken;
    const orderId = await createPaidOrder(db, uniqueEmail('contact-detail'));
    const withOrder = await insertInquiry(ctx, { tag, key: 'with-order', type: 'order', orderId });
    const withoutOrder = await insertInquiry(ctx, { tag, key: 'no-order', type: 'product' });
    // 時刻の古い順と入れた順を食い違わせる
    await insertMessage(ctx, withOrder, 'user', `${tag} 3番目のお客様の返信`, '-1 hours');
    await insertMessage(ctx, withOrder, 'user', `${tag} 1番目のお客様の最初`, '-3 hours');
    await insertMessage(ctx, withOrder, 'admin', `${tag} 2番目の店の返信`, '-2 hours');

    const detail = await call<DetailBody>(request, token, 'GET', `/api/admin/contact/${withOrder}`);
    expect(detail.status).toBe(200);
    const f = fieldsOf(tag, 'with-order');
    expect(detail.body.data.name).toBe(f.name);
    expect(detail.body.data.email).toBe(f.email);
    expect(detail.body.data.inquiry_type).toBe('order');
    expect(detail.body.data.subject).toBe(f.subject);
    expect(detail.body.data.orderNumber).toBe(`ORD-${orderId.slice(0, 8).toUpperCase()}`);
    expect(detail.body.data.messages.map((message) => message.body)).toEqual([
      `${tag} 1番目のお客様の最初`, `${tag} 2番目の店の返信`, `${tag} 3番目のお客様の返信`,
    ]);
    expect(detail.body.data.messages.map((message) => message.sender_role)).toEqual(['user', 'admin', 'user']);

    // 注文に結んでいない問い合わせには注文番号が出ない
    const plain = await call<DetailBody>(request, token, 'GET', `/api/admin/contact/${withoutOrder}`);
    expect(plain.status).toBe(200);
    expect(plain.body.data.inquiry_type).toBe('product');
    expect(plain.body.data.orderNumber).toBeNull();

    // 無い問い合わせを開くと 404
    const missing = await call(request, token, 'GET', `/api/admin/contact/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

// ---- FR-ADMIN-009-AC-04 ----

test('FR-ADMIN-009-AC-04 状態を open・pending・answered・closed のどれかに変えると一覧と詳細にその状態が出て、ほかの値は 400 で断られ状態が変わらない', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, actors } = ctx;
    const token = actors.admin.accessToken;
    const id = await insertInquiry(ctx, { tag, key: 'status', status: 'open' });
    const subject = fieldsOf(tag, 'status').subject;
    const statusInDetail = async (): Promise<string> =>
      (await call<DetailBody>(request, token, 'GET', `/api/admin/contact/${id}`)).body.data.status;
    const statusInList = async (): Promise<string | undefined> => {
      const list = await call<ListBody>(request, token, 'GET', listPath({ q: subject }));
      return list.body.data.find((row) => row.id === id)?.status;
    };

    // 直前と違う状態へ順に変える（open から始まるので、最後に open へ戻る）
    for (const status of ['pending', 'answered', 'closed', 'open'] as const) {
      const changed = await call<{ success?: boolean }>(request, token, 'PATCH', `/api/admin/contact/${id}`, { status });
      expect(changed.status, `${status} への変更`).toBe(200);
      expect(changed.body.success).toBe(true);
      expect(await statusInDetail(), `${status} の詳細`).toBe(status);
      expect(await statusInList(), `${status} の一覧`).toBe(status);
    }

    // 決まった値以外は 400 で、状態は変わらない
    for (const invalid of [{ status: 'archived' }, { status: 'OPEN' }, { status: '' }, { status: 1 }, { status: null }, {}]) {
      const refused = await call(request, token, 'PATCH', `/api/admin/contact/${id}`, invalid);
      expect(refused.status, `送った値 ${JSON.stringify(invalid)}`).toBe(400);
    }
    expect(await statusInDetail()).toBe('open');
    expect(await statusInList()).toBe('open');
  });
});

// ---- FR-ADMIN-009-AC-05（テンプレートの作成・更新・削除。窓口） ----

test('FR-ADMIN-009-AC-05 返信のテンプレートを作ると並び順の小さい順に一覧へ出て、直すと新しい題と本文が出て、消すと一覧から消える', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, actors } = ctx;
    const token = actors.admin.accessToken;
    const listTemplates = async (): Promise<TemplateRow[]> => {
      const list = await call<TemplatesBody>(request, token, 'GET', '/api/admin/contact/templates');
      expect(list.status).toBe(200);
      return list.body.data;
    };

    // PgClient で入れた1件（並び順 9000）が先頭側、窓口で作る2件（9002・9001）が後ろに並ぶ
    const seededId = await insertTemplate(ctx, { title: `${tag} 取り置き`, body: '取り置きの本文', category: 'general', sortOrder: 9000 });
    const createdA = await call<{ success?: boolean; id?: string }>(request, token, 'POST', '/api/admin/contact/templates', {
      title: `${tag} 発送のご案内`, body: '発送のご案内の本文', category: 'order', sortOrder: 9002,
    });
    const createdB = await call<{ success?: boolean; id?: string }>(request, token, 'POST', '/api/admin/contact/templates', {
      title: `${tag} お詫び`, body: 'お詫びの本文', category: null, sortOrder: 9001,
    });
    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    const idA = createdA.body.id as string;
    const idB = createdB.body.id as string;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    ctx.created.templates.push(idA, idB);

    let templates = await listTemplates();
    const order = templates.map((template) => template.id);
    expect(order.indexOf(seededId)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(seededId)).toBeLessThan(order.indexOf(idB));
    expect(order.indexOf(idB)).toBeLessThan(order.indexOf(idA));
    const sortOrders = templates.map((template) => template.sort_order);
    expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
    const rowA = templates.find((template) => template.id === idA);
    expect(rowA).toMatchObject({ title: `${tag} 発送のご案内`, body: '発送のご案内の本文', category: 'order', sort_order: 9002 });

    // 直すと新しい題と本文が出る（並び順を渡さなければ変わらない）
    const updated = await call<{ success?: boolean }>(request, token, 'PUT', `/api/admin/contact/templates/${idA}`, {
      title: `${tag} 発送のご案内（改）`, body: '直した本文', category: 'order',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.success).toBe(true);
    templates = await listTemplates();
    expect(templates.find((template) => template.id === idA)).toMatchObject({
      title: `${tag} 発送のご案内（改）`, body: '直した本文', sort_order: 9002,
    });

    // 消すと一覧から消える（ほかの件は残る）
    const deleted = await call<{ success?: boolean }>(request, token, 'DELETE', `/api/admin/contact/templates/${idA}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    templates = await listTemplates();
    expect(templates.some((template) => template.id === idA)).toBe(false);
    expect(templates.some((template) => template.id === idB)).toBe(true);
    expect(templates.some((template) => template.id === seededId)).toBe(true);
  });
});

// ---- FR-ADMIN-009-AC-06 ----

type ManageCall = { label: string; method: 'PATCH' | 'POST' | 'PUT' | 'DELETE'; path: string; data?: unknown };

function manageCalls(inquiryId: string, templateId: string, tag: string): ManageCall[] {
  return [
    { label: '状態の変更', method: 'PATCH', path: `/api/admin/contact/${inquiryId}`, data: { status: 'closed' } },
    { label: '返信', method: 'POST', path: `/api/admin/contact/${inquiryId}/reply`, data: { body: `${tag} 断られるはずの返信` } },
    { label: 'テンプレートの作成', method: 'POST', path: '/api/admin/contact/templates', data: { title: `${tag} 断られる作成`, body: '本文' } },
    { label: 'テンプレートの更新', method: 'PUT', path: `/api/admin/contact/templates/${templateId}`, data: { title: `${tag} 書き換え`, body: '書き換えた本文' } },
    { label: 'テンプレートの削除', method: 'DELETE', path: `/api/admin/contact/templates/${templateId}` },
  ];
}

type ContactState = { status: string; messageCount: number; template: { title: string; body: string } | null; templatesWithTag: number };

async function readContactState(db: PgClient, inquiryId: string, templateId: string, tag: string): Promise<ContactState> {
  const inquiry = await db.query('select status from public.contact_inquiries where id = $1::uuid', [inquiryId]);
  const messages = await db.query('select count(*)::int as n from public.contact_messages where inquiry_id = $1::uuid', [inquiryId]);
  const template = await db.query('select title, body from public.contact_reply_templates where id = $1::uuid', [templateId]);
  const tagged = await db.query('select count(*)::int as n from public.contact_reply_templates where title like $1', [`${tag}%`]);
  return {
    status: inquiry.rows[0].status as string,
    messageCount: messages.rows[0].n as number,
    template: template.rows[0] ? { title: template.rows[0].title as string, body: template.rows[0].body as string } : null,
    templatesWithTag: tagged.rows[0].n as number,
  };
}

test('FR-ADMIN-009-AC-06 閲覧の権限が無いと読めず、管理の権限が無いと返信・状態の変更・テンプレートの変更が断られ中身が変わらない。初期の店長とサポーターは両方できる', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, db, actors } = ctx;
    const inquiryId = await insertInquiry(ctx, { tag, key: 'perm', status: 'open' });
    const templateId = await insertTemplate(ctx, { title: `${tag} 元の題`, body: '元の本文', category: 'general', sortOrder: 9000 });
    const subject = fieldsOf(tag, 'perm').subject;

    const expectReadable = async (token: string, who: string): Promise<void> => {
      const list = await call<ListBody>(request, token, 'GET', listPath({ q: subject }));
      expect(list.status, `${who} の一覧`).toBe(200);
      expect(list.body.data.map((row) => row.id)).toEqual([inquiryId]);
      const detail = await call<DetailBody>(request, token, 'GET', `/api/admin/contact/${inquiryId}`);
      expect(detail.status, `${who} の詳細`).toBe(200);
      const templates = await call<TemplatesBody>(request, token, 'GET', '/api/admin/contact/templates');
      expect(templates.status, `${who} のテンプレートの一覧`).toBe(200);
      expect(templates.body.data.some((template) => template.id === templateId)).toBe(true);
    };
    const expectReadDenied = async (token: string | null, who: string): Promise<void> => {
      for (const path of [listPath({ q: subject }), `/api/admin/contact/${inquiryId}`, '/api/admin/contact/templates']) {
        const reply = await call(request, token, 'GET', path);
        expect(DENIED, `${who} の GET ${path} は ${reply.status}`).toContain(reply.status);
      }
    };
    const expectManageDenied = async (token: string | null, who: string): Promise<void> => {
      const before = await readContactState(db, inquiryId, templateId, tag);
      for (const manage of manageCalls(inquiryId, templateId, tag)) {
        const reply = await call(request, token, manage.method, manage.path, manage.data);
        expect(DENIED, `${who} の ${manage.label} は ${reply.status}`).toContain(reply.status);
      }
      expect(await readContactState(db, inquiryId, templateId, tag), `${who} の断られた操作の後も中身が同じ`).toEqual(before);
    };

    // 初期の店長とサポーターは、読むことも返信・状態の変更・テンプレートの変更もできる
    for (const role of ['admin', 'supporter'] as const) {
      const token = actors[role].accessToken;
      await expectReadable(token, role);
      const changed = await call(request, token, 'PATCH', `/api/admin/contact/${inquiryId}`, { status: 'pending' });
      expect(changed.status, `${role} の状態の変更`).toBe(200);
      const created = await call<{ id?: string }>(request, token, 'POST', '/api/admin/contact/templates', { title: `${tag} ${role} 作成`, body: '本文' });
      expect(created.status, `${role} のテンプレートの作成`).toBe(201);
      ctx.created.templates.push(created.body.id as string);
      const updated = await call(request, token, 'PUT', `/api/admin/contact/templates/${created.body.id}`, { title: `${tag} ${role} 更新`, body: '更新した本文' });
      expect(updated.status, `${role} のテンプレートの更新`).toBe(200);
      const deleted = await call(request, token, 'DELETE', `/api/admin/contact/templates/${created.body.id}`);
      expect(deleted.status, `${role} のテンプレートの削除`).toBe(200);
      const replyBody = `${tag} ${role} の返信`;
      const replied = await call<{ success?: boolean }>(request, token, 'POST', `/api/admin/contact/${inquiryId}/reply`, { body: replyBody });
      expect(replied.status, `${role} の返信`).toBe(201);
      expect(replied.body.success).toBe(true);
      const detail = await call<DetailBody>(request, token, 'GET', `/api/admin/contact/${inquiryId}`);
      expect(detail.body.data.messages.some((message) => message.sender_role === 'admin' && message.body === replyBody)).toBe(true);
    }

    // ログインしていない: 読めず、変えられない
    await expectReadDenied(null, 'ログインしていない人');
    await expectManageDenied(null, 'ログインしていない人');

    // 閲覧だけ（サポーターから admin.contact.manage を外す）: 読めるが、変えられない
    const adminActorId = await createPermissionActor(db, 'admin');
    const supporterState = await readRolePermissionState(db, 'supporter');
    expect(supporterState.permissionCodes).toContain('admin.contact.read');
    const saved = await saveRolePermissionsInDb(db, adminActorId, {
      roleCode: 'supporter',
      permissionCodes: supporterState.permissionCodes.filter((code) => code !== 'admin.contact.manage'),
      expectedVersion: supporterState.version,
      requestKey: randomUUID(),
    });
    expect(saved.status, 'サポーターから管理の権限を外す保存').toBe(200);
    await expectReadable(actors.supporter.accessToken, '閲覧だけのサポーター');
    await expectManageDenied(actors.supporter.accessToken, '閲覧だけのサポーター');

    // 権限なし（有効な割り当てが無い人）: 読めず、変えられない
    await expectReadDenied(actors.noPermission.accessToken, '権限なしの人');
    await expectManageDenied(actors.noPermission.accessToken, '権限なしの人');
  }, { changesPermissions: true });
});

// ---- SEC-ADMIN-019-AC-01 ----

test('SEC-ADMIN-019-AC-01 区切りの字を含む検索語で一覧を要求すると 200 が返り、ほかの条件が足されず closed の問い合わせが一覧に出ない', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, actors } = ctx;
    const token = actors.admin.accessToken;
    // 一覧の1ページ目に載るよう、1日先の時刻で入れる
    const openId = await insertInquiry(ctx, { tag, key: 'open', status: 'open', offset: '1 day' });
    const closedId = await insertInquiry(ctx, { tag, key: 'closed', status: 'closed', offset: '1 day' });
    const injection = 'x),status.eq.closed,(name.ilike.x';

    // 状態 open で絞り、検索語に区切りの字を入れる
    const withStatus = await call<ListBody>(request, token, 'GET', listPath({ status: 'open', q: injection }));
    expect(withStatus.status).toBe(200);
    expect(Array.isArray(withStatus.body.data)).toBe(true);
    expect(withStatus.body.data.some((row) => row.id === closedId)).toBe(false);
    expect(withStatus.body.data.every((row) => row.status === 'open')).toBe(true);

    // 状態で絞らずに同じ検索語: 差し込みが効くと closed の問い合わせが全部混ざる
    const noStatus = await call<ListBody>(request, token, 'GET', listPath({ q: injection }));
    expect(noStatus.status).toBe(200);
    expect(noStatus.body.data.some((row) => row.id === closedId)).toBe(false);
    expect(noStatus.body.data.some((row) => row.status === 'closed')).toBe(false);

    // 見本: 普通の検索語なら、入れた open と closed の両方が見つかる（一覧と窓口が生きている確かめ）
    const normal = await call<ListBody>(request, token, 'GET', listPath({ q: tag }));
    expect(normal.body.data.map((row) => row.id).sort()).toEqual([openId, closedId].sort());
  });
});

// ---- SEC-ADMIN-020-AC-01 ----

test('SEC-ADMIN-020-AC-01 サポーターの aal2 の JWT で問い合わせの詳細を要求すると 200 が返り、応答に submitted_ip・user_agent の項目が無い', async ({ request }) => {
  await scenario(async (ctx) => {
    const { tag, actors } = ctx;
    const ip = '203.0.113.7';
    const agent = `E2E-Agent/${tag}`;
    const id = await insertInquiry(ctx, { tag, key: 'pii', submittedIp: ip, userAgent: agent });

    const detail = await call<DetailBody>(request, actors.supporter.accessToken, 'GET', `/api/admin/contact/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.subject).toBe(fieldsOf(tag, 'pii').subject);
    expect(Object.keys(detail.body.data)).not.toContain('submitted_ip');
    expect(Object.keys(detail.body.data)).not.toContain('user_agent');
    // 項目の名前を変えて返しても漏れない
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain(ip);
    expect(text).not.toContain(agent);
  });
});

// ---- SEC-ADMIN-021-AC-01 ----

test('SEC-ADMIN-021-AC-01 存在しない id で問い合わせの PATCH・テンプレートの PUT と DELETE・色見本の DELETE を送ると 404 が返り、success の監査の行が増えない', async ({ request }) => {
  await scenario(async ({ db, actors }) => {
    const token = actors.admin.accessToken;
    const missingUuid = randomUUID();
    // identity の連番が届かない大きさで、窓口の形の検査（18 桁以下の数字）は通り、DB が 0 行を返して 404 になる bigint（色見本の id）
    const missingPresetId = `8${Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join('')}`;

    const patch = await call(request, token, 'PATCH', `/api/admin/contact/${missingUuid}`, { status: 'closed' });
    const put = await call(request, token, 'PUT', `/api/admin/contact/templates/${missingUuid}`, { title: '題', body: '本文' });
    const del = await call(request, token, 'DELETE', `/api/admin/contact/templates/${missingUuid}`);
    const preset = await call(request, token, 'DELETE', `/api/admin/item-color-presets/${missingPresetId}`);
    expect.soft(patch.status, '存在しない問い合わせの PATCH').toBe(404);
    expect.soft(put.status, '存在しないテンプレートの PUT').toBe(404);
    expect.soft(del.status, '存在しないテンプレートの DELETE').toBe(404);
    expect.soft(preset.status, '存在しない色見本の DELETE').toBe(404);

    const audits = await db.query(
      `select action, resource, resource_id from public.audit_logs
        where outcome = 'success' and resource_id = any($1::text[])`,
      [[missingUuid, missingPresetId]],
    );
    expect(audits.rows, '存在しない id への成功の監査の行').toEqual([]);
  });
});
