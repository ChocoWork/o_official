export type ContactPrefill = {
  inquiryType?: 'product' | 'order' | 'other';
  orderNumber?: string;
};

/** URL は初期値だけに使い、重複や形式の合わない項目は個別に無視する。 */
export function parseContactPrefill(search: string): ContactPrefill {
  const params = new URLSearchParams(search);
  const types = params.getAll('type');
  const orders = params.getAll('order');
  const prefill: ContactPrefill = {};

  if (types.length === 1) {
    const inquiryType = types[0];
    if (inquiryType === 'product' || inquiryType === 'order' || inquiryType === 'other') {
      prefill.inquiryType = inquiryType;
    }
  }

  if (orders.length === 1) {
    const orderNumber = orders[0].trim().toUpperCase();
    if (/^ORD-[0-9A-F]{8}$/.test(orderNumber)) {
      prefill.orderNumber = orderNumber;
    }
  }

  return prefill;
}
