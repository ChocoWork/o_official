/**
 * FR-LOGIN-063 店長の窓口: 招待・上げる・やり直し・下げる・招待の取り消し（API の試験）
 * 対応: FR-AUTH-038-AC-01〜03 / FR-AUTH-039-AC-01〜02 / FR-AUTH-040-AC-01〜02（設計: API-AUTH-033〜036、DD-AUTH-076・077。ADR-0471）
 *
 * 手元の Supabase とアプリ（本番ビルド）に、共有の道具 createAdminSessionActor（provisionStaff → パスキーのログイン → アプリの sessions に結び付ける）
 * で作った店長の JWT で、HTTP から叩く（画面は開かない。3つの幅でくり返す）。メールは手元の Mailpit（MAIL_PROVIDER=local）で、待ちは expect.poll。
 * 招待の合言葉のハッシュ（bytea）が PostgREST を通って表に入ったことは、メールのリンクの合言葉の SHA-256 と表の token_hash の一致で確かめる。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { createHash, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { provisionPasskeyUser, provisionStaff } from '../scripts/e2e/passkey-staff';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { mailBodies, uniqueEmail, waitForMail, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const INVITE_SUBJECT = '店員のアカウントの登録のご案内';
const DELETED_NOTICE = 'これまでのパスキーはすべて削除されました。';
const INVITE_LINK = /\/staff\/invite#([A-Za-z0-9_-]{43})/;
const EXPIRY_LINE = /リンクの有効期限は (\d{4})年(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{2})（日本時間） までです。/;

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function headersOf(actor: AdminSessionActor, origin: string): Record<string, string> {
  return { ...bearerHeaders(actor), origin, 'x-real-ip': uniqueIp() };
}

async function inviteMail(request: APIRequestContext, email: string): Promise<string> {
  const bodies = await waitForMail(request, email, INVITE_SUBJECT);
  expect(bodies).toHaveLength(1);
  return bodies[0].Text;
}

function tokenOf(text: string): string {
  const match = INVITE_LINK.exec(text);
  if (!match) throw new Error('メールにリンクの合言葉が無い');
  return match[1];
}

async function countOf(sql: string, userId: string): Promise<number> {
  return withLocalDb(async (db) => Number((await db.query(sql, [userId])).rows[0].n));
}

const credentialCount = (userId: string) => countOf('select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid', userId);
const approvedCount = (userId: string) => countOf('select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid', userId);
const sessionCount = (userId: string) => countOf('select count(*)::int as n from auth.sessions where user_id = $1::uuid', userId);
const activeRoleCount = (userId: string) =>
  countOf("select count(*)::int as n from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1::uuid and ur.active and r.code in ('admin','supporter')", userId);

type InviteRow = { id: string; kind: string; role_code: string; token_hash: Buffer; cancelled_at: string | null; expires_at: string; issued_by: string | null };

async function inviteRows(userId: string): Promise<InviteRow[]> {
  return withLocalDb(async (db) =>
    (await db.query('select id, kind, role_code, token_hash, cancelled_at, expires_at, issued_by::text from private.staff_invites where user_id = $1::uuid order by created_at', [userId])).rows as InviteRow[],
  );
}

async function userIdOf(email: string): Promise<string> {
  return withLocalDb(async (db) => (await db.query('select id::text as id from auth.users where lower(email) = lower($1)', [email])).rows[0].id as string);
}

async function addRawSession(userId: string): Promise<void> {
  await withLocalDb((db) => db.query('insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), $1::uuid, now())', [userId]));
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-063 staff invite api (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-038-AC-01 ${viewport.name}: 新しいアドレスの招待で、アカウントが作られ、メールが1通届き、リンクの合言葉の SHA-256 が表に入る`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const email = uniqueEmail('invite-new');

      const response = await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email, role: 'supporter' } });

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(response.headers()['cache-control']).toBe('no-store');
      const text = await inviteMail(request, email);
      expect(text).not.toContain(DELETED_NOTICE);
      expect(text).toContain('サポーターとして');
      const token = tokenOf(text);
      const userId = await userIdOf(email);
      const rows = await inviteRows(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'invite', role_code: 'supporter', cancelled_at: null, issued_by: admin.userId });
      // bytea の \x 形が PostgREST を通って、合言葉（UTF-8 の文字列）の SHA-256 として入っている
      expect(Buffer.from(rows[0].token_hash).toString('hex')).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
      expect(await activeRoleCount(userId)).toBe(0);
      // リンクの期限は、日本時間の書式で、表の期限とほぼ同じ時刻（発行の24時間後）
      const expiry = EXPIRY_LINE.exec(text);
      expect(expiry).not.toBeNull();
      const [, year, month, day, hour, minute] = expiry!.map(Number);
      const mailExpiry = Date.UTC(year, month - 1, day, hour - 9, minute);
      expect(Math.abs(mailExpiry - new Date(rows[0].expires_at).getTime())).toBeLessThanOrEqual(2 * 60 * 1000);
    });

    test(`FR-AUTH-038-AC-02 ${viewport.name}: パスキーとログインを持つお客さんへの招待は、鍵・ログインを消してメールの冒頭で知らせ、応答は新しいアドレスと同じ。今の店員は 409 で何も消えない`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const customer = await withLocalDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 1 }));
      await addRawSession(customer.userId);
      expect(await credentialCount(customer.userId)).toBe(1);
      expect(await sessionCount(customer.userId)).toBeGreaterThanOrEqual(1);

      const response = await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email: customer.email, role: 'admin' } });

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      const text = await inviteMail(request, customer.email);
      expect(text.startsWith(DELETED_NOTICE)).toBe(true);
      expect(await credentialCount(customer.userId)).toBe(0);
      expect(await approvedCount(customer.userId)).toBe(0);
      // アプリに結び付いていない GoTrue のセッション（auth.sessions に直に作った行）も消えている
      expect(await sessionCount(customer.userId)).toBe(0);

      // 今の有効な店員は 409 already_staff。鍵・ログインは何も消えない
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      await addRawSession(staff.userId);
      const sessionsBefore = await sessionCount(staff.userId);
      const refused = await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email: staff.email, role: 'admin' } });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error).toMatch(/^すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください/);
      expect(await credentialCount(staff.userId)).toBe(2);
      expect(await approvedCount(staff.userId)).toBe(2);
      expect(await sessionCount(staff.userId)).toBe(sessionsBefore);
      expect(await activeRoleCount(staff.userId)).toBe(1);
      expect(await inviteRows(staff.userId)).toHaveLength(0);
    });

    test(`FR-AUTH-038-AC-02 ${viewport.name}: 店長でない人・CSRF の Origin が無い要求は断られる`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const supporter = await withLocalDb((db) => createAdminSessionActor(db, 'supporter', 'aal2'));
      const customer = await withLocalDb((db) => createAdminSessionActor(db, 'user', 'aal1'));
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const email = uniqueEmail('invite-denied');
      const data = { email, role: 'admin' };

      for (const actor of [supporter, customer]) {
        const response = await request.post('/api/admin/staff/invites', { headers: headersOf(actor, origin), data, failOnStatusCode: false });
        expect(response.status()).toBe(403);
      }
      const noOrigin = await request.post('/api/admin/staff/invites', {
        headers: { ...bearerHeaders(admin), 'x-real-ip': uniqueIp() },
        data,
        failOnStatusCode: false,
      });
      expect(noOrigin.status()).toBe(403);
      expect(await mailBodies(request, email, INVITE_SUBJECT)).toHaveLength(0);
    });

    test(`FR-AUTH-038-AC-03 ${viewport.name}: 旧の利用者の作成の画面と窓口は 404 で、アカウントが作られない`, async ({ request, baseURL, page }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const email = uniqueEmail('old-create');

      const api = await request.post('/api/admin/create-user', {
        headers: headersOf(admin, origin),
        data: { email, password: `E2e-Old-${randomInt(1e9)}-0123456789`, display_name: 'old' },
        failOnStatusCode: false,
      });
      expect(api.status()).toBe(404);
      const screen = await page.goto('/admin/create-user');
      expect(screen?.status()).toBe(404);
      const created = await withLocalDb(async (db) => Number((await db.query('select count(*)::int as n from auth.users where lower(email) = lower($1)', [email])).rows[0].n));
      expect(created).toBe(0);
    });

    test(`FR-AUTH-039-AC-01 ${viewport.name}: やり直しは確認の語と理由を求め、自分自身は断り、成功すると鍵が0本・役割が無い・メールが1通・古い招待が取り消しになる`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      await addRawSession(target.userId);
      const reason = '端末を紛失したため、やり直します';
      const redo = (id: string, data: unknown) =>
        request.post(`/api/admin/staff/${id}/redo`, { headers: headersOf(admin, origin), data, failOnStatusCode: false });

      expect((await redo(target.userId, { confirm: 'RESET_MFA', reason })).status()).toBe(400);
      expect((await redo(target.userId, { confirm: 'やり直し', reason: '123456789' })).status()).toBe(400);
      expect((await redo(admin.userId, { confirm: 'やり直し', reason })).status()).toBe(403);
      expect(await credentialCount(target.userId)).toBe(2);

      const response = await redo(target.userId, { confirm: 'やり直し', reason });

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      const text = await inviteMail(request, target.email);
      expect(text.startsWith(DELETED_NOTICE)).toBe(true);
      expect(text).toContain('サポーターとして');
      expect(await credentialCount(target.userId)).toBe(0);
      expect(await approvedCount(target.userId)).toBe(0);
      expect(await activeRoleCount(target.userId)).toBe(0);
      expect(await sessionCount(target.userId)).toBe(0);
      const rows = await inviteRows(target.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'redo', role_code: 'supporter', cancelled_at: null });

      // 2回目のやり直し（招待中）は、店員でないので 409 not_staff
      const again = await redo(target.userId, { confirm: 'やり直し', reason });
      expect(again.status()).toBe(409);
      expect((await again.json()).code).toBe('not_staff');
      // 店員でない人（役割が無いお客さん）も 409
      const customer = await withLocalDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 0 }));
      expect((await redo(customer.userId, { confirm: 'やり直し', reason })).status()).toBe(409);
    });

    test(`FR-AUTH-039-AC-02 ${viewport.name}: お客さんを店員にする要求は直に役割を付けず、招待のメールを送り、期限を日本時間で書く`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const customer = await withLocalDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 1 }));

      const response = await request.patch('/api/admin/users', { headers: headersOf(admin, origin), data: { userId: customer.userId, role: 'admin' } });

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ success: true, invited: true });
      expect(await activeRoleCount(customer.userId)).toBe(0);
      const text = await inviteMail(request, customer.email);
      expect(text.startsWith(DELETED_NOTICE)).toBe(true);
      expect(text).toContain('店長として');
      expect(text).toMatch(EXPIRY_LINE);
      expect(await credentialCount(customer.userId)).toBe(0);
      const rows = await inviteRows(customer.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'promote', role_code: 'admin', cancelled_at: null });

      // 店員どうしの入れ替えは今のまま（招待を出さず、役割がそのまま変わる）
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      const swap = await request.patch('/api/admin/users', { headers: headersOf(admin, origin), data: { userId: staff.userId, role: 'admin' } });
      expect(swap.status()).toBe(200);
      expect(await swap.json()).toEqual({ success: true });
      expect(await inviteRows(staff.userId)).toHaveLength(0);
      expect(await credentialCount(staff.userId)).toBe(2);
    });

    test(`FR-AUTH-040-AC-01 ${viewport.name}: 降格は役割を外してログインを終わらせ（鍵は残す）、user への変更で開いている招待も取り消す`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      await addRawSession(staff.userId);

      const demoted = await request.post(`/api/admin/staff/${staff.userId}/demote`, { headers: headersOf(admin, origin), failOnStatusCode: false });

      expect(demoted.status()).toBe(200);
      expect(await demoted.json()).toEqual({ success: true });
      expect(await activeRoleCount(staff.userId)).toBe(0);
      expect(await sessionCount(staff.userId)).toBe(0);
      expect(await credentialCount(staff.userId)).toBe(2);
      expect(await approvedCount(staff.userId)).toBe(0);
      const self = await request.post(`/api/admin/staff/${admin.userId}/demote`, { headers: headersOf(admin, origin), failOnStatusCode: false });
      expect(self.status()).toBe(403);

      // 開いている招待のある人を PATCH で user にすると、招待も取り消される（admin_set_user_role の道では取り消されない）
      const invitee = uniqueEmail('demote-invite');
      expect((await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email: invitee, role: 'supporter' } })).status()).toBe(200);
      const inviteeId = await userIdOf(invitee);
      expect((await inviteRows(inviteeId))[0].cancelled_at).toBeNull();
      const patched = await request.patch('/api/admin/users', { headers: headersOf(admin, origin), data: { userId: inviteeId, role: 'user' } });
      expect(patched.status()).toBe(200);
      expect((await inviteRows(inviteeId))[0].cancelled_at).not.toBeNull();
    });

    test(`FR-AUTH-040-AC-02 ${viewport.name}: 招待の取り消しで、同じ合言葉が使えなくなり、招待のログインも終わる`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const email = uniqueEmail('cancel');
      expect((await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email, role: 'supporter' } })).status()).toBe(200);
      const text = await inviteMail(request, email);
      const hash = createHash('sha256').update(tokenOf(text), 'utf8').digest();
      const userId = await userIdOf(email);
      await addRawSession(userId);
      // 取り消す前は、同じハッシュで消費の関数が招待を返す（消費は使い切りなので、取り消しの確かめには別の招待を使わず、行だけ見る）
      const openBefore = await withLocalDb(async (db) =>
        (await db.query('select public.staff_invite_open($1::uuid) as open', [userId])).rows[0].open as boolean,
      );
      expect(openBefore).toBe(true);

      const cancelled = await request.post(`/api/admin/staff/${userId}/invite/cancel`, { headers: headersOf(admin, origin), failOnStatusCode: false });

      expect(cancelled.status()).toBe(200);
      expect(await cancelled.json()).toEqual({ success: true, cancelled: true });
      const rows = await inviteRows(userId);
      expect(rows[0].cancelled_at).not.toBeNull();
      const consumed = await withLocalDb(async (db) =>
        (await db.query('select * from public.staff_invite_consume($1::bytea)', [hash])).rows,
      );
      expect(consumed).toHaveLength(0);
      expect(await sessionCount(userId)).toBe(0);

      // 店長でない人は取り消せない
      const supporter = await withLocalDb((db) => createAdminSessionActor(db, 'supporter', 'aal2'));
      const denied = await request.post(`/api/admin/staff/${userId}/invite/cancel`, { headers: headersOf(supporter, origin), failOnStatusCode: false });
      expect(denied.status()).toBe(403);
    });

    test(`FR-AUTH-051-AC-01 ${viewport.name}: 取り消す招待が無い時は、200 の cancelled: false を返し、その人のログインを終わらせない`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const email = uniqueEmail('cancel-twice');
      expect((await request.post('/api/admin/staff/invites', { headers: headersOf(admin, origin), data: { email, role: 'supporter' } })).status()).toBe(200);
      await inviteMail(request, email);
      const userId = await userIdOf(email);
      await addRawSession(userId);

      const first = await request.post(`/api/admin/staff/${userId}/invite/cancel`, { headers: headersOf(admin, origin), failOnStatusCode: false });
      expect(first.status()).toBe(200);
      expect(await first.json()).toEqual({ success: true, cancelled: true });
      expect(await sessionCount(userId)).toBe(0);

      // もう取り消してある時は、ログインを終わらせない
      await addRawSession(userId);
      const second = await request.post(`/api/admin/staff/${userId}/invite/cancel`, { headers: headersOf(admin, origin), failOnStatusCode: false });
      expect(second.status()).toBe(200);
      expect(await second.json()).toEqual({ success: true, cancelled: false });
      expect(await sessionCount(userId)).toBe(1);
    });
  });
}
