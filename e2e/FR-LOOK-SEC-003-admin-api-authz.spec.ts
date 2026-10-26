/**
 * 管理の LOOK の窓口（GET・POST /api/admin/looks、GET・PUT・PATCH・DELETE /api/admin/looks/[id]）の認可・送り元の確かめ・入口の値・回数の制限（LOOK 領域）。
 * 受け入れ条件: SEC-LOOK-019-AC-01・AC-02・AC-03・AC-04・AC-05（401・aal1 の 403・読み出しだけの権限・画面の出し分け）、
 * SEC-LOOK-018-AC-01・AC-02（他のオリジン・Origin も Referer も無い変更）、SEC-LOOK-016-AC-02・AC-03（数でない id・JSON でない本文）、
 * SEC-LOOK-011-AC-01（送り元の見出しを変えても操作者の回数は止まる）。
 *
 * 道:
 * - 窓口の確かめ（019-AC-01〜03、018、016、011）は本番ビルドの窓口へ Playwright の request で直に要求する。画面は開かないので画面幅に関係せず、1回だけ流す。
 *   管理者は手元の Supabase の本物の JWT（店長・aal1 か aal2。e2e/admin-session-test-utils.ts）を Authorization: Bearer で送る。Cookie を送らないので
 *   CSRF の token は要らない。変更の要求には、送り元を確かめる proxy を通すため許可のオリジン（Origin）を付ける（018 は付けない・変える）。
 * - 019-AC-04 と 019-AC-05 はブラウザで、mobile 390・tablet 768・desktop 1280 の3つの幅で流す。同じ種類の JWT を Cookie（sb-access-token）に置いて /admin?tab=LOOK を開く
 *   （e2e/look-admin-test-utils.ts の signInAsLookAdmin）。
 * - 読み出しの権限だけを持つ利用者は、店長の JWT の利用者の有効な役割を外し、admin.looks.read だけを持つ試験用の役割（e2e-look019-ro-*）を付けて作る。
 *   窓口の認可は 要求のたびに DB の ACL を読むので、JWT は店長（app_metadata.role = admin）のまま、権限だけが読み出しになる。
 *   カードの3ボタンは窓口の meta.canManage で出し分ける（019-AC-05）。「新規作成」は src/app/admin/page.tsx が役（admin）で出していて、そのままになる（019-AC-04）。
 * - 試験ごとに、非公開の LOOK を1つ作り（テーマは一意・created_at 2000-01-01・商品1を紐づけ）、終わりに必ず消す。LOOK の行は to_jsonb の全列で前後を比べ、「変わらない」を確かめる。
 *   試験ごとに新しい利用者・試験ごとの送り元（x-forwarded-for）を使い、変更の枠（status 30回/600秒）を他の試験や前の実行と共有しない。
 * - 権限の表は共有の状態なので、利用者を作る試験は withPermissionScenario（advisory lock 190520）の中で流す。
 *
 * 現行のコードが満たさない AC（文のとおりに書いてあり、緩めない。コードが直るまで赤）:
 * - SEC-LOOK-019-AC-04: 「新規作成」のボタンを src/app/admin/page.tsx が権限でなく役（admin）で出すので、読み出しだけの利用者にも出る（波 4 で直す）。
 *   カードの公開の切り替え・編集・削除は直した（019-AC-05 が緑）。
 * - SEC-LOOK-011-AC-01: 回数の制限が x-forwarded-for をそのまま送り元として数えるので、操作者の段も見出しごとに別の枠になる見込み。
 * 019-AC-01〜03・AC-05・018-AC-01・AC-02・016-AC-02・AC-03 は満たす見込み。
 *
 * 作った利用者・session・監査の行は消さない（db reset で消える）。LOOK の行と試験用の役割は終わりに消す。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { insertPrivateLook, purgeLooksByThemePrefix, signInAsLookAdmin } from './look-admin-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { deactivatePermissionActor, withPermissionScenario } from './permission-settings-test-utils';

// 管理者の JWT を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });
test.describe.configure({ timeout: 120_000 });

const LIST_PATH = '/api/admin/looks';
const one = (id: number | string): string => `/api/admin/looks/${id}`;
const FOREIGN_ORIGIN = 'https://evil.example';
/** 状態の切り替えの枠（SEC-LOOK-011 の文: 10分の中で 30 回まで。31回目から 429） */
const STATUS_LIMIT = 30;
const WINDOW_SECONDS = 600;
/** 31回を送り終えるまで窓が替わらないと見なす、窓の残りの秒数 */
const WINDOW_GUARD_SECONDS = 45;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Reply = { status: number; text: string };
type Throwaway = { id: number; theme: string };

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return new URL(baseURL).origin;
}

