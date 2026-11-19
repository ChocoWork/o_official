/**
 * FR-LOGIN-073 店長でなくなる時は、その店長が出した招待も取り消される（API の試験）
 * 対応: FR-AUTH-050-AC-01〜03（設計: DD-AUTH-085、API-AUTH-035。THR-AUTH-056・SEC-AUTH-059）
 *
 * 店長 A が出した招待のリンクは、別の店長 B が A を (1) 降格 (2) PATCH でサポーターへ変更 (3) やり直し、のどれで店長から外しても、
 * POST /api/auth/staff/invite/start で使えない（400 invite_invalid）。招待の行は取り消され、使えない理由は DB でも確かめる。
 * 手元の Supabase と本番ビルドに、createAdminSessionActor の JWT で HTTP から叩く（画面は開かない。3つの幅でくり返す）。
 * メールは手元の Mailpit（MAIL_PROVIDER=local）で、待ちは expect.poll。JWT が通信記録に残らないよう trace は切る。
 */
import { randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { mailBodies, uniqueEmail, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const INVITE_SUBJECT = '店員のアカウントの登録のご案内';
const INVITE_LINK = /\/staff\/invite#([A-Za-z0-9_-]{43})/;

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const uniqueIp = (): string => `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
const headersOf = (actor: AdminSessionActor, origin: string): Record<string, string> => ({ ...bearerHeaders(actor), origin, 'x-real-ip': uniqueIp() });

/** `issuer` が新しいアドレスへ招待を出し、メールのリンクの合言葉と利用者の id を返す */
async function issueFrom(request: APIRequestContext, issuer: AdminSessionActor, origin: string): Promise<{ token: string; userId: string }> {
  const email = uniqueEmail('cascade');
  const issued = await request.post('/api/admin/staff/invites', { headers: headersOf(issuer, origin), data: { email, role: 'supporter' } });
  expect(issued.status()).toBe(200);
  let text = '';
  await expect
    .poll(
      async () => {
        const bodies = await mailBodies(request, email, INVITE_SUBJECT);
        text = bodies[0]?.Text ?? '';
        return bodies.length;
      },
      { timeout: 15_000, message: '招待のメールが1通届く' },
    )
    .toBe(1);
  const match = INVITE_LINK.exec(text);
  if (!match) throw new Error('メールにリンクの合言葉が無い');
  const userId = await withLocalDb(
    async (db) => (await db.query('select id::text as id from auth.users where lower(email) = lower($1)', [email])).rows[0].id as string,
  );
  return { token: match[1], userId };
}

const isCancelled = (userId: string) =>
  withLocalDb(async (db) => (await db.query('select cancelled_at is not null as c from private.staff_invites where user_id = $1::uuid', [userId])).rows[0].c as boolean);

async function startWith(request: APIRequestContext, origin: string, token: string) {
  return request.post('/api/auth/staff/invite/start', { headers: { origin, 'x-real-ip': uniqueIp() }, data: { token }, failOnStatusCode: false });
}

async function twoManagers(): Promise<[AdminSessionActor, AdminSessionActor]> {
  return withLocalDb(async (db) => [await createAdminSessionActor(db, 'admin', 'aal2'), await createAdminSessionActor(db, 'admin', 'aal2')]);
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-073 staff demote cancels issued invites (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-050-AC-01 ${viewport.name}: 降格した店長が出した招待のリンクは使えず、ほかの店長が出した招待は使える`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const [manager, other] = await twoManagers();
      const byManager = await issueFrom(request, manager, origin);
      const byOther = await issueFrom(request, other, origin);

      const demoted = await request.post(`/api/admin/staff/${manager.userId}/demote`, { headers: headersOf(other, origin), failOnStatusCode: false });

      expect(demoted.status()).toBe(200);
      expect(await isCancelled(byManager.userId)).toBe(true);
      const refused = await startWith(request, origin, byManager.token);
      expect(refused.status()).toBe(400);
      expect(await refused.json()).toEqual({ error: 'invite_invalid' });
      expect(await isCancelled(byOther.userId)).toBe(false);
      expect((await startWith(request, origin, byOther.token)).status()).toBe(200);
    });

    test(`FR-AUTH-050-AC-02 ${viewport.name}: 店長をサポーターに変えても、その店長が出した招待のリンクは使えない`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const [manager, other] = await twoManagers();
      const issued = await issueFrom(request, manager, origin);

      const patched = await request.patch('/api/admin/users', { headers: headersOf(other, origin), data: { userId: manager.userId, role: 'supporter' } });

      expect(patched.status()).toBe(200);
      expect(await isCancelled(issued.userId)).toBe(true);
      const refused = await startWith(request, origin, issued.token);
      expect(refused.status()).toBe(400);
      expect(await refused.json()).toEqual({ error: 'invite_invalid' });
    });

    test(`FR-AUTH-050-AC-03 ${viewport.name}: 店長をやり直しにしても、その店長が出した招待のリンクは使えない`, async ({ request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = new URL(baseURL as string).origin;
      const [manager, other] = await twoManagers();
      const issued = await issueFrom(request, manager, origin);

      const redone = await request.post(`/api/admin/staff/${manager.userId}/redo`, {
        headers: headersOf(other, origin),
        data: { confirm: 'やり直し', reason: 'FR-LOGIN-073 の確かめ' },
        failOnStatusCode: false,
      });

      expect(redone.status()).toBe(200);
      expect(await isCancelled(issued.userId)).toBe(true);
      const refused = await startWith(request, origin, issued.token);
      expect(refused.status()).toBe(400);
      expect(await refused.json()).toEqual({ error: 'invite_invalid' });
    });
  });
}
