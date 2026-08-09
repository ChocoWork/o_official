import { buildArchiveCsv, escapeCsvCell } from '@/lib/legal-archive/csv';

const fixture = [{
  orders: [{ id: 'order-1', created_at: '2026-01-01T00:00:00.000Z', total_amount: 1000, refunded_amount: 100 }],
  orderItems: [{ id: 'item-1', order_id: 'order-1', item_name: 'Dress', line_total: 1000 }],
  revisions: [{ id: 1, order_id: 'order-1', operation: 'status_update' }],
  nextCursor: null,
  totals: { grossAmount: 1000, refundedAmount: 100, netAmount: 900 },
}];

describe('legal archive CSV', () => {
  it('uses fixed headers, CRLF rows and deterministic output', () => {
    const first = buildArchiveCsv(fixture as never);
    expect(first.ordersCsv).toMatch(/^order_id,order_date,/);
    expect(first.ordersCsv).toContain('\r\n');
    expect(first).toEqual(buildArchiveCsv(fixture as never));
    expect(first.totals).toEqual({ grossAmount: 1000, refundedAmount: 100, netAmount: 900 });
  });

  it.each(['=SUM(1,1)', '+1', '-1+2', '@cmd', '\tcmd', '\rcmd'])(
    'neutralizes spreadsheet formula value %s',
    (value) => expect(escapeCsvCell(value)).toBe(`'${value}`),
  );
});