/** 試験ごとの送り元（x-forwarded-for）。回数の枠を試験どうしで共有しない */
function uniqueIp(): string {
  const groups = randomBytes(12).toString('hex').match(/.{4}/g) ?? [];
  return `2001:db8:${groups.join(':')}`;
}

/** 窓（600秒で割った固定の区切り）の終わりまでの秒数 */
function secondsLeftInWindow(): number {
  return WINDOW_SECONDS - ((Date.now() / 1000) % WINDOW_SECONDS);
}

/** 窓の終わりが近ければ、次の窓に入るまで待つ。31回の変更が窓をまたいで枠が戻るのを避ける（待つのは expect.poll で、固定の sleep ではない） */
async function enterFreshWindowSpan(): Promise<void> {
  if (secondsLeftInWindow() > WINDOW_GUARD_SECONDS) return;
  await expect
    .poll(secondsLeftInWindow, { timeout: (WINDOW_GUARD_SECONDS + 30) * 1000, intervals: [500] })
    .toBeGreaterThan(WINDOW_GUARD_SECONDS);
}

type SendOptions = {
  /** null なら Authorization を付けない（session の無い要求） */
  actor: AdminSessionActor | null;
  /** 変更の要求の Origin。null なら Origin を付けない。GET には付けない */
  origin: string | null;
  ip: string;
  data?: unknown;
  contentType?: string;
};

