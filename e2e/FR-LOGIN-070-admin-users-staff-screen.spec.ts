/**
 * FR-LOGIN-070 管理画面「ユーザー」の店員の操作（招待・やり直し・店員にする・招待の取り消し）
 * 対応: FR-AUTH-040-AC-03、FR-AUTH-051-AC-02（設計: SCR-AUTH-016、DD-AUTH-084、SEC-AUTH-056）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で、店長が画面から操作する。店長は provisionStaff（ソフトの認証器）で用意し、
 * パスキーでログインして Cookie を得る（page.request と画面は同じ Cookie）。メールの待ちは expect.poll。鍵の中身・トークンは文面に出さない。
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { provisionPasskeyUser, provisionStaff, skipPasskeyNotificationsOf } from '../scripts/e2e/passkey-staff';
import { mailBodies, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { loginViaApp } from './passkey-app-api';

test.use({ trace: 'off' });

const NAVIGATION = { timeout: 30_000 };
const INVITE_SUBJECT = '店員のアカウントの登録のご案内';
const INVITE_LINK = /\/staff\/invite#([A-Za-z0-9_-]{43})/;

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** 認めた鍵が2本の店長を用意し、パスキーでログインした Cookie を、画面と同じ文脈（page.request）に得る。 */
async function adminLoggedIn(page: Page): Promise<string> {
  const admin = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
  const login = await loginViaApp(page.request, { authenticator: admin.authenticators[0], ip: uniqueIp() });
  expect(login.status).toBe(200);
  return admin.userId;
}

async function openUsers(page: Page): Promise<void> {
  await page.goto('/admin?tab=USER');
  await expect(page.getByRole('button', { name: '店員を招待' })).toBeVisible(NAVIGATION);
}

function rowOf(page: Page, email: string) {
  return page.getByRole('row').filter({ hasText: email });
}

async function inviteMailText(page: Page, email: string): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const bodies = await mailBodies(page.request, email, INVITE_SUBJECT);
        text = bodies[0]?.Text ?? '';
        return bodies.length;
      },
      { timeout: 15_000, message: '招待のメールが1通届く' },
    )
    .toBe(1);
  return text;
}

/** 招待の取り消しの確認（Task 18）で「取り消す」を押す。 */
async function confirmCancel(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '招待を取り消す' });
  await expect(dialog).toContainText('この招待を取り消します。よろしいですか。');
  await dialog.getByRole('button', { name: '取り消す' }).click();
}

async function countOf(sql: string, userId: string): Promise<number> {
  return withLocalDb(async (db) => Number((await db.query(sql, [userId])).rows[0].n));
}

const activeRoleCount = (userId: string) =>
  countOf("select count(*)::int as n from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1::uuid and ur.active and r.code in ('admin','supporter')", userId);

const approvedCount = (userId: string) => countOf('select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid', userId);

