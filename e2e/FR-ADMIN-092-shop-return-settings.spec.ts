/**
 * FR-ADMIN-092 ショップの設定の「返品」の欄（段1）
 * 対応 FREQ: FREQ-470（AC-01〜AC-14・AC-16・AC-17）
 *
 * 画面は窓口を差し替えて確かめる（実装計画 P11。FR-ADMIN-079 と同じやり方）。窓口の答えは共通の約束（C-2）の形で、返品の設定の元は
 * 単体の試験と同じ道具（buildShopReturnSettings）で作る。最初の値が移行 A の値と同じこと（AC-14）は、手元の DB の設定の表を読んで確かめる。
 * 窓口の権限・CSRF・回数の制限（AC-15）は単体の試験（shop-settings-route）が確かめる。
 * 探し方は Task 12 の「画面の作りの約束」のとおり、役割と見出しの文字で探す（まとまりは region、返送先と理由ごとの行は group）。
 * 入力の誤りの言葉8つと、保存の最中の知らせ1つは Task 12 の T12-6 の表のとおり。保存の知らせの場所（T12-13）は、3つの画面幅で
 * 画面の中に見えるかを確かめる。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ShopReturnSettings, ShopReturnSettingsUpdate } from '@/lib/orders/returns/return-types';
import { buildShopReturnSettings } from '../tests/unit/components/shop-return-settings-test-fixtures';
import { withLocalDb } from './order-email-test-utils';
import { fulfillJson, mockOrderList, viewports } from './order-fulfillment-test-utils';
import { formatJst, mockAdminSessionAs } from './refund-test-utils';

const CHANGED_AT = '2026-10-12T02:30:00.000Z';
const SAVED = '設定を保存しました。';
const SAVE_FAILED = 'ショップの設定を保存できませんでした。';
const SUMMARY = '入力を確かめてください。';
/** 金額（返送料の定額・交換の手数料・交換の送料）が0〜1000000の整数でない時の誤り（Task 12 の T12-6。作る画面の円の欄と同じ言葉） */
const YEN_LIMIT = '0から1000000までの整数（半角）で入れてください。';
/** 保存の最中に「保存する」を押した時の知らせ（Task 12 の T12-6） */
const PRESSED_WHILE_SAVING = '保存の最中です。済んでから、もう一度「保存する」を押してください。';
const GROUPS = ['返送', '受付の期限', '理由ごとの設定', '手数料', '受け取り'] as const;
/** 理由の言葉（C-5）。理由ごとの設定は、この10個をこの順に出す */
const REASON_LABELS = [
  '破損・不良',
  '注文と違う品が届いた',
  'サイズが小さい',
  'サイズが大きい',
  '色がイメージと違った',
  'デザインが好みでない',
  '説明と違った',
  '不要になった',
  'その他',
  '不明',
] as const;

type PutBody = {
  autoRefundCancelledOrderPayment: boolean;
  autoCancelAmountMismatch: boolean;
  returns?: ShopReturnSettingsUpdate;
};

type SettingsState = {
  returns: ShopReturnSettings;
  /** 窓口が受けた呼び出しの順（GET と PUT） */
  calls: Array<'GET' | 'PUT'>;
  puts: PutBody[];
  putFails: boolean;
  /** 保存の最中を作るための関門。holdPut を付けると PUT は releasePut が呼ばれるまで答えない */
  releasePut: () => void;
};

const CHANGED = { at: CHANGED_AT, byEmail: 'admin@example.com' };

