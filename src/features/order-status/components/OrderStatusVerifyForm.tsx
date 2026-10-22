'use client';
// File: src/features/order-status/components/OrderStatusVerifyForm.tsx

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { TextField } from '@/components/ui/TextField/TextField';
import { submitOrderStatusLastFour } from '@/features/order-status/status-client';
import { ORDER_STATUS_TEXT as TEXT, ORDER_STATUS_ERROR_MESSAGES as ERR } from '@/lib/orders/status/status-messages';
import { parseOrderStatusLastFour } from '@/lib/orders/status/status-phone';
import type { OrderStatusErrorResponse, OrderStatusVerification, OrderStatusVerifyResponse } from '@/lib/orders/status/status-types';

export function OrderStatusVerifyForm({ token, onVerified, onUnavailable }: {
  token: string; onVerified: (expiresAt: string) => void; onUnavailable: (value: OrderStatusVerification) => void;
}): React.JSX.Element {
  const sending = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending.current) return;
    const input = event.currentTarget.elements.namedItem('lastFour');
    const field = input instanceof HTMLInputElement ? input : null;
    const lastFour = parseOrderStatusLastFour(field?.value);
    if (!lastFour) { setMessage(ERR.ORDER_STATUS_INPUT_INVALID); return; }
    sending.current = true; setPending(true); setMessage(null); setVerified(false);
    try {
      const response = await submitOrderStatusLastFour(token, lastFour);
      const body = await response.json() as OrderStatusVerifyResponse | OrderStatusErrorResponse;
      if (!mounted.current) return;
      if (response.ok && 'ok' in body && body.ok && Number.isFinite(Date.parse(body.expiresAt))) {
        if (field) field.value = '';
        setVerified(true); onVerified(body.expiresAt);
      } else {
        const error = body as OrderStatusErrorResponse;
        if (error.verifiable === false && (error.reason === 'locked' || error.reason === 'expired' || error.reason === 'unavailable')) {
          const code = error.reason === 'locked' ? 'ORDER_STATUS_LOCKED' : error.reason === 'expired' ? 'ORDER_STATUS_EXPIRED' : 'ORDER_STATUS_UNAVAILABLE';
          setMessage(ERR[code]); onUnavailable({ verifiable: false, reason: error.reason });
        } else {
          setMessage(response.status === 403 ? ERR.ORDER_STATUS_FORBIDDEN : ERR[error.code] ?? ERR.ORDER_STATUS_FAILED);
        }
      }
    } catch {
      if (mounted.current) setMessage(ERR.ORDER_STATUS_FAILED);
    } finally {
      sending.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section className="border border-black/10 p-5 sm:p-8 space-y-4 min-w-0 break-words">
      <h2>{TEXT.verify.heading}</h2>
      <p>{TEXT.verify.description}</p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField name="lastFour" label={TEXT.verify.label} helperText={TEXT.verify.hint} errorText={message ?? undefined}
          type="text" inputMode="numeric" autoComplete="off" maxLength={64} placeholder={TEXT.verify.placeholder} disabled={pending} />
        <Button type="submit" disabled={pending}>{pending ? TEXT.verify.submitting : TEXT.verify.submit}</Button>
      </form>
      <LiveMessage politeness="status">{verified ? TEXT.verify.verified : null}</LiveMessage>
    </section>
  );
}
