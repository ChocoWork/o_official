import type { CustomerOrderPrivateView } from '@/lib/orders/customer-order-view-types';

/**
 * 注文の状況の頁（グループ E-5。共通の約束 C-2）の土台の型。型だけなので、画面からも読める。
 * OrderStatusLink はサーバーの中だけで使い、Client Component の props へ渡さない
 * （お客様の番号・失敗の数・期限の DB の値をブラウザへ出さないため）。
 */
export type OrderStatusLink = {
  orderId: string;
  customerId: string | null;
  verifyUntil: string | null;
  failedAttempts: number;
  phoneAvailable: boolean;
};

/** 電話番号の下4桁で確かめられない理由。期限切れ → 利用不可（電話が無い） → ロックの順で決まる */
export type OrderStatusUnavailableReason = 'expired' | 'unavailable' | 'locked';

export type OrderStatusVerification =
  | { verifiable: true; reason: null }
  | { verifiable: false; reason: OrderStatusUnavailableReason };

/** DB の確かめの結果。比較は DB の中で済み、TS は電話番号も入力の下4桁も持ち帰らない */
export type OrderStatusPhoneResult = {
  result: 'ok' | 'mismatch' | 'locked' | 'unavailable' | 'expired';
  verifyUntil: string | null;
  failedAttempts: number;
};

/** 確認済みの印（Cookie）の中身。生のトークンも電話番号も入れない */
export type OrderStatusSession = {
  purpose: 'order_status';
  orderId: string;
  tokenHashPrefix: string;
  iat: number;
  exp: number;
};

export type OrderStatusPrivateResponse =
  | ({ access: 'none' } & OrderStatusVerification)
  | { access: 'member'; data: CustomerOrderPrivateView; expiresAt: null }
  | { access: 'verified'; data: CustomerOrderPrivateView; expiresAt: string };

export type OrderStatusVerifyResponse = { ok: true; expiresAt: string };

export type OrderStatusErrorCode =
  | 'ORDER_STATUS_NOT_FOUND'
  | 'ORDER_STATUS_INPUT_INVALID'
  | 'ORDER_STATUS_MISMATCH'
  | 'ORDER_STATUS_LOCKED'
  | 'ORDER_STATUS_UNAVAILABLE'
  | 'ORDER_STATUS_EXPIRED'
  | 'ORDER_STATUS_RATE_LIMITED'
  | 'ORDER_STATUS_FORBIDDEN'
  | 'ORDER_STATUS_AUTH_REQUIRED'
  | 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE'
  | 'ORDER_STATUS_FAILED';

export type OrderStatusErrorResponse = {
  error: string;
  code: OrderStatusErrorCode;
  verifiable?: boolean;
  reason?: OrderStatusUnavailableReason | null;
};
