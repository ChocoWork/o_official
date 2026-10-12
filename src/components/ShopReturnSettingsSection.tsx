'use client';

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';
import { TextField } from '@/components/ui/TextField/TextField';
import { INVALID_REQUEST_MESSAGE } from '@/lib/orders/refund/refund-messages';
import { RETURN_REASON_LABELS } from '@/lib/orders/returns/return-messages';
import {
  RETURN_REASONS,
  type OutOfStockExchange,
  type ReturnReason,
  type ShippingPayer,
  type ShopReturnSettings,
  type ShopReturnSettingsUpdate,
} from '@/lib/orders/returns/return-types';

const NOT_CHANGED_YET = 'まだ変えていません';
/** 「無制限」のチェックを外した時に入れる日数（DB の最初の値と同じ） */
const DEFAULT_WINDOW_DAYS = 7;
const ADDRESS_TEXT_MAX = 200;
const POSTAL_CODE_PATTERN = /^[0-9]{3}-?[0-9]{4}$/;
const PHONE_PATTERN = /^[0-9+-]{6,20}$/;
/** 半角の数字だけを9桁まで受ける。長すぎる数字は、範囲を見る前に断る */
const INTEGER_PATTERN = /^[0-9]{1,9}$/;
/**
 * 金額の欄の上限（Global Constraints の「金額の入力の上限」）。DB の関数 admin_update_shop_return_settings（Task 2）と
 * 窓口の zod（Task 7）が、この額を超える値を断るので、画面も同じ所で断る（作る画面 Task 10 の上限とも同じ）
 */
const MAX_FEE_YEN = 1_000_000;

// 入力の誤りの言葉。DB の CHECK・関数と同じ範囲で、窓口に送る前に画面が断る（どの欄が誤りかを示すため）
const AMOUNT_MESSAGE = '0から1000000までの整数（半角）で入れてください。';
const PERCENT_MESSAGE = '0から100までの整数（半角）で入れてください。';
const WINDOW_DAYS_MESSAGE = '1から365までの整数（半角）で入れてください。';
const DELIVERY_BUFFER_MESSAGE = '0から14までの整数（半角）で入れてください。';
const ADDRESS_REQUIRED_MESSAGE = '返送先は4つとも入れてください。';
const ADDRESS_TOO_LONG_MESSAGE = '200字までで入れてください。';
const POSTAL_CODE_MESSAGE = '郵便番号は 123-4567 の形で入れてください。';
const PHONE_MESSAGE = '電話番号は、数字と「+」「-」だけで6〜20文字にしてください。';
/** 保存の最中に「保存する」を押された時の知らせ（T12-12） */
const PRESSED_WHILE_SAVING_MESSAGE = '保存の最中です。済んでから、もう一度「保存する」を押してください。';

type IntegerRange = { min: number; max: number; message: string };

const AMOUNT_RANGE: IntegerRange = { min: 0, max: MAX_FEE_YEN, message: AMOUNT_MESSAGE };
const PERCENT_RANGE: IntegerRange = { min: 0, max: 100, message: PERCENT_MESSAGE };
const WINDOW_DAYS_RANGE: IntegerRange = { min: 1, max: 365, message: WINDOW_DAYS_MESSAGE };
const DELIVERY_BUFFER_RANGE: IntegerRange = { min: 0, max: 14, message: DELIVERY_BUFFER_MESSAGE };

const PAID_METHOD_OPTIONS = [
  { value: 'customer_ships', label: 'ご自身で送っていただく' },
  { value: 'shop_label', label: 'お店の送り状で送っていただき、返送料を差し引く' },
];
const WINDOW_START_OPTIONS = [
  { value: 'each_item', label: '品ごとの届いた日' },
  { value: 'last_item', label: '最後の品の届いた日' },
];
const PAYER_OPTIONS = [
  { value: 'shop', label: 'お店' },
  { value: 'customer', label: 'お客様' },
];
const OUT_OF_STOCK_OPTIONS = [
  { value: 'make', label: '作って送る' },
  { value: 'decline', label: '受けない' },
];

type UpdatedEntry = ShopReturnSettings['updated']['shipping'];

/** 文字で持つ入力欄。数も文字で持ち、空・途中の入力を許してから、保存の時に数へ直す */
type TextKey =
  | 'addressName'
  | 'addressPostalCode'
  | 'addressLine'
  | 'addressPhone'
  | 'shopLabelFee'
  | 'windowDays'
  | 'deliveryBufferDays'
  | 'restockingFeePercent'
  | 'exchangeFee'
  | 'exchangeShippingFee';

