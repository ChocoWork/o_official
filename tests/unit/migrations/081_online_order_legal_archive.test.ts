import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('081_online_order_legal_archive migration', () => {
  const migrationPath = join(
    process.cwd(),
    'migrations',
    '081_online_order_legal_archive.sql',
  );

  it('blocks physical deletion and immutable order changes', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('protect_legal_order_delete');
    expect(sql).toContain('protect_legal_order_immutable_fields');
    expect(sql).toContain('protect_legal_order_item_delete');
    expect(sql).toContain(
      "RAISE EXCEPTION 'legal order records cannot be deleted'",
    );
  });

  it('records allowed changes in an append-only history', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.order_revisions',
    );
    expect(sql).toContain('changed_fields text[]');
    expect(sql).toContain('before_data jsonb');
    expect(sql).toContain('after_data jsonb');
    expect(sql).toContain('record_order_revision');
    expect(sql).not.toMatch(
      /CREATE POLICY[^;]+order_revisions[^;]+FOR (UPDATE|DELETE)/s,
    );
  });

  it('creates archive run state and a private bucket', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.legal_archive_runs',
    );
    expect(sql).toContain(
      "VALUES ('legal-archive', 'legal-archive', false)",
    );
    expect(sql).toContain(
      "status IN ('running', 'completed', 'failed')",
    );
  });
});
