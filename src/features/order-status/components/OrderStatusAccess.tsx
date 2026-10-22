'use client';
// File: src/features/order-status/components/OrderStatusAccess.tsx

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { useLogin } from '@/contexts/LoginContext';
import { OrderStatusGuidance } from '@/features/order-status/components/OrderStatusGuidance';
import { OrderStatusPrivate } from '@/features/order-status/components/OrderStatusPrivate';
import { OrderStatusVerifyForm } from '@/features/order-status/components/OrderStatusVerifyForm';
import { fetchOrderStatusPrivate } from '@/features/order-status/status-client';
import { SESSION_EXPIRED_EVENT } from '@/lib/client-fetch';
import type { PublicCustomerOrderReturn } from '@/lib/orders/customer-order-view-types';
import { ORDER_STATUS_TEXT as TEXT, ORDER_STATUS_ERROR_MESSAGES as ERR } from '@/lib/orders/status/status-messages';
import type { OrderStatusErrorCode, OrderStatusPrivateResponse, OrderStatusVerification } from '@/lib/orders/status/status-types';

type AccessState = {
  response: OrderStatusPrivateResponse | null; loading: boolean; error: OrderStatusErrorCode | null;
  context?: { isLoggedIn: boolean; orderId: string };
};
const LOADING: AccessState = { response: null, loading: true, error: null };

export function OrderStatusAccess({ token, orderId, orderNumber, publicReturns }: {
  token: string; orderId: string; orderNumber: string; publicReturns: readonly PublicCustomerOrderReturn[];
}): React.JSX.Element {
  const { isLoggedIn, isAuthResolved } = useLogin();
  const [state, setState] = useState<AccessState>(LOADING);
  const [verifiedNotice, setVerifiedNotice] = useState(false);
  const readAgain = useRef<(() => void) | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function invalidate(): void {
      generation.current += 1;
      controller?.abort();
      clearTimeout(timer);
      setState(LOADING);
    }
    async function read(): Promise<void> {
      invalidate();
      if (!isAuthResolved) return;
      controller = new AbortController();
      const current = generation.current;
      const signal = controller.signal;
      try {
        const response = await fetchOrderStatusPrivate(token, signal);
        const body = await response.json() as OrderStatusPrivateResponse;
        if (!alive || current !== generation.current || signal.aborted) return;
        if (response.status === 401 && body.access === 'none') {
          setState({ response: body, loading: false, error: 'ORDER_STATUS_AUTH_REQUIRED' });
          return;
        }
        if (!response.ok) {
          const error = response.status === 503 ? 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE' : response.status === 404 ? 'ORDER_STATUS_NOT_FOUND' : 'ORDER_STATUS_FAILED';
          setState({ response: null, loading: false, error });
          return;
        }
        if (body.access !== 'member' && body.access !== 'verified' && body.access !== 'none') throw new Error('ORDER_STATUS_FAILED');
        if (body.access === 'verified') {
          const remaining = Date.parse(body.expiresAt) - Date.now();
          // 既に過ぎた返事を画面へ戻さず、即時再読込のループも作らない。
          if (!Number.isFinite(remaining) || remaining <= 0) {
            setState({ response: { access: 'none', verifiable: false, reason: 'expired' }, loading: false, error: null });
            return;
          }
          timer = setTimeout(() => { void read(); }, remaining);
        }
        setState({ response: body, loading: false, error: null, context: { isLoggedIn, orderId } });
      } catch {
        if (alive && current === generation.current && !signal.aborted) setState({ response: null, loading: false, error: 'ORDER_STATUS_FAILED' });
      }
    }
    const reload = () => { void read(); };
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    readAgain.current = reload;
    reload();
    window.addEventListener(SESSION_EXPIRED_EVENT, reload);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false; generation.current += 1; controller?.abort(); clearTimeout(timer);
      readAgain.current = null;
      window.removeEventListener(SESSION_EXPIRED_EVENT, reload);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, orderId, isAuthResolved, isLoggedIn]);

  // ログイン状態は認可には使わず、読取時から文脈が変わった答えを描画する前に捨てる。
  const currentContext = isAuthResolved && state.context?.isLoggedIn === isLoggedIn && state.context.orderId === orderId;
  const response = state.response?.access !== 'none' && !currentContext ? null : state.response;
  const access = response?.access ?? 'none';
  const verification = response?.access === 'none' ? response : null;
  const unavailableCode = verification && !verification.verifiable
    ? verification.reason === 'locked' ? 'ORDER_STATUS_LOCKED' : verification.reason === 'expired' ? 'ORDER_STATUS_EXPIRED' : 'ORDER_STATUS_UNAVAILABLE'
    : null;
  const onUnavailable = (value: OrderStatusVerification) => { setState({ response: { access: 'none', ...value }, loading: false, error: null }); };
  return (
    <div className="space-y-6 min-w-0 break-words">
      <LiveMessage politeness="status">{state.loading ? TEXT.verify.loadingPrivate : verifiedNotice && access !== 'none' ? TEXT.verify.verified : null}</LiveMessage>
      <LiveMessage>{state.error ? ERR[state.error] : null}</LiveMessage>
      <LiveMessage>{unavailableCode ? ERR[unavailableCode] : null}</LiveMessage>
      {response && response.access !== 'none' ? <OrderStatusPrivate data={response.data} publicReturns={publicReturns} /> : null}
      {verification?.verifiable ? <OrderStatusVerifyForm token={token} onVerified={() => { setVerifiedNotice(true); readAgain.current?.(); }} onUnavailable={onUnavailable} /> : null}
      {!state.loading && access === 'none' ? <Button href={TEXT.login.href} variant="secondary">{TEXT.login.label}</Button> : null}
      {!state.loading && state.error && state.error !== 'ORDER_STATUS_AUTH_REQUIRED' ? <Button type="button" variant="secondary" onClick={() => readAgain.current?.()}>{TEXT.reload}</Button> : null}
      <OrderStatusGuidance access={access} orderId={orderId} orderNumber={orderNumber} />
    </div>
  );
}
