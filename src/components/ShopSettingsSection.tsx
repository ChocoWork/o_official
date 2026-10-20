'use client';

import { useEffect, useId, useState } from 'react';
import ShopReturnSettingsSection from '@/components/ShopReturnSettingsSection';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';
import { clientFetch } from '@/lib/client-fetch';
import { REFUND_FAILURE_MESSAGES } from '@/lib/orders/refund/refund-messages';
import type { ShopSettings, ShopSettingToggle, UpdateShopSettingsRequest } from '@/lib/orders/refund/refund-types';
import {
  RETURN_REASONS,
  type ReturnReason,
  type ShopReturnSettings,
  type ShopReturnSettingsUpdate,
} from '@/lib/orders/returns/return-types';
import { cn } from '@/lib/utils';

const SETTINGS_URL = '/api/admin/settings/shop';
const SAVED_MESSAGE = '設定を保存しました。';
const NOT_CHANGED_YET = 'まだ変えていません';
const AUTO_CANCEL_CONFIRM_MESSAGE =
  'オンにすると、支払額が注文と違う注文は、差が小さくても自動で全額返金して取り消されます。オンにしますか？';

type ToggleKey = keyof ShopSettings;

type ToggleDefinition = {
  key: ToggleKey;
  /** 「最後に変えた人」の行の目印（data-testid）に使う短い名前 */
  id: string;
  name: string;
  description: string;
};

const AUTO_REFUND_TOGGLE: ToggleDefinition = {
  key: 'autoRefundCancelledOrderPayment',
  id: 'auto-refund',
  name: '取り消した注文に届いた入金を、自動で全額返金する',
  description: '主にコンビニ払いで、期限切れで取り消した後に払われた時に動きます。お客様に返金のお知らせが届きます。',
};

const AUTO_CANCEL_TOGGLE: ToggleDefinition = {
  key: 'autoCancelAmountMismatch',
  id: 'auto-cancel',
  name: '支払額が注文と違う注文を、自動で全額返金して取り消す',
  description: 'オンにすると、差が小さくても注文は取り消されます。',
};

const TOGGLES: readonly ToggleDefinition[] = [AUTO_REFUND_TOGGLE, AUTO_CANCEL_TOGGLE];

/**
 * 窓口が返した設定。returns は返品の欄の設定。窓口の答えに無い間（E-2 の窓口の形）は null で、返品の欄を出さない
 * （returns があるのに形が違う答えは null でなく、読み込めなかった扱いにする）
 */
type LoadedSettings = { settings: ShopSettings; returns: ShopReturnSettings | null };

type LoadState = { kind: 'loading' } | { kind: 'error' } | ({ kind: 'ready' } & LoadedSettings);

type SettingsResult = ({ ok: true } & LoadedSettings) | { ok: false };

/** 窓口へ送る中身。自動の返金の2つは必ず送り、returns は返品の欄を保存する時だけ付ける */
type SettingsRequest = UpdateShopSettingsRequest & { returns?: ShopReturnSettingsUpdate };

function formatJst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** トグルの下の「最後に変えた人」。時刻が空（まだ誰も変えていない）の時だけ「まだ変えていません」 */
function updatedLine(toggle: ShopSettingToggle): string {
  if (!toggle.updatedAt) {
    return NOT_CHANGED_YET;
  }
  return `最後に変えた人: ${toggle.updatedByEmail ?? '不明'}（${formatJst(toggle.updatedAt)}）`;
}

function isToggle(value: unknown): value is ShopSettingToggle {
  return typeof value === 'object' && value !== null && typeof (value as { enabled?: unknown }).enabled === 'boolean';
}

function isShopSettings(value: unknown): value is ShopSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { autoRefundCancelledOrderPayment, autoCancelAmountMismatch } = value as Record<string, unknown>;
  return isToggle(autoRefundCancelledOrderPayment) && isToggle(autoCancelAmountMismatch);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isOneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);

/** 段2の欄の選べる値。ShopReturnSettings の型（return-types.ts）と同じ値で、窓口の答えの形の確かめに使う */
const REQUEST_TYPES = ['returns_and_cancellations', 'returns_only', 'cancellations_only'] as const;
const REASON_RESOLUTIONS = ['refund_and_exchange', 'exchange_only', 'refund_only'] as const;
const REASON_PHOTO_RULES = ['none', 'optional', 'required'] as const;

/** ShopReturnSettings.updated のキー（まとまりの名前）。段2の requests も、形だけは確かめる */
const UPDATED_GROUPS = ['requests', 'window', 'shipping', 'reasons', 'fees', 'receiving'] as const;

function isUpdatedEntry(value: unknown): boolean {
  return isRecord(value) && isNullableString(value.at) && isNullableString(value.byEmail);
}