async function userIdOf(email: string): Promise<string> {
  return withLocalDb(async (db) => (await db.query('select id::text as id from auth.users where lower(email) = lower($1)', [email])).rows[0].id as string);
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-070 admin users staff screen (${viewport.name})`, () => {
    const cleanup: string[] = [];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const userId of cleanup.splice(0)) await withLocalDb((db) => skipPasskeyNotificationsOf(db, userId));
    });

    test(`FR-AUTH-040-AC-03 ${viewport.name}: 画面から店員を招待するとメールが1通届き、その行に「招待中」が出る。取り消すと同じリンクが使えない`, async ({ page }) => {
      test.setTimeout(120_000);
      cleanup.push(await adminLoggedIn(page));
      const email = uniqueEmail('screen-invite');
      await openUsers(page);

      await page.getByRole('button', { name: '店員を招待' }).click();
      const dialog = page.getByRole('dialog', { name: '店員を招待' });
      await dialog.getByLabel(/メールアドレス/).fill(email);
      await dialog.getByLabel('役割').selectOption('supporter');
      await dialog.getByRole('button', { name: '招待を送る' }).click();

      await expect(page.getByText(`${email} へ、招待のメールを送りました。`)).toBeVisible(NAVIGATION);
      const text = await inviteMailText(page, email);
      const match = INVITE_LINK.exec(text);
      expect(match).not.toBeNull();
      const hash = createHash('sha256').update(match![1], 'utf8').digest();

      const row = rowOf(page, email);
      await expect(row.getByText('招待中')).toBeVisible(NAVIGATION);
      await row.getByRole('button', { name: '招待を取り消す' }).click();
      await confirmCancel(page);
      await expect(page.getByText(`${email} への招待を取り消しました。`)).toBeVisible(NAVIGATION);
      await expect(rowOf(page, email).getByText('招待中')).toHaveCount(0);

      const consumed = await withLocalDb(async (db) => (await db.query('select * from public.staff_invite_consume($1::bytea)', [hash])).rows);
      expect(consumed).toHaveLength(0);
    });

    test(`FR-AUTH-051-AC-02 ${viewport.name}: すでに取り消されている招待の「招待を取り消す」では、取り消しの知らせを出さず、一覧だけ読み直して「招待中」が消える`, async ({ page }) => {
      test.setTimeout(120_000);
      cleanup.push(await adminLoggedIn(page));
      const email = uniqueEmail('screen-cancel-twice');
      await openUsers(page);

      await page.getByRole('button', { name: '店員を招待' }).click();
      const dialog = page.getByRole('dialog', { name: '店員を招待' });
      await dialog.getByLabel(/メールアドレス/).fill(email);
      await dialog.getByLabel('役割').selectOption('supporter');
      await dialog.getByRole('button', { name: '招待を送る' }).click();
      await expect(page.getByText(`${email} へ、招待のメールを送りました。`)).toBeVisible(NAVIGATION);
      const row = rowOf(page, email);
      await expect(row.getByText('招待中')).toBeVisible(NAVIGATION);

      // 画面を開いたまま、別の道（降格など）で先に取り消された状態にする
      const userId = await userIdOf(email);
      await withLocalDb((db) => db.query('update private.staff_invites set cancelled_at = now() where user_id = $1::uuid and cancelled_at is null', [userId]));

      await row.getByRole('button', { name: '招待を取り消す' }).click();
      await confirmCancel(page);
      await expect(rowOf(page, email).getByText('招待中')).toHaveCount(0, NAVIGATION);
      await expect(page.getByText(`${email} への招待を取り消しました。`)).toHaveCount(0);
    });

    test(`FR-AUTH-040-AC-03 ${viewport.name}: やり直しで認めた鍵が2本から0本になり、その行は役割が外れて「招待中」になり、やり直しのメールが1通届く`, async ({ page }) => {
      test.setTimeout(120_000);
      cleanup.push(await adminLoggedIn(page));
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      cleanup.push(target.userId);
      await openUsers(page);

      const row = rowOf(page, target.email);
      await expect(row.getByText('認めた鍵 2本')).toBeVisible(NAVIGATION);
      await row.getByRole('button', { name: 'パスキーを全部消してやり直す' }).click();
      const dialog = page.getByRole('dialog', { name: 'パスキーを全部消してやり直す' });
      const send = dialog.getByRole('button', { name: 'やり直しを送る' });
      await dialog.getByLabel(/確認のため/).fill('やり直し');
      await dialog.getByLabel(/理由/).fill('123456789');
      await expect(send).toBeDisabled();
      await dialog.getByLabel(/理由/).fill('端末を紛失したため、やり直します');
      await send.click();

      await expect(page.getByText(`${target.email} へ、やり直しの招待のメールを送りました。`)).toBeVisible(NAVIGATION);
      // 役割は止まり（お客さんの扱い）、開いた招待が出るので、行は店員の本数の表示から「招待中」に替わる
      await expect(rowOf(page, target.email).getByText('招待中')).toBeVisible(NAVIGATION);
      expect(await approvedCount(target.userId)).toBe(0);
      expect((await inviteMailText(page, target.email)).startsWith('これまでのパスキーはすべて削除されました。')).toBe(true);
      expect(await activeRoleCount(target.userId)).toBe(0);
    });

    test(`FR-AUTH-040-AC-03 ${viewport.name}: 「店員にする」は確認の後に招待を出し、役割はすぐには変わらない`, async ({ page }) => {
      test.setTimeout(120_000);
      cleanup.push(await adminLoggedIn(page));
      const customer = await withLocalDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 1 }));
      cleanup.push(customer.userId);
      await openUsers(page);

      const row = rowOf(page, customer.email);
      const select = row.getByRole('combobox');
      await expect(select).toHaveText('User', NAVIGATION);
      await select.click();
      await page.getByRole('listbox').getByRole('option', { name: 'Support', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '店員にする' });
      await expect(dialog).toContainText('招待のメールを送ります');
      expect(await activeRoleCount(customer.userId)).toBe(0);
      await dialog.getByRole('button', { name: '店員にする' }).click();

      await expect(page.getByText('招待のメールを送りました。')).toBeVisible(NAVIGATION);
      await expect(rowOf(page, customer.email).getByText('招待中')).toBeVisible(NAVIGATION);
      await expect(rowOf(page, customer.email).getByRole('combobox')).toHaveText('User');
      expect(await activeRoleCount(customer.userId)).toBe(0);
      expect(await inviteMailText(page, customer.email)).toContain('サポーターとして');
      expect(await userIdOf(customer.email)).toBe(customer.userId);
    });

    test(`FR-AUTH-040-AC-03 ${viewport.name}: 自分の行は押せない。お客さんに戻すと役割が外れる`, async ({ page }) => {
      test.setTimeout(120_000);
      const selfId = await adminLoggedIn(page);
      cleanup.push(selfId);
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      cleanup.push(target.userId);
      await openUsers(page);

      const selfEmail = await withLocalDb(async (db) => (await db.query('select email from auth.users where id = $1::uuid', [selfId])).rows[0].email as string);
      const self = rowOf(page, selfEmail);
      await expect(self.getByRole('button', { name: 'お客さんに戻す' })).toBeDisabled(NAVIGATION);
      await expect(self.getByText('自分自身は変更できません。')).toBeVisible();

      const row = rowOf(page, target.email);
      // 選択欄からは、確認なしで降格できない（User を選べない）
      await row.getByRole('combobox').click();
      await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Admin', 'Support']);
      await page.keyboard.press('Escape');
      await row.getByRole('button', { name: 'お客さんに戻す' }).click();
      await page.getByRole('dialog', { name: 'お客さんに戻す' }).getByRole('button', { name: 'お客さんに戻す' }).click();
      await expect(page.getByText(`${target.email} をお客さんに戻しました。`)).toBeVisible(NAVIGATION);
      expect(await activeRoleCount(target.userId)).toBe(0);
    });
  });
}
