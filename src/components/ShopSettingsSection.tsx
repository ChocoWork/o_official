'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';
import { clientFetch } from '@/lib/client-fetch';
import { REFUND_FAILURE_MESSAGES } from '@/lib/orders/refund/refund-messages';
import type { ShopSettings, ShopSettingToggle, UpdateShopSettingsRequest } from '@/lib/orders/refund/refund-types';
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

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; settings: ShopSettings };

type SettingsResult = { ok: true; settings: ShopSettings } | { ok: false };

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

/**
 * 窓口の答え（{ data: ShopSettings }）を読む。断られた・通信が切れた・答えの形が違う、はどれも失敗にする。
 * 画面は理由を分けず、読み込みと保存で1つずつの文を出す（窓口の英語の文を出さないため）。
 */
async function readSettings(send: () => Promise<Response>): Promise<SettingsResult> {
  try {
    const response = await send();
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as { data?: unknown };
    return isShopSettings(body.data) ? { ok: true, settings: body.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const loadSettings = () => readSettings(() => clientFetch(SETTINGS_URL, { cache: 'no-store' }));

// 書き込みは clientFetch が CSRF の印（x-csrf-token）を付ける
const saveSettings = (request: UpdateShopSettingsRequest) =>
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

/**
 * ショップの設定の画面（グループ E-2 設計書 9-6。店長だけ）。「自動の返金」の2つのトグルを出し、切り替えるたびに保存する。
 * 自動の取消②をオンにする時だけ、保存の前に確かめの画面を出す（差が小さくても注文が取り消されるため）。
 * 保存の直前に設定を読み直し、変えない方のトグルは読み直した値を送る（開きっぱなしの古い画面が、
 * 別のタブで変えた値を黙って戻さないため）。各トグルの下に、最後に変えた人と日本時間の時刻を出す。
 */
export default function ShopSettingsSection() {
  const titleId = useId();
  const groupId = useId();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadSettings().then((result) => {
      if (active) {
        setLoad(result.ok ? { kind: 'ready', settings: result.settings } : { kind: 'error' });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const save = async (key: ToggleKey, enabled: boolean) => {
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
      setLoad({ kind: 'ready', settings: result.settings });
      setNotice(SAVED_MESSAGE);
      return;
    }
    setSaveError(REFUND_FAILURE_MESSAGES.settings_update);
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

  return (
    <section aria-labelledby={titleId} aria-busy={saving} className="max-w-3xl space-y-6">
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
        <section aria-labelledby={groupId} className="space-y-2 border border-black/15 p-4">
          <h3 id={groupId} className="font-acumin lk-text-3xs tracking-widest text-[#474747]">
            自動の返金
          </h3>
          <ul className="divide-y divide-black/10">
            {TOGGLES.map((toggle) => {
              const state = load.settings[toggle.key];
              return (
                <li key={toggle.key} className="space-y-1 py-3">
                  <SwitchToggle
                    label={toggle.name}
                    checked={state.enabled}
                    disabled={saving}
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

      {/* 保存の知らせ。後から差し込むと読み上げられない環境が多いので、入れ物は最初から置く（空の間は場所を取らない） */}
      <p role="status" aria-live="polite" className={cn('font-acumin lk-text-sm text-[#474747]', !notice && 'sr-only')}>
        {notice}
      </p>

      {saveError ? (
        <p role="alert" className="font-acumin lk-text-sm text-red-700">
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