function isReturnAddress(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.postalCode === 'string' &&
    typeof value.address === 'string' &&
    typeof value.phone === 'string'
  );
}

function isReasonRow(value: unknown, reason: ReturnReason): boolean {
  return (
    isRecord(value) &&
    value.reason === reason &&
    typeof value.shown === 'boolean' &&
    isOneOf(value.resolutions, REASON_RESOLUTIONS) &&
    (value.outOfStockExchange === 'make' || value.outOfStockExchange === 'decline') &&
    isOneOf(value.photo, REASON_PHOTO_RULES) &&
    typeof value.photoInstructions === 'string' &&
    (value.shippingPayer === 'shop' || value.shippingPayer === 'customer')
  );
}

/**
 * 返品の設定の形を確かめる。確かめるのは、この画面が読む欄（段1の分と、段2の申し込みの受付・種類・注意書き・
 * 理由ごとの出す／ご希望／写真／案内の文）。欄の部品は保存で全部の欄を送り返すので、欠けた答えは読み込めなかった旨にする。
 * 理由は10個そろっていること（欠けると理由ごとの行を作れない）。
 */
function isShopReturnSettings(value: unknown): value is ShopReturnSettings {
  if (!isRecord(value)) {
    return false;
  }
  const { reasons, updated } = value;
  return (
    (value.windowDays === null || isInteger(value.windowDays)) &&
    (value.windowStart === 'each_item' || value.windowStart === 'last_item') &&
    isInteger(value.deliveryBufferDays) &&
    isReturnAddress(value.returnAddress) &&
    (value.customerPaidMethod === 'customer_ships' || value.customerPaidMethod === 'shop_label') &&
    isInteger(value.shopLabelFee) &&
    typeof value.noReturnNeededEnabled === 'boolean' &&
    typeof value.restockingFeeEnabled === 'boolean' &&
    isInteger(value.restockingFeePercent) &&
    typeof value.exchangeFeesEnabled === 'boolean' &&
    isInteger(value.exchangeFee) &&
    isInteger(value.exchangeShippingFee) &&
    typeof value.inspectionEnabled === 'boolean' &&
    typeof value.requestsEnabled === 'boolean' &&
    isOneOf(value.requestTypes, REQUEST_TYPES) &&
    typeof value.noticeText === 'string' &&
    Array.isArray(reasons) &&
    RETURN_REASONS.every((reason) => reasons.some((row) => isReasonRow(row, reason))) &&
    isRecord(updated) &&
    UPDATED_GROUPS.every((group) => isUpdatedEntry(updated[group]))
  );
}

/**
 * 窓口の答えの中身（data）を読む。自動の返金の2つは今までどおり必ず要る。returns が無い（undefined）答えは返品の欄なしとして読み、
 * returns があるのに形が違う答え（null を含む）は失敗にする。
 */
function parseSettings(data: unknown): SettingsResult {
  if (!isShopSettings(data)) {
    return { ok: false };
  }
  const returns: unknown = 'returns' in data ? data.returns : undefined;
  if (returns === undefined) {
    return { ok: true, settings: data, returns: null };
  }
  return isShopReturnSettings(returns) ? { ok: true, settings: data, returns } : { ok: false };
}

/**
 * 窓口の答え（{ data: ShopSettings に returns が付いた物 }）を読む。断られた・通信が切れた・答えの形が違う、はどれも失敗にする。
 * 画面は理由を分けず、読み込みと保存で1つずつの文を出す（窓口の英語の文を出さないため）。
 */
async function readSettings(send: () => Promise<Response>): Promise<SettingsResult> {
  try {
    const response = await send();
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as { data?: unknown };
    return parseSettings(body.data);
  } catch {
    return { ok: false };
  }
}

const loadSettings = () => readSettings(() => clientFetch(SETTINGS_URL, { cache: 'no-store' }));

