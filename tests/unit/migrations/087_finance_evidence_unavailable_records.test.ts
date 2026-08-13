import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('087_finance_evidence_unavailable_records migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'migrations',
      '087_finance_evidence_unavailable_records.sql',
    ),
    'utf8',
  );

  it('creates a protected table for unavailable evidence records', () => {
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.admin_finance_evidence_unavailable_records',
    );
    expect(sql).toContain("'bank_history_expired'");
    expect(sql).toContain("'external_electronic_storage'");
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toContain("'admin.finance.read'");
    expect(sql).toContain("'admin.finance.manage'");
  });

  it('requires a trimmed note for reasons that need an explanation', () => {
    expect(sql).toMatch(/reason NOT IN \('bank_history_expired', 'other'\)/);
    expect(sql).toMatch(
      /char_length\(btrim\(coalesce\(note, ''\)\)\) BETWEEN 1 AND 500/,
    );
  });
});
