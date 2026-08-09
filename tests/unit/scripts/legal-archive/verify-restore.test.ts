import { verifyRestore } from '@/../scripts/legal-archive/verify-restore';
import { sha256 } from '@/lib/legal-archive/manifest';

it('verifies restored structure, counts, totals and artifact hashes', async () => {
  const csv = new TextEncoder().encode('order_id\r\n');
  const responses = [
    { rows: [{ table_name: 'orders' }, { table_name: 'order_items' }, { table_name: 'order_revisions' }] },
    { rows: [
      { trigger_name: 'protect_legal_order_delete' },
      { trigger_name: 'protect_legal_order_item_delete' },
      { trigger_name: 'record_order_revision' },
    ] },
    { rows: [{ count: 0 }] },
    { rows: [{ orders: 0, items: 0, revisions: 0 }] },
    { rows: [{ gross: 0, refunded: 0, net: 0 }] },
  ];
  const client = { query: jest.fn().mockImplementation(async () => responses.shift()!) };
  const result = await verifyRestore({
    client: client as never,
    artifacts: { 'orders.csv': csv },
    manifest: {
      schemaVersion: 1, fiscalYear: 2026, generatedAt: '', gitCommit: '', previousManifestSha256: null,
      files: { 'orders.csv': { sha256: sha256(csv), byteSize: csv.byteLength } },
      rowCounts: { orders: 0, orderItems: 0, revisions: 0 },
      totals: { grossAmount: 0, refundedAmount: 0, netAmount: 0 }, storageTargets: [],
    },
  });
  expect(result).toEqual({ ok: true, checks: 10 });
  expect(client.query.mock.calls.flat().join(' ')).not.toMatch(/shipping_/);
});
