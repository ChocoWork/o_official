'use client';
// File: src/app/order-status/[token]/error.tsx

import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { ORDER_STATUS_TEXT, ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';

export default function OrderStatusError({ retry }: { error: Error & { digest?: string }; retry: () => void }): React.JSX.Element {
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <LiveMessage>{ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED}</LiveMessage>
      <Button type="button" variant="secondary" onClick={retry}>{ORDER_STATUS_TEXT.reload}</Button>
    </main>
  );
}
