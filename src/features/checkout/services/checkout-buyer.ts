import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { refreshCookieName } from '@/lib/cookie';

/**
 * 決済の入口が扱う買い手（グループ C 設計書 4-1）。会員の ID と email は検証済みのログインからだけ取る。
 * email は注文のメールを画面の値にしないための値（4-2・C7）。claims.email が無い印は null
 */
export type CheckoutBuyer = { kind: 'member'; userId: string; email: string | null } | { kind: 'guest' };

export type CheckoutBuyerResolution = CheckoutBuyer | { kind: 'expired' } | { kind: 'unavailable' };

/**
 * ログインを確かめて、この要求の買い手を決める。決済の入口は、守り（Cookie・回数の制限・CSRF）の直後、
 * 何かを変える前に呼ぶ。だから 401 の後に画面が送り直しても二重にならない。
 */
export async function resolveCheckoutBuyer(request: NextRequest): Promise<CheckoutBuyerResolution> {
  const verified = await authenticateRequest(request);
  if (verified.ok) {
    const userId = verified.claims.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      return { kind: 'expired' };
    }
    const email = verified.claims.email;
    return { kind: 'member', userId, email: typeof email === 'string' && email.length > 0 ? email : null };
  }
  if (verified.reason === 'missing') {
    return { kind: 'guest' };
  }
  if (verified.reason === 'unavailable') {
    // 確かめられないままゲストとして受け付けると、「確認へ進む」と「注文する」の比べが意味を失う（設計書 C3）
    return { kind: 'unavailable' };
  }
  // 新しくできる印が無ければ、残った古い印は使わずゲストとして扱う。同じ断りを繰り返さない（設計書 4-1）
  return request.cookies.get(refreshCookieName)?.value ? { kind: 'expired' } : { kind: 'guest' };
}

export function checkoutBuyerFailureResponse(kind: 'expired' | 'unavailable'): NextResponse {
  if (kind === 'unavailable') {
    return authFailureResponse('unavailable');
  }
  return NextResponse.json({ error: 'auth_expired' }, { status: 401 });
}

export function buyerUserIdOf(buyer: CheckoutBuyer): string | null {
  return buyer.kind === 'member' ? buyer.userId : null;
}
