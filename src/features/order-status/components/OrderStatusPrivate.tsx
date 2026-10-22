// File: src/features/order-status/components/OrderStatusPrivate.tsx
import { OrderReturnPrivateDetails } from '@/features/account/returns/OrderReturnsSection';
import type { CustomerOrderPrivateView, PublicCustomerOrderReturn } from '@/lib/orders/customer-order-view-types';
import { ORDER_STATUS_TEXT as TEXT } from '@/lib/orders/status/status-messages';

function trackingHref(value: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined; }
  catch { return undefined; }
}

export function OrderStatusPrivate({ data, publicReturns }: { data: CustomerOrderPrivateView; publicReturns: readonly PublicCustomerOrderReturn[] }): React.JSX.Element {
  const returnDetails = data.returns.flatMap((details) => {
    const orderReturn = publicReturns.find((item) => item.id === details.id);
    if (!orderReturn) return [];
    const showHowTo = (orderReturn.customerStatus === 'accepted' || orderReturn.customerStatus === 'partially_received')
      && (orderReturn.returnMethod === 'not_required' || details.returnAddress !== null);
    const tracked = details.sentBack.some((item) => Number.isInteger(item.index) && item.index >= 0 && orderReturn.sentBack[item.index] && item.trackingNumber);
    return showHowTo || tracked ? [{ orderReturn, details }] : [];
  });
  const shipments = data.shipments.filter((item) => item.trackingNumber);
  return (
    <div className="space-y-6 min-w-0 break-words">
      <section className="border border-black/10 p-5 sm:p-8 space-y-4">
        <h2>{TEXT.private.shippingHeading}</h2>
        <dl className="space-y-2">
          {[[TEXT.private.name, data.shipping.fullName], [TEXT.private.postalCode, data.shipping.postalCode], [TEXT.private.address, data.shipping.address], [TEXT.private.phone, data.shipping.phone]].map(([label, value]) => (
            <div key={label}><dt className="account-label">{label}</dt><dd className="account-value break-words">{value || TEXT.private.empty}</dd></div>
          ))}
        </dl>
      </section>
      <section className="border border-black/10 p-5 sm:p-8 space-y-4">
        <h2>{TEXT.private.contactHeading}</h2>
        <dl><dt className="account-label">{TEXT.private.email}</dt><dd className="account-value">{data.contactEmail || TEXT.private.empty}</dd></dl>
      </section>
      <section className="border border-black/10 p-5 sm:p-8 space-y-4">
        <h2>{TEXT.private.paymentHeading}</h2><p className="account-value">{data.paymentMethod || TEXT.private.empty}</p>
      </section>
      {shipments.length > 0 ? (
        <section className="border border-black/10 p-5 sm:p-8 space-y-4">
          <h2>{TEXT.private.trackingHeading}</h2>
          {shipments.map((shipment) => {
            const href = trackingHref(shipment.trackingUrl);
            return <div key={shipment.id} className="space-y-2"><h3>{TEXT.shipment.heading(shipment.number)}</h3>
              <p>{TEXT.private.trackingNumber(shipment.trackingNumber ?? '')}</p>
              {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{TEXT.shipment.trackingLink}</a> : null}
            </div>;
          })}
        </section>
      ) : null}
      {returnDetails.length > 0 ? (
        <section className="border border-black/10 p-5 sm:p-8 space-y-4">
          <h2>{TEXT.private.returnsHeading}</h2>
          {returnDetails.map(({ orderReturn, details }) => <OrderReturnPrivateDetails key={details.id} orderReturn={orderReturn} details={details} />)}
        </section>
      ) : null}
    </div>
  );
}