/** 送られた中身で設定を更新し、値が変わったまとまりだけに「最後に変えた人」を書く（DB の関数 admin_update_shop_return_settings と同じ） */
function applyUpdate(current: ShopReturnSettings, update: ShopReturnSettingsUpdate): ShopReturnSettings {
  const changedAddress = JSON.stringify(update.returnAddress) !== JSON.stringify(current.returnAddress);
  const shipping =
    changedAddress ||
    update.customerPaidMethod !== current.customerPaidMethod ||
    update.shopLabelFee !== current.shopLabelFee ||
    update.noReturnNeededEnabled !== current.noReturnNeededEnabled;
  const periodChanged =
    update.windowDays !== current.windowDays ||
    update.windowStart !== current.windowStart ||
    update.deliveryBufferDays !== current.deliveryBufferDays;
  const reasonsChanged = update.reasons.some((row) => {
    const before = current.reasons.find((item) => item.reason === row.reason);
    return before?.shippingPayer !== row.shippingPayer || before?.outOfStockExchange !== row.outOfStockExchange;
  });
  const fees =
    update.restockingFeeEnabled !== current.restockingFeeEnabled ||
    update.restockingFeePercent !== current.restockingFeePercent ||
    update.exchangeFeesEnabled !== current.exchangeFeesEnabled ||
    update.exchangeFee !== current.exchangeFee ||
    update.exchangeShippingFee !== current.exchangeShippingFee;
  const receiving = update.inspectionEnabled !== current.inspectionEnabled;
  return {
    ...current,
    returnAddress: update.returnAddress,
    customerPaidMethod: update.customerPaidMethod,
    shopLabelFee: update.shopLabelFee,
    noReturnNeededEnabled: update.noReturnNeededEnabled,
    windowDays: update.windowDays,
    windowStart: update.windowStart,
    deliveryBufferDays: update.deliveryBufferDays,
    restockingFeeEnabled: update.restockingFeeEnabled,
    restockingFeePercent: update.restockingFeePercent,
    exchangeFeesEnabled: update.exchangeFeesEnabled,
    exchangeFee: update.exchangeFee,
    exchangeShippingFee: update.exchangeShippingFee,
    inspectionEnabled: update.inspectionEnabled,
    reasons: current.reasons.map((row) => {
      const next = update.reasons.find((item) => item.reason === row.reason);
      return next ? { ...row, shippingPayer: next.shippingPayer, outOfStockExchange: next.outOfStockExchange } : row;
    }),
    updated: {
      ...current.updated,
      ...(shipping ? { shipping: CHANGED } : {}),
      ...(periodChanged ? { window: CHANGED } : {}),
      ...(reasonsChanged ? { reasons: CHANGED } : {}),
      ...(fees ? { fees: CHANGED } : {}),
      ...(receiving ? { receiving: CHANGED } : {}),
    },
  };
}

/** 設定の窓口（GET・PUT）を差し替える。GET は返品の設定つきの答え、PUT は送られた返品の設定で更新した答えを返す */
async function mockSettingsApis(page: Page, options: { putFails?: boolean; holdPut?: boolean } = {}): Promise<SettingsState> {
  let release: (() => void) | null = null;
  const gate = options.holdPut
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : null;
  const state: SettingsState = {
    returns: buildShopReturnSettings(),
    calls: [],
    puts: [],
    putFails: options.putFails ?? false,
    releasePut: () => release?.(),
  };
  const answer = () => ({
    data: {
      autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
      autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
      returns: state.returns,
    },
  });
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => []);
  await page.route('**/api/admin/settings/shop', async (route) => {
    if (route.request().method() === 'GET') {
      state.calls.push('GET');
      await fulfillJson(route, answer());
      return;
    }
    state.calls.push('PUT');
    const body = route.request().postDataJSON() as PutBody;
    state.puts.push(body);
    if (gate) await gate;
    if (state.putFails) {
      await fulfillJson(route, { error: 'failed', code: 'failed' }, 500);
      return;
    }
    if (body.returns) state.returns = applyUpdate(state.returns, body.returns);
    await fulfillJson(route, answer());
  });
  return state;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await expect(page.getByRole('heading', { name: '返品', level: 3, exact: true })).toBeVisible();
}

const group = (page: Page, name: (typeof GROUPS)[number]): Locator => page.getByRole('region', { name, exact: true });
const reasonRow = (page: Page, name: (typeof REASON_LABELS)[number]): Locator => group(page, '理由ごとの設定').getByRole('group', { name, exact: true });
const saveButton = (page: Page): Locator => page.getByRole('button', { name: '保存する', exact: true });