/** 1回呼ぶ。Referer は付けない */
async function send(request: APIRequestContext, method: Method, path: string, options: SendOptions): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': options.ip };
  if (options.actor) Object.assign(headers, bearerHeaders(options.actor));
  if (method !== 'GET' && options.origin !== null) headers.origin = options.origin;
  if (options.contentType) headers['content-type'] = options.contentType;
  const response = await request.fetch(path, {
    method,
    headers,
    ...(options.data === undefined ? {} : { data: options.data }),
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  return { status: response.status(), text: await response.text() };
}

/** LOOK の行を全列（updated_at まで）読む。無ければ null */
async function readLook(db: PgClient, id: number): Promise<unknown> {
  const res = await db.query('select to_jsonb(l) as row from public.looks l where l.id = $1::bigint', [id]);
  return res.rows[0]?.row ?? null;
}

async function readStatus(db: PgClient, id: number): Promise<string | null> {
  const res = await db.query('select status from public.looks where id = $1::bigint', [id]);
  return (res.rows[0]?.status as string | undefined) ?? null;
}

/** 非公開の LOOK を1つ作り、終わりに（落ちても）消す */
async function withLook(run: (look: Throwaway) => Promise<void>): Promise<void> {
  const theme = `E2E-LOOK-SEC003-${randomBytes(4).toString('hex')}`;
  try {
    const id = await insertPrivateLook(theme);
    await run({ id, theme });
  } finally {
    await purgeLooksByThemePrefix(theme);
  }
}

/** admin.looks.read だけを持つ試験用の役割の、aal2 の利用者（JWT は店長のまま）を作り、終わりに役割を消す */
async function withReadOnlyLookActor(db: PgClient, run: (actor: AdminSessionActor) => Promise<void>): Promise<void> {
  const actor = await createAdminSessionActor(db, 'admin', 'aal2');
  await deactivatePermissionActor(db, actor.userId);
  const role = await db.query('insert into public.roles (code, name) values ($1, $2) returning id', [
    `e2e-look019-ro-${randomBytes(6).toString('hex')}`,
    'E2E LOOK read only',
  ]);
  const roleId: number = role.rows[0].id;
  try {
    const granted = await db.query(
      `insert into public.role_permissions (role_id, permission_id)
       select $1, p.id from public.permissions p where p.code = 'admin.looks.read'`,
      [roleId],
    );
    if (granted.rowCount !== 1) throw new Error('権限 admin.looks.read の行が手元の DB に無い');
    await db.query('insert into public.user_roles (user_id, role_id, active, expires_at) values ($1::uuid, $2, true, null)', [
      actor.userId,
      roleId,
    ]);
    await run(actor);
  } finally {
    await db.query('delete from public.user_roles where role_id = $1', [roleId]);
    await db.query('delete from public.role_permissions where role_id = $1', [roleId]);
    await db.query('delete from public.roles where id = $1', [roleId]);
  }
}

test('SEC-LOOK-019-AC-01 session の無い要求は、/api/admin/looks の GET・POST と /api/admin/looks/<id> の GET・PUT・PATCH・DELETE のどれも 401 になり、LOOK が変わらない', async ({
  request,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  await withLook(async (look) => {
    await withLocalDb(async (db) => {
      const before = await readLook(db, look.id);
      expect(before, '作った LOOK がある').not.toBeNull();
      const calls: Array<{ label: string; method: Method; path: string; data?: unknown }> = [
        { label: 'GET /api/admin/looks', method: 'GET', path: LIST_PATH },
        { label: 'POST /api/admin/looks', method: 'POST', path: LIST_PATH, data: { theme: `${look.theme}-created` } },
        { label: 'GET /api/admin/looks/<id>', method: 'GET', path: one(look.id) },
        { label: 'PUT /api/admin/looks/<id>', method: 'PUT', path: one(look.id), data: { theme: `${look.theme}-put` } },
        { label: 'PATCH /api/admin/looks/<id>', method: 'PATCH', path: one(look.id), data: { status: 'published' } },
        { label: 'DELETE /api/admin/looks/<id>', method: 'DELETE', path: one(look.id) },
      ];
      for (const call of calls) {
        // 変更の要求は許可のオリジンを付ける（付けないと proxy が窓口より前に 403 を返し、認可まで届かない）
        const reply = await send(request, call.method, call.path, { actor: null, origin, ip: uniqueIp(), data: call.data });
        expect(reply.status, `${call.label} は 401`).toBe(401);
      }
      expect(await readLook(db, look.id), 'LOOK が変わらない').toEqual(before);
      const created = await db.query('select count(*)::int as n from public.looks where theme like $1', [`${look.theme}%`]);
      expect(created.rows[0].n, '作成の POST で LOOK が増えない').toBe(1);
    });
  });
});

test('SEC-LOOK-019-AC-02 admin.looks.manage を持つ利用者でも aal1 の session は、GET と状態の変更のどちらも 403 になり、LOOK の状態が変わらない', async ({
  request,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal1');
    await withLook(async (look) => {
      const before = await readLook(db, look.id);
      const ip = uniqueIp();
      const read = await send(request, 'GET', LIST_PATH, { actor, origin, ip });
      expect(read.status, 'aal1 の GET').toBe(403);
      const change = await send(request, 'PATCH', one(look.id), { actor, origin, ip, data: { status: 'published' } });
      expect(change.status, 'aal1 の状態の変更').toBe(403);
      expect(await readStatus(db, look.id), 'LOOK の状態が変わらない').toBe('private');
      expect(await readLook(db, look.id), 'LOOK が変わらない').toEqual(before);
    });
  });
});

test('SEC-LOOK-019-AC-03 admin.looks.read だけを持つ役の aal2 の session は、/api/admin/looks の GET が 200、/api/admin/looks/<id> の PATCH・DELETE が 403 になる', async ({
  request,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    await withReadOnlyLookActor(db, async (actor) => {
      await withLook(async (look) => {
        const before = await readLook(db, look.id);
        const ip = uniqueIp();
        const read = await send(request, 'GET', LIST_PATH, { actor, origin, ip });
        expect(read.status, '読み出しの GET').toBe(200);
        const body = JSON.parse(read.text) as { data?: Array<{ id: number }> };
        expect(body.data?.some((row) => row.id === look.id), '一覧に作った LOOK がある').toBe(true);

        const patch = await send(request, 'PATCH', one(look.id), { actor, origin, ip, data: { status: 'published' } });
        expect(patch.status, '読み出しだけの PATCH').toBe(403);
        const remove = await send(request, 'DELETE', one(look.id), { actor, origin, ip });
        expect(remove.status, '読み出しだけの DELETE').toBe(403);
        expect(await readLook(db, look.id), 'LOOK が変わらない').toEqual(before);
      });
    });
  });
});

