/**
 * FR-ADMIN-MISC-005 色見本と管理の表を、アプリを通さず DB へ直接届く道（PostgREST）から叩いても守られ、色見本の変更が記録される
 * 対応: SEC-ADMIN-002-AC-01 / SEC-ADMIN-002-AC-02 / SEC-ADMIN-003-AC-01 / SEC-ADMIN-004-AC-01 / SEC-ADMIN-022-AC-01
 *
 * 手元の Supabase の PostgREST（SUPABASE_URL/rest/v1）を anon の鍵・一般会員の JWT・店長（役割 admin）の JWT で直接叩く。
 * 色見本の作成・削除と強制失効は、本物の窓口（/api/admin/item-color-presets・/api/admin/revoke-user-sessions）を Bearer で叩く。
 * 画面は開かない HTTP の試験なので、viewport の繰り返しは無い（1本ずつ）。
 *
 * JWT は共有の道具（e2e/admin-session-test-utils.ts）で作る。パスワードのログインで GoTrue が出した本物の JWT で、
 * aal2 は session に amr の行を足して refresh して出させる（JWT を自分で署名しない。アプリも PostgREST も本物の検証を通す）。
 *
 * 権限の表（role_permissions）は共有の状態で、権限の設定の試験が一時的に動かしうる。この spec は admin.items.* の付与を前提にするので、
 * 全部の試験を権限の鍵（190520, 0）の共有で持った間に流し、権限を外す試験が排他で動く間は待つ。
 *
 * 後始末: 試験で足した色見本・問い合わせの行は消す。利用者は残る（db reset で消える）。役割 admin を付けた利用者は、
 * 他の試験の「管理者の数」に影響しないよう、試験が終わるとき user_roles を無効にする。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { expect, test, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  createAdminSessionActor,
  elevateAdminSessionToAal2,
  type AdminSessionActor,
  type AdminSessionRole,
} from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const PRESETS_TABLE = 'item_color_presets';
const REVOKE_ROUTE = '/api/admin/revoke-user-sessions';
const PRESETS_ROUTE = '/api/admin/item-color-presets';

// ---- 手元の環境と DB ----

/** 権限の鍵（190520, 0）を共有で持って手元の DB の接続を使う（権限を外す試験が排他で動く間は待つ） */
async function withDb<T>(run: (db: PgClient) => Promise<T>): Promise<T> {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
  return withLocalDb(async (db) => {
    await db.query('select pg_catalog.pg_advisory_lock_shared(190520, 0)');
    try {
      return await run(db);
    } finally {
      await db.query('select pg_catalog.pg_advisory_unlock_shared(190520, 0)');
    }
  });
}

// ---- 利用者 ----

/** 役割つきの本物の JWT の利用者を作る（共有の道具）。共有の利用者は消さない（db reset で消える）。単独の利用者は各テストの finally で無効にする */
async function actorOf(role: AdminSessionRole, aal: 'aal1' | 'aal2'): Promise<AdminSessionActor> {
  return withLocalDb((db) => createAdminSessionActor(db, role, aal));
}

async function deactivateAdminRoles(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await withLocalDb((db) => db.query('update public.user_roles set active = false where user_id = any($1::uuid[])', [userIds]));
}

// ログインの回数の枠（5 分で 30 回）を使い切らないよう、共有で使う利用者は worker ごとに1回だけ作る
let sharedAdminAal1Promise: Promise<AdminSessionActor> | null = null;
let sharedAdminAal2Promise: Promise<AdminSessionActor> | null = null;
let sharedMemberPromise: Promise<AdminSessionActor> | null = null;
const sharedAdminAal1 = (): Promise<AdminSessionActor> => (sharedAdminAal1Promise ??= actorOf('admin', 'aal1'));
/** sharedAdminAal1 と同じ人・同じ session を aal2 に上げたもの（同じ人の aal1・aal2 の JWT を比べるため） */
const sharedAdminAal2 = (): Promise<AdminSessionActor> =>
  (sharedAdminAal2Promise ??= sharedAdminAal1().then((aal1) => withLocalDb((db) => elevateAdminSessionToAal2(db, aal1))));
