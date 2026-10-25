// File: src/lib/orders/shipment-slips/bundling.ts
// 同梱できる注文かの判定（G-3 / FREQ-532）。画面の候補の絞り込み用で、唯一の正は DB の private.group_g_bundle_verdict。
// 評価の順（配送先の不足 → お客様の違い → 配送先の違い）と比べ方（前後の空白だけを落とし、建物は空と無しを同じ空として比べる）を DB と同じにする。

export type BundleShipTo = {
  fullName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string | null;
  phone: string;
};

export type BundleOrder = {
  /** 会員の注文はその会員の ID、ゲストの注文は null */
  userId: string | null;
  email: string | null;
  shipTo: BundleShipTo;
};

export type BundleVerdict = null | 'address_incomplete' | 'customer_mismatch' | 'address_mismatch';

/** メールアドレスの比べ方（前後の空白を落として小文字）。空は null */
export function normalizeBundleEmail(email: string | null): string | null {
  if (email === null) return null;
  const normalized = email.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

/** DB の btrim と同じく、前後の半角の空白だけを落とす（タブや全角の空白は落とさない） */
function trimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/** 建物以外の6項目とメールが空でない注文か（DB の order_has_required_shipping_fields と同じ） */
function hasRequiredFields(order: BundleOrder): boolean {
  const { fullName, postalCode, prefecture, city, address, phone } = order.shipTo;
  return normalizeBundleEmail(order.email) !== null
    && [fullName, postalCode, prefecture, city, address, phone].every((field) => trimSpaces(field) !== '');
}

/** 配送先7項目の比べる値。建物は空と無しを同じ空として扱う */
function addressKey(order: BundleOrder): string {
  const { fullName, postalCode, prefecture, city, address, building, phone } = order.shipTo;
  return JSON.stringify([
    trimSpaces(fullName), trimSpaces(postalCode), trimSpaces(prefecture), trimSpaces(city),
    trimSpaces(address), trimSpaces(building ?? ''), trimSpaces(phone),
  ]);
}

/** 会員だけで同じ会員、またはゲストだけで同じメールアドレスか（会員同士のメールの違いは問わない。別の会員をメールで結ばない） */
function isSameCustomer(orders: readonly BundleOrder[]): boolean {
  if (orders.every((order) => order.userId !== null)) return new Set(orders.map((order) => order.userId)).size === 1;
  if (orders.every((order) => order.userId === null)) return new Set(orders.map((order) => normalizeBundleEmail(order.email))).size === 1;
  return false;
}

/**
 * 同梱できるかの判定。できる時は null、できない時は最初に当たる理由。
 * 順は DB と同じで、1つも無い・配送先の足りない注文がある → address_incomplete、お客様が同じでない → customer_mismatch、
 * 配送先7項目が完全一致でない → address_mismatch。
 */
export function bundleVerdict(orders: readonly BundleOrder[]): BundleVerdict {
  if (orders.length === 0 || !orders.every(hasRequiredFields)) return 'address_incomplete';
  if (!isSameCustomer(orders)) return 'customer_mismatch';
  if (new Set(orders.map(addressKey)).size > 1) return 'address_mismatch';
  return null;
}
