// File: src/features/order-status/components/OrderStatusPublic.tsx
import { Fragment } from 'react';
import { OrderItemRow } from '@/features/account/components/OrderItemRow';
import { OrderReturnsSection } from '@/features/account/returns/OrderReturnsSection';
import { formatMonthDay, itemLabel } from '@/features/account/returns/return-request-model';
import type { CustomerOrderPublicView } from '@/lib/orders/customer-order-view-types';
import { PARTIALLY_SHIPPED_LABEL } from '@/lib/orders/order-progress';
import { ORDER_STATUS_TEXT as TEXT } from '@/lib/orders/status/status-messages';
import { DELIVERY_STATUS_LABELS } from '@/lib/orders/tracking/delivery-messages';

function dateText(value: string, withTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return TEXT.private.empty;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tokyo',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(date);
}

export function OrderStatusPublic({ view }: { view: CustomerOrderPublicView }): React.JSX.Element {
  const unshipped = [
    { heading: TEXT.unshipped.readyHeading, items: view.items.filter((item) => item.readyQuantity > 0).map((item) => ({ ...item, quantity: item.readyQuantity })) },
    { heading: TEXT.unshipped.inProductionHeading, items: view.items.filter((item) => item.inProductionQuantity > 0).map((item) => ({ ...item, quantity: item.inProductionQuantity })) },
  ];
  return (
    <div className="space-y-6 min-w-0 break-words">
      <header className="space-y-4">
        <h1>{TEXT.heading}</h1>
        <p className="account-value">{TEXT.orderNumber(view.orderNumber)}</p>
        <p className="account-label">{TEXT.orderDate(view.orderDate)}</p>
        <div className="flex flex-wrap gap-2">
          <span className="account-status">{view.progress.label}</span>
          {view.progress.partiallyShipped ? <span className="account-status account-status-sm">{PARTIALLY_SHIPPED_LABEL}</span> : null}
        </div>
        {view.progress.steps ? (
          <ol aria-label={TEXT.progressAriaLabel} className="flex items-start gap-1.5 pt-2 min-w-0">
            {view.progress.steps.map((step, index, steps) => (
              <Fragment key={step.key}>
                <li aria-current={step.state === 'current' ? 'step' : undefined} className="flex flex-col items-center gap-1 min-w-0">
                  <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-full border lk-text-6xs ${step.state === 'todo' ? 'border-black/25 text-[#999]' : 'border-black bg-black text-white'}`}>{index + 1}</span>
                  <span className="lk-text-2xs break-words">{step.label}</span>
                </li>
                {index < steps.length - 1 ? <li aria-hidden="true" className={`h-px flex-1 mt-3 ${step.state === 'done' ? 'bg-black' : 'bg-black/15'}`} /> : null}
              </Fragment>
            ))}
          </ol>
        ) : null}
      </header>

      {view.shipments.map((shipment) => (
        <section key={shipment.id} aria-label={TEXT.shipment.heading(shipment.number)} className="border border-black/10 p-5 sm:p-8 space-y-3 min-w-0">
          <h2>{TEXT.shipment.heading(shipment.number)}</h2>
          {shipment.deliveredAt ? (
            <div className="flex flex-wrap gap-2"><span className="account-status account-status-sm">{DELIVERY_STATUS_LABELS.delivered}</span><span>{TEXT.shipment.deliveredOn(Number.isFinite(Date.parse(shipment.deliveredAt)) ? formatMonthDay(shipment.deliveredAt) : TEXT.private.empty)}</span></div>
          ) : shipment.delivery ? <span className="account-status account-status-sm">{DELIVERY_STATUS_LABELS[shipment.delivery.status]}</span> : null}
          {shipment.delivery && !shipment.deliveredAt && (shipment.delivery.status === 'failure' || shipment.delivery.status === 'delayed') ? <p>{TEXT.shipment.problem}</p> : null}
          {shipment.delivery ? <p className="account-label">{TEXT.shipment.updatedAt(dateText(shipment.delivery.statusAt, true))}</p> : null}
          <dl className="space-y-1 lk-text-sm">
            <div className="flex flex-wrap gap-x-2"><dt>{TEXT.shipment.shippedAt}</dt><dd>{dateText(shipment.shippedAt)}</dd></div>
            {shipment.carrierLabel ? <div className="flex flex-wrap gap-x-2"><dt>{TEXT.shipment.carrier}</dt><dd>{shipment.carrierLabel}</dd></div> : null}
          </dl>
          {shipment.delivery && shipment.delivery.events.length > 0 ? (
            <div><h3>{TEXT.shipment.history}</h3><ul className="space-y-1 lk-text-sm">
              {shipment.delivery.events.map((event, index) => <li key={`${event.happenedAt}-${index}`} className="flex flex-wrap gap-x-2"><span>{DELIVERY_STATUS_LABELS[event.status]}</span><span className="account-label">{dateText(event.happenedAt, true)}</span></li>)}
            </ul></div>
          ) : null}
          <ul className="space-y-1 lk-text-sm">
            {shipment.items.map((item) => <li key={item.orderItemId}>{`${itemLabel(item.name, item.color, item.size)} × ${item.quantity}`}
              {item.lineKind === 'exchange' ? <span className="account-status account-status-sm ml-2">{TEXT.items.exchange}</span> : null}
            </li>)}
          </ul>
        </section>
      ))}

      {unshipped.map(({ heading, items }) => items.length > 0 ? (
        <section key={heading} className="border border-black/10 p-5 sm:p-8 space-y-3"><h2>{heading}</h2><ul className="space-y-1 lk-text-sm">
          {items.map((item) => <li key={item.id}>{`${itemLabel(item.name, item.color, item.size)} × ${item.quantity}`}</li>)}
        </ul></section>
      ) : null)}

      <section className="border border-black/10 p-5 sm:p-8 space-y-4"><h2>{TEXT.items.heading}</h2>
        <div className="account-order-items">{view.items.map((item) => <OrderItemRow key={item.id} item={item} readOnly />)}</div>
      </section>

      {view.refunds.length > 0 ? (
        <section className="border border-black/10 p-5 sm:p-8 space-y-4"><h2>{TEXT.refunds.heading}</h2>
          <dl className="space-y-2">{view.refunds.map((refund) => <div key={refund.id} className="flex flex-wrap justify-between gap-2">
            <dt>{refund.date}</dt><dd>{refund.amount} <span className="account-status account-status-sm">{TEXT.refunds[refund.status]}</span></dd>
          </div>)}
            {view.refunds.length >= 2 && view.refundTotal ? <div className="flex flex-wrap justify-between gap-2"><dt>{TEXT.refunds.total}</dt><dd>{view.refundTotal}</dd></div> : null}
          </dl>
        </section>
      ) : null}

      {view.returnSection ? <OrderReturnsSection orderId={view.id} section={view.returnSection} readOnly /> : null}

      <section className="border border-black/10 p-5 sm:p-8 space-y-4"><h2>{TEXT.amounts.heading}</h2>
        <dl className="space-y-2">{[[TEXT.amounts.subtotal, view.subtotalAmount], [TEXT.amounts.shipping, view.shippingAmount], [TEXT.amounts.discount, view.discountAmount], [TEXT.amounts.total, view.totalAmount]].map(([label, amount]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2"><dt className="account-label">{label}</dt><dd className="account-value">{amount}</dd></div>
        ))}</dl>
      </section>
    </div>
  );
}
