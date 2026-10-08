import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import {
  checkoutBuyerFailureResponse,
  resolveCheckoutBuyer,
  type CheckoutBuyer,
} from '@/features/checkout/services/checkout-buyer';
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import {
  clearGuestShoppingCookies,
  generateGuestShoppingToken,
  hashGuestShoppingToken,
  readGuestShoppingTokens,
  setGuestShoppingCookie,
  type GuestShoppingKind,
} from '@/features/cart/services/guest-shopping-token';
import {
  ensureOwnerRowId,
  findOwnerRowId,
  type ShoppingOwnerRef,
  type ShoppingOwnerTable,
} from '@/features/cart/services/shopping-owner.repository';

export type ShoppingContext = {
  kind: GuestShoppingKind;
  /** 今の持ち主。印のまだ無いゲストは null */
  owner: ShoppingOwnerRef | null;
  /** 回数の制限の subject。印のまだ無いゲストは null（IP だけで数える） */
  rateLimitSubject: string | null;
  /** 監査の記録に入れる持ち主の情報。印そのものは入れない */
  auditOwner: Record<string, string>;
  findOwnerId(): Promise<string | null>;
  ensureOwnerId(): Promise<string>;
  /** 応答に Cookie を付ける・消す（合わせ終えた印を消す、新しい印を付ける、書き換えで寿命を延ばす） */
  finish(response: NextResponse): NextResponse;
};

const tableOf = (kind: GuestShoppingKind): ShoppingOwnerTable => (kind === 'cart' ? 'carts' : 'wishlists');

function auditOwnerOf(owner: ShoppingOwnerRef | null): Record<string, string> {
  if (owner?.kind === 'member') return { owner: 'member', user_id: owner.userId };
  // キーに token があると maskAuditEvent が値を伏せてゲストの記録をつなげられないため、含めない。
  if (owner?.kind === 'guest') return { owner: 'guest', guest_hash_prefix: owner.tokenHash.slice(0, 12) };
  return { owner: 'guest' };
}

function subjectOf(owner: ShoppingOwnerRef | null): string | null {
  if (owner?.kind === 'member') return `member:${owner.userId}`;
  if (owner?.kind === 'guest') return `guest:${owner.tokenHash}`;
  return null;
}

/**
 * カート・お気に入りの窓口の持ち主を決める（設計書 4-2）。ログインの確かめはグループ C と同じ規則。
 * 会員の要求にゲストの印が残っていれば、ログインの時に失敗した分としてここで合わせる（設計書 5-1）。
 */
export async function openShoppingContext(
  request: NextRequest,
  kind: GuestShoppingKind,
  supabase: SupabaseClient,
  options: { write: boolean },
): Promise<{ ok: true; context: ShoppingContext } | { ok: false; response: NextResponse }> {
  const buyer = await resolveCheckoutBuyer(request);
  if (buyer.kind === 'expired' || buyer.kind === 'unavailable') {
    return { ok: false, response: checkoutBuyerFailureResponse(buyer.kind) };
  }

  const tokens = readGuestShoppingTokens(request.headers.get('cookie'));
  let owner: ShoppingOwnerRef | null = null;
  let currentToken: string | null = null;
  let issuedToken: string | null = null;
  let clearGuestCookies = false;

  if (buyer.kind === 'member') {
    owner = { kind: 'member', userId: buyer.userId };
    if (tokens.cartToken || tokens.wishlistToken) {
      const merged = await mergeGuestShoppingIntoMember(supabase, { userId: buyer.userId, ...tokens });
      clearGuestCookies = merged.ok;
    }
  } else {
    currentToken = kind === 'cart' ? tokens.cartToken : tokens.wishlistToken;
    if (currentToken) {
      owner = { kind: 'guest', tokenHash: await hashGuestShoppingToken(currentToken) };
    }
  }

  const context: ShoppingContext = {
    kind,
    owner,
    rateLimitSubject: subjectOf(owner),
    auditOwner: auditOwnerOf(owner),
    async findOwnerId() {
      return context.owner ? findOwnerRowId(supabase, tableOf(kind), context.owner) : null;
    },
    async ensureOwnerId() {
      if (!context.owner) {
        issuedToken = generateGuestShoppingToken();
        context.owner = { kind: 'guest', tokenHash: await hashGuestShoppingToken(issuedToken) };
        context.rateLimitSubject = subjectOf(context.owner);
        context.auditOwner = auditOwnerOf(context.owner);
      }
      return ensureOwnerRowId(supabase, tableOf(kind), context.owner);
    },
    finish(response) {
      if (clearGuestCookies) {
        clearGuestShoppingCookies(response);
      } else if (issuedToken) {
        setGuestShoppingCookie(response, kind, issuedToken);
      } else if (options.write && currentToken) {
        setGuestShoppingCookie(response, kind, currentToken);
      }
      return response;
    },
  };
  return { ok: true, context };
}

/** 決済の窓口が、確かめた買い手からカートを引く。Cookie は消さない（次のカートの読み込みが消す。本計画の決め事 P3） */
export async function findCartIdForBuyer(
  supabase: SupabaseClient,
  request: Request,
  buyer: CheckoutBuyer,
): Promise<string | null> {
  const tokens = readGuestShoppingTokens(request.headers.get('cookie'));
  if (buyer.kind === 'member') {
    if (tokens.cartToken || tokens.wishlistToken) {
      await mergeGuestShoppingIntoMember(supabase, { userId: buyer.userId, ...tokens });
    }
    return findOwnerRowId(supabase, 'carts', { kind: 'member', userId: buyer.userId });
  }
  if (!tokens.cartToken) {
    return null;
  }
  return findOwnerRowId(supabase, 'carts', { kind: 'guest', tokenHash: await hashGuestShoppingToken(tokens.cartToken) });
}

/** 会員の書き換えに CSRF の合言葉を求める（更新の印の無いゲストは素通り。決済の窓口と同じ） */
export async function denyIfCsrfInvalid(): Promise<NextResponse | null> {
  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const result = await requireCsrfOrDeny();
  if (result instanceof Response) {
    return result as NextResponse;
  }
  return null;
}
