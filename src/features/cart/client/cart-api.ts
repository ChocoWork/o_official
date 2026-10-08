import { getCsrfTokenFromCookie, refreshSessionOnce } from '@/lib/client-fetch';
import { CART_OPTION_NAMES, type CartJson } from '@/features/cart/types/cart-json';
import type { Item } from '@/types/item';

/** カートの画面・決済の画面が使う明細の形（今の画面の部品の形。本計画の決め事 P8） */
export type CartEntry = {
  id: string;
  item_id: number;
  variant_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  fulfillment?: 'stock' | 'backorder' | null;
  items: { id: number; name: string; price: number; image_url: string; category?: string } | null;
};

export function toCartEntries(cart: CartJson): CartEntry[] {
  return cart.items.map((line) => ({
    id: line.key,
    item_id: line.product_id,
    variant_id: line.variant_id,
    quantity: line.quantity,
    color: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.color)?.value ?? null,
    size: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.size)?.value ?? null,
    fulfillment: line.fulfillment,
    items: { id: line.product_id, name: line.product_title, price: line.price, image_url: line.image ?? '' },
  }));
}

/**
 * カート・お気に入りの窓口へ送る（本計画の決め事 P9）。読める CSRF の Cookie がある時（会員）だけ合言葉を付ける。
 * 401 auth_expired と CSRF の 403 は、印を1回だけ新しくして送り直す。ゲストには印の更新を呼ばない。
 *
 * clientFetch を使わないのは、書き込み（POST）で読める CSRF の Cookie が無いと印の更新を先に呼ぶため。
 * ゲストはもともと Cookie が無いので、カートを触るたびに印の更新（/api/auth/refresh）が走ってしまう。
 */
export async function sendShoppingRequest(endpoint: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const send = () => {
    const headers = new Headers(init.headers);
    if (method !== 'GET' && method !== 'HEAD') {
      const csrfToken = getCsrfTokenFromCookie();
      if (csrfToken) {
        headers.set('x-csrf-token', csrfToken);
      }
    }
    return fetch(endpoint, { ...init, method, headers, credentials: 'same-origin', cache: 'no-store' });
  };

  const first = await send();
  if (first.status !== 401 && first.status !== 403) {
    return first;
  }
  const body = (await first.clone().json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  const authExpired = first.status === 401 && body?.error === 'auth_expired';
  const csrfRejected = first.status === 403 && body?.reason === 'CSRF validation failed';
  if (!authExpired && !csrfRejected) {
    return first;
  }
  return (await refreshSessionOnce()) === 'refreshed' ? send() : first;
}

export async function fetchCartJson(): Promise<CartJson> {
  const response = await sendShoppingRequest('/api/cart');
  if (!response.ok) {
    throw new Error('カートの取得に失敗しました');
  }
  return (await response.json()) as CartJson;
}

export type CartPostResult = { ok: true; body: unknown } | { ok: false; status: number; description: string };

export async function postCart(
  endpoint: '/api/cart/add' | '/api/cart/change',
  payload: unknown,
  fallbackDescription: string,
): Promise<CartPostResult> {
  const response = await sendShoppingRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, body };
  }
  const description = typeof (body as { description?: unknown } | null)?.description === 'string'
    ? (body as { description: string }).description
    : fallbackDescription;
  return { ok: false, status: response.status, description };
}

/** 選んだ色・サイズのバリアントの番号（比べ方は商品詳細の DeliveryNote と同じ） */
export function findVariantId(
  availability: Item['variantAvailability'],
  color: string | null,
  size: string | null,
): number | null {
  const match = availability?.find(
    (entry) => (entry.colorName ?? '') === (color ?? '') && (entry.sizeLabel ?? '') === (size ?? ''),
  );
  return match?.variantId ?? null;
}