for (const vp of viewports) {
  test(`SEC-LOOK-019-AC-04 ${vp.name} admin.looks.read だけを持つ役の aal2 の session で LOOK のタブを開くと、一覧は表示され、作成・編集・公開の切り替え・削除のボタンが表示されない`, async ({
    page,
    baseURL,
  }) => {
    test.fail(true, 'SEC-LOOK-019-AC-04 今のコードは満たさない。カードの3ボタンは AC-05。新規作成のボタンは src/app/admin/page.tsx が役で出している（波 4。docs/02_Requirements/areas/look.md）');
    if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
    await withPermissionScenario(async (db) => {
      await withReadOnlyLookActor(db, async (actor) => {
        await withLook(async (look) => {
          await mockAdminBackgroundApis(page);
          await signInAsLookAdmin(page.context(), actor, baseURL);
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.goto('/admin?tab=LOOK');

          // 一覧は表示される（読み出しの権限で窓口が 200 を返し、非公開の LOOK も見える）
          await expect(page.getByText(look.theme, { exact: true })).toBeVisible();
          await expect(page.getByText('Aoi Weekend Layers', { exact: true })).toBeVisible();

          // 作成・編集・公開の切り替え（公開 / 非公開）・削除の操作が出ない
          const operations = ['新規作成', '編集', '公開', '非公開', '削除'];
          for (const name of operations) {
            for (const role of ['button', 'link'] as const) {
              await expect(page.getByRole(role, { name, exact: true }), `${role}「${name}」は出ない`).toHaveCount(0);
            }
          }
        });
      });
    });
  });
}

for (const vp of viewports) {
  test(`SEC-LOOK-019-AC-05 ${vp.name} admin.looks.read だけを持つ役の aal2 の session で LOOK のタブを開くと、一覧は表示され、カードの公開の切り替え・編集・削除のボタンが表示されない`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
    await withPermissionScenario(async (db) => {
      await withReadOnlyLookActor(db, async (actor) => {
        await withLook(async (look) => {
          await mockAdminBackgroundApis(page);
          await signInAsLookAdmin(page.context(), actor, baseURL);
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.goto('/admin?tab=LOOK');

          // 数える範囲は LOOK の一覧の区画の中だけ（頁のヘッダーなど別の部品の同じ名前のボタンを数えない）
          const lookSection = page.locator('section').filter({ has: page.getByText(look.theme, { exact: true }) }).last();

          // 一覧は表示される（読み出しの権限で窓口が 200 を返し、非公開の LOOK も見える）。0 件の見かけの成功を避ける
          await expect(lookSection.getByText(look.theme, { exact: true })).toBeVisible();
          await expect(lookSection.getByText('Aoi Weekend Layers', { exact: true })).toBeVisible();
          await expect(lookSection.locator('[data-ui-tag-label-variant]').first(), 'カードの状態の印が出ている').toBeVisible();

          // カードの公開の切り替え（公開 / 非公開）・編集・削除の操作が出ない
          const operations = ['編集', '公開', '非公開', '削除'];
          for (const name of operations) {
            for (const role of ['button', 'link'] as const) {
              await expect(lookSection.getByRole(role, { name, exact: true }), `${role}「${name}」は出ない`).toHaveCount(0);
            }
          }
        });
      });
    });
  });
}

test('SEC-LOOK-018-AC-01 aal2 の管理者の session でも、Origin を他のオリジンにした PATCH と DELETE は 403 で断られ、LOOK が変わらない', async ({
  request,
}) => {
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    await withLook(async (look) => {
      const before = await readLook(db, look.id);
      const ip = uniqueIp();
      const patch = await send(request, 'PATCH', one(look.id), { actor, origin: FOREIGN_ORIGIN, ip, data: { status: 'published' } });
      expect(patch.status, '他のオリジンの PATCH').toBe(403);
      const remove = await send(request, 'DELETE', one(look.id), { actor, origin: FOREIGN_ORIGIN, ip });
      expect(remove.status, '他のオリジンの DELETE').toBe(403);
      expect(await readLook(db, look.id), 'LOOK が残り、変わらない').toEqual(before);
    });
  });
});

