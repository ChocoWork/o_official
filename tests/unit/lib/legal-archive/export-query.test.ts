import { fetchLegalArchivePage } from '@/lib/legal-archive/export-query';

describe('fetchLegalArchivePage', () => {
  it('uses JST calendar-year bounds and returns related rows and totals', async () => {
    const orderQuery = chain({
      data: [
        {
          id: 'order-1',
          created_at: '2026-01-02T00:00:00.000Z',
          total_amount: 12000,
          refunded_amount: 2000,
        },
      ],
      error: null,
    });
    const itemQuery = chain({ data: [{ id: 'item-1', order_id: 'order-1' }], error: null });
    const revisionQuery = chain({ data: [{ id: 1, order_id: 'order-1' }], error: null });
    const client = {
      from: jest
        .fn()
        .mockReturnValueOnce(orderQuery)
        .mockReturnValueOnce(itemQuery)
        .mockReturnValueOnce(revisionQuery),
    };

    const result = await fetchLegalArchivePage({
      client,
      year: 2026,
      cursor: null,
      pageSize: 500,
    });

    expect(orderQuery.gte).toHaveBeenCalledWith('created_at', '2025-12-31T15:00:00.000Z');
    expect(orderQuery.lt).toHaveBeenCalledWith('created_at', '2026-12-31T15:00:00.000Z');
    expect(itemQuery.in).toHaveBeenCalledWith('order_id', ['order-1']);
    expect(result.orderItems).toHaveLength(1);
    expect(result.revisions).toHaveLength(1);
    expect(result.totals).toEqual({ grossAmount: 12000, refundedAmount: 2000, netAmount: 10000 });
  });
});

function chain(result: unknown) {
  const query = {
    select: jest.fn(),
    gte: jest.fn(),
    lt: jest.fn(),
    or: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  for (const key of ['select', 'gte', 'lt', 'or', 'in', 'order', 'limit'] as const) {
    query[key].mockReturnValue(query);
  }
  return query;
}
