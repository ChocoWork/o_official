// File: src/app/order-status/[token]/not-found.tsx
import Link from 'next/link';
import { ORDER_STATUS_TEXT, ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';

export default function OrderStatusNotFound(): React.JSX.Element {
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <h1>{ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_NOT_FOUND}</h1>
      <Link href={ORDER_STATUS_TEXT.notFoundLink.href} className="underline">{ORDER_STATUS_TEXT.notFoundLink.label}</Link>
    </main>
  );
}
