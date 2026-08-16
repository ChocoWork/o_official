import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('089_stripe_accounting_settlement migration', () => {
  const migrationPath = join(
    process.cwd(),
    'migrations',
    '089_stripe_accounting_settlement.sql',
  );

  it('creates Stripe source-of-truth tables with accounting constraints', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE public.stripe_balance_transactions');
    expect(sql).toContain('CHECK (amount - fee = net)');
    expect(sql).toContain('CREATE TABLE public.stripe_refunds');
    expect(sql).toContain('CHECK (amount > 0)');
    expect(sql).toContain('CREATE TABLE public.stripe_payouts');
    expect(sql).toContain(
      "CHECK (reconciliation_status IN ('pending', 'matched', 'mismatch'))",
    );
  });

  it('protects all Stripe accounting tables from client access', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'stripe_balance_transactions',
      'stripe_refunds',
      'stripe_payouts',
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM anon, authenticated`);
      // Supabase の既定権限で service_role に付く ALL を剥がしてから必要分だけ渡す。
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM service_role`);
      expect(sql).toContain(
        `GRANT SELECT, INSERT, UPDATE ON public.${table} TO service_role`,
      );
      expect(sql.indexOf(`REVOKE ALL ON public.${table} FROM service_role`)).toBeLessThan(
        sql.indexOf(`GRANT SELECT, INSERT, UPDATE ON public.${table} TO service_role`),
      );
    }
  });

  it('links records to existing orders without deleting accounting evidence', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('REFERENCES public.orders(id) ON DELETE RESTRICT');
    expect(sql).not.toMatch(/GRANT[^;]*DELETE/i);
  });
});
