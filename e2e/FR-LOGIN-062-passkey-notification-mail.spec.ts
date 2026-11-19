/**
 * FR-LOGIN-062 パスキーの足し・消しの知らせのメール: お客さん本人・店員本人・ほかの店長に、それぞれの文面で届く
 * 対応: FR-AUTH-031-AC-01〜03・FR-AUTH-048-AC-01（設計: DD-AUTH-067・DD-AUTH-088。ADR-0470）
 *
 * 知らせの送り箱（private.passkey_notification_outbox）は全体で1つなので、毎分の定期処理（POST /api/cron/process-stripe-webhooks。
 * `e2e/order-email-test-utils.ts` と同じ CRON_SECRET の呼び方）が他の試験の行まで取る。だから serial の `isolated-global` で流し、
 * 先に手元の DB だけで、未送信の行を `skipped` にし、この試験が作る店員以外の E2E の店長の役割を一時的に外す（終わりの afterEach で戻す）。
 * メールは手元の Mailpit だけ（MAIL_PROVIDER=local。E2E の見張りが外へのメールを拒む）。手元の送り手は重複防止の鍵を使わないので、
 * 「2通目が出ない」は、行が `sent` のままで取り直されないことで確かめる（鍵そのものは単体テスト）。
 * お客さんのパスキーは Chromium の仮想の認証器（FR-LOGIN-060 と同じ）、店員の鍵は GoTrue へ直に足す（アプリの窓口を通さない道。keepNotifications）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { deviceNameFromUserAgent } from '../src/features/auth/passkey/device-name';
import { addUnapprovedPasskey, provisionStaff } from '../scripts/e2e/passkey-staff';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';
import { mailBodies, mailsTo, runWorkerOnce, runWorkerUntil, withLocalDb } from './order-email-test-utils';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './passkey-virtual-authenticator';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const NAVIGATION = { timeout: 15_000 };
const SECURITY_URL = '/account?tab=security';
const ADDED_SUBJECT = 'パスキーが追加されました';
const REMOVED_SUBJECT = 'パスキーが削除されました';
const ADMIN_ADDED_SUBJECT = '店員のパスキーが追加されました';
const DATE_LINE = /日時: \d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}（日本時間）/;

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-passkey-notice-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

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

/** 新しいお客さんがメールのコードで入る（FR-LOGIN-060 と同じ）。 */
async function signInByCode(page: Page, email: string): Promise<void> {
  const previous = new Set((await readMailpitMessages(email)).map((message) => message.ID));
  const started = await page.request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
  expect(started.status()).toBe(202);
  const code = await readLatestCode(email, previous);

  await page.goto('/login/code');
  await page.getByLabel('確認コード 1桁目').click();
  await page.keyboard.type(code);
  await expect(page.getByLabel('確認コード 8桁目')).toHaveValue(code[7]);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).not.toHaveURL(/\/login\/code/, NAVIGATION);
}

