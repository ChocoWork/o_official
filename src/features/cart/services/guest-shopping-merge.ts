import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { hashGuestShoppingToken, type GuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';

export type GuestMergeResult =
  | { ok: true; cartLinesMoved: number; cartLinesDropped: number; wishlistLinesMoved: number }
  | { ok: false };

type MergeRow = { cart_lines_moved: number; cart_lines_dropped: number; wishlist_lines_moved: number };

/**
 * ゲストのカートとお気に入りを会員の分へ合わせる（設計書第5章）。ログインを止めないため、失敗しても投げない。
 * 印そのものは DB にも監査の記録にも渡さない（ハッシュと件数だけ）。
 */
export async function mergeGuestShoppingIntoMember(
  supabase: SupabaseClient,
  params: { userId: string } & GuestShoppingTokens,
): Promise<GuestMergeResult> {
  if (!params.cartToken && !params.wishlistToken) {
    return { ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0 };
  }
  let result: Extract<GuestMergeResult, { ok: true }>;
  try {
    const { data, error } = await supabase.rpc('merge_guest_into_member', {
      _user_id: params.userId,
      _cart_token_hash: params.cartToken ? await hashGuestShoppingToken(params.cartToken) : null,
      _wishlist_token_hash: params.wishlistToken ? await hashGuestShoppingToken(params.wishlistToken) : null,
    });
    if (error) {
      throw error;
    }
    const row = ((data ?? []) as MergeRow[])[0] ?? { cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 };
    result = {
      ok: true as const,
      cartLinesMoved: Number(row.cart_lines_moved),
      cartLinesDropped: Number(row.cart_lines_dropped),
      wishlistLinesMoved: Number(row.wishlist_lines_moved),
    };
  } catch (error) {
    // DB の関数にはハッシュしか渡らずエラーの文に印は入らないため、原因の code と message を記録する。
    const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    const message = error instanceof Error
      ? error.message
      : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : 'merge failed';
    console.error('Failed to merge guest shopping into member:', { ...(code === undefined ? {} : { code }), message });
    try {
      await logAudit({
        action: 'cart.merge',
        outcome: 'error',
        actor_id: params.userId,
        detail: code ? `${code}: ${message}` : message,
      });
    } catch {
      console.error('Failed to log cart merge audit');
    }
    return { ok: false };
  }

  // 偽の Cookie で監査を水増しさせないため、移した・移さなかった件数がすべて0なら記録しない。
  if (result.cartLinesMoved === 0 && result.cartLinesDropped === 0 && result.wishlistLinesMoved === 0) {
    return result;
  }
  // DB の処理は済んでいるため、監査の失敗で合わせる処理を失敗扱いにしない。
  try {
    await logAudit({
      action: 'cart.merge',
      outcome: 'success',
      actor_id: params.userId,
      metadata: {
        cart_lines_moved: result.cartLinesMoved,
        cart_lines_dropped: result.cartLinesDropped,
        wishlist_lines_moved: result.wishlistLinesMoved,
      },
    });
  } catch {
    console.error('Failed to log cart merge audit');
  }
  return result;
}
