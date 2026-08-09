import { readFile } from 'node:fs/promises';
import { Client, type QueryResult } from 'pg';
import { sha256, type LegalArchiveManifest } from '../../src/lib/legal-archive/manifest';

type QueryClient = { query(text: string): Promise<Pick<QueryResult, 'rows'>> };

export async function verifyRestore(input: {
  client: QueryClient;
  artifacts: Record<string, Uint8Array>;
  manifest: LegalArchiveManifest;
}) {
  const fail = (code: string) => ({ ok: false as const, code });
  const year = input.manifest.fiscalYear;
  if (!Number.isInteger(year) || year < 2000 || year > 9999) return fail('INVALID_FISCAL_YEAR');
  const lower = new Date(Date.UTC(year - 1, 11, 31, 15)).toISOString();
  const upper = new Date(Date.UTC(year, 11, 31, 15)).toISOString();
  for (const [name, metadata] of Object.entries(input.manifest.files)) {
    const artifact = input.artifacts[name];
    if (!artifact || sha256(artifact) !== metadata.sha256) return fail('ARTIFACT_HASH_MISMATCH');
  }
  const tables = await input.client.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('orders','order_items','order_revisions')",
  );
  if (tables.rows.length !== 3) return fail('REQUIRED_TABLE_MISSING');
  const triggers = await input.client.query(
    "select trigger_name from information_schema.triggers where event_object_table in ('orders','order_items')",
  );
  const triggerNames = new Set(triggers.rows.map((row) => String(row.trigger_name)));
  for (const required of ['protect_legal_order_delete', 'protect_legal_order_item_delete', 'record_order_revision']) {
    if (![...triggerNames].some((name) => name.includes(required))) return fail('PROTECTION_TRIGGER_MISSING');
  }
  const orphan = await input.client.query(
    'select count(*)::integer as count from order_items i left join orders o on o.id=i.order_id where o.id is null',
  );
  if (Number(orphan.rows[0]?.count ?? 0) !== 0) return fail('ORPHAN_ORDER_ITEM');
  const counts = await input.client.query(
    `select
      (select count(*) from orders where created_at >= '${lower}' and created_at < '${upper}')::integer as orders,
      (select count(*) from order_items i join orders o on o.id=i.order_id where o.created_at >= '${lower}' and o.created_at < '${upper}')::integer as items,
      (select count(*) from order_revisions r join orders o on o.id=r.order_id where o.created_at >= '${lower}' and o.created_at < '${upper}')::integer as revisions`,
  );
  const count = counts.rows[0] ?? {};
  if (Number(count.orders) !== input.manifest.rowCounts.orders) return fail('ORDER_COUNT_MISMATCH');
  if (Number(count.items) !== input.manifest.rowCounts.orderItems) return fail('ORDER_ITEM_COUNT_MISMATCH');
  if (Number(count.revisions) !== input.manifest.rowCounts.revisions) return fail('REVISION_COUNT_MISMATCH');
  const totals = await input.client.query(
    `select coalesce(sum(total_amount),0)::bigint as gross,
      coalesce(sum(refunded_amount),0)::bigint as refunded,
      coalesce(sum(total_amount-refunded_amount),0)::bigint as net
      from orders where created_at >= '${lower}' and created_at < '${upper}'`,
  );
  const total = totals.rows[0] ?? {};
  if (Number(total.gross) !== input.manifest.totals.grossAmount) return fail('GROSS_TOTAL_MISMATCH');
  if (Number(total.refunded) !== input.manifest.totals.refundedAmount) return fail('REFUND_TOTAL_MISMATCH');
  if (Number(total.net) !== input.manifest.totals.netAmount) return fail('NET_TOTAL_MISMATCH');
  return { ok: true as const, checks: 10 };
}

async function main() {
  const directory = process.env.LEGAL_ARCHIVE_RESTORE_DIRECTORY;
  const databaseUrl = process.env.RESTORE_DATABASE_URL;
  if (!directory || !databaseUrl) throw new Error('Restore verification environment is incomplete');
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8')) as LegalArchiveManifest;
  const artifacts: Record<string, Uint8Array> = {};
  for (const name of Object.keys(manifest.files)) artifacts[name] = new Uint8Array(await readFile(`${directory}/${name}`));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await verifyRestore({ client, artifacts, manifest });
    if (!result.ok) throw new Error(result.code);
    console.info('Legal archive restore verification passed');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RESTORE_VERIFY_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}