const sharedMember = (): Promise<AdminSessionActor> => (sharedMemberPromise ??= actorOf('user', 'aal1'));

async function expectPermissions(db: PgClient, userId: string, codes: readonly string[]): Promise<void> {
  const held = await db.query(
    `select count(distinct p.code)::int as n
       from public.user_roles ur
       join public.role_permissions rp on rp.role_id = ur.role_id
       join public.permissions p on p.id = rp.permission_id
      where ur.user_id = $1::uuid and ur.active = true and (ur.expires_at is null or ur.expires_at > now())
        and p.code = any($2::text[])`,
    [userId, codes],
  );
  expect(held.rows[0].n, `${userId} が持つ権限（${codes.join('・')}）`).toBe(codes.length);
}

// ---- PostgREST ----

type Credential = { name: string; bearer: string };

const anonCredential = (): Credential => ({ name: 'anon の鍵', bearer: ANON_KEY });

function postgrestHeaders(bearer: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...extra };
}

const REPRESENTATION = { Prefer: 'return=representation' };

async function parsedRows(response: APIResponse): Promise<unknown[]> {
  const text = await response.text();
  if (text.trim() === '') return [];
  const body = JSON.parse(text) as unknown;
  if (!Array.isArray(body)) throw new Error(`行の一覧ではない応答: ${response.status()}`);
  return body;
}

/** select が1件も返さない（200 の空の一覧、または権限の断り） */
async function expectNoRowsReturned(response: APIResponse, label: string): Promise<void> {
  if ([401, 403].includes(response.status())) return;
  expect(response.status(), `${label}: select の status`).toBe(200);
  expect(await parsedRows(response), `${label}: select が返した行`).toEqual([]);
}

/** insert が断られる（行ができた 2xx は通さない） */
function expectInsertRefused(response: APIResponse, label: string): void {
  expect([401, 403], `${label}: insert の status`).toContain(response.status());
}

/** update・delete が断られるか、方針で1行も対象にならない（変わった行を返さない） */
async function expectWriteRefusedOrNoRowsAffected(response: APIResponse, label: string): Promise<void> {
  if ([401, 403].includes(response.status())) return;
  expect([200, 204], `${label}: 書き込みの status`).toContain(response.status());
  expect(await parsedRows(response), `${label}: 書き込みで変わった行`).toEqual([]);
}

/**
 * 「表の権限が無い」ことで断られたこと（403・SQLSTATE 42501・文が permission denied for table <表>）。
 * RLS の違反や 0 件の成功は通さない。JWT は有効なので 401 も通さない
 */
async function expectPermissionDenied(response: APIResponse, table: string, label: string): Promise<void> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  expect(response.status(), `${label}: 権限の誤りの状態`).toBe(403);
  expect(body.code, `${label}: SQLSTATE`).toBe('42501');
  expect(String(body.message), `${label}: 権限の誤りの文（RLS の誤りでも 0 件の成功でもない）`).toBe(`permission denied for table ${table}`);
}

