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
import type { DeliveryTrackingSettings } from '@/lib/orders/tracking/delivery-types';
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

// 「配送の追跡」の欄の言葉（グループ E-4 の計画 C-5。一字も変えない）
const DELIVERY_TOGGLE_NAME = '配送の追跡（17TRACK）を使う';
const DELIVERY_EXPLANATIONS = [
  'オンにすると、発送した荷物の配送状況（配達中・配達済みなど）を 17TRACK から受け取り、お客様の注文の画面に出し、配達中・配達済みのメールを送ります。17TRACK には配送業者と伝票番号だけを渡します',
  '17TRACK の利用料がかかります（最初の200件は無料。その後は年払い）。佐川急便の荷物は、佐川急便の追跡が止まっている間は追えません',
  'オフの間も、伝票番号の直しと、手で配達済みにすることはできます',
] as const;
const DELIVERY_KEY_CONFIGURED = '鍵：設定済み';
const DELIVERY_KEY_MISSING = '鍵：未設定';
const DELIVERY_KEY_MISSING_HINT = '17TRACK の鍵を設定してください';
const DELIVERY_CHECKING_COUNT = '件数を確かめています…';
const DELIVERY_ON_CONFIRM_TITLE = '配送の追跡を使う';
const DELIVERY_OFF_CONFIRM_TITLE = '配送の追跡を止める';
const DELIVERY_OFF_CONFIRM_MESSAGE = '追跡を止め、配送の要対応を閉じます。記録した配送状況は残ります';
const DELIVERY_REREAD_MESSAGE = '設定を保存できませんでした。現在の設定を読み直しました。';
const deliveryOnConfirmMessage = (count: number) =>
  `30日以内に発送した配達済みでない発送（${count}件）も 17TRACK に登録します。1件ごとに 17TRACK の件数を使います`;

/**
 * 窓口が返した設定。returns は返品の欄の設定、deliveryTracking は配送の追跡の欄の設定。窓口の答えに無い間
 * （returns は E-2 の窓口の形、deliveryTracking は E-4 より前の形・古い見本）は null で、その欄を出さない
 * （あるのに形が違う答えは null でなく、読み込めなかった扱いにする。実際の窓口の答えには必ず付く）
 */
type LoadedSettings = {
  settings: ShopSettings;
  returns: ShopReturnSettings | null;
  deliveryTracking: DeliveryTrackingSettings | null;
};

type LoadState = { kind: 'loading' } | { kind: 'error' } | ({ kind: 'ready' } & LoadedSettings);

type SettingsResult = ({ ok: true } & LoadedSettings) | { ok: false };

/** 窓口へ送る中身。自動の返金の2つは必ず送り、returns は返品の欄を、deliveryTracking は配送の欄を保存する時だけ付ける */
type SettingsRequest = UpdateShopSettingsRequest & {
  returns?: ShopReturnSettingsUpdate;
  deliveryTracking?: { enabled: boolean };
};

/** 配送の欄の確かめ。オンは「確かめを開く前に読み直した」件数と2つのトグルを持ち、保存はその2つを送る。オフは件数を使わない */
type DeliveryConfirm = { kind: 'on'; count: number; toggles: ShopSettings } | { kind: 'off' };

/** 配送の欄の中に出す保存の結果。自動の返金・返品の結果の文（欄の外の入れ物）とは別に、欄のすぐ下で見せる */
type DeliveryMessage = { kind: 'saved' | 'error'; text: string };

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

/** 配送の追跡の設定の形を確かめる（C-2 の DeliveryTrackingSettings の5項目。件数は0以上の整数） */
function isDeliveryTrackingSettings(value: unknown): value is DeliveryTrackingSettings {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isNullableString(value.updatedAt) &&
    isNullableString(value.updatedByEmail) &&
    typeof value.keyConfigured === 'boolean' &&
    isInteger(value.backfillCount) &&
    value.backfillCount >= 0
  );
}

/**
 * 窓口の答えの中身（data）を読む。自動の返金の2つは今までどおり必ず要る。returns・deliveryTracking が無い（undefined）答えは
 * その欄なしとして読み、あるのに形が違う答え（null を含む）は失敗にする。
 * 配送の設定は5項目だけを写し取る（窓口が余計な項目を返しても、鍵に当たる物を画面の状態に持たない）。
 */