// 書き込みは clientFetch が CSRF の印（x-csrf-token）を付ける
const saveSettings = (request: SettingsRequest) =>
  readSettings(() =>
    clientFetch(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );

/** 変えた1つだけ新しい値にして、もう1つは渡された設定（保存の直前に読み直した物）の値を送る。窓口は2つの値を受け取る */
function requestWith(settings: ShopSettings, key: ToggleKey, enabled: boolean): UpdateShopSettingsRequest {
  return {
    autoRefundCancelledOrderPayment:
      key === 'autoRefundCancelledOrderPayment' ? enabled : settings.autoRefundCancelledOrderPayment.enabled,
    autoCancelAmountMismatch: key === 'autoCancelAmountMismatch' ? enabled : settings.autoCancelAmountMismatch.enabled,
  };
}

/** 返品の欄を保存する時の自動の返金の2つ。変えないので、保存の直前に読み直した値をそのまま送る（窓口は2つの値を必ず受け取る） */
function keepingToggles(settings: ShopSettings): UpdateShopSettingsRequest {
  return {
    autoRefundCancelledOrderPayment: settings.autoRefundCancelledOrderPayment.enabled,
    autoCancelAmountMismatch: settings.autoCancelAmountMismatch.enabled,
  };
}

/**
 * ショップの設定の画面（グループ E-2 設計書 9-6。店長だけ）。「自動の返金」の2つのトグルを出し、切り替えるたびに保存する。
 * 自動の取消②をオンにする時だけ、保存の前に確かめの画面を出す（差が小さくても注文が取り消されるため）。
 * 保存の直前に設定を読み直し、変えない方のトグルは読み直した値を送る（開きっぱなしの古い画面が、
 * 別のタブで変えた値を黙って戻さないため）。各トグルの下に、最後に変えた人と日本時間の時刻を出す。
 *
 * グループ E-3 で、その下に「返品」の欄（ShopReturnSettingsSection）を足した。窓口の答えに返品の設定が付いている時だけ出す。
 * 返品の欄は「保存する」で1回に保存し、手順は自動の返金と同じ（保存の直前に読み直し、変えない自動の返金の2つは読み直した値を送る）。
 * 返品の欄の入力は欄の部品が持つので、自動の返金のトグルを保存しても消えない。
 * 保存の結果の文は、トグルを保存した時は自動の返金の欄の直後、返品の欄を保存した時は返品の欄の直後に見せる
 * （入れ物は1つずつのまま、CSS の order で位置だけ動かす。T12-13）。
 */
export default function ShopSettingsSection() {
  const titleId = useId();
  const groupId = useId();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 保存の結果の文（role="status"・role="alert"）を見せる位置。入れ物は1つずつのまま、CSS の order で動かす（T12-13）。
  // 自動の返金のトグルの保存の結果は自動の返金の欄の直後、返品の欄の保存の結果は返品の欄の直後に見せる
  const [resultPlace, setResultPlace] = useState<'toggles' | 'returns'>('returns');

  useEffect(() => {
    let active = true;
    void loadSettings().then((result) => {
      if (active) {
        setLoad(result.ok ? { kind: 'ready', settings: result.settings, returns: result.returns } : { kind: 'error' });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const save = async (key: ToggleKey, enabled: boolean) => {
    // 結果の文は、自動の返金の欄の直後に見せる（T12-13）
    setResultPlace('toggles');
    setSaving(true);
    setNotice(null);
    setSaveError(null);
    // 画面を開いた後に別のタブ・別の人が変えた値を、古い画面の値で黙って戻さない。変えない方のトグルは、
    // 読み直した値を送る（別のタブでオフにした②を、確かめ無しでオンに戻さない）。読み直せなければ保存しない（T13-4）
    const latest = await loadSettings();
    const result = latest.ok ? await saveSettings(requestWith(latest.settings, key, enabled)) : latest;
    // 確かめの画面は、答えが返ってから閉じる。保存の間に閉じると、閉じた時にフォーカスを戻したい②のトグルが
    // 押せない状態で、戻せずに失われる（T13-5）。成功でも失敗でも、ここで閉じる
    setSaving(false);
    setConfirming(false);
    if (result.ok) {
      // 自動の返金の保存の答えに返品の設定が無くても、返品の欄は消さない
      setLoad((current) => ({
        kind: 'ready',
        settings: result.settings,
        returns: result.returns ?? (current.kind === 'ready' ? current.returns : null),
      }));
      setNotice(SAVED_MESSAGE);
      return;
    }
    setSaveError(REFUND_FAILURE_MESSAGES.settings_update);
  };

  /**
   * 返品の欄の「保存する」。自動の返金のトグルの保存と同じ手順で、保存の直前に読み直し、変えない自動の返金の2つは読み直した値を
   * 一緒に送る（T13-4）。窓口が返した返品の設定を返す。保存できなかった時は失敗の文を出して null を返し、入力は欄に残る。
   * 答えに返品の設定が無い時は、保存できたと確かめられないので失敗にする。
   */
  const saveReturns = async (input: ShopReturnSettingsUpdate): Promise<ShopReturnSettings | null> => {
    if (saving) {
      return null;
    }
    // 結果の文は、返品の欄の直後に見せる（T12-13）
    setResultPlace('returns');
    setSaving(true);
    setNotice(null);
    setSaveError(null);
    const latest = await loadSettings();
    const result = latest.ok ? await saveSettings({ ...keepingToggles(latest.settings), returns: input }) : latest;
    setSaving(false);
    if (result.ok && result.returns) {
      setLoad({ kind: 'ready', settings: result.settings, returns: result.returns });
      setNotice(SAVED_MESSAGE);
      return result.returns;
    }
    setSaveError(REFUND_FAILURE_MESSAGES.settings_update);
    return null;
  };

  const handleToggle = (key: ToggleKey, enabled: boolean) => {
    if (saving) {
      return;
    }
    // ②をオフからオンにする時だけ確かめる。確かめの間、トグルは保存してある値のまま（T13-2）
    if (key === 'autoCancelAmountMismatch' && enabled) {
      setConfirming(true);
      return;
    }
    void save(key, enabled);
  };

  const confirmAutoCancel = () => {
    if (saving) {
      return;
    }
    void save('autoCancelAmountMismatch', true);
  };

  // 保存の間は閉じない（Escape・背景・「やめる」）
  const closeConfirm = () => {
    if (!saving) {
      setConfirming(false);
    }
  };

  // 保存の結果の文を見せる位置（CSS の order。T12-13）。トグルの結果は自動の返金の欄（order-1）の直後、返品の欄の結果は
  // 返品の欄を包む入れ物（order-3）の直後。DOM の順は変えない（読み上げとフォーカスの順は今のまま）
  const resultOrder = resultPlace === 'toggles' ? 'order-2' : 'order-4';

  return (
    <section aria-labelledby={titleId} aria-busy={saving} className="max-w-3xl flex flex-col gap-6">
      <h2 id={titleId} className="font-acumin lk-text-lg text-black">
        ショップの設定
      </h2>

      {load.kind === 'loading' ? <p className="font-acumin lk-text-sm text-[#474747]">読み込み中です...</p> : null}

      {load.kind === 'error' ? (
        <p role="alert" className="font-acumin lk-text-sm text-red-700">
          {REFUND_FAILURE_MESSAGES.settings}
        </p>
      ) : null}

      {load.kind === 'ready' ? (
        <section aria-labelledby={groupId} className="order-1 space-y-2 border border-black/15 p-4">
          <h3 id={groupId} className="font-acumin lk-text-3xs tracking-widest text-[#474747]">
            自動の返金
          </h3>
          <ul className="divide-y divide-black/10">
            {TOGGLES.map((toggle) => {
              const state = load.settings[toggle.key];
              return (
                <li key={toggle.key} className="space-y-1 py-3">
                  {/* 保存の間も disabled にしない。disabled にすると、キーボードで押した時にブラウザがフォーカスを body へ移し、
                      保存が済んでも戻らない。保存の間の押し直しは handleToggle の saving の判断が受け付けず、画面は aria-busy で知らせる */}
                  <SwitchToggle
                    label={toggle.name}
                    checked={state.enabled}
                    fullWidth
                    size="sm"
                    onChange={(enabled) => handleToggle(toggle.key, enabled)}
                  />
                  <p className="font-acumin lk-text-3xs text-[#474747]">{toggle.description}</p>
                  <p data-testid={`shop-setting-${toggle.id}-updated`} className="font-acumin lk-text-3xs text-[#474747]">
                    {updatedLine(state)}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {load.kind === 'ready' && load.returns ? (
        <div className="order-3">
          <ShopReturnSettingsSection
            settings={load.returns}
            saving={saving}
            onSave={saveReturns}
            onInvalid={() => {
              // 入力の誤りで保存しなかった時は、前の保存の知らせと窓口の失敗の文を残さない（誤りのまとめの文と並べない）
              setNotice(null);
              setSaveError(null);
            }}
          />
        </div>
      ) : null}

      {/* 保存の知らせ。後から差し込むと読み上げられない環境が多いので、入れ物は最初から置く（空の間は場所を取らない）。
          見せる位置は resultOrder（トグルの保存の結果は自動の返金の欄の直後、返品の欄の保存の結果は返品の欄の直後。T12-13） */}
      <p role="status" aria-live="polite" className={cn('font-acumin lk-text-sm text-[#474747]', resultOrder, !notice && 'sr-only')}>
        {notice}
      </p>

      {saveError ? (
        <p role="alert" className={cn('font-acumin lk-text-sm text-red-700', resultOrder)}>
          {saveError}
        </p>
      ) : null}

      {/* children を渡すと Dialog の標準のボタン（押すと必ず onClose も呼ぶ）は出ない。2つのボタンは自分で置く（T13-3） */}
      <Dialog
        open={confirming}
        onClose={closeConfirm}
        title={AUTO_CANCEL_TOGGLE.name}
        description={AUTO_CANCEL_CONFIRM_MESSAGE}
      >
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={saving} onClick={closeConfirm}>
            やめる
          </Button>
          <Button variant="primary" size="sm" className="w-full font-acumin" disabled={saving} onClick={confirmAutoCancel}>
            オンにする
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
