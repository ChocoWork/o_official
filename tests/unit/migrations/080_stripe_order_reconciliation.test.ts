import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('080_stripe_order_reconciliation migration', () => {
  const migrationPath = join(process.cwd(), 'migrations', '080_stripe_order_reconciliation.sql');

  it('adds bounded refund state to orders', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS refunded_amount');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS refunded_at');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS payment_status_updated_at');
    expect(sql).toContain('refunded_amount <= total_amount');
  });

  it('adds retryable processing state to Stripe webhook events', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS processing_status');
    expect(sql).toContain("processing_status IN ('processing', 'completed', 'failed')");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS attempt_count');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS completed_at');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_error');
  });
});