function parseSettings(data: unknown): SettingsResult {
  if (!isShopSettings(data)) {
    return { ok: false };
  }
  const rawReturns: unknown = 'returns' in data ? data.returns : undefined;
  const rawDelivery: unknown = 'deliveryTracking' in data ? data.deliveryTracking : undefined;
  let returns: ShopReturnSettings | null = null;
  if (rawReturns !== undefined) {
    if (!isShopReturnSettings(rawReturns)) {
      return { ok: false };
    }
    returns = rawReturns;
  }
  let deliveryTracking: DeliveryTrackingSettings | null = null;
  if (rawDelivery !== undefined) {
    if (!isDeliveryTrackingSettings(rawDelivery)) {
      return { ok: false };
    }
    deliveryTracking = {
      enabled: rawDelivery.enabled,
      updatedAt: rawDelivery.updatedAt,
      updatedByEmail: rawDelivery.updatedByEmail,
      keyConfigured: rawDelivery.keyConfigured,
      backfillCount: rawDelivery.backfillCount,
    };
  }
  // 自動の返金の2つだけを写し取る（答えに付いてくる returns・deliveryTracking の生の値を、設定の状態に持ち越さない）
  const settings: ShopSettings = {
    autoRefundCancelledOrderPayment: data.autoRefundCancelledOrderPayment,
    autoCancelAmountMismatch: data.autoCancelAmountMismatch,
  };
  return { ok: true, settings, returns, deliveryTracking };
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
 *
 * グループ E-4 で、自動の返金と返品の間に「配送の追跡」の欄を足した（設計書 6-7）。窓口の答えに deliveryTracking が付いている時だけ出す。
 * トグルは切り替えるたびに確かめの画面を出す。オンにする前は、確かめを開く直前に設定を読み直し、登録する件数・鍵・自動の返金の2つを
 * 取り直す（件数は開いた後に変わりうるため、確かめに出すのは直前の数。保存で取り込んだ実数が違っても失敗にしない）。
 * 保存は「自動の返金の2つ（その読み直した値）＋配送」だけを送り、返品の設定は送らない。
 * 鍵が未設定の間は、オフからオンへは押せない。すでにオンの店で鍵が無くなった時は、止める道を残すためオフへ戻す操作を許す。
 * 鍵の値は窓口が返さず、この画面も持たない（出すのは「設定済み／未設定」だけ）。
 * 配送の欄の保存の結果の文は、欄の中に出す（自動の返金・返品の結果の文の位置は変えない）。
 */
export default function ShopSettingsSection() {
  const titleId = useId();
  const groupId = useId();
  const deliveryGroupId = useId();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 配送の欄: 確かめの画面（null は閉じている）、オンにする前の件数の読み直し中、欄の中に出す保存の結果
  const [deliveryConfirm, setDeliveryConfirm] = useState<DeliveryConfirm | null>(null);
  const [checkingCount, setCheckingCount] = useState(false);
  const [deliveryMessage, setDeliveryMessage] = useState<DeliveryMessage | null>(null);
  // 保存の結果の文（role="status"・role="alert"）を見せる位置。入れ物は1つずつのまま、CSS の order で動かす（T12-13）。
  // 自動の返金のトグルの保存の結果は自動の返金の欄の直後、返品の欄の保存の結果は返品の欄の直後に見せる
  const [resultPlace, setResultPlace] = useState<'toggles' | 'returns'>('returns');

  useEffect(() => {
    let active = true;
    void loadSettings().then((result) => {
      if (active) {
        setLoad(
          result.ok
            ? { kind: 'ready', settings: result.settings, returns: result.returns, deliveryTracking: result.deliveryTracking }
            : { kind: 'error' },
        );
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
    setDeliveryMessage(null);
    // 画面を開いた後に別のタブ・別の人が変えた値を、古い画面の値で黙って戻さない。変えない方のトグルは、
    // 読み直した値を送る（別のタブでオフにした②を、確かめ無しでオンに戻さない）。読み直せなければ保存しない（T13-4）
    const latest = await loadSettings();
    const result = latest.ok ? await saveSettings(requestWith(latest.settings, key, enabled)) : latest;
    // 確かめの画面は、答えが返ってから閉じる。保存の間に閉じると、閉じた時にフォーカスを戻したい②のトグルが
    // 押せない状態で、戻せずに失われる（T13-5）。成功でも失敗でも、ここで閉じる
    setSaving(false);
    setConfirming(false);
    if (result.ok) {
      // 自動の返金の保存の答えに返品・配送の設定が無くても、その欄は消さない
      setLoad((current) => ({
        kind: 'ready',
        settings: result.settings,
        returns: result.returns ?? (current.kind === 'ready' ? current.returns : null),
        deliveryTracking: result.deliveryTracking ?? (current.kind === 'ready' ? current.deliveryTracking : null),
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
    setDeliveryMessage(null);
    const latest = await loadSettings();
    const result = latest.ok ? await saveSettings({ ...keepingToggles(latest.settings), returns: input }) : latest;
    setSaving(false);
    if (result.ok && result.returns) {
      const { settings, returns } = result;
      // 返品の保存の答えに配送の設定が無くても、配送の欄は消さない
      setLoad((current) => ({
        kind: 'ready',
        settings,
        returns,
        deliveryTracking: result.deliveryTracking ?? (current.kind === 'ready' ? current.deliveryTracking : null),
      }));
      setNotice(SAVED_MESSAGE);
      return returns;
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

  /**
   * 配送の追跡のトグル。オフにする時は件数が要らないので、すぐ確かめを出す。オンにする時は、確かめを出す直前に設定を読み直す
   * （件数・鍵・自動の返金の2つを取り直す。読み直せなければ確かめを出さない）。読み直しで鍵が無くなっていた・もうオンになっていた
   * 時も確かめは出さず、取り直した値で欄を替える（鍵が無いとトグルは押せなくなる）。
   */
  const handleDeliveryToggle = async (enabled: boolean) => {
    if (saving || load.kind !== 'ready' || !load.deliveryTracking) {
      return;
    }
    setNotice(null);
    setSaveError(null);
    setDeliveryMessage(null);
    if (!enabled) {
      setDeliveryConfirm({ kind: 'off' });
      return;
    }
    if (!load.deliveryTracking.keyConfigured) {
      return;
    }
    setSaving(true);
    setCheckingCount(true);
    const latest = await loadSettings();
    setSaving(false);
    setCheckingCount(false);
    if (!latest.ok || !latest.deliveryTracking) {
      setDeliveryMessage({ kind: 'error', text: REFUND_FAILURE_MESSAGES.settings });
      return;
    }
    const { settings, deliveryTracking } = latest;
    // 返品の欄は読み直した値に替えない（返品の欄の入力は欄の部品が持ち、この確かめは返品を保存しない）
    setLoad((current) => (current.kind === 'ready' ? { ...current, settings, deliveryTracking } : current));
    if (deliveryTracking.enabled || !deliveryTracking.keyConfigured) {
      return;
    }
    setDeliveryConfirm({ kind: 'on', count: deliveryTracking.backfillCount, toggles: settings });
  };

  /**
   * 確かめの「オンにする」「オフにする」。送るのは、自動の返金の2つ（オンは確かめを開く直前に読み直した値、オフは保存の直前に
   * 読み直した値）と配送だけで、返品の設定は送らない。窓口は返品 → 自動の返金 → 配送の順に別々に保存するので、途中で失敗すると
   * 前の分だけ保存済みになりうる。失敗した時は、どこまで保存されたか分からないので設定を読み直して画面を合わせ、そう伝える。
   * 確かめの画面は答えが返ってから閉じる（成功でも失敗でも）。
   */
  const confirmDelivery = async () => {
    if (saving || !deliveryConfirm) {
      return;
    }
    const enabled = deliveryConfirm.kind === 'on';
    setSaving(true);
    setNotice(null);
    setSaveError(null);
    setDeliveryMessage(null);
    let toggles: ShopSettings | null = deliveryConfirm.kind === 'on' ? deliveryConfirm.toggles : null;
    if (!toggles) {
      const latest = await loadSettings();
      toggles = latest.ok ? latest.settings : null;
    }
    const result = toggles ? await saveSettings({ ...keepingToggles(toggles), deliveryTracking: { enabled } }) : null;
    if (result?.ok && result.deliveryTracking) {
      const { settings, deliveryTracking } = result;
      // 保存の答え（保存後の実際の設定）で画面を置き換える。確かめの間に増えた件数との差は、失敗にしない
      setLoad((current) => ({
        kind: 'ready',
        settings,
        returns: result.returns ?? (current.kind === 'ready' ? current.returns : null),
        deliveryTracking,
      }));
      setSaving(false);
      setDeliveryConfirm(null);
      setDeliveryMessage({ kind: 'saved', text: SAVED_MESSAGE });
      return;
    }
    // 読み直せなくて保存の窓口を呼んでいない時は、読み直しを重ねない
    const reread = toggles ? await loadSettings() : null;
    if (reread?.ok && reread.deliveryTracking) {
      const { settings, deliveryTracking } = reread;
      setLoad((current) => (current.kind === 'ready' ? { ...current, settings, deliveryTracking } : current));
      setDeliveryMessage({ kind: 'error', text: DELIVERY_REREAD_MESSAGE });
    } else {
      setDeliveryMessage({ kind: 'error', text: REFUND_FAILURE_MESSAGES.settings_update });
    }
    setSaving(false);
    setDeliveryConfirm(null);
  };

  // 保存の間は閉じない（Escape・背景・「戻る」）
  const closeDeliveryConfirm = () => {
    if (!saving) {
      setDeliveryConfirm(null);
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

      {/* 配送の追跡の欄。DOM では自動の返金と返品の間に置き、見た目の並びは返品の欄を包む入れ物と同じ order-3
          （同じ番号は DOM の順。自動の返金のトグルの結果の文は order-2 なので、この欄の前に出る）。
          この欄の保存の結果の文は、欄の中に置く */}
      {load.kind === 'ready' && load.deliveryTracking ? (
        <section aria-labelledby={deliveryGroupId} className="order-3 space-y-2 border border-black/15 p-4">
          <h3 id={deliveryGroupId} className="font-acumin lk-text-3xs tracking-widest text-[#474747]">
            配送の追跡
          </h3>
          <div className="space-y-1 py-3">
            {/* 鍵が未設定の間は、オフからオンへは押せない。すでにオンならオフへ戻せる（鍵が無くなった店の追跡を止める道） */}
            <SwitchToggle
              label={DELIVERY_TOGGLE_NAME}
              checked={load.deliveryTracking.enabled}
              disabled={!load.deliveryTracking.enabled && !load.deliveryTracking.keyConfigured}
              fullWidth
              size="sm"
              onChange={(enabled) => void handleDeliveryToggle(enabled)}
            />
            {DELIVERY_EXPLANATIONS.map((sentence) => (
              <p key={sentence} className="font-acumin lk-text-3xs text-[#474747]">
                {sentence}
              </p>
            ))}
            <p className="font-acumin lk-text-3xs text-[#474747]">
              {load.deliveryTracking.keyConfigured ? DELIVERY_KEY_CONFIGURED : DELIVERY_KEY_MISSING}
            </p>
            {load.deliveryTracking.keyConfigured ? null : (
              <p className="font-acumin lk-text-3xs text-red-700">{DELIVERY_KEY_MISSING_HINT}</p>
            )}
            {load.deliveryTracking.updatedAt ? (
              <p data-testid="shop-setting-delivery-tracking-updated" className="font-acumin lk-text-3xs text-[#474747]">
                {`最後の変更：${formatJst(load.deliveryTracking.updatedAt)}・${load.deliveryTracking.updatedByEmail || '不明'}`}
              </p>
            ) : null}
            {checkingCount ? <p className="font-acumin lk-text-3xs text-[#474747]">{DELIVERY_CHECKING_COUNT}</p> : null}
          </div>
          {/* 後から差し込むと読み上げられない環境が多いので、保存の知らせの入れ物は最初から置く（空の間は場所を取らない） */}
          <p
            role="status"
            aria-live="polite"
            className={cn('font-acumin lk-text-sm text-[#474747]', deliveryMessage?.kind !== 'saved' && 'sr-only')}
          >
            {deliveryMessage?.kind === 'saved' ? deliveryMessage.text : null}
          </p>
          {deliveryMessage?.kind === 'error' ? (
            <p role="alert" className="font-acumin lk-text-sm text-red-700">
              {deliveryMessage.text}
            </p>
          ) : null}
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
              setDeliveryMessage(null);
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

      {/* 配送の追跡の確かめ。オンは直前に読み直した件数を、オフは止める旨を出す。2つのボタンは自分で置く（上の確かめと同じ） */}
      <Dialog
        open={deliveryConfirm !== null}
        onClose={closeDeliveryConfirm}
        title={deliveryConfirm?.kind === 'off' ? DELIVERY_OFF_CONFIRM_TITLE : DELIVERY_ON_CONFIRM_TITLE}
        description={
          deliveryConfirm?.kind === 'on'
            ? deliveryOnConfirmMessage(deliveryConfirm.count)
            : DELIVERY_OFF_CONFIRM_MESSAGE
        }
      >
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={saving} onClick={closeDeliveryConfirm}>
            戻る
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="w-full font-acumin"
            disabled={saving}
            onClick={() => void confirmDelivery()}
          >
            {deliveryConfirm?.kind === 'off' ? 'オフにする' : 'オンにする'}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
