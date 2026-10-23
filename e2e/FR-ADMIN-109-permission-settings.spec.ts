/**
 * FR-ADMIN-109 権限の設定の画面（グループ G-0）
 * 対応 FREQ: FREQ-519（AC-01・AC-02 の画面側・AC-03・AC-04・AC-05・AC-06）
 *
 * 画面 → 窓口の差し替え（bridge）→ 手元の DB の関数、の道で確かめる（e2e/permission-settings-test-utils.ts）。
 * 本物の窓口（GET /api/admin/permissions・POST /api/admin/role-permissions）の認可・MFA・CSRF・回数の制限・操作の監査は通らない。
 * それらは Task 2 の単体（permissions-route・role-permissions-route）、DB の権限・トリガー・別接続の競合は Task 1 の DB 結合が確かめる。
 * 表と版は手元の DB の共有の状態なので、場面ごとに lock を取り、終わりに 30 コードの中の付与と版を元へ戻す。
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { RolePermissionChange } from '@/lib/auth/role-permission-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { dialogHeaderClose } from './admin-test-utils';
import { UUID_PATTERN, viewports } from './order-fulfillment-test-utils';
import {
  MANAGED_PERMISSION_CODES,
  SUPPORTER_INITIAL_CODES,
  countPermissionRequests,
  createPermissionActor,
  mockPermissionUiBridge,
  readPermissionEvents,
  readRolePermissionState,
  recordPermissionPosts,
  saveRolePermissionsInDb,
  versionPlus,
  withPermissionScenario,
} from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const PAGE_PATH = '/admin/settings/permissions';
const SAVED = '権限を保存しました。';
const RESULT_UNKNOWN = '保存結果を確認できませんでした。同じ変更を再送するか、現在の設定を読み直してください。';
const VERSION_CONFLICT = 'ほかの人が権限を変更しました。現在の設定を読み直してください。';
const UPCOMING = 'この権限は、対応する画面の公開後に使われます。';
const FIXED = '店長のみ・変更不可';

/** 分野（表の初出順）と、その中の操作（Task 1 の表の順） */
const AREAS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['利用者', ['利用者の閲覧', '利用者の管理']],
  ['商品', ['商品の閲覧', '商品の管理']],
  ['お知らせ', ['お知らせの閲覧', 'お知らせの管理']],
  ['LOOK', ['LOOKの閲覧', 'LOOKの管理']],
  ['取扱店', ['取扱店の閲覧', '取扱店の管理']],
  ['注文', [
    '注文一覧・詳細・CSV・履歴・要対応の閲覧',
    '未入金取消・取消申請審査・要確認解消・メール再送',
    '返金・返金再試行・金額決定',
    '返品作成・審査・受取・検品・取消・開き直し・金額相談',
    '割り当てを入れ替える',
  ]],
  ['問い合わせ', ['問い合わせの閲覧', '問い合わせの管理']],
  ['会計', ['会計の閲覧', '会計の管理']],
  ['監査', ['監査の閲覧']],
  ['ショップ設定', ['ショップ設定']],
  ['在庫', ['在庫一覧', '入荷・棚卸・割当強制解除']],
  ['発注', ['発注一覧・発注書・取引添付の閲覧/取得', '発注入力/確認/確定・数量/単価訂正・添付追加・打切り/再確定']],
  ['受け取り', ['全部/一部受取・受取取消/訂正']],
  ['発送', ['荷作り・発送票閲覧', '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消', '確定後の出荷日訂正']],
  ['権限管理', ['権限設定の閲覧・保存']],
];
const FIXED_LABELS = ['利用者の管理', '権限設定の閲覧・保存'] as const;
const SHIP_READ = '荷作り・発送票閲覧';
const SHIP_MANAGE = '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消';
/** 最初にサポーターで「可」の 8 行（画面の並び順） */
const SUPPORTER_INITIAL_SWITCHES = [
  '利用者の閲覧',
  '注文一覧・詳細・CSV・履歴・要対応の閲覧',
  '未入金取消・取消申請審査・要確認解消・メール再送',
  '返品作成・審査・受取・検品・取消・開き直し・金額相談',
  '問い合わせの閲覧',
  '問い合わせの管理',
  SHIP_READ,
  SHIP_MANAGE,
].map((label) => `サポーター：${label}`);