async function insertPreset(db: PgClient, label: string): Promise<{ id: string; name: string }> {
  const name = `e2e-misc005-${label}-${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const inserted = await db.query(
    'insert into public.item_color_presets (name, hex) values ($1, $2) returning id::text as id',
    [name, '#a1b2c3'],
  );
  return { id: inserted.rows[0].id as string, name };
}

async function deletePresets(db: PgClient, ids: readonly string[], names: readonly string[]): Promise<void> {
  await db.query('delete from public.item_color_presets where id = any($1::bigint[]) or name = any($2::text[])', [ids, names]);
}

async function rowJson(db: PgClient, table: string, id: string): Promise<string | null> {
  const tables = ['item_color_presets', 'contact_inquiries', 'contact_messages', 'contact_reply_templates'];
  if (!tables.includes(table)) throw new Error(`知らない表: ${table}`);
  const found = await db.query(`select to_jsonb(t)::text as j from public.${table} as t where t.id = $1`, [id]);
  return found.rows[0]?.j ?? null;
}

async function authSessionIds(db: PgClient, userId: string): Promise<string[]> {
  const rows = await db.query('select id::text as id from auth.sessions where user_id = $1::uuid order by id', [userId]);
  return rows.rows.map((row: { id: string }) => row.id);
}

test.describe('FR-ADMIN-MISC-005 色見本と管理の表への直接の道', () => {
  test(`SEC-ADMIN-002-AC-01 admin.items.manage を持つ人の aal1 の JWT で色見本に insert・delete を送ると断られ、表の行が変わらない`, async ({ request }) => {
    const admin = await sharedAdminAal1();
    const aal2Admin = await sharedAdminAal2();
    const aal1 = admin.accessToken;
    const attempted = `e2e-misc005-002a-attempt-${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    await withDb(async (db) => {
      await expectPermissions(db, admin.userId, ['admin.items.manage', 'admin.items.read']);
      const seeded = await insertPreset(db, '002a');
      try {
        // 対照: 同じ人の aal2 の JWT なら、同じ表の行が読める（権限や付与の欠けで断られたのではないことの確かめ）
        const control = await request.get(`${SUPABASE_URL}/rest/v1/${PRESETS_TABLE}?select=id&id=eq.${seeded.id}`, {
          headers: postgrestHeaders(aal2Admin.accessToken),
          failOnStatusCode: false,
        });
        expect(control.status()).toBe(200);
        expect((await parsedRows(control)).length, '対照の aal2 の JWT で見える行').toBe(1);

        const before = await rowJson(db, PRESETS_TABLE, seeded.id);
        expect(before).not.toBeNull();

        const insert = await request.post(`${SUPABASE_URL}/rest/v1/${PRESETS_TABLE}`, {
          headers: postgrestHeaders(aal1, REPRESENTATION),
          data: { name: attempted, hex: '#112233' },
          failOnStatusCode: false,
        });
        await expectPermissionDenied(insert, PRESETS_TABLE, 'aal1 の JWT の insert');

        const remove = await request.delete(`${SUPABASE_URL}/rest/v1/${PRESETS_TABLE}?id=eq.${seeded.id}`, {
          headers: postgrestHeaders(aal1, REPRESENTATION),
          failOnStatusCode: false,
        });
        await expectPermissionDenied(remove, PRESETS_TABLE, 'aal1 の JWT の delete');

        // 表の行が変わらない: 送った insert の行は無く、入れておいた行は同じ中身で残る
        const inserted = await db.query('select count(*)::int as n from public.item_color_presets where name = $1', [attempted]);
        expect(inserted.rows[0].n, 'aal1 の insert で足された行').toBe(0);
        expect(await rowJson(db, PRESETS_TABLE, seeded.id), '入れておいた行').toBe(before);
      } finally {
        await deletePresets(db, [seeded.id], [attempted]);
      }
    });
  });

  test(`SEC-ADMIN-002-AC-02 /api/admin/revoke-user-sessions で失効させた人の、期限の残る JWT では色見本を select しても行が1件も返らない`, async ({ request, baseURL }) => {
    test.fail(true, 'SEC-ADMIN-002-AC-02 今のコードは満たさない（docs/02_Requirements/areas/admin.md）');
    if (!baseURL || !isLocalUrl(baseURL)) throw new Error('手元のアプリの baseURL が無い');
    const revoker = await sharedAdminAal2();
    await withDb(async (db) => {
      // 失効させる人は色見本を読める権限（admin.items.read）を持つ。権限が無ければ、失効の前から行が返らず試験にならない
      const target = await actorOf('admin', 'aal2');
      const seeded = await insertPreset(db, '002b');
      try {
        await expectPermissions(db, revoker.userId, ['admin.users.manage']);
        await expectPermissions(db, target.userId, ['admin.items.read']);
        const token = target.accessToken;
        const read = () =>
          request.get(`${SUPABASE_URL}/rest/v1/${PRESETS_TABLE}?select=id&id=eq.${seeded.id}`, {
            headers: postgrestHeaders(token),
            failOnStatusCode: false,
          });

        // 失効の前は、期限の残るこの JWT で行が読める
        const beforeRevoke = await read();
        expect(beforeRevoke.status()).toBe(200);
        expect((await parsedRows(beforeRevoke)).length, '失効の前に見える行').toBe(1);
        expect(await authSessionIds(db, target.userId)).toEqual([target.sessionId]);

        const revoke = await request.post(new URL(REVOKE_ROUTE, baseURL).toString(), {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${revoker.accessToken}`, Origin: new URL(baseURL).origin },
          data: { user_id: target.userId },
          failOnStatusCode: false,
        });
        expect(revoke.status(), `${REVOKE_ROUTE} の status`).toBe(200);
        expect(await authSessionIds(db, target.userId), '失効の後の auth.sessions').toEqual([]);

        // 失効の後: JWT の期限（1 時間）は残っているのに、行が1件も返らない
        const afterRevoke = await read();
        await expectNoRowsReturned(afterRevoke, '強制失効の後の JWT');
        const listAll = await request.get(`${SUPABASE_URL}/rest/v1/${PRESETS_TABLE}?select=*`, {
          headers: postgrestHeaders(token),
          failOnStatusCode: false,
        });
        await expectNoRowsReturned(listAll, '強制失効の後の JWT（全件）');
      } finally {
        await deletePresets(db, [seeded.id], []);
        await deactivateAdminRoles([target.userId]);
      }
    });
  });

  test(`SEC-ADMIN-003-AC-01 anon の鍵と一般会員の JWT では問い合わせの3つの表を読めず（0件）、insert・update・delete が断られ、行が変わらない`, async ({ request }) => {
    const member = await sharedMember();
    const marker = `e2e-misc005-003-${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    await withDb(async (db) => {
      const inquiry = (
        await db.query(
          `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
           values ('E2E', 'e2e-misc005@example.com', 'other', $1, 'seed') returning id::text as id`,
          [`${marker}-seed`],
        )
      ).rows[0].id as string;
      try {
        const message = (
          await db.query(
            `insert into public.contact_messages (inquiry_id, sender_role, body)
             values ($1::uuid, 'user', $2) returning id::text as id`,
            [inquiry, `${marker}-seed`],
          )
        ).rows[0].id as string;
        const template = (
          await db.query(
            `insert into public.contact_reply_templates (title, body) values ($1, 'seed') returning id::text as id`,
            [`${marker}-seed`],
          )
        ).rows[0].id as string;

        // 表ごとに、マーカーを入れる列（insert・update で書き換えを試す列）を決めておく
        const tables = [
          { table: 'contact_inquiries', id: inquiry, column: 'subject', insert: { name: 'E2E', email: 'e2e-misc005@example.com', inquiry_type: 'other', subject: `${marker}-attempt`, message: 'attempt' } },
          { table: 'contact_messages', id: message, column: 'body', insert: { inquiry_id: inquiry, sender_role: 'user', body: `${marker}-attempt` } },
          { table: 'contact_reply_templates', id: template, column: 'title', insert: { title: `${marker}-attempt`, body: 'attempt' } },
        ] as const;

        const before = new Map<string, string | null>();
        for (const t of tables) {
          before.set(t.table, await rowJson(db, t.table, t.id));
          expect(before.get(t.table), `${t.table} に入れておいた行`).not.toBeNull();
        }

        for (const credential of [anonCredential(), { name: '一般会員の JWT', bearer: member.accessToken }]) {
          for (const t of tables) {
            const label = `${credential.name} × ${t.table}`;
            const headers = postgrestHeaders(credential.bearer, REPRESENTATION);

            const select = await request.get(`${SUPABASE_URL}/rest/v1/${t.table}?select=*`, { headers, failOnStatusCode: false });
            expect(await select.text(), `${label}: select の応答に入れておいた行が出ない`).not.toContain(marker);
            await expectNoRowsReturned(select, label);

            const insert = await request.post(`${SUPABASE_URL}/rest/v1/${t.table}`, { headers, data: t.insert, failOnStatusCode: false });
            expectInsertRefused(insert, label);

            const update = await request.patch(`${SUPABASE_URL}/rest/v1/${t.table}?id=eq.${t.id}`, {
              headers,
              data: { [t.column]: `${marker}-tampered` },
              failOnStatusCode: false,
            });
            await expectWriteRefusedOrNoRowsAffected(update, `${label} の update`);

            const remove = await request.delete(`${SUPABASE_URL}/rest/v1/${t.table}?id=eq.${t.id}`, { headers, failOnStatusCode: false });
            await expectWriteRefusedOrNoRowsAffected(remove, `${label} の delete`);
          }
        }

        // 行が変わらない: 入れておいた行は同じ中身で残り、insert・update の印は表のどこにも無い
        for (const t of tables) {
          expect(await rowJson(db, t.table, t.id), `${t.table} の行`).toBe(before.get(t.table));
          const leaked = await db.query(
            `select count(*)::int as n from public.${t.table} where ${t.column} like $1 or ${t.column} like $2`,
            [`${marker}-attempt%`, `${marker}-tampered%`],
          );
          expect(leaked.rows[0].n, `${t.table} に書き込まれた行`).toBe(0);
        }
      } finally {
        // 試験の行だけ消す（後始末の失敗で試験を落とさない。残っても db reset で消える）
        await db.query('delete from public.contact_messages where inquiry_id = $1::uuid', [inquiry]).catch(() => undefined);
        await db.query('delete from public.contact_inquiries where id = $1::uuid', [inquiry]).catch(() => undefined);
        await db.query('delete from public.contact_reply_templates where title like $1', [`${marker}%`]).catch(() => undefined);
      }
    });
  });

  test(`SEC-ADMIN-004-AC-01 anon の鍵・一般会員の JWT・店長の aal2 の JWT で別の利用者の id を渡して RPC を呼ぶと断られ、その利用者の auth.sessions の行が残る`, async ({ request }) => {
    const member = await sharedMember();
    const manager = await sharedAdminAal2();
    await withDb(async (db) => {
      const target = await actorOf('user', 'aal1');
      const control = await actorOf('user', 'aal1');
      const rpc = `${SUPABASE_URL}/rest/v1/rpc/revoke_auth_sessions_for_user`;
      try {
        // 対照: service role の鍵なら同じ呼び方（引数 p_user_id）が通り、その利用者の session が消える。
        // 断りが「関数や引数の名前の違い」ではなく実行の権限によることの確かめ
        const allowed = await request.post(rpc, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          data: { p_user_id: control.userId },
          failOnStatusCode: false,
        });
        expect(allowed.status()).toBe(200);
        expect(await allowed.json()).toBe(1);
        expect(await authSessionIds(db, control.userId), '対照の利用者の auth.sessions').toEqual([]);

        const sessionsBefore = await authSessionIds(db, target.userId);
        expect(sessionsBefore).toEqual([target.sessionId]);

        const credentials: Credential[] = [
          anonCredential(),
          { name: '一般会員の JWT', bearer: member.accessToken },
          { name: '店長の aal2 の JWT', bearer: manager.accessToken },
        ];
        for (const credential of credentials) {
          const response = await request.post(rpc, {
            headers: postgrestHeaders(credential.bearer),
            data: { p_user_id: target.userId },
            failOnStatusCode: false,
          });
          // 実行の権限が無い呼び出しは 401（anon）・403（authenticated）。関数が見えない場合の 404 も断りに数える
          expect([401, 403, 404], `${credential.name}: RPC の status（${await response.text()}）`).toContain(response.status());
          expect(await authSessionIds(db, target.userId), `${credential.name} の後の対象の auth.sessions`).toEqual(sessionsBefore);
        }
      } finally {
        await db.query('delete from auth.sessions where user_id = any($1::uuid[])', [[target.userId, control.userId]]);
      }
    });
  });

  test(`SEC-ADMIN-022-AC-01 店長が色見本を1件作って消した後、監査ログに作成と削除の2行があり、どちらにもその店長の id とメールが入る`, async ({ request, baseURL }) => {
    if (!baseURL || !isLocalUrl(baseURL)) throw new Error('手元のアプリの baseURL が無い');
    const origin = new URL(baseURL).origin;
    await withDb(async (db) => {
      // 行為者を試験ごとに分けるため、この試験だけの店長を作る（監査ログを行為者の id で絞れる）
      const manager = await actorOf('admin', 'aal2');
      try {
        await expectPermissions(db, manager.userId, ['admin.items.manage']);
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${manager.accessToken}`, Origin: origin };
        const name = `e2e-misc005-022-${Date.now()}${Math.floor(Math.random() * 10_000)}`;

        const created = await request.post(new URL(PRESETS_ROUTE, baseURL).toString(), {
          headers,
          data: { name, hex: '#0a0b0c' },
          failOnStatusCode: false,
        });
        expect(created.status(), `POST ${PRESETS_ROUTE} の status`).toBe(201);
        const presetId = String(((await created.json()) as { data: { id: number | string } }).data.id);

        const removed = await request.delete(new URL(`${PRESETS_ROUTE}/${presetId}`, baseURL).toString(), {
          headers,
          failOnStatusCode: false,
        });
        expect(removed.status(), `DELETE ${PRESETS_ROUTE}/:id の status`).toBe(200);
        expect(await db.query('select 1 from public.item_color_presets where id = $1::bigint', [presetId]).then((r) => r.rowCount)).toBe(0);

        // この店長の行為の記録のうち、色見本のもの（action・resource・resource_id・detail・metadata のどこかに color が出る）
        const readColorRows = async () => {
          const rows = await db.query(
            `select action, actor_id::text as actor_id, actor_email, resource, resource_id, outcome, detail, metadata::text as metadata
               from public.audit_logs where actor_id = $1::uuid order by created_at, id`,
            [manager.userId],
          );
          return (rows.rows as Array<Record<string, string | null>>).filter((row) =>
            /color/i.test([row.action, row.resource, row.resource_id, row.detail, row.metadata].join(' ')),
          );
        };
        await expect
          .poll(async () => (await readColorRows()).length, { timeout: 5_000, message: '色見本の作成と削除の監査の行（2行）' })
          .toBeGreaterThanOrEqual(2);

        const rows = await readColorRows();
        // 作成か削除かは action と detail の言葉で見分ける（resource_id や metadata の名前には頼らない）
        const kindOf = (row: Record<string, string | null>) => `${row.action ?? ''} ${row.detail ?? ''}`;
        const createRow = rows.find((row) => /creat|save|insert|add|post/i.test(kindOf(row)) && !/delet|remov/i.test(kindOf(row)));
        const deleteRow = rows.find((row) => /delet|remov/i.test(kindOf(row)));
        expect(createRow, `作成の監査の行（${JSON.stringify(rows)}）`).toBeDefined();
        expect(deleteRow, `削除の監査の行（${JSON.stringify(rows)}）`).toBeDefined();
        expect(createRow).not.toBe(deleteRow);
        for (const row of [createRow, deleteRow]) {
          expect(row?.actor_id, '行為者の id').toBe(manager.userId);
          expect(row?.actor_email, '行為者のメール').toBe(manager.email);
        }
      } finally {
        await deactivateAdminRoles([manager.userId]);
      }
    });
  });
});
