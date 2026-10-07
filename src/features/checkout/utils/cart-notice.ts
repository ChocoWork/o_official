/** 受け付けで断ったときにカート画面へ渡す、変わった明細（設計書 5-3） */
export type CartNoticeLine = { itemId: number; name: string; color: string | null; size: string | null };

export type CartNotice =
  | { kind: 'stock_changed'; message: string; lines: CartNoticeLine[] }
  | { kind: 'message'; message: string };

const STORAGE_KEY = 'checkout:cart-notice';

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isCartNoticeLine(value: unknown): value is CartNoticeLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    typeof line.itemId === 'number' &&
    typeof line.name === 'string' &&
    isNullableString(line.color) &&
    isNullableString(line.size)
  );
}

export function parseCartNotice(value: unknown): CartNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const notice = value as Record<string, unknown>;
  if (typeof notice.message !== 'string') return null;
  if (notice.kind === 'message') {
    return { kind: 'message', message: notice.message };
  }
  if (notice.kind === 'stock_changed' && Array.isArray(notice.lines) && notice.lines.every(isCartNoticeLine)) {
    return { kind: 'stock_changed', message: notice.message, lines: notice.lines };
  }
  return null;
}

/**
 * 受け付けで断った理由をカート画面へ渡す（計画の決め事 D11）。URL に商品名を載せないため sessionStorage を使う。
 * 保存できない環境（容量・設定）では案内が出ないだけで、カートはそのまま使える。
 */
export function saveCartNotice(notice: CartNotice): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(notice));
  } catch {
    // 案内を出せないだけ。カートの中身はサーバーが正しく返す
  }
}

/** カート画面が1回だけ読む。読んだら消す（読み込み直しで同じ案内を出し続けない） */
export function takeCartNotice(): CartNotice | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    return parseCartNotice(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** カートの行が案内の明細と同じか（商品・色・サイズで比べる。カートはこの組で一意） */
export function isSameCartLine(
  line: CartNoticeLine,
  row: { item_id: number; color: string | null; size: string | null },
): boolean {
  return line.itemId === row.item_id && line.color === (row.color ?? null) && line.size === (row.size ?? null);
}
