/**
 * FR-LOGIN-071 店長への知らせのメール: 店員のやり直し・招待・降格を、ほかの店長に届け、対象の本人には届けない
 * 対応: FR-AUTH-047-AC-01〜03（設計: DD-AUTH-086・DD-AUTH-087。ADR-0473）
 *
 * 知らせの送り箱（private.passkey_notification_outbox）は全体で1つで、新しい知らせは DB の全店長へ出るので、FR-LOGIN-062 と同じく
 * serial の `isolated-global` で流し、先に手元の DB だけで未送信の行を `skipped` にし、この試験が作る店長以外の E2E の店長の役割を
 * 一時的に外す（終わりの afterEach で戻す）。知らせは worker を叩かないと送られないので、待ちは `runWorkerUntil`（B に件名のメールが届くまで）。
 * 「届かない」の確かめは、B に届いた後に行う（先に確かめると、まだ送っていないだけで通ってしまう）。
 * 手元の送り手は重複防止の鍵を見ないので、予算越えの再試行で同じ店長に2通届きうる。だから「1通以上」と書く。
 * メールは手元の Mailpit だけ（MAIL_PROVIDER=local）。店長の JWT で HTTP から叩く（画面は開かない。3つの幅でくり返す）。JWT が残らないよう trace は切る。
 */
import { randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { provisionStaff } from '../scripts/e2e/passkey-staff';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { mailBodies, mailsTo, runWorkerUntil, uniqueEmail, waitForMail, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const REDO_SUBJECT = '店員のパスキーのやり直しが出されました';
const INVITED_SUBJECT = '店員の招待が出されました';
const DEMOTED_SUBJECT = '店員がお客さんに戻されました';
const INVITE_MAIL_SUBJECT = '店員のアカウントの登録のご案内';
const CLOSING = '心当たりがない場合は、店長の権限を確認してください。';
const DATE_LINE = /日時: \d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}（日本時間）/;
const MANAGER_SUBJECTS = [REDO_SUBJECT, INVITED_SUBJECT, DEMOTED_SUBJECT];

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const uniqueIp = (): string => `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
const headersOf = (actor: AdminSessionActor, origin: string): Record<string, string> => ({ ...bearerHeaders(actor), origin, 'x-real-ip': uniqueIp() });

/** 他の試験の未送信の行を取り下げる（この試験の行を作る前に流す。手元の DB だけ）。 */
async function clearPendingNotifications(): Promise<void> {
  await withLocalDb(async (db) => {
    await db.query(
      `update private.passkey_notification_outbox
          set status = 'skipped', finished_at = now(), last_error_code = 'e2e_skipped'
        where status in ('pending', 'retry_wait')`,
    );
  });
}

async function mailCount(request: APIRequestContext, email: string, subject: string): Promise<number> {
  return (await mailsTo(request, email)).filter((message) => message.Subject === subject).length;
}

/** 手元の DB に、店長（actor・other）と、その役割を持つ対象の店員を用意する。ほかの E2E の店長は外す（afterEach で戻す） */
async function prepareManagers(
  deactivated: Array<{ userId: string; roleId: number }>,
  mine: string[],
): Promise<{ actor: AdminSessionActor; other: AdminSessionActor }> {
  await clearPendingNotifications();
  return withLocalDb(async (db) => {
    // 作った直後に控える（途中で落ちても afterEach が店長の役割を外せる）
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    mine.push(actor.userId);
    const other = await createAdminSessionActor(db, 'admin', 'aal2');
    mine.push(other.userId);
    const result = await db.query(
      `update public.user_roles ur set active = false
         from public.roles r, auth.users u
        where r.id = ur.role_id and r.code = 'admin' and ur.active and u.id = ur.user_id
          and u.email like '%@example.com' and ur.user_id <> all($1::uuid[])
    returning ur.user_id, ur.role_id`,
      [[actor.userId, other.userId]],
    );
    for (const row of result.rows as Array<{ user_id: string; role_id: number }>) deactivated.push({ userId: row.user_id, roleId: Number(row.role_id) });
    return { actor, other };
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-071 staff manager notice mail (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // 外した店長・この試験の店長の役割は、afterEach で戻す・外す（試験の時間切れでも流れる。外した行は (user_id, role_id) で控える。
    // 試験のプロセスが殺されると戻らないので、その時は `npm run db:reset` で戻す）
    let deactivated: Array<{ userId: string; roleId: number }> = [];
    let mine: string[] = [];

    test.afterEach(async () => {
      const restore = deactivated;
      const own = mine;
      deactivated = [];
      mine = [];
      if (restore.length === 0 && own.length === 0) return;
      await withLocalDb(async (db) => {
        if (restore.length > 0) {
          await db.query(
            'update public.user_roles set active = true where (user_id, role_id) in (select * from unnest($1::uuid[], $2::bigint[]))',
            [restore.map((row) => row.userId), restore.map((row) => row.roleId)],
          );
        }
        if (own.length > 0) await db.query('update public.user_roles set active = false where user_id = any($1::uuid[])', [own]);
      });
    });

    test(`FR-AUTH-047-AC-01 ${viewport.name}: 店長 A が店員 X をやり直すと、ほかの店長 B に操作した店長つきの知らせが届き、X には届かない`, async ({ request, baseURL }) => {
      test.setTimeout(180_000);
      const origin = new URL(baseURL as string).origin;
      const { actor, other } = await prepareManagers(deactivated, mine);
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      mine.push(target.userId);

      const response = await request.post(`/api/admin/staff/${target.userId}/redo`, {
        headers: headersOf(actor, origin),
        data: { confirm: 'やり直し', reason: '端末を紛失したため、やり直します' },
        failOnStatusCode: false,
      });
      expect(response.status()).toBe(200);

      await runWorkerUntil(request, async () => (await mailCount(request, other.email, REDO_SUBJECT)) >= 1, 'やり直しの知らせが B に届かない');

      const bodies = await mailBodies(request, other.email, REDO_SUBJECT);
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(bodies[0].Text).toContain(`${target.email} のパスキーのやり直しが出されました。`);
      expect(bodies[0].Text).toMatch(DATE_LINE);
      expect(bodies[0].Text).toContain(`操作した店長: ${actor.email}`);
      expect(bodies[0].Text).toContain(CLOSING);
      expect(bodies[0].Text).not.toContain('名前:');
      // B に届いた後で、対象の本人には店長への知らせが無いことを確かめる（本人には招待のメールが別の件名で届く）
      for (const subject of MANAGER_SUBJECTS) expect(await mailCount(request, target.email, subject)).toBe(0);
      await waitForMail(request, target.email, INVITE_MAIL_SUBJECT);
    });

    test(`FR-AUTH-047-AC-02 ${viewport.name}: 店長 A が新しいアドレスの X を招待すると、ほかの店長 B に招待の知らせが届き、X には招待のメールだけが届く`, async ({ request, baseURL }) => {
      test.setTimeout(180_000);
      const origin = new URL(baseURL as string).origin;
      const { actor, other } = await prepareManagers(deactivated, mine);
      const inviteeEmail = uniqueEmail('manager-notice-invite');

      const response = await request.post('/api/admin/staff/invites', {
        headers: headersOf(actor, origin),
        data: { email: inviteeEmail, role: 'supporter' },
        failOnStatusCode: false,
      });
      expect(response.status()).toBe(200);

      await runWorkerUntil(request, async () => (await mailCount(request, other.email, INVITED_SUBJECT)) >= 1, '招待の知らせが B に届かない');

      const bodies = await mailBodies(request, other.email, INVITED_SUBJECT);
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(bodies[0].Text).toContain(`${inviteeEmail} への店員の招待が出されました。`);
      expect(bodies[0].Text).toMatch(DATE_LINE);
      expect(bodies[0].Text).toContain(`操作した店長: ${actor.email}`);
      expect(bodies[0].Text).toContain(CLOSING);
      for (const subject of MANAGER_SUBJECTS) expect(await mailCount(request, inviteeEmail, subject)).toBe(0);
      await waitForMail(request, inviteeEmail, INVITE_MAIL_SUBJECT);
    });

    test(`FR-AUTH-047-AC-03 ${viewport.name}: 店長 A が店員 X をお客さんに戻すと、ほかの店長 B に降格の知らせが届き、X には届かない`, async ({ request, baseURL }) => {
      test.setTimeout(180_000);
      const origin = new URL(baseURL as string).origin;
      const { actor, other } = await prepareManagers(deactivated, mine);
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      mine.push(target.userId);

      const response = await request.post(`/api/admin/staff/${target.userId}/demote`, { headers: headersOf(actor, origin), failOnStatusCode: false });
      expect(response.status()).toBe(200);

      await runWorkerUntil(request, async () => (await mailCount(request, other.email, DEMOTED_SUBJECT)) >= 1, '降格の知らせが B に届かない');

      const bodies = await mailBodies(request, other.email, DEMOTED_SUBJECT);
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(bodies[0].Text).toContain(`${target.email} が、店員からお客さんに戻されました。`);
      expect(bodies[0].Text).toMatch(DATE_LINE);
      expect(bodies[0].Text).toContain(`操作した店長: ${actor.email}`);
      expect(bodies[0].Text).toContain(CLOSING);
      for (const subject of MANAGER_SUBJECTS) expect(await mailCount(request, target.email, subject)).toBe(0);
    });
  });
}