type ReasonDraft = { shippingPayer: ShippingPayer; outOfStockExchange: OutOfStockExchange };

type Draft = Record<TextKey, string> & {
  customerPaidMethod: ShopReturnSettings['customerPaidMethod'];
  noReturnNeededEnabled: boolean;
  windowUnlimited: boolean;
  windowStart: ShopReturnSettings['windowStart'];
  reasons: Record<ReturnReason, ReasonDraft>;
  restockingFeeEnabled: boolean;
  exchangeFeesEnabled: boolean;
  inspectionEnabled: boolean;
};

type FieldErrors = Partial<Record<TextKey, string>>;
const NO_ERRORS: FieldErrors = {};

/** 入力欄の id。上から画面に並ぶ順で、誤りの最初の欄へフォーカスを移すのにも使う */
const FIELD_IDS: Record<TextKey, string> = {
  addressName: 'shop-return-address-name',
  addressPostalCode: 'shop-return-address-postal-code',
  addressLine: 'shop-return-address-line',
  addressPhone: 'shop-return-address-phone',
  shopLabelFee: 'shop-return-shop-label-fee',
  windowDays: 'shop-return-window-days',
  deliveryBufferDays: 'shop-return-delivery-buffer-days',
  restockingFeePercent: 'shop-return-restocking-fee-percent',
  exchangeFee: 'shop-return-exchange-fee',
  exchangeShippingFee: 'shop-return-exchange-shipping-fee',
};
const FIELD_ORDER = Object.keys(FIELD_IDS) as TextKey[];

function toDraft(settings: ShopReturnSettings): Draft {
  const address = settings.returnAddress;
  const reasons = {} as Record<ReturnReason, ReasonDraft>;
  for (const row of settings.reasons) {
    reasons[row.reason] = { shippingPayer: row.shippingPayer, outOfStockExchange: row.outOfStockExchange };
  }
  return {
    addressName: address?.name ?? '',
    addressPostalCode: address?.postalCode ?? '',
    addressLine: address?.address ?? '',
    addressPhone: address?.phone ?? '',
    shopLabelFee: String(settings.shopLabelFee),
    windowDays: String(settings.windowDays ?? DEFAULT_WINDOW_DAYS),
    deliveryBufferDays: String(settings.deliveryBufferDays),
    restockingFeePercent: String(settings.restockingFeePercent),
    exchangeFee: String(settings.exchangeFee),
    exchangeShippingFee: String(settings.exchangeShippingFee),
    customerPaidMethod: settings.customerPaidMethod,
    noReturnNeededEnabled: settings.noReturnNeededEnabled,
    windowUnlimited: settings.windowDays === null,
    windowStart: settings.windowStart,
    reasons,
    restockingFeeEnabled: settings.restockingFeeEnabled,
    exchangeFeesEnabled: settings.exchangeFeesEnabled,
    inspectionEnabled: settings.inspectionEnabled,
  };
}

function parseInteger(text: string, range: IntegerRange): number | null {
  const trimmed = text.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= range.min && value <= range.max ? value : null;
}

type Validation = { ok: true; input: ShopReturnSettingsUpdate } | { ok: false; errors: FieldErrors };

/**
 * 入力を確かめ、窓口へ送る形に直す。誤りは欄ごとに集める。
 * 返送先は、4つとも空なら「未設定」（null）、1つでも入っていれば4つとも要る（DB の CHECK と同じ）。
 * 手数料の3つの欄は、使うトグルがオンの時だけ確かめる。オフの時は保存してある値をそのまま送る（変えたことにしない）。
 */