async function save(page: Page, state: SettingsState): Promise<ShopReturnSettingsUpdate> {
  const before = state.puts.length;
  await saveButton(page).click();
  await expect.poll(() => state.puts.length).toBe(before + 1);
  const returns = state.puts[before].returns;
  if (!returns) throw new Error('PUT の本文に returns が無い');
  return returns;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-092 shop return settings (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('ショップの設定に見出し「返品」の欄が出て、5つのまとまりが見出しつきでこの順に並ぶ', async ({ page }) => {
      // FREQ-470-AC-01
      await mockSettingsApis(page);
      await openSettings(page);

      // 見出し（h4）は返品の欄の中だけで数える（どの画面にも出るフッターにも h4 の SHOP・INFORMATION・FOLLOW US がある）
      const returnsSection = page.getByRole('region', { name: '返品', exact: true });
      expect(await returnsSection.getByRole('heading', { level: 4 }).allTextContents()).toEqual([...GROUPS]);
      for (const name of GROUPS) await expect(group(page, name)).toBeVisible();
      // 自動の返金の欄は、これまでどおり出る
      await expect(page.getByRole('heading', { name: '自動の返金', level: 3 })).toBeVisible();
      await expect(page.getByRole('switch', { name: '取り消した注文に届いた入金を、自動で全額返金する', exact: true })).toBeVisible();
    });

    test('返送のまとまりに返送先の4つの入力が出て、4つとも空の間は「返品の受付のお知らせに載せます。空の間は、返品を作れません。」の説明が出る', async ({ page }) => {
      // FREQ-470-AC-02
      await mockSettingsApis(page);
      await openSettings(page);
      const address = group(page, '返送').getByRole('group', { name: '返送先', exact: true });

      for (const label of ['名前', '郵便番号', '住所', '電話番号']) {
        await expect(address.getByLabel(label, { exact: true })).toBeVisible();
        await expect(address.getByLabel(label, { exact: true })).toHaveValue('');
      }
      await expect(group(page, '返送').getByText('返品の受付のお知らせに載せます。空の間は、返品を作れません。')).toBeVisible();
    });

    test('「お客様の負担の時の送り方」の2つの選びと、送り方にかかわらず出る「返送料の定額（円）」が、最初の値で出る', async ({ page }) => {
      // FREQ-470-AC-03
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const shipping = group(page, '返送');
      const method = shipping.getByRole('combobox', { name: 'お客様の負担の時の送り方', exact: true });

      expect(await method.locator('option').allTextContents()).toEqual(['ご自身で送っていただく', 'お店の送り状で送っていただき、返送料を差し引く']);
      await expect(method).toHaveValue('customer_ships');
      const fee = shipping.getByLabel('返送料の定額（円）', { exact: true });
      await expect(fee).toHaveValue('0');

      await method.selectOption({ label: 'お店の送り状で送っていただき、返送料を差し引く' });
      await fee.fill('800');
      await expect(fee).toBeVisible();
      const saved = await save(page, state);
      expect(saved).toMatchObject({ customerPaidMethod: 'shop_label', shopLabelFee: 800 });
    });

    test('「「返送不要」を選べるようにする」のトグルと説明が出て、切り替えただけでは窓口が呼ばれず、保存で届く', async ({ page }) => {
      // FREQ-470-AC-04
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const toggle = group(page, '返送').getByRole('switch', { name: '「返送不要」を選べるようにする', exact: true });

      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(group(page, '返送').getByText('オンにすると、返品を作る画面で「返送不要」を選べます。')).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(state.puts).toHaveLength(0);

      expect(await save(page, state)).toMatchObject({ noReturnNeededEnabled: true });
    });

    test('受付の期限に「日数」と「無制限」のチェックが出て、チェックすると日数は入力できず、保存では無制限（日数 null）が窓口へ届く', async ({ page }) => {
      // FREQ-470-AC-05
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const period = group(page, '受付の期限');
      const days = period.getByLabel('日数', { exact: true });
      const unlimited = period.getByRole('checkbox', { name: '無制限', exact: true });

      await expect(days).toHaveValue('7');
      await expect(unlimited).not.toBeChecked();
      await unlimited.check();
      await expect(days).toBeDisabled();
      await unlimited.uncheck();
      await expect(days).toBeEnabled();
      await expect(days).toHaveValue('7');

      await unlimited.check();
      expect(await save(page, state)).toMatchObject({ windowDays: null });
    });

    test('「数え始め」の2つの選び（品ごとの届いた日・最後の品の届いた日）が出て、選んだ値が保存で窓口へ届く', async ({ page }) => {
      // FREQ-470-AC-06
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const start = group(page, '受付の期限').getByRole('combobox', { name: '数え始め', exact: true });

      expect(await start.locator('option').allTextContents()).toEqual(['品ごとの届いた日', '最後の品の届いた日']);
      await expect(start).toHaveValue('each_item');
      await start.selectOption({ label: '最後の品の届いた日' });
      expect(await save(page, state)).toMatchObject({ windowStart: 'last_item' });
    });

    test('「届いた日がわからない時の目安（日）」が最初の値3で出て、説明が付き、変えた値が保存で窓口へ届く', async ({ page }) => {
      // FREQ-470-AC-07
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const period = group(page, '受付の期限');
      const buffer = period.getByLabel('届いた日がわからない時の目安（日）', { exact: true });

      await expect(buffer).toHaveValue('3');
      await expect(period.getByText('配達の記録ができるまでは、発送の日にこの日数を足した日を届いた日とみなします。')).toBeVisible();
      await buffer.fill('5');
      expect(await save(page, state)).toMatchObject({ deliveryBufferDays: 5 });
    });

    test('理由ごとの設定に10の理由が決まった順に並び、理由ごとの「返送料の負担」と「在庫の無い交換」が最初の値で出る。変えた値が保存で届く', async ({ page }) => {
      // FREQ-470-AC-08
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const reasons = group(page, '理由ごとの設定');

      await expect(reasons.getByRole('group')).toHaveCount(10);
      // 10の理由が、決まった順（上から下、同じ高さなら左から右）に並ぶ
      const tops: number[] = [];
      for (const name of REASON_LABELS) {
        await expect(reasonRow(page, name)).toBeVisible();
        tops.push((await reasonRow(page, name).boundingBox())?.y ?? Number.NaN);
      }
      expect(tops.every((top) => !Number.isNaN(top))).toBe(true);
      expect(tops).toEqual([...tops].sort((a, b) => a - b));
      const payer = (name: (typeof REASON_LABELS)[number]) => reasonRow(page, name).getByRole('combobox', { name: '返送料の負担', exact: true });
      const stock = (name: (typeof REASON_LABELS)[number]) => reasonRow(page, name).getByRole('combobox', { name: '在庫の無い交換', exact: true });
      expect(await payer('破損・不良').locator('option').allTextContents()).toEqual(['お店', 'お客様']);
      expect(await stock('破損・不良').locator('option').allTextContents()).toEqual(['作って送る', '受けない']);
      await expect(payer('破損・不良')).toHaveValue('shop');
      await expect(stock('破損・不良')).toHaveValue('make');
      await expect(payer('サイズが小さい')).toHaveValue('customer');
      await expect(stock('サイズが小さい')).toHaveValue('decline');

      await payer('その他').selectOption({ label: 'お店' });
      await stock('その他').selectOption({ label: '作って送る' });
      const saved = await save(page, state);
      expect(saved.reasons).toHaveLength(10);
      expect(saved.reasons.find((row) => row.reason === 'other')).toEqual({ reason: 'other', shippingPayer: 'shop', outOfStockExchange: 'make' });
      expect(saved.reasons.find((row) => row.reason === 'defective')).toEqual({ reason: 'defective', shippingPayer: 'shop', outOfStockExchange: 'make' });
    });

    test('手数料のトグルをオンにした時だけ入力が出て、「手で受け取った手数料は、帳簿に自動では入りません。」の注意が出る。入れた値が保存で窓口へ届く', async ({ page }) => {
      // FREQ-470-AC-09
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const fees = group(page, '手数料');
      const restocking = fees.getByRole('switch', { name: '返品の手数料を使う', exact: true });
      const exchange = fees.getByRole('switch', { name: '交換の手数料と送料を使う', exact: true });

      await expect(restocking).toHaveAttribute('aria-checked', 'false');
      await expect(exchange).toHaveAttribute('aria-checked', 'false');
      await expect(fees.getByLabel('返品の手数料（%）', { exact: true })).toHaveCount(0);
      await expect(fees.getByLabel('交換の手数料（円）', { exact: true })).toHaveCount(0);
      await expect(fees.getByLabel('交換の送料（円）', { exact: true })).toHaveCount(0);

      await restocking.click();
      await exchange.click();
      await fees.getByLabel('返品の手数料（%）', { exact: true }).fill('10');
      await fees.getByLabel('交換の手数料（円）', { exact: true }).fill('500');
      await fees.getByLabel('交換の送料（円）', { exact: true }).fill('300');
      await expect(fees.getByText('手で受け取った手数料は、帳簿に自動では入りません。')).toBeVisible();

      expect(await save(page, state)).toMatchObject({
        restockingFeeEnabled: true,
        restockingFeePercent: 10,
        exchangeFeesEnabled: true,
        exchangeFee: 500,
        exchangeShippingFee: 300,
      });
    });

    test('受け取りのまとまりに「要検品を使う」のトグルと説明が出て、オンにして保存すると窓口へ届く', async ({ page }) => {
      // FREQ-470-AC-10
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const receiving = group(page, '受け取り');
      const toggle = receiving.getByRole('switch', { name: '要検品を使う', exact: true });

      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(receiving.getByText('オンにすると、受け取りの画面に「検品待ち」が出て、後で在庫に戻すかを決められます。')).toBeVisible();
      await toggle.click();
      expect(await save(page, state)).toMatchObject({ inspectionEnabled: true });
    });

    test('「保存する」で窓口へ段1の欄が全部届き（保存の直前に読み直した後）、「設定を保存しました。」が出る。窓口が失敗した時は失敗の文が出て、入力が残る', async ({ page }) => {
      // FREQ-470-AC-11
      const state = await mockSettingsApis(page);
      await openSettings(page);

      const saved = await save(page, state);
      // 保存の直前に、自動の返金のトグルを読み直してから送る
      expect(state.calls.slice(-2)).toEqual(['GET', 'PUT']);
      expect(saved).toEqual({
        returnAddress: null,
        customerPaidMethod: 'customer_ships',
        shopLabelFee: 0,
        noReturnNeededEnabled: false,
        windowDays: 7,
        windowStart: 'each_item',
        deliveryBufferDays: 3,
        reasons: [
          { reason: 'defective', shippingPayer: 'shop', outOfStockExchange: 'make' },
          { reason: 'wrong_item', shippingPayer: 'shop', outOfStockExchange: 'make' },
          { reason: 'size_too_small', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'size_too_large', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'color', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'style', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'not_as_described', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'unwanted', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'other', shippingPayer: 'customer', outOfStockExchange: 'decline' },
          { reason: 'unknown', shippingPayer: 'customer', outOfStockExchange: 'decline' },
        ],
        restockingFeeEnabled: false,
        restockingFeePercent: 0,
        exchangeFeesEnabled: false,
        exchangeFee: 0,
        exchangeShippingFee: 0,
        inspectionEnabled: false,
      });
      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
    });

    test('窓口が保存に失敗した時は「ショップの設定を保存できませんでした。」が出て、入れた値は残る', async ({ page }) => {
      // FREQ-470-AC-11
      const state = await mockSettingsApis(page, { putFails: true });
      await openSettings(page);
      const days = group(page, '受付の期限').getByLabel('日数', { exact: true });

      await days.fill('14');
      await saveButton(page).click();

      await expect(page.getByRole('alert').filter({ hasText: SAVE_FAILED })).toBeVisible();
      await expect(days).toHaveValue('14');
      expect(state.puts).toHaveLength(1);
      await expect(page.getByRole('status').filter({ hasText: SAVED })).toHaveCount(0);
    });

    test('「最後に変えた人」が、変えたまとまりにだけ変えた人と日時で出て、変えていないまとまりは「まだ変えていません」のまま', async ({ page }) => {
      // FREQ-470-AC-12
      const state = await mockSettingsApis(page);
      await openSettings(page);
      for (const name of GROUPS) await expect(group(page, name).getByText('まだ変えていません')).toBeVisible();

      await group(page, '受付の期限').getByLabel('日数', { exact: true }).fill('14');
      await save(page, state);

      await expect(group(page, '受付の期限').getByText(`最後に変えた人: admin@example.com（${formatJst(CHANGED_AT)}）`)).toBeVisible();
      for (const name of GROUPS.filter((item) => item !== '受付の期限')) {
        await expect(group(page, name).getByText('まだ変えていません')).toBeVisible();
      }
    });

    test('入力の誤り8つの言葉が、それぞれの欄の下に出て、欄が不正の印になり、窓口は呼ばれず、最初の誤りの欄へフォーカスが移る。直すと消える', async ({ page }) => {
      // FREQ-470-AC-13
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const shipping = group(page, '返送');
      const period = group(page, '受付の期限');
      const fees = group(page, '手数料');
      const address = shipping.getByRole('group', { name: '返送先', exact: true });
      const name = address.getByLabel('名前', { exact: true });
      const postal = address.getByLabel('郵便番号', { exact: true });
      const line = address.getByLabel('住所', { exact: true });
      const phone = address.getByLabel('電話番号', { exact: true });
      const labelFee = shipping.getByLabel('返送料の定額（円）', { exact: true });
      const days = period.getByLabel('日数', { exact: true });
      const buffer = period.getByLabel('届いた日がわからない時の目安（日）', { exact: true });

      // 手数料の入力は、使うトグルをオンにした時だけ出る
      await fees.getByRole('switch', { name: '返品の手数料を使う', exact: true }).click();
      await fees.getByRole('switch', { name: '交換の手数料と送料を使う', exact: true }).click();
      const percent = fees.getByLabel('返品の手数料（%）', { exact: true });
      const exchangeFee = fees.getByLabel('交換の手数料（円）', { exact: true });
      const exchangeShippingFee = fees.getByLabel('交換の送料（円）', { exact: true });

      // 入力の誤りの言葉は 9 つのうち 8 つ（ほかの 1 つは保存の最中の知らせ）。住所は空のまま、返送先の一部だけを入れる
      const cases: Array<{ input: Locator; value: string; message: string }> = [
        { input: name, value: 'あ'.repeat(201), message: '200字までで入れてください。' },
        { input: postal, value: '12345', message: '郵便番号は 123-4567 の形で入れてください。' },
        { input: phone, value: 'abc', message: '電話番号は、数字と「+」「-」だけで6〜20文字にしてください。' },
        { input: labelFee, value: '1000001', message: YEN_LIMIT },
        { input: days, value: '0', message: '1から365までの整数（半角）で入れてください。' },
        { input: buffer, value: '15', message: '0から14までの整数（半角）で入れてください。' },
        { input: percent, value: '101', message: '0から100までの整数（半角）で入れてください。' },
        { input: exchangeFee, value: '1000001', message: YEN_LIMIT },
        { input: exchangeShippingFee, value: '-1', message: YEN_LIMIT },
      ];
      for (const item of cases) await item.input.fill(item.value);
      // 押す前は、誤りを出さない
      await expect(page.getByRole('alert').filter({ hasText: SUMMARY })).toHaveCount(0);
      await expect(days).not.toHaveAttribute('aria-invalid', 'true');

      await saveButton(page).click();

      for (const item of cases) {
        await expect(item.input).toHaveAttribute('aria-invalid', 'true');
        await expect(item.input).toHaveAccessibleDescription(item.message);
      }
      await expect(line).toHaveAttribute('aria-invalid', 'true');
      await expect(line).toHaveAccessibleDescription('返送先は4つとも入れてください。');
      await expect(page.getByRole('alert').filter({ hasText: SUMMARY })).toBeVisible();
      expect(state.puts).toHaveLength(0);
      // 画面の上にある最初の誤りの欄（返送先の名前）へフォーカスが移る
      await expect(name).toBeFocused();

      // 直すと、その欄の誤りが消える。全部直すと、まとめの文も消えて保存できる
      await days.fill('10');
      await expect(days).not.toHaveAttribute('aria-invalid', 'true');
      await expect(period.getByText('1から365までの整数（半角）で入れてください。')).toHaveCount(0);
      await name.fill('返品係 山田');
      await postal.fill('150-0001');
      await line.fill('東京都渋谷区神宮前1-2-3');
      await phone.fill('03-1234-5678');
      await labelFee.fill('800');
      await buffer.fill('5');
      await percent.fill('10');
      await exchangeFee.fill('500');
      await exchangeShippingFee.fill('300');
      await expect(page.getByRole('alert').filter({ hasText: SUMMARY })).toHaveCount(0);
      expect(await save(page, state)).toMatchObject({
        windowDays: 10,
        deliveryBufferDays: 5,
        shopLabelFee: 800,
        restockingFeePercent: 10,
        exchangeFee: 500,
        exchangeShippingFee: 300,
        returnAddress: { name: '返品係 山田', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      });
    });

    test('入力の誤りで止めた時は、前の保存の知らせ（保存できた・保存できなかった）が消えて、誤りのまとめの文だけが残る', async ({ page }) => {
      // FREQ-470-AC-13
      const state = await mockSettingsApis(page);
      await openSettings(page);
      const days = group(page, '受付の期限').getByLabel('日数', { exact: true });
      const saved = page.getByRole('status').filter({ hasText: SAVED });
      const failed = page.getByRole('alert').filter({ hasText: SAVE_FAILED });
      const summary = page.getByRole('alert').filter({ hasText: SUMMARY });

      // 保存できた知らせが出ている間に、誤りで止めると、その知らせが消える
      await save(page, state);
      await expect(saved).toBeVisible();
      await days.fill('0');
      await saveButton(page).click();
      await expect(summary).toBeVisible();
      await expect(saved).toHaveCount(0);

      // 窓口が保存に失敗した文が出ている間に、誤りで止めると、その文が消える
      await days.fill('10');
      state.putFails = true;
      await saveButton(page).click();
      await expect(failed).toBeVisible();
      await days.fill('0');
      await saveButton(page).click();
      await expect(summary).toBeVisible();
      await expect(failed).toHaveCount(0);
      // 誤りで止めた間は、窓口を呼んでいない（呼んだのは、保存できた1回と、失敗した1回だけ）
      expect(state.puts).toHaveLength(2);
    });

    test('保存の最中に「保存する」（または入力欄の Enter）をもう一度押すと、何も送らず「保存の最中です。…」が出て、保存が済むと消える', async ({ page }) => {
      // FREQ-470-AC-16
      const state = await mockSettingsApis(page, { holdPut: true });
      await openSettings(page);
      const days = group(page, '受付の期限').getByLabel('日数', { exact: true });
      const waiting = page.getByText(PRESSED_WHILE_SAVING, { exact: true });

      await days.fill('14');
      await saveButton(page).click();
      // 窓口は答えを止めたまま（保存の最中）
      await expect.poll(() => state.puts.length).toBe(1);
      await expect(waiting).toHaveCount(0);

      // 保存の最中も、ボタンは押せる見た目のまま。押しても、2つ目の保存は送らず、待つよう伝える
      await expect(saveButton(page)).toBeEnabled();
      await saveButton(page).click();
      await expect(waiting).toBeVisible();
      await days.press('Enter');
      await expect(waiting).toBeVisible();
      expect(state.puts).toHaveLength(1);

      state.releasePut();
      await expect(page.getByRole('status').filter({ hasText: SAVED })).toBeVisible();
      await expect(waiting).toHaveCount(0);
      expect(state.puts).toHaveLength(1);
      expect(state.puts[0].returns).toMatchObject({ windowDays: 14 });
    });

    test('保存の結果の文（保存できた・保存できなかった）は、返品の欄を保存した時も、自動の返金のトグルの保存に失敗した時も、画面の中に見える', async ({ page }) => {
      // FREQ-470-AC-17（Task 12 の T12-13。3つの画面幅で確かめる）
      // 結果の入れ物は1つずつのまま、Task 12 が CSS の order で、返品の欄の結果を返品の欄の直後（「保存する」のすぐ下）に、
      // トグルの結果を自動の返金の欄の直後に見せる。返品の欄が長くても、操作した所と同じ画面の中に出る
      const state = await mockSettingsApis(page);
      await openSettings(page);

      // 返品の欄を保存できた時：「保存する」のすぐ下に出る
      await saveButton(page).click();
      const saved = page.getByRole('status').filter({ hasText: SAVED });
      await expect(saved).toBeVisible();
      await expect(saved).toBeInViewport({ ratio: 1 });

      // 返品の欄の保存に窓口が失敗した時
      state.putFails = true;
      await saveButton(page).click();
      const failed = page.getByRole('alert').filter({ hasText: SAVE_FAILED });
      await expect(failed).toBeVisible();
      await expect(failed).toBeInViewport({ ratio: 1 });

      // 自動の返金のトグルの保存に窓口が失敗した時：返品の欄は長いが、失敗の文は自動の返金の欄の直後（返品の欄より上）に出るので、
      // トグルと同じ画面の中に見える（画面を開き直して、前の保存の文が残っていない所から確かめる）
      await openSettings(page);
      const toggle = page.getByRole('switch', { name: '取り消した注文に届いた入金を、自動で全額返金する', exact: true });
      await expect(failed).toHaveCount(0);
      await toggle.click();
      await expect(failed).toBeVisible();
      await expect(failed).toBeInViewport({ ratio: 1 });
      await expect(toggle).toBeInViewport({ ratio: 1 });
    });

    test('最初の値（受付の期限の日数7・数え始め「品ごとの届いた日」・目安3日、理由ごと10行の返送料の負担と在庫の無い交換）が、手元の DB の設定と画面の見本で同じ（手元の DB）', async () => {
      // FREQ-470-AC-14
      await withLocalDb(async (db) => {
        const settings = (
          await db.query('select window_days, window_start, delivery_buffer_days from public.shop_return_settings where id = 1')
        ).rows[0];
        expect(settings).toEqual({ window_days: 7, window_start: 'each_item', delivery_buffer_days: 3 });

        const rows = (
          await db.query('select reason, shipping_payer, out_of_stock_exchange from public.shop_return_reason_settings order by reason')
        ).rows as Array<{ reason: string; shipping_payer: string; out_of_stock_exchange: string }>;
        expect(rows).toHaveLength(10);
        // 仕様書 8-3 の表: 破損・不良と注文と違う品が届いたは、返送料をお店が持ち、在庫が無ければ作って送る。ほかは、お客様が持ち、受けない
        for (const row of rows) {
          const shop = row.reason === 'defective' || row.reason === 'wrong_item';
          expect(row, row.reason).toEqual({
            reason: row.reason,
            shipping_payer: shop ? 'shop' : 'customer',
            out_of_stock_exchange: shop ? 'make' : 'decline',
          });
        }
        // 画面の試験の見本（buildShopReturnSettings）も、同じ最初の値を持つ
        const sample = buildShopReturnSettings();
        expect(sample.windowDays).toBe(7);
        expect(sample.windowStart).toBe('each_item');
        expect(sample.deliveryBufferDays).toBe(3);
        for (const row of sample.reasons) {
          const stored = rows.find((item) => item.reason === row.reason);
          expect(stored, row.reason).toMatchObject({ shipping_payer: row.shippingPayer, out_of_stock_exchange: row.outOfStockExchange });
        }
      });
    });

    test('返品の欄を足しても、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockSettingsApis(page);
      await openSettings(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