type RoleLabel = '店長' | 'サポーター';

const table = (page: Page): Locator => page.getByRole('table');
const tableRegion = (page: Page): Locator => page.getByRole('region', { name: '権限の表', exact: true });
const toggle = (page: Page, role: RoleLabel, label: string): Locator =>
  page.getByRole('switch', { name: `${role}：${label}`, exact: true });
const confirmDialog = (page: Page): Locator => page.getByRole('dialog', { name: '権限を変更する', exact: true });
const savedStatus = (page: Page): Locator => page.getByRole('status').filter({ hasText: SAVED });
const alertOf = (page: Page, text: string): Locator => page.getByRole('alert').filter({ hasText: text });
const confirmText = (role: RoleLabel, label: string, next: boolean): string =>
  `${role}の「${label}」を${next ? '許可' : '解除'}します。変更しますか？`;

/** 店長の形でログインし、画面の GET/POST を DB の関数へ橋渡しして、権限の画面を開く。送った保存の本文を控えて返す */
async function openPermissions(page: Page, client: PgClient, actorId: string): Promise<RolePermissionChange[]> {
  await mockAdminSessionAs(page, 'admin');
  await mockPermissionUiBridge(page, client, actorId);
  const posts = recordPermissionPosts(page);
  await page.goto(PAGE_PATH);
  await expect(table(page)).toBeVisible();
  return posts;
}

