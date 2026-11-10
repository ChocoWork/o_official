'use client';

import { useEffect, useState } from 'react';
import { callReturnApi } from '@/lib/orders/returns/return-client';

/**
 * 値段の見込みの窓口（受け取り・返金の見込み。FREQ-642）を呼ぶ。額は必ずサーバーの計画から出し、画面で計算しない。
 * 選びが変わるたびに DEBOUNCE_MS 待ってから1回だけ呼び、待つ間と通信中は loading。選びがまた変わった後に届いた古い答えは捨てる。
 * url か body が null の時は何もしない（idle）。誤りは文つきの error（額は出さない）。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-022
 */
export const ESTIMATE_DEBOUNCE_MS = 300;

export type UnitPricingEstimateState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; estimate: T }
  | { status: 'error'; message: string };

type Settled<T> = { key: string; result: Exclude<UnitPricingEstimateState<T>, { status: 'idle' | 'loading' }> };

function readEstimate<T>(body: unknown): T | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as T) : null;
}

export function useUnitPricingEstimate<T>(
  url: string | null,
  body: object | null,
  fallbackMessage: string,
): UnitPricingEstimateState<T> {
  const key = url === null || body === null ? null : `${url}\n${JSON.stringify(body)}`;
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    if (key === null || url === null || body === null) return;
    // 選びがまた変わった（または閉じた）後に届いた答えは捨てる
    let current = true;
    const timer = setTimeout(() => {
      void callReturnApi(url, body, fallbackMessage).then((call) => {
        if (!current) return;
        if (call.kind === 'ok') {
          const estimate = readEstimate<T>(call.body);
          setSettled({ key, result: estimate ? { status: 'ready', estimate } : { status: 'error', message: fallbackMessage } });
        } else {
          setSettled({ key, result: { status: 'error', message: call.kind === 'unknown' ? fallbackMessage : call.message } });
        }
      });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // key は url と body の中身そのもの（body は描画のたびに作り直されるので、依存には key を使う）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (key === null) return { status: 'idle' };
  return settled?.key === key ? settled.result : { status: 'loading' };
}