function validate(draft: Draft, saved: ShopReturnSettings): Validation {
  const errors: FieldErrors = {};

  const name = draft.addressName.trim();
  const postalCode = draft.addressPostalCode.trim();
  const address = draft.addressLine.trim();
  const phone = draft.addressPhone.trim();
  let returnAddress: ShopReturnSettings['returnAddress'] = null;
  if ([name, postalCode, address, phone].some((part) => part !== '')) {
    returnAddress = { name, postalCode, address, phone };
    if (name === '') {
      errors.addressName = ADDRESS_REQUIRED_MESSAGE;
    } else if (name.length > ADDRESS_TEXT_MAX) {
      errors.addressName = ADDRESS_TOO_LONG_MESSAGE;
    }
    if (postalCode === '') {
      errors.addressPostalCode = ADDRESS_REQUIRED_MESSAGE;
    } else if (!POSTAL_CODE_PATTERN.test(postalCode)) {
      errors.addressPostalCode = POSTAL_CODE_MESSAGE;
    }
    if (address === '') {
      errors.addressLine = ADDRESS_REQUIRED_MESSAGE;
    } else if (address.length > ADDRESS_TEXT_MAX) {
      errors.addressLine = ADDRESS_TOO_LONG_MESSAGE;
    }
    if (phone === '') {
      errors.addressPhone = ADDRESS_REQUIRED_MESSAGE;
    } else if (!PHONE_PATTERN.test(phone)) {
      errors.addressPhone = PHONE_MESSAGE;
    }
  }

  // 誤りの時は、型を満たすために fallback を返す（誤りがあれば、この値は送らない）
  const read = (key: TextKey, range: IntegerRange, fallback: number): number => {
    const value = parseInteger(draft[key], range);
    if (value === null) {
      errors[key] = range.message;
      return fallback;
    }
    return value;
  };

  const shopLabelFee = read('shopLabelFee', AMOUNT_RANGE, saved.shopLabelFee);
  const windowDays = draft.windowUnlimited ? null : read('windowDays', WINDOW_DAYS_RANGE, DEFAULT_WINDOW_DAYS);
  const deliveryBufferDays = read('deliveryBufferDays', DELIVERY_BUFFER_RANGE, saved.deliveryBufferDays);
  const restockingFeePercent = draft.restockingFeeEnabled
    ? read('restockingFeePercent', PERCENT_RANGE, saved.restockingFeePercent)
    : saved.restockingFeePercent;
  const exchangeFee = draft.exchangeFeesEnabled ? read('exchangeFee', AMOUNT_RANGE, saved.exchangeFee) : saved.exchangeFee;
  const exchangeShippingFee = draft.exchangeFeesEnabled
    ? read('exchangeShippingFee', AMOUNT_RANGE, saved.exchangeShippingFee)
    : saved.exchangeShippingFee;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      returnAddress,
      customerPaidMethod: draft.customerPaidMethod,
      shopLabelFee,
      noReturnNeededEnabled: draft.noReturnNeededEnabled,
      windowDays,
      windowStart: draft.windowStart,
      deliveryBufferDays,
      reasons: RETURN_REASONS.map((reason) => ({ reason, ...draft.reasons[reason] })),
      restockingFeeEnabled: draft.restockingFeeEnabled,
      restockingFeePercent,
      exchangeFeesEnabled: draft.exchangeFeesEnabled,
      exchangeFee,
      exchangeShippingFee,
      inspectionEnabled: draft.inspectionEnabled,
    },
  };
}

// 日本時間の書き方は ShopSettingsSection と同じ。共通の関数が無く、各画面が小さな関数を持つ（グループ E-2 の T13-7）
function formatJst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** まとまりの下の「最後に変えた人」。時刻が空（まだ誰も変えていない）の時だけ「まだ変えていません」 */
function updatedLine(entry: UpdatedEntry): string {
  if (!entry.at) {
    return NOT_CHANGED_YET;
  }
  return `最後に変えた人: ${entry.byEmail ?? '不明'}（${formatJst(entry.at)}）`;
}

/** 欄のまとまり。見出し（h4）で名前の付いた region にし、下に、そのまとまりを最後に変えた人を出す */
function Group({ title, updated, children }: { title: string; updated: UpdatedEntry; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3 border-t border-black/10 pt-4">
      <h4 id={titleId} className="font-acumin lk-text-sm text-black">
        {title}
      </h4>
      {children}
      <p className="font-acumin lk-text-3xs text-[#474747]">{updatedLine(updated)}</p>
    </section>
  );
}

type TextOptions = { numeric?: boolean; disabled?: boolean; helperText?: string };

type ShopReturnSettingsSectionProps = {
  /** 窓口が返した、保存してある返品の設定。「最後に変えた人」と、使わない手数料の値はこれを使う */
  settings: ShopReturnSettings;
  /** 保存の最中か。親が持つ（自動の返金のトグルの保存と同じ状態を使って、同時に2つ送らない） */
  saving: boolean;
  /** 保存を頼む。窓口が返した設定（保存できた）か null（保存できなかった。失敗の文は親が出す）を返す */
  onSave: (input: ShopReturnSettingsUpdate) => Promise<ShopReturnSettings | null>;
  /** 入力に誤りがあって保存しなかった時に呼ぶ（親が前の保存の知らせと窓口の失敗の文を消す） */
  onInvalid?: () => void;
};