/** 1つのスイッチを押し、確認で「変更する」を押して、保存が済むまで待つ。送った本文を返す */
async function changeAndSave(
  page: Page,
  posts: RolePermissionChange[],
  role: RoleLabel,
  label: string,
  next: boolean,
): Promise<RolePermissionChange> {
  const before = posts.length;
  await toggle(page, role, label).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(confirmText(role, label, next), { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '変更する', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(savedStatus(page)).toBeVisible();
  await expect(toggle(page, role, label)).toHaveAttribute('aria-checked', String(next));
  await expect.poll(() => posts.length).toBe(before + 1);
  return posts[before];
}

/** 送る POST の答えを、release を呼ぶまで止める（止めた後は bridge が DB の関数へ渡す） */
async function holdSaves(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route((url) => url.pathname === '/api/admin/role-permissions', async (route: Route) => {
    await gate;
    await route.fallback();
  });
  return () => release();
}

/**
 * 背景（overlay）を押す。768px 以上は背景の見える左下の隅を本当に押す（ほかの要素が上にあれば Playwright が止まる）。
 * 768px 未満は確認が画面いっぱいで背景が見えないので、overlay へ click を送る（Dialog は押下の記録が無い click を背景の click として扱う）
 */
async function pressBackdrop(page: Page, viewport: { width: number; height: number }): Promise<void> {
  const overlay = page.locator('[data-ui-dialog]');
  if (viewport.width >= 768) {
    await overlay.click({ position: { x: 5, y: viewport.height - 5 } });
    return;
  }
  // 全面表示で背景に届かないので、背景を押した時と同じ順（押し始め → click）で送る。
  // click だけだと、前に中のボタンを押した時の「パネルの中で押した」印が残って閉じない
  await overlay.dispatchEvent('pointerdown');
  await overlay.dispatchEvent('click');
}

/** 見出しの行の「×」を押す。768px 未満だけ見えるので本当に押し、768px 以上は隠れていることを確かめて click を送る */
async function pressHeaderClose(dialog: Locator, width: number): Promise<void> {
  const close = dialogHeaderClose(dialog);
  if (width < 768) {
    await expect(close).toBeVisible();
    await close.click();
    return;
  }
  await expect(close).toBeHidden();
  await close.dispatchEvent('click');
}

const sorted = (codes: readonly string[]): string[] => [...codes].sort();

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-109 permission settings (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('SETTINGS の「設定メニュー」の「権限」から権限の画面を開き、「管理画面に戻る」で SETTINGS へ戻る', async ({ page }) => {
      // FREQ-519-AC-01（画面の入口）
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, actorId);

        await page.goto('/admin?tab=SETTINGS');
        const menu = page.getByRole('navigation', { name: '設定メニュー', exact: true });
        await expect(menu).toBeVisible();
        await menu.getByRole('link', { name: '権限', exact: true }).click();

        await expect(page).toHaveURL(/\/admin\/settings\/permissions$/);
        await expect(page.getByRole('heading', { name: '権限', level: 1, exact: true })).toBeVisible();
        await expect(table(page)).toBeVisible();

        await page.getByRole('link', { name: '管理画面に戻る', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\?tab=SETTINGS$/);
        await expect(page.getByRole('navigation', { name: '設定メニュー', exact: true })).toBeVisible();
      });
    });

    test('分野ごとに30行・店長とサポーターの2列で出て、最初は店長30・サポーター8・一般利用者0。固定2行はスイッチが無く、新しい役割の入力も無い。画面ははみ出さず、表の中だけ横に動く', async ({ page }) => {
      // FREQ-519-AC-01・AC-02（画面）・AC-06
      await withPermissionScenario(async (client) => {
        // DB の最初の値（30 コードの中）
        expect((await readRolePermissionState(client, 'admin')).permissionCodes).toEqual(sorted(MANAGED_PERMISSION_CODES));
        expect((await readRolePermissionState(client, 'supporter')).permissionCodes).toEqual(sorted(SUPPORTER_INITIAL_CODES));
        expect((await readRolePermissionState(client, 'user')).permissionCodes).toEqual([]);

        const actorId = await createPermissionActor(client, 'admin');
        await openPermissions(page, client, actorId);

        await expect(page.getByRole('heading', { name: '権限', level: 1, exact: true })).toBeVisible();
        await expect(page.getByText('役割ごとに、できる操作を設定します。', { exact: true })).toBeVisible();
        await expect(page.getByText('管理メニューの表示は、権限の設定ではなく役割名で決まります。', { exact: true })).toBeVisible();

        // 列は「操作」「店長」「サポーター」だけ（一般利用者の列や、新しい役割の列は無い）
        expect(await table(page).locator('thead th').allTextContents()).toEqual(['操作', '店長', 'サポーター']);
        expect(await table(page).locator('th[scope="rowgroup"]').allTextContents()).toEqual(AREAS.map(([area]) => area));
        const rowLabels = await table(page).locator('th[scope="row"]').evaluateAll((cells) =>
          cells.map((cell) => cell.firstChild?.textContent ?? ''));
        expect(rowLabels).toEqual(AREAS.flatMap(([, labels]) => labels));
        await expect(table(page).getByText(UPCOMING, { exact: true })).toHaveCount(9);

        // 固定2行は両方の役割の欄をまたいで「店長のみ・変更不可」。スイッチは無い
        for (const label of FIXED_LABELS) {
          const row = table(page).locator('tr').filter({ has: page.locator('th[scope="row"]', { hasText: label }) });
          await expect(row.getByRole('cell')).toHaveText([FIXED]);
          await expect(row.getByRole('switch')).toHaveCount(0);
          await expect(toggle(page, '店長', label)).toHaveCount(0);
          await expect(toggle(page, 'サポーター', label)).toHaveCount(0);
        }

        // スイッチは 28 行 × 2 役割。店長は全部オン、サポーターは決まった 8 つだけオン
        await expect(page.getByRole('switch')).toHaveCount(56);
        const admin = page.getByRole('switch', { name: /^店長：/ });
        const supporter = page.getByRole('switch', { name: /^サポーター：/ });
        await expect(admin).toHaveCount(28);
        await expect(supporter).toHaveCount(28);
        const checkedNames = (switches: Locator) => switches.evaluateAll((items) =>
          items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.getAttribute('aria-label')));
        expect(await checkedNames(admin)).toHaveLength(28);
        expect(await checkedNames(supporter)).toEqual(SUPPORTER_INITIAL_SWITCHES);
        // 読み上げの名前は「役割：操作」。スイッチの横に操作の文字を出さない（操作は行の見出しだけ）
        await expect(toggle(page, 'サポーター', SHIP_READ)).toBeVisible();
        await expect(page.locator('[data-ui-switch-label]')).toHaveCount(0);

        // 新しい役割を作る入力は無い
        await expect(page.getByRole('textbox')).toHaveCount(0);
        await expect(page.getByRole('combobox')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /役割/ })).toHaveCount(0);

        // 画面全体は横にはみ出さない
        const pageOverflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(pageOverflows).toBe(false);

        // 390・768 は表の中だけ横に動く（キーボードの → でも動く）。1280 は全部の列が収まる
        const region = tableRegion(page);
        const regionOverflows = await region.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        if (viewport.width < 1280) {
          expect(regionOverflows).toBe(true);
          await region.focus();
          await expect(region).toBeFocused();
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowRight');
          await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          expect(await page.evaluate(() => window.scrollX)).toBe(0);
        } else {
          expect(regionOverflows).toBe(false);
        }
      });
    });

    test('発送の2権限をサポーターから1つずつ外し、読み直しても外れたまま。付け直すと元に戻る。保存ごとに版が1つ進み、外した2つの差分は DB の記録と付与に一致する', async ({ page }) => {
      // FREQ-519-AC-01・AC-03（G-0 の「発送権限の切替」は保存と再読込まで）
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const posts = await openPermissions(page, client, actorId);
        const dependency = page.getByRole('region', { name: 'サポーターの依存不足', exact: true });
        await expect(dependency).toHaveCount(0);

        // 1つ目: 荷作り・発送票閲覧を外す。票の下書き…が残るので依存不足の知らせが出るが、自動では付け足さない
        const revokeRead = await changeAndSave(page, posts, 'サポーター', SHIP_READ, false);
        expect(revokeRead.roleCode).toBe('supporter');
        expect(revokeRead.expectedVersion).toBe(start.version);
        expect(revokeRead.requestKey).toMatch(UUID_PATTERN);
        expect(sorted(revokeRead.permissionCodes)).toEqual(start.permissionCodes.filter((code) => code !== 'admin.shipping.read'));
        expect((await readRolePermissionState(client, 'supporter')).version).toBe(versionPlus(start.version, 1));
        await expect(dependency.getByText('操作に必要な権限が不足しています：荷作り・発送票閲覧。', { exact: true })).toBeVisible();

        // 2つ目: 票の下書き…を外す。期待の版は1つ目の保存の答えの版
        const revokeManage = await changeAndSave(page, posts, 'サポーター', SHIP_MANAGE, false);
        expect(revokeManage.expectedVersion).toBe(versionPlus(start.version, 1));
        expect(revokeManage.requestKey).not.toBe(revokeRead.requestKey);
        const withoutShipping = start.permissionCodes.filter((code) => code !== 'admin.shipping.read' && code !== 'admin.shipping.manage');
        expect(sorted(revokeManage.permissionCodes)).toEqual(withoutShipping);
        await expect(dependency).toHaveCount(0);

        // DB: 付与と版、外した2つの差分の記録（同じ実行者・要求の番号ごとに1件）
        const afterRevoke = await readRolePermissionState(client, 'supporter');
        expect(afterRevoke).toEqual({ version: versionPlus(start.version, 2), permissionCodes: withoutShipping });
        expect(await readPermissionEvents(client, [revokeRead.requestKey, revokeManage.requestKey])).toEqual([
          { request_key: revokeRead.requestKey, role: 'supporter', permission_code: 'admin.shipping.read', action: 'revoke', actor_id: actorId },
          { request_key: revokeManage.requestKey, role: 'supporter', permission_code: 'admin.shipping.manage', action: 'revoke', actor_id: actorId },
        ]);
        expect(await countPermissionRequests(client, [revokeRead.requestKey, revokeManage.requestKey])).toBe(2);

        // 読み直しても外れたまま（DB から読む）
        await page.reload();
        await expect(table(page)).toBeVisible();
        await expect(toggle(page, 'サポーター', SHIP_READ)).toHaveAttribute('aria-checked', 'false');
        await expect(toggle(page, 'サポーター', SHIP_MANAGE)).toHaveAttribute('aria-checked', 'false');

        // 付け直す
        const grantRead = await changeAndSave(page, posts, 'サポーター', SHIP_READ, true);
        expect(grantRead.expectedVersion).toBe(versionPlus(start.version, 2));
        const grantManage = await changeAndSave(page, posts, 'サポーター', SHIP_MANAGE, true);
        expect(grantManage.expectedVersion).toBe(versionPlus(start.version, 3));
        expect(await readRolePermissionState(client, 'supporter')).toEqual({
          version: versionPlus(start.version, 4), permissionCodes: start.permissionCodes,
        });
        expect(await readPermissionEvents(client, [grantRead.requestKey, grantManage.requestKey])).toEqual([
          { request_key: grantRead.requestKey, role: 'supporter', permission_code: 'admin.shipping.read', action: 'grant', actor_id: actorId },
          { request_key: grantManage.requestKey, role: 'supporter', permission_code: 'admin.shipping.manage', action: 'grant', actor_id: actorId },
        ]);

        await page.reload();
        await expect(table(page)).toBeVisible();
        await expect(toggle(page, 'サポーター', SHIP_READ)).toHaveAttribute('aria-checked', 'true');
        await expect(toggle(page, 'サポーター', SHIP_MANAGE)).toHaveAttribute('aria-checked', 'true');
        // 保存したのはサポーターの行だけ（4回）
        expect(posts.map((post) => post.roleCode)).toEqual(['supporter', 'supporter', 'supporter', 'supporter']);
      });
    });

    test('確認は画面の中に出て、保存の前は「戻る」・Esc・背景・× で閉じる。閉じても送らず、値も版も変わらない', async ({ page }) => {
      // FREQ-519-AC-03・AC-06
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const posts = await openPermissions(page, client, actorId);
        const target = toggle(page, 'サポーター', '商品の閲覧');
        const dialog = confirmDialog(page);
        const closers: Array<[string, () => Promise<void>]> = [
          ['戻る', () => dialog.getByRole('button', { name: '戻る', exact: true }).click()],
          ['Esc', () => page.keyboard.press('Escape')],
          ['背景', () => pressBackdrop(page, viewport)],
          ['×', () => pressHeaderClose(dialog, viewport.width)],
        ];

        for (const [name, close] of closers) {
          await target.click();
          await expect(dialog, name).toBeVisible();
          await expect(dialog).toBeInViewport({ ratio: 1 });
          await expect(dialog.getByText(confirmText('サポーター', '商品の閲覧', true), { exact: true })).toBeVisible();
          await expect(dialog.getByRole('button', { name: '変更する', exact: true })).toBeInViewport();
          await expect(dialog.getByRole('button', { name: '戻る', exact: true })).toBeInViewport();
          await close();
          await expect(dialog, name).toBeHidden();
          await expect(target).toHaveAttribute('aria-checked', 'false');
          await expect(target).toBeEnabled();
        }

        expect(posts).toHaveLength(0);
        expect(await readRolePermissionState(client, 'supporter')).toEqual(start);
      });
    });

    test('キーボードで開いて保存し、保存中は Esc・×・背景でも閉じず、戻る・変更する・全スイッチが押せない。保存が済んでから閉じ、焦点は元のスイッチへ戻る', async ({ page }) => {
      // FREQ-519-AC-03・AC-06
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const posts = await openPermissions(page, client, actorId);
        const release = await holdSaves(page);
        const target = toggle(page, 'サポーター', '商品の閲覧');
        const dialog = confirmDialog(page);
        const back = dialog.getByRole('button', { name: '戻る', exact: true });
        const confirm = dialog.getByRole('button', { name: '変更する', exact: true });

        // キーボードだけで: スイッチで Space → 確認の最初のボタン（戻る）→ Tab で「変更する」→ Enter
        await target.focus();
        await page.keyboard.press('Space');
        await expect(dialog).toBeVisible();
        await expect(back).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(confirm).toBeFocused();
        await page.keyboard.press('Enter');

        await expect.poll(() => posts.length).toBe(1);
        await expect(dialog.getByRole('status').filter({ hasText: '保存しています...' })).toBeVisible();
        await expect(back).toBeDisabled();
        await expect(confirm).toBeDisabled();
        await expect.poll(() => page.getByRole('switch').evaluateAll((items) =>
          items.every((item) => (item as HTMLButtonElement).disabled))).toBe(true);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await pressHeaderClose(dialog, viewport.width);
        await expect(dialog).toBeVisible();
        await pressBackdrop(page, viewport);
        await expect(dialog).toBeVisible();
        await expect(dialog).toBeInViewport({ ratio: 1 });
        expect(posts).toHaveLength(1);

        release();
        await expect(dialog).toBeHidden();
        await expect(savedStatus(page)).toBeVisible();
        await expect(target).toHaveAttribute('aria-checked', 'true');
        await expect(target).toBeFocused();
        expect(posts).toHaveLength(1);
        expect(await readRolePermissionState(client, 'supporter')).toEqual({
          version: versionPlus(start.version, 1), permissionCodes: sorted([...start.permissionCodes, 'admin.items.read']),
        });
      });
    });

    test('「変更する」を続けて2回押しても、送るのは1回で、版は1つだけ進み、記録も1件', async ({ page }) => {
      // FREQ-519-AC-04
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const posts = await openPermissions(page, client, actorId);
        const release = await holdSaves(page);
        const dialog = confirmDialog(page);

        await toggle(page, 'サポーター', 'お知らせの閲覧').click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: '変更する', exact: true }).dblclick();
        await expect.poll(() => posts.length).toBe(1);

        release();
        await expect(dialog).toBeHidden();
        await expect(savedStatus(page)).toBeVisible();
        await expect(toggle(page, 'サポーター', 'お知らせの閲覧')).toHaveAttribute('aria-checked', 'true');
        expect(posts).toHaveLength(1);
        expect((await readRolePermissionState(client, 'supporter')).version).toBe(versionPlus(start.version, 1));
        expect(await readPermissionEvents(client, [posts[0].requestKey])).toEqual([
          { request_key: posts[0].requestKey, role: 'supporter', permission_code: 'admin.news.read', action: 'grant', actor_id: actorId },
        ]);
        expect(await countPermissionRequests(client, [posts[0].requestKey])).toBe(1);
      });
    });

    test('保存の結果がわからない（5xx）時は「同じ変更を再送」で同じ本文を送り直し、DB は最初の結果を返す。記録・受付・版は1回分だけ', async ({ page }) => {
      // FREQ-519-AC-04
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const posts = await openPermissions(page, client, actorId);
        // 1回目は DB に保存させた上で、答えだけを失わせる（窓口の 5xx）。2回目からは bridge が DB の関数へ渡す
        let lost = false;
        await page.route((url) => url.pathname === '/api/admin/role-permissions', async (route) => {
          if (lost) {
            await route.fallback();
            return;
          }
          lost = true;
          await saveRolePermissionsInDb(client, actorId, route.request().postDataJSON() as RolePermissionChange);
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: '権限を保存できませんでした。', code: 'PERMISSION_UPDATE_FAILED' }),
          });
        });
        const target = toggle(page, 'サポーター', '在庫一覧');

        await target.click();
        await confirmDialog(page).getByRole('button', { name: '変更する', exact: true }).click();
        await expect(alertOf(page, RESULT_UNKNOWN)).toBeVisible();
        await expect(confirmDialog(page)).toBeHidden();
        await expect(target).toHaveAttribute('aria-checked', 'false');
        await expect(target).toBeDisabled();
        await expect(page.getByRole('button', { name: '現在の設定を読み直す', exact: true })).toBeVisible();
        // 答えは失われたが、DB には1回分が保存されている
        expect((await readRolePermissionState(client, 'supporter')).version).toBe(versionPlus(start.version, 1));

        await page.getByRole('button', { name: '同じ変更を再送', exact: true }).click();
        await expect(savedStatus(page)).toBeVisible();
        await expect(alertOf(page, RESULT_UNKNOWN)).toHaveCount(0);
        await expect(target).toHaveAttribute('aria-checked', 'true');
        await expect.poll(() => posts.length).toBe(2);
        expect(posts[1]).toEqual(posts[0]);

        expect(await readRolePermissionState(client, 'supporter')).toEqual({
          version: versionPlus(start.version, 1), permissionCodes: sorted([...start.permissionCodes, 'admin.stock.read']),
        });
        expect(await readPermissionEvents(client, [posts[0].requestKey])).toEqual([
          { request_key: posts[0].requestKey, role: 'supporter', permission_code: 'admin.stock.read', action: 'grant', actor_id: actorId },
        ]);
        expect(await countPermissionRequests(client, [posts[0].requestKey])).toBe(1);
      });
    });

    test('2つのタブが同じ版から保存すると、後のタブは競合で止まって保存せず、「現在の設定を読み直す」の後に新しい要求の番号と版で保存できる', async ({ page, context }) => {
      // FREQ-519-AC-05
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        const start = await readRolePermissionState(client, 'supporter');
        const postsA = await openPermissions(page, client, actorId);
        const pageB = await context.newPage();
        try {
          await pageB.setViewportSize({ width: viewport.width, height: viewport.height });
          const postsB = await openPermissions(pageB, client, actorId);

          // タブ A が先に保存する
          const saved = await changeAndSave(page, postsA, 'サポーター', '商品の閲覧', true);
          expect(saved.expectedVersion).toBe(start.version);

          // タブ B は古い版のまま保存しようとして、競合で止まる
          await toggle(pageB, 'サポーター', 'お知らせの閲覧').click();
          await confirmDialog(pageB).getByRole('button', { name: '変更する', exact: true }).click();
          await expect(alertOf(pageB, VERSION_CONFLICT)).toBeVisible();
          await expect.poll(() => postsB.length).toBe(1);
          const refused = postsB[0];
          expect(refused.expectedVersion).toBe(start.version);
          await expect(toggle(pageB, 'サポーター', 'お知らせの閲覧')).toHaveAttribute('aria-checked', 'false');
          await expect(toggle(pageB, 'サポーター', 'お知らせの閲覧')).toBeDisabled();
          await expect(pageB.getByRole('button', { name: '同じ変更を再送', exact: true })).toHaveCount(0);
          expect(await readPermissionEvents(client, [refused.requestKey])).toEqual([]);
          expect(await countPermissionRequests(client, [refused.requestKey])).toBe(0);
          expect(await readRolePermissionState(client, 'supporter')).toEqual({
            version: versionPlus(start.version, 1), permissionCodes: sorted([...start.permissionCodes, 'admin.items.read']),
          });

          // 読み直すと、タブ A の変更が見えて、操作できるようになる
          await pageB.getByRole('button', { name: '現在の設定を読み直す', exact: true }).click();
          await expect(table(pageB)).toBeVisible();
          await expect(alertOf(pageB, VERSION_CONFLICT)).toHaveCount(0);
          await expect(toggle(pageB, 'サポーター', '商品の閲覧')).toHaveAttribute('aria-checked', 'true');
          await expect(toggle(pageB, 'サポーター', 'お知らせの閲覧')).toBeEnabled();

          // もう一度確認して保存する。要求の番号は新しく、版は読み直した版
          const retried = await changeAndSave(pageB, postsB, 'サポーター', 'お知らせの閲覧', true);
          expect(retried.requestKey).not.toBe(refused.requestKey);
          expect(retried.expectedVersion).toBe(versionPlus(start.version, 1));
          expect(await readRolePermissionState(client, 'supporter')).toEqual({
            version: versionPlus(start.version, 2),
            permissionCodes: sorted([...start.permissionCodes, 'admin.items.read', 'admin.news.read']),
          });
        } finally {
          await pageB.close();
        }
      });
    });
  });
}