/** 1通の宛先（To）の一覧。「他のアドレスが無い」ことの確かめに使う。 */
async function recipientsOf(request: APIRequestContext, messageId: string): Promise<string[]> {
  const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(messageId)}`, process.env.MAIL_LOCAL_URL).toString(), { timeout: 5_000 });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { To?: Array<{ Address: string }>; Cc?: unknown[]; Bcc?: unknown[] };
  expect(body.Cc ?? []).toHaveLength(0);
  expect(body.Bcc ?? []).toHaveLength(0);
  return (body.To ?? []).map((entry) => entry.Address.toLowerCase());
}

async function mailCount(request: APIRequestContext, email: string, subject: string): Promise<number> {
  return (await mailsTo(request, email)).filter((message) => message.Subject === subject).length;
}

async function outboxStatus(userId: string, kind: string): Promise<string[]> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select status from private.passkey_notification_outbox
        where user_id = $1::uuid and kind = $2 and coalesce(last_error_code, '') <> 'e2e_skipped' order by seq`,
      [userId, kind],
    );
    return result.rows.map((row: { status: string }) => row.status);
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-062 passkey notification mail (${viewport.name})`, () => {
    let authenticators: VirtualAuthenticator[] = [];
    // 外した店長・この試験の店員の役割は、afterEach で戻す（試験の時間切れでも流れる。外した行は (user_id, role_id) で控え、その行だけ戻す。
    // 試験のプロセスが殺されると戻らないので、その時は `npm run db:reset` で戻す）
    let deactivated: Array<{ userId: string; roleId: number }> = [];
    let mine: string[] = [];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const authenticator of authenticators) await authenticator.remove();
      authenticators = [];
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

    test(`FR-AUTH-031-AC-01 ${viewport.name}: お客さんが追加すると本人だけに1通届き、名前を変えて削除すると削除の1通が届く。再実行しても2通目は出ない`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      test.setTimeout(180_000);
      await clearPendingNotifications();
      authenticators.push(await addVirtualAuthenticator(page));
      const email = uniqueEmail('customer');
      await signInByCode(page, email);
      await page.goto(SECURITY_URL);
      await expect(page.getByRole('heading', { name: 'パスキー' })).toBeVisible(NAVIGATION);

      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'パスキーを追加しました。' })).toBeVisible(NAVIGATION);

      await runWorkerUntil(page.request, async () => (await mailCount(page.request, email, ADDED_SUBJECT)) >= 1, '追加の知らせが届かない');
      const added = await mailBodies(page.request, email, ADDED_SUBJECT);
      expect(added).toHaveLength(1);
      // 鍵は GoTrue が「Passkey」で足し、画面が後から端末の名前に直す。知らせには送る時の名前（端末の名前）が載る
      const expectedName = deviceNameFromUserAgent(await page.evaluate(() => navigator.userAgent));
      expect(added[0].Text).toContain(`名前: ${expectedName}`);
      expect(added[0].Text).not.toContain('名前: Passkey');
      expect(added[0].Text).toMatch(DATE_LINE);
      expect(added[0].Text).toContain('ご登録のアカウントに、パスキーが追加されました。');
      expect(added[0].Text).toContain('/contact');
      expect(added[0].Text).not.toContain('店長');
      const addedMessage = (await mailsTo(page.request, email)).find((message) => message.Subject === ADDED_SUBJECT);
      expect(await recipientsOf(page.request, addedMessage!.ID)).toEqual([email.toLowerCase()]);

      // もう一度流しても、行は sent のままで取り直されず、2通目は出ない
      await runWorkerOnce(page.request);
      await runWorkerOnce(page.request);
      expect(await mailCount(page.request, email, ADDED_SUBJECT)).toBe(1);

      // 名前の変更（鍵の中身は変わらないので、知らせは増えない）→ 削除
      await page.getByRole('button', { name: /名前を変更/ }).click();
      await page.getByLabel('名前', { exact: true }).fill('仕事の PC');
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.locator('.account-card ul > li').getByText('仕事の PC', { exact: true })).toBeVisible(NAVIGATION);
      await page.getByRole('button', { name: '仕事の PCを削除' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '削除する' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'パスキーを削除しました。' })).toBeVisible(NAVIGATION);

      await runWorkerUntil(page.request, async () => (await mailCount(page.request, email, REMOVED_SUBJECT)) >= 1, '削除の知らせが届かない');
      const removed = await mailBodies(page.request, email, REMOVED_SUBJECT);
      expect(removed).toHaveLength(1);
      expect(removed[0].Text).toContain('名前: 仕事の PC');
      expect(removed[0].Text).toMatch(DATE_LINE);
      expect(removed[0].Text).toContain('ご登録のアカウントから、パスキーが削除されました。');
      await runWorkerOnce(page.request);
      expect(await mailCount(page.request, email, REMOVED_SUBJECT)).toBe(1);
      expect(await mailCount(page.request, email, ADDED_SUBJECT)).toBe(1);
    });

    test(`FR-AUTH-031-AC-02 ${viewport.name}: 店員が鍵を足すと本人に店員の文面、ほかの店長に本人のアドレス入りの店長の文面が届き、サポーターには届かない`, async ({ request }) => {
      test.setTimeout(180_000);
      await clearPendingNotifications();
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const otherAdmin = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const supporter = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 1 }));
      mine = [staff.userId, otherAdmin.userId, supporter.userId];
      // この試験が作った店長以外の E2E の店長を外す（isolated-global なので、ほかの試験は動いていない。終わりに戻す）
      await withLocalDb(async (db) => {
        const result = await db.query(
          `update public.user_roles ur set active = false
             from public.roles r, auth.users u
            where r.id = ur.role_id and r.code = 'admin' and ur.active and u.id = ur.user_id
              and u.email like '%@example.com' and ur.user_id <> all($1::uuid[])
        returning ur.user_id, ur.role_id`,
          [mine],
        );
        for (const row of result.rows as Array<{ user_id: string; role_id: number }>) deactivated.push({ userId: row.user_id, roleId: Number(row.role_id) });
      });

      await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0], keepNotifications: true });
      await runWorkerUntil(
        request,
        async () => (await mailCount(request, staff.email, ADDED_SUBJECT)) >= 1 && (await mailCount(request, otherAdmin.email, ADMIN_ADDED_SUBJECT)) >= 1,
        '店員の追加の知らせが届かない',
      );

      const own = await mailBodies(request, staff.email, ADDED_SUBJECT);
      expect(own).toHaveLength(1);
      expect(own[0].Text).toContain('ご自身で行われた操作でない場合は、すぐに店長へお知らせください。');
      expect(own[0].Text).not.toContain('/contact');
      expect(own[0].Text).not.toContain(staff.email);
      expect(own[0].Text).toMatch(DATE_LINE);

      const toAdmin = await mailBodies(request, otherAdmin.email, ADMIN_ADDED_SUBJECT);
      expect(toAdmin).toHaveLength(1);
      expect(toAdmin[0].Text).toContain(`${staff.email} のパスキーが追加されました。`);
      expect(toAdmin[0].Text).toContain('本人の操作か確認してください。心当たりがない場合は、そのアカウントのログインを止めてください。');
      expect(toAdmin[0].Text).toMatch(DATE_LINE);
      const adminMessage = (await mailsTo(request, otherAdmin.email)).find((message) => message.Subject === ADMIN_ADDED_SUBJECT);
      expect(await recipientsOf(request, adminMessage!.ID)).toEqual([otherAdmin.email.toLowerCase()]);

      // 本人には店長の文面が、店長には店員の文面が出ない。サポーターには何も届かない
      expect(await mailCount(request, staff.email, ADMIN_ADDED_SUBJECT)).toBe(0);
      expect(await mailCount(request, otherAdmin.email, ADDED_SUBJECT)).toBe(0);
      expect((await mailsTo(request, supporter.email)).filter((message) => message.Subject.includes('パスキー'))).toHaveLength(0);
      expect(await outboxStatus(staff.userId, 'passkey_added')).toEqual(['sent']);

      // 再実行しても2通目は出ない
      await runWorkerOnce(request);
      expect(await mailCount(request, staff.email, ADDED_SUBJECT)).toBe(1);
      expect(await mailCount(request, otherAdmin.email, ADMIN_ADDED_SUBJECT)).toBe(1);
    });

    test(`FR-AUTH-048-AC-01 ${viewport.name}: 宛先の店長が6人いても、全員に知らせが届く（煙の確かめ）`, async ({ request }) => {
      test.setTimeout(240_000);
      await clearPendingNotifications();
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const admins: Awaited<ReturnType<typeof provisionStaff>>[] = [];
      mine.push(staff.userId);
      for (let i = 0; i < 6; i += 1) {
        const admin = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
        admins.push(admin);
        mine.push(admin.userId);
      }
      await withLocalDb(async (db) => {
        const result = await db.query(
          `update public.user_roles ur set active = false
             from public.roles r, auth.users u
            where r.id = ur.role_id and r.code = 'admin' and ur.active and u.id = ur.user_id
              and u.email like '%@example.com' and ur.user_id <> all($1::uuid[])
        returning ur.user_id, ur.role_id`,
          [mine],
        );
        for (const row of result.rows as Array<{ user_id: string; role_id: number }>) deactivated.push({ userId: row.user_id, roleId: Number(row.role_id) });
      });

      await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0], keepNotifications: true });
      await runWorkerUntil(
        request,
        async () => {
          for (const admin of admins) if ((await mailCount(request, admin.email, ADMIN_ADDED_SUBJECT)) < 1) return false;
          return true;
        },
        '6人の店長全員に知らせが届かない',
      );
      for (const admin of admins) expect(await mailCount(request, admin.email, ADMIN_ADDED_SUBJECT)).toBeGreaterThanOrEqual(1);
      expect(await outboxStatus(staff.userId, 'passkey_added')).toEqual(['sent']);
    });

    test(`FR-AUTH-031-AC-03 ${viewport.name}: メールは手元の Mailpit だけへ送られる（外へ出る設定ではない）`, async () => {
      expect(process.env.MAIL_PROVIDER).toBe('local');
      expect(isLocalUrl(process.env.MAIL_LOCAL_URL)).toBe(true);
    });
  });
}
