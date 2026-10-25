/** @jest-environment node */
import { insertDeliveryFixture } from '../../integration/db/helpers/delivery-tracking-fixtures';
import type { PgClient } from '../../integration/db/helpers/local-db';
import { createShippedOrderFixture } from '../../integration/db/helpers/order-fixtures';
import { createOrderStatusEmail } from '../../integration/db/helpers/order-status-fixtures';

/** Reject unavailable schema features, rather than pretending a G-0 DB accepted G-3 SQL. */
class SchemaDb {
  calls: Array<{ sql: string; params: unknown[] }> = [];
  private nextId = 0;

  constructor(private readonly shipmentDate: boolean) {}

  query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    this.calls.push({ sql, params });
    const rows = (value: Record<string, unknown>[]) => ({ rows: value, rowCount: value.length });
    if (sql.includes('from pg_catalog.pg_attribute')) return rows([{ present: this.shipmentDate }]);
    if (sql.includes("to_regclass('public.order_item_allocations')")) return rows([{ present: false }]);
    if (sql.includes('statement_timestamp() <> pg_catalog.transaction_timestamp()')) return rows([{ in_transaction: false }]);
    if (sql.startsWith('select pg_catalog.now()::text as now')) return rows([{ now: '2026-10-25T00:30:00Z' }]);
    if (sql.startsWith('insert into public.order_fulfillments') && !this.shipmentDate && /\bshipment_date\b/.test(sql)) {
      throw new Error('G0_COLUMN_DOES_NOT_EXIST: shipment_date');
    }
    if (/group_g_shipment_consumption|with_fixture_consumption|order_item_allocation_events|private\.group_g_operations|private\.(?:capture|record)_group_g/.test(sql)) {
      throw new Error('G0_GROUP_G_FEATURE_DOES_NOT_EXIST');
    }
    if (sql.startsWith('insert ') && sql.endsWith('returning id')) return rows([{ id: ++this.nextId }]);
    if (/^(begin|commit|savepoint|release savepoint|select pg_catalog.pg_advisory|insert |update )/.test(sql)) return rows([]);
    throw new Error(`UNEXPECTED_FIXTURE_QUERY: ${sql}`);
  };

  get client(): PgClient { return this as unknown as PgClient; }

  shipments() { return this.calls.filter(({ sql }) => sql.startsWith('insert into public.order_fulfillments')); }
}

describe('shared shipment fixtures across migration baselines', () => {
  it('FREQ-533-AC-02: G-0清掃の発送とメールはG-3列・消費ガードなしで作れる', async () => {
    const db = new SchemaDb(false);
    const order = await createShippedOrderFixture(db.client, {
      lines: [{ quantity: 4 }, { quantity: 1, fulfillmentType: 'backorder' }],
      shipments: [
        { lines: [{ lineIndex: 0, quantity: 3 }, { lineIndex: 1, quantity: 1 }] },
        { lines: [{ lineIndex: 0, quantity: 1 }], cancelled: true },
      ],
    });
    await createOrderStatusEmail(db.client, order.orderId, 'shipping_update');
    await createOrderStatusEmail(db.client, order.orderId, 'paid');
    await createOrderStatusEmail(db.client, order.orderId, 'shipped');

    expect(order.fulfillments).toHaveLength(2);
    expect(db.shipments()).toHaveLength(4);
    for (const { sql } of db.shipments()) expect(sql).not.toMatch(/\bshipment_date\b/);
    expect(db.calls.filter(({ sql }) => sql.includes('from pg_catalog.pg_attribute'))).toHaveLength(1);
    expect(db.calls.some(({ sql }) => sql.startsWith('insert into public.order_item_completions'))).toBe(true);
    expect(db.calls.some(({ sql }) => sql.startsWith('update public.order_fulfillments set cancelled_at'))).toBe(true);
    expect(db.calls.filter(({ sql }) => sql.startsWith('insert into private.order_email_outbox'))).toHaveLength(3);
  });

  it('FREQ-533-AC-02: G-3では列のある接続だけにJSTの出荷日を入れる', async () => {
    const db = new SchemaDb(true);
    const input = { orderId: 'order-1', shippedAt: '2026-10-24T23:30:00Z' };
    await insertDeliveryFixture(db.client, input);
    await insertDeliveryFixture(db.client, { ...input, trackingNumber: null });

    expect(db.shipments()).toHaveLength(2);
    for (const { sql } of db.shipments()) {
      expect(sql).toMatch(/\bshipment_date\b/);
      expect(sql).toContain("(($2::timestamptz) at time zone 'asia/tokyo')::date");
      expect(sql).toContain('($3::text is null or $4::text is null)');
    }
    expect(db.shipments()[0].params.slice(0, 4)).toEqual([input.orderId, input.shippedAt, 'yamato', 'DELIVERY-123']);
    expect(db.shipments()[1].params[3]).toBeNull();
    expect(db.calls.filter(({ sql }) => sql.includes('from pg_catalog.pg_attribute'))).toHaveLength(1);
  });
});