/**
 * ショップの設定の「返品」の欄（グループ E-3 設計書 8-3。段1の分: 返送・受付の期限・理由ごとの設定・手数料・受け取り）。
 * 入力は欄の部品が持ち、「保存する」で1回に保存する。保存できた時だけ、窓口が返した値で入力を置き換える
 * （失敗の時は入力を残す。自動の返金のトグルの保存では、入力を消さない）。保存の最中（自動の返金のトグルの保存も含む）に
 * 押された時は、何も頼まず、ボタンの上の知らせで待つよう伝える。
 */
export default function ShopReturnSettingsSection({ settings, saving, onSave, onInvalid }: ShopReturnSettingsSectionProps) {
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  // 一度「保存する」を押したら、誤りを直すそばから消えるよう、描くたびに確かめ直す
  const [submitted, setSubmitted] = useState(false);
  // 保存の最中に「保存する」が押された印。保存が済んだら戻す（戻さないと、次の保存の間に、押していないのに知らせが出る）
  const [pressedWhileSaving, setPressedWhileSaving] = useState(false);
  useEffect(() => {
    if (!saving) {
      setPressedWhileSaving(false);
    }
  }, [saving]);

  const validation = validate(draft, settings);
  const errors = submitted && !validation.ok ? validation.errors : NO_ERRORS;
  const showSummary = submitted && !validation.ok;

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setReason = (reason: ReturnReason, changes: Partial<ReasonDraft>) =>
    setDraft((current) => ({
      ...current,
      reasons: { ...current.reasons, [reason]: { ...current.reasons[reason], ...changes } },
    }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 保存の間の押し直しは受け付けない。ボタンは disabled にしない（キーボードで押した時にフォーカスが失われるため。E-2 の T13-5 と同じ）。
    // 黙って捨てると、押した返品の欄の保存まで済んだと読み違えるので、ボタンの上の知らせで待つよう伝える（T12-12）
    if (saving) {
      setPressedWhileSaving(true);
      return;
    }
    setSubmitted(true);
    if (!validation.ok) {
      onInvalid?.();
      const firstKey = FIELD_ORDER.find((key) => validation.errors[key]);
      if (firstKey) {
        document.getElementById(FIELD_IDS[firstKey])?.focus();
      }
      return;
    }
    const saved = await onSave(validation.input);
    if (saved) {
      setDraft(toDraft(saved));
      setSubmitted(false);
    }
  };

  const renderText = (key: TextKey, label: string, options: TextOptions = {}) => (
    <TextField
      id={FIELD_IDS[key]}
      label={label}
      type="text"
      size="sm"
      inputMode={options.numeric ? 'numeric' : undefined}
      autoComplete="off"
      value={draft[key]}
      disabled={options.disabled}
      helperText={options.helperText}
      errorText={errors[key]}
      onChange={(event) => setField(key, event.target.value)}
    />
  );

  return (
    <section aria-labelledby={titleId} className="space-y-4 border border-black/15 p-4">
      <h3 id={titleId} className="font-acumin lk-text-3xs tracking-widest text-[#474747]">
        返品
      </h3>

      <form noValidate onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
        <Group title="返送" updated={settings.updated.shipping}>
          <div
            role="group"
            aria-labelledby="shop-return-address-title"
            aria-describedby="shop-return-address-note"
            className="space-y-3"
          >
            <div className="space-y-1">
              <p id="shop-return-address-title" className="font-acumin lk-text-sm text-black">
                返送先
              </p>
              <p id="shop-return-address-note" className="font-acumin lk-text-3xs text-[#474747]">
                返品の受付のお知らせに載せます。空の間は、返品を作れません。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {renderText('addressName', '名前')}
              {renderText('addressPostalCode', '郵便番号')}
              <div className="sm:col-span-2">{renderText('addressLine', '住所')}</div>
              {renderText('addressPhone', '電話番号')}
            </div>
          </div>
          <SingleSelect
            id="shop-return-customer-paid-method"
            label="お客様の負担の時の送り方"
            size="sm"
            options={PAID_METHOD_OPTIONS}
            value={draft.customerPaidMethod}
            onChange={(event) => setField('customerPaidMethod', event.target.value === 'shop_label' ? 'shop_label' : 'customer_ships')}
          />
          {renderText('shopLabelFee', '返送料の定額（円）', { numeric: true })}
          <div className="space-y-1">
            <SwitchToggle
              label="「返送不要」を選べるようにする"
              checked={draft.noReturnNeededEnabled}
              fullWidth
              size="sm"
              onChange={(enabled) => setField('noReturnNeededEnabled', enabled)}
            />
            <p className="font-acumin lk-text-3xs text-[#474747]">オンにすると、返品を作る画面で「返送不要」を選べます。</p>
          </div>
        </Group>

        <Group title="受付の期限" updated={settings.updated.window}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">{renderText('windowDays', '日数', { numeric: true, disabled: draft.windowUnlimited })}</div>
            <Checkbox
              id="shop-return-window-unlimited"
              label="無制限"
              size="sm"
              checked={draft.windowUnlimited}
              onChange={(event) => setField('windowUnlimited', event.target.checked)}
            />
          </div>
          <SingleSelect
            id="shop-return-window-start"
            label="数え始め"
            size="sm"
            options={WINDOW_START_OPTIONS}
            value={draft.windowStart}
            onChange={(event) => setField('windowStart', event.target.value === 'last_item' ? 'last_item' : 'each_item')}
          />
          {renderText('deliveryBufferDays', '届いた日がわからない時の目安（日）', {
            numeric: true,
            helperText: '配達の記録ができるまでは、発送の日にこの日数を足した日を届いた日とみなします。',
          })}
        </Group>

        <Group title="理由ごとの設定" updated={settings.updated.reasons}>
          <div className="space-y-3">
            {RETURN_REASONS.map((reason) => {
              const rowTitleId = `shop-return-reason-${reason}-title`;
              const row = draft.reasons[reason];
              return (
                <div key={reason} role="group" aria-labelledby={rowTitleId} className="space-y-2 border border-black/10 p-3">
                  <p id={rowTitleId} className="font-acumin lk-text-sm text-black">
                    {RETURN_REASON_LABELS[reason]}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SingleSelect
                      id={`shop-return-reason-${reason}-payer`}
                      label="返送料の負担"
                      size="sm"
                      options={PAYER_OPTIONS}
                      value={row.shippingPayer}
                      onChange={(event) => setReason(reason, { shippingPayer: event.target.value === 'shop' ? 'shop' : 'customer' })}
                    />
                    <SingleSelect
                      id={`shop-return-reason-${reason}-out-of-stock`}
                      label="在庫の無い交換"
                      size="sm"
                      options={OUT_OF_STOCK_OPTIONS}
                      value={row.outOfStockExchange}
                      onChange={(event) =>
                        setReason(reason, { outOfStockExchange: event.target.value === 'make' ? 'make' : 'decline' })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Group>

        <Group title="手数料" updated={settings.updated.fees}>
          <div className="space-y-2">
            <SwitchToggle
              label="返品の手数料を使う"
              checked={draft.restockingFeeEnabled}
              fullWidth
              size="sm"
              onChange={(enabled) => setField('restockingFeeEnabled', enabled)}
            />
            {draft.restockingFeeEnabled ? renderText('restockingFeePercent', '返品の手数料（%）', { numeric: true }) : null}
          </div>
          <div className="space-y-2">
            <SwitchToggle
              label="交換の手数料と送料を使う"
              checked={draft.exchangeFeesEnabled}
              fullWidth
              size="sm"
              onChange={(enabled) => setField('exchangeFeesEnabled', enabled)}
            />
            {draft.exchangeFeesEnabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {renderText('exchangeFee', '交換の手数料（円）', { numeric: true })}
                {renderText('exchangeShippingFee', '交換の送料（円）', { numeric: true })}
              </div>
            ) : null}
          </div>
          <p className="font-acumin lk-text-3xs text-[#474747]">手で受け取った手数料は、帳簿に自動では入りません。</p>
        </Group>

        <Group title="受け取り" updated={settings.updated.receiving}>
          <div className="space-y-1">
            <SwitchToggle
              label="要検品を使う"
              checked={draft.inspectionEnabled}
              fullWidth
              size="sm"
              onChange={(enabled) => setField('inspectionEnabled', enabled)}
            />
            <p className="font-acumin lk-text-3xs text-[#474747]">
              オンにすると、受け取りの画面に「検品待ち」が出て、後で在庫に戻すかを決められます。
            </p>
          </div>
        </Group>

        {showSummary ? (
          <p role="alert" className="font-acumin lk-text-sm text-red-700">
            {INVALID_REQUEST_MESSAGE}
          </p>
        ) : null}
        {/* 保存の最中に押された時の知らせ。入れ物は最初から置く（空の間は場所を取らない）。role は付けない
            （親の保存の知らせ role="status" と窓口の失敗の文 role="alert" を、画面に1つずつのままにするため） */}
        <LiveMessage as="p" politeness="polite" className="font-acumin lk-text-sm text-[#474747]">
          {pressedWhileSaving && saving ? PRESSED_WHILE_SAVING_MESSAGE : null}
        </LiveMessage>
        <Button type="submit" variant="primary" size="sm" className="font-acumin">
          保存する
        </Button>
      </form>
    </section>
  );
}
