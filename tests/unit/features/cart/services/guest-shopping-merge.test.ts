/** @jest-environment node */
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import { logAudit } from '@/lib/audit';

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

const CART = 'c'.repeat(43);
const WISHLIST = 'w'.repeat(43);

function supabaseReturning(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn().mockResolvedValue(result) } as never;
}

describe('ログインで合わせる', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('印が2つとも無ければ DB を呼ばない', async () => {
    const supabase = supabaseReturning({ data: [], error: null });
    await expect(mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: null, wishlistToken: null })).resolves.toEqual({
      ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0,
    });
    expect((supabase as unknown as { rpc: jest.Mock }).rpc).not.toHaveBeenCalled();
  });

  test('印のハッシュだけを DB に渡し、件数を監査に残す（印は残さない）', async () => {
    const supabase = supabaseReturning({ data: [{ cart_lines_moved: 2, cart_lines_dropped: 1, wishlist_lines_moved: 3 }], error: null });
    const result = await mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: CART, wishlistToken: WISHLIST });
    expect(result).toEqual({ ok: true, cartLinesMoved: 2, cartLinesDropped: 1, wishlistLinesMoved: 3 });
    const rpc = (supabase as unknown as { rpc: jest.Mock }).rpc;
    expect(rpc).toHaveBeenCalledWith('merge_guest_into_member', {
      _user_id: 'u1',
      _cart_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      _wishlist_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ action: 'cart.merge', outcome: 'success', actor_id: 'u1' });
    expect(JSON.stringify(audit)).not.toContain(CART);
    expect(JSON.stringify(audit)).not.toContain(WISHLIST);
  });

  test('DB の失敗は投げずに ok: false を返し、監査に残す', async () => {
    const supabase = supabaseReturning({ data: null, error: { message: 'boom' } });
    await expect(mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: CART, wishlistToken: null })).resolves.toEqual({ ok: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cart.merge', outcome: 'error' }));
  });

  test.each(['応答のエラー', '投げられた例外'])('%sに印が含まれてもログと監査へ出さない', async (failure) => {
    const error = new Error(`failed ${CART} ${WISHLIST}`);
    const rpc = failure === '応答のエラー'
      ? jest.fn().mockResolvedValue({ data: null, error })
      : jest.fn().mockRejectedValue(error);
    await expect(mergeGuestShoppingIntoMember({ rpc } as never, {
      userId: 'u1', cartToken: CART, wishlistToken: WISHLIST,
    })).resolves.toEqual({ ok: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cart.merge', outcome: 'error' }));
    for (const calls of [(console.error as jest.Mock).mock.calls, (logAudit as jest.Mock).mock.calls]) {
      expect(JSON.stringify(calls)).not.toContain(CART);
      expect(JSON.stringify(calls)).not.toContain(WISHLIST);
    }
  });

  test('監査も失敗して例外に印が含まれても投げず、ログへ出さない', async () => {
    const supabase = supabaseReturning({ data: null, error: new Error(`failed ${CART}`) });
    (logAudit as jest.Mock).mockRejectedValueOnce(new Error(`audit failed ${WISHLIST}`));
    await expect(mergeGuestShoppingIntoMember(supabase, {
      userId: 'u1', cartToken: CART, wishlistToken: WISHLIST,
    })).resolves.toEqual({ ok: false });
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(CART);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(WISHLIST);
  });
});
