import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { searchBestDiscountPlan } from '@/lib/discounts/discount-search';
import type { DiscountBuyer, DiscountDefinition, DiscountFacts } from '@/lib/discounts/discount-types';
import { listDiscountAdvertisements, previewAutomaticDiscounts } from '@/lib/discounts/discount-preview-store';
import { definition, line, usage } from './fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/discounts/discount-engine', () => ({ calculateDiscounts: jest.fn((i) => jest.requireActual('@/lib/discounts/discount-engine').calculateDiscounts(i)) }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

const at = '2026-10-29T00:00:00Z';
const lines = [line('b', 1, 20000, 2)];

function factsFor(buyer: DiscountBuyer, discounts: readonly DiscountDefinition[]): DiscountFacts {
  const guest = buyer.kind === 'guest';
  return { phase: 'preview', at, buyer, hasPreviousOrder: guest ? null : false, hasFirstOrderReservation: guest ? null : false, priorUnitsByItem: {},
    usage: discounts.map(d => usage(d, { buyerUses: guest ? null : 0 })) };
}
function clientOf(discounts: readonly DiscountDefinition[], buyer: DiscountBuyer) {
  const rpc = jest.fn().mockResolvedValue({ data: { discounts, facts: factsFor(buyer, discounts), refusals: [] }, error: null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}
const GUEST: DiscountBuyer = { kind: 'guest', normalizedEmail: null };
const MEMBER: DiscountBuyer = { kind: 'member', userId: 'member-1' };

describe('previewAutomaticDiscounts', () => {
  test('FREQ-550-AC-01: 自動割引だけをpreviewで評価し、ゲストのメールは破棄して初回は見込みのまま', async () => {
    const first = definition('first', { kind: 'order_percent', firstOrderOnly: true, value: { type: 'percent', value: 10 }, combinesWithProduct: true });
    const { client, rpc } = clientOf([first], GUEST);

    const result = await previewAutomaticDiscounts(client, { kind: 'guest', normalizedEmail: 'someone@example.test' }, lines, at);

    expect(result).toMatchObject({ subtotalAmount: 40000, discountAmount: 4000, totalAmount: 36000, provisional: true, unusedCodes: [] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_checkout_discount_context', expect.objectContaining({
      _buyer_user_id: null, _guest_email: null, _codes: [], _item_ids: [1], _phase: 'preview',
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('someone@example.test');
  });

  test('FREQ-546-AC-04: 探索のguardでも完全に評価したfallback額を返し、管理要対応へ１回だけ記録する', async () => {
    const auto = definition('auto', { kind: 'order_percent', value: { type: 'percent', value: 10 } });
    const { client, rpc } = clientOf([auto], MEMBER);
    jest.mocked(calculateDiscounts).mockImplementationOnce(i => searchBestDiscountPlan(i, { maxProductPlans: 0, maxCombinations: 0 }));

    const result = await previewAutomaticDiscounts(client, MEMBER, lines, at);

    expect(result).toMatchObject({ calculationMode: 'fallback', discountAmount: 4000, totalAmount: 36000 });
    const attention = rpc.mock.calls.filter(([name]) => name === 'record_discount_search_fallback');
    expect(attention).toEqual([['record_discount_search_fallback', { _discount_ids: ['auto'] }]]);
  });
});

describe('listDiscountAdvertisements', () => {
  const ad = (id: string, patch: Partial<DiscountDefinition> = {}) => definition(id, { advertise: true, advertisingText: `${id}の案内`, ...patch });

  test('FREQ-550-AC-03: 広告は自動ONの１行だけでguestにはAを含む会員条件を出さない', async () => {
    const rows = [
      ad('on'),
      ad('off', { advertise: false }),
      ad('code', { method: 'code' }),
      ad('stopped', { stopped: true }),
      ad('future', { startsAt: '2026-12-01T00:00:00Z' }),
      ad('past', { endsAt: '2026-10-01T00:00:00Z' }),
      ad('excluded', { kind: 'product', targetMode: 'exclude', itemIds: [7] }),
      ad('other', { kind: 'product', targetMode: 'include', itemIds: [8] }),
      ad('blank', { advertisingText: '  ' }),
    ];
    const { client } = clientOf(rows, MEMBER);

    const result = await listDiscountAdvertisements(client, MEMBER, 7, at);

    expect(result).toEqual([{ discountId: 'on', text: 'onの案内' }]);
    await expect(listDiscountAdvertisements(clientOf(rows, GUEST).client, GUEST, 7, at)).resolves.toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/code|usage|assigned/i);
  });

  test('FREQ-550-AC-03: ゲストにはAを含む会員用の案内を出さず、会員には同じ割引を出す', async () => {
    const rows = [
      ad('everyone'),
      ad('previous', { kind: 'repeat', targetMode: 'include', itemIds: [7], repeatPrevious: true }),
      ad('both', { kind: 'repeat', targetMode: 'include', itemIds: [7], repeatPrevious: true, repeatInOrder: true }),
      ad('inOrder', { kind: 'repeat', targetMode: 'include', itemIds: [7], repeatInOrder: true }),
      ad('firstOrder', { firstOrderOnly: true }),
    ];
    const guest = await listDiscountAdvertisements(clientOf(rows, GUEST).client, GUEST, 7, at);
    const member = await listDiscountAdvertisements(clientOf(rows, MEMBER).client, MEMBER, 7, at);

    expect(guest.map(r => r.discountId)).toEqual(['everyone', 'firstOrder', 'inOrder']);
    expect(member.map(r => r.discountId)).toEqual(['both', 'everyone', 'firstOrder', 'inOrder', 'previous']);
  });

  test('FREQ-550-AC-03: 案内にHTMLが入っていても加工せず文字のまま返す', async () => {
    const text = '<img src=x onerror=alert(1)>春の割引';
    const { client } = clientOf([ad('html', { advertisingText: text })], GUEST);
    await expect(listDiscountAdvertisements(client, GUEST, 7, at)).resolves.toEqual([{ discountId: 'html', text }]);
  });
});