test('SEC-LOOK-018-AC-02 aal2 の管理者の session でも、Origin も Referer も付けない PATCH と DELETE は 403 で断られ、LOOK の状態が変わらない', async ({
  request,
}) => {
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    await withLook(async (look) => {
      const before = await readLook(db, look.id);
      const ip = uniqueIp();
      const patch = await send(request, 'PATCH', one(look.id), { actor, origin: null, ip, data: { status: 'published' } });
      expect(patch.status, 'Origin も Referer も無い PATCH').toBe(403);
      const remove = await send(request, 'DELETE', one(look.id), { actor, origin: null, ip });
      expect(remove.status, 'Origin も Referer も無い DELETE').toBe(403);
      expect(await readStatus(db, look.id), 'LOOK の状態が変わらない').toBe('private');
      expect(await readLook(db, look.id), 'LOOK が残り、変わらない').toEqual(before);
    });
  });
});

test('SEC-LOOK-016-AC-02 aal2 の管理者の session で /api/admin/looks/abc に GET・PATCH・DELETE を送ると、どれも 400 で断られる', async ({
  request,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    const ip = uniqueIp();
    const get = await send(request, 'GET', one('abc'), { actor, origin, ip });
    expect(get.status, 'GET /api/admin/looks/abc').toBe(400);
    const patch = await send(request, 'PATCH', one('abc'), { actor, origin, ip, data: { status: 'private' } });
    expect(patch.status, 'PATCH /api/admin/looks/abc').toBe(400);
    const remove = await send(request, 'DELETE', one('abc'), { actor, origin, ip });
    expect(remove.status, 'DELETE /api/admin/looks/abc').toBe(400);
  });
});

test('SEC-LOOK-016-AC-03 /api/admin/looks/<id> に JSON でない本文の PATCH を送ると 400 が返り、LOOK の状態が変わらない', async ({
  request,
  baseURL,
}) => {
  const origin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    await withLook(async (look) => {
      const before = await readLook(db, look.id);
      const reply = await send(request, 'PATCH', one(look.id), {
        actor,
        origin,
        ip: uniqueIp(),
        data: 'not json',
        contentType: 'text/plain',
      });
      expect(reply.status, 'JSON でない本文の PATCH').toBe(400);
      expect(await readLook(db, look.id), 'LOOK の状態が変わらない').toEqual(before);
    });
  });
});

test('SEC-LOOK-011-AC-01 同じ操作者が x-forwarded-for を毎回変えて状態の変更を送っても、10分の中の31回目は 429 で断られ、LOOK の状態が変わらない', async ({
  request,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    // 専用の利用者（操作者の枠を他の試験と共有しない）
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    await withLook(async (look) => {
      await enterFreshWindowSpan();
      // 1〜30回目: 毎回別の送り元で、状態を非公開にする要求を送る（公開の画面に LOOK を出さないため、状態は private のまま）
      for (let n = 1; n <= STATUS_LIMIT; n += 1) {
        const reply = await send(request, 'PATCH', one(look.id), { actor, origin, ip: uniqueIp(), data: { status: 'private' } });
        expect(reply.status, `${n}回目の状態の変更は枠の内`).toBe(200);
      }
      const statusAfterThirty = await readStatus(db, look.id);
      expect(statusAfterThirty, '30回目までの状態').toBe('private');

      // 31回目: 状態を変えようとする要求を、また別の送り元で送る
      const last = await send(request, 'PATCH', one(look.id), { actor, origin, ip: uniqueIp(), data: { status: 'published' } });
      expect(last.status, '31回目の状態の変更').toBe(429);
      expect(await readStatus(db, look.id), '31回目で LOOK の状態が変わらない（30回目の状態のまま）').toBe(statusAfterThirty);
    });
  });
});
