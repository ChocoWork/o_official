// File: src/features/order-status/components/OrderStatusGuidance.tsx
import { Button } from '@/components/ui/Button/Button';
import { ORDER_STATUS_TEXT as TEXT } from '@/lib/orders/status/status-messages';

export function OrderStatusGuidance({ access, orderId, orderNumber }: { access: 'none' | 'verified' | 'member'; orderId: string; orderNumber: string }): React.JSX.Element {
  if (access === 'member') {
    return (
      <section className="border border-black/10 p-5 sm:p-8 space-y-4 min-w-0 break-words">
        <h2>{TEXT.owner.heading}</h2>
        <p>{TEXT.owner.description}</p>
        <Button href={TEXT.owner.href(orderId)} variant="secondary">{TEXT.owner.linkLabel}</Button>
      </section>
    );
  }
  return (
    <section className="border border-black/10 p-5 sm:p-8 space-y-4 min-w-0 break-words">
      <h2>{TEXT.guest.heading}</h2>
      <p>{TEXT.guest.registerDescription}</p>
      <Button href={TEXT.guest.registerHref} variant="secondary">{TEXT.guest.registerLabel}</Button>
      <p>{TEXT.guest.contactDescription}</p>
      <Button href={TEXT.guest.contactHref(orderNumber)} variant="secondary">{TEXT.guest.contactLabel}</Button>
    </section>
  );
}
