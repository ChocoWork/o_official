'use client';

// File: src/hooks/useOrderAttention.ts
// 要対応・要確認の欄（設計書 5-2）の読み込みと操作。旧 admin/page.tsx の fetchAttention・runAttentionAction・handle* をそのまま移した（G-4 / FREQ-539-AC-05）。
// 成功したら欄を読み直し、呼び手が渡す onChanged（一覧の読み直し）も呼ぶ。断られたら理由を欄のすぐ下に出す（行は残し、押し直せる）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OrderCancelValues } from '@/components/OrderCancelDialog';
import { clientFetch } from '@/lib/client-fetch';
import {
  ATTENTION_NETWORK_ERROR_MESSAGE,
  RATE_LIMITED_MESSAGE,
  readSafeOrderActionError,
  STRIPE_UNAVAILABLE_MESSAGE,
} from '@/lib/orders/admin-orders/admin-order-client';
import type { OrderAttention } from '@/lib/orders/order-payment-types';

export type AdminOrderAttention = OrderAttention & {
  emailSending?: { paused: boolean; reasonLabel: string | null } | null;
};

const ATTENTION_LOAD_FAILED_MESSAGE = '要対応・要確認を読み込めませんでした。';

type UseOrderAttentionOptions = {
  /** 権限と2要素認証が済んでいる時だけ読む */
  enabled: boolean;
  /** 操作が成功した後に、欄と一緒に読み直す物（一覧の頁の表）。無ければ欄だけ */
  onChanged?: () => void | Promise<void>;
};

export function useOrderAttention({ enabled, onChanged }: UseOrderAttentionOptions) {
  const [attention, setAttention] = useState<AdminOrderAttention | null>(null);
  // 欄を読めなかった理由（errorBanner）と、操作が断られた理由（errorMessage）。旧い画面では1つの欄に出していたので、同時には1つだけ持つ
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [processingIds, setProcessingIds] = useState<string[]>([]);

  // 操作を始めた時点の onChanged が古い条件を閉じ込めていても、返事の後は今の関数を呼ぶ
  const onChangedRef = useRef(onChanged);
  useLayoutEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // 要対応・要確認（設計書 5-2）。サイドナビと KPI 画面の件数にも使う。
  // 読めなかったときに欄を出さないだけだと「未処理なし」に見え、開いている要対応を見落とすので、その旨を出す
  const reload = useCallback(async () => {
    try {
      const response = await clientFetch('/api/admin/order-attention', { cache: 'no-store' });
      if (!response.ok) {
        await response.arrayBuffer?.().catch(() => undefined);
        throw new Error(`Failed to fetch order attention: ${response.status}`);
      }
      const json = (await response.json()) as { data?: Partial<AdminOrderAttention> };
      const data = json.data;
      if (!data || !Array.isArray(data.exceptions) || !Array.isArray(data.reviews) || !data.counts) {
        throw new Error('Unexpected order attention response');
      }
      setAttention(data as AdminOrderAttention);
      setErrorMessage(null);
      setErrorBanner(null);
    } catch (error) {
      console.error('Failed to fetch order attention:', error);
      setErrorMessage(null);
      setErrorBanner(ATTENTION_LOAD_FAILED_MESSAGE);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void reload();
  }, [enabled, reload]);

  /**
   * 要対応・要確認の操作。成功したら欄と一覧を読み直す。断られたら理由を欄のすぐ下に出す（行は残し、押し直せる）。
   * 送っている間は id を操作中に置き、成功でも失敗でも finally で外す。
   */
  const runAttentionAction = async (
    id: string,
    request: () => Promise<Response>,
    successMessage: string,
    failure: { readableStatuses?: readonly number[]; rateLimitedMessage?: string } = {},
  ) => {
    try {
      setNoticeMessage(null);
      setErrorMessage(null);
      setErrorBanner(null);
      setProcessingIds((prev) => [...prev, id]);

      const response = await request();
      if (!response.ok) {
        if (response.status === 403) {
          await response.arrayBuffer?.().catch(() => undefined);
          throw new Error('この操作の権限がありません。');
        }
        if (response.status === 503) {
          // 回数の制限の 503 は no-store。本文を読まずに捨てるとブラウザが要求を開いたまま残す
          void response.arrayBuffer?.().catch(() => {});
          throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
        }
        if (response.status === 429 && failure.rateLimitedMessage) {
          // 回数の制限の 429 は no-store。本文を読まずに捨てるとブラウザが要求を開いたまま残す
          void response.arrayBuffer?.().catch(() => {});
          throw new Error(failure.rateLimitedMessage);
        }
        throw new Error(
          await readSafeOrderActionError(response, '操作に失敗しました。一覧を更新してください。', failure.readableStatuses),
        );
      }

      setNoticeMessage(successMessage);
      await Promise.all([reload(), onChangedRef.current?.()]);
    } catch (error) {
      console.error('Failed to update order attention:', error);
      // 通信が切れた（fetch の TypeError。英語の文）時は日本語の文にする。要対応・要確認のどの操作も、この catch を通る
      setErrorBanner(null);
      setErrorMessage(
        error instanceof TypeError ? ATTENTION_NETWORK_ERROR_MESSAGE : error instanceof Error ? error.message : '操作に失敗しました。',
      );
    } finally {
      setProcessingIds((prev) => prev.filter((itemId) => itemId !== id));
    }
  };

  const onReview = (orderId: string) =>
    void runAttentionAction(
      orderId,
      () => clientFetch(`/api/admin/orders/${orderId}/review`, { method: 'POST' }),
      '確認済みにしました。',
    );

  const onResolve = ({ exceptionId, note }: { exceptionId: string; note: string }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(note ? { note } : {}),
        }),
      '解決済みにしました。',
    );

  const onCancelAndResolve = ({ exceptionId, values }: { exceptionId: string; values: OrderCancelValues }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note: values.note,
            cancelOrder: true,
            cancelReason: values.reason,
            notifyCustomer: values.notifyCustomer,
          }),
        }),
      '注文を取り消して解決しました。',
    );

  // 配送の要対応を対応済みにする。成功したら欄と一覧を読み直し、全部閉じれば「配送」の組が消える（もう閉じてあった時も同じ）
  const onResolveDelivery = (attentionId: string) =>
    void runAttentionAction(
      attentionId,
      () =>
        clientFetch(`/api/admin/order-attention/deliveries/${attentionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      '対応済みにしました。',
      // 窓口は、見つからない（404）も日本語の文で返す。回数の制限（429）は、画面の案内（計画の C-4）にする
      { readableStatuses: [400, 404, 409], rateLimitedMessage: RATE_LIMITED_MESSAGE },
    );

  const onResolveDiscount = (orderId: string) => void runAttentionAction(orderId,
    () => clientFetch(`/api/admin/order-attention/discounts/${orderId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}), cache: 'no-store',
    }), '確認済みにしました。', { readableStatuses: [400, 404, 409], rateLimitedMessage: RATE_LIMITED_MESSAGE });

  return {
    attention,
    errorMessage,
    errorBanner,
    noticeMessage,
    processingIds,
    reload,
    onReview,
    onResolve,
    onCancelAndResolve,
    onResolveDelivery,
    onResolveDiscount,
  };
}
