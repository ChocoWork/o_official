import fs from 'node:fs';
import path from 'node:path';

describe('086 finance summary options migration', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'migrations/086_finance_summary_options.sql'), 'utf8');

  it('creates a protected, type-scoped and normalized summary option table', () => {
    expect(sql).toContain('admin_finance_summary_options');
    expect(sql).toMatch(/entry_type[\s\S]*expense[\s\S]*income/i);
    expect(sql).toMatch(/normalized_name/i);
    expect(sql).toMatch(/unique[\s\S]*entry_type[\s\S]*normalized_name/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toContain("admin.finance.read");
    expect(sql).toContain("admin.finance.manage");
  });
});
