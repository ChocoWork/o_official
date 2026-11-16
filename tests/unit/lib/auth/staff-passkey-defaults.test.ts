import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultStaffPasskeySettings } from '@/lib/auth/staff-passkey-defaults';

const migration = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261116215034_passkey_foundation_tables.sql'),
  'utf8',
);

describe('staff passkey defaults', () => {
  it('DD-AUTH-043 設定の初めの値は 24 時間・1 時間・窓 30 分・認めたパスキー 2 本・お客さんのパスワードは拒否しない', () => {
    expect(defaultStaffPasskeySettings()).toEqual({
      staffMaxSessionSeconds: 86400,
      staffIdleSeconds: 3600,
      windowMinutes: 30,
      minApprovedPasskeys: 2,
      rejectCustomerPassword: false,
    });
  });

  it('DD-AUTH-043 TS の初めの値は移行の設定の表の既定値と同じ', () => {
    const d = defaultStaffPasskeySettings();
    const column = (name: string) => new RegExp(name + ' (?:integer|boolean) NOT NULL DEFAULT ([a-z0-9]+)').exec(migration)?.[1];
    expect(column('staff_max_session_seconds')).toBe(String(d.staffMaxSessionSeconds));
    expect(column('staff_idle_seconds')).toBe(String(d.staffIdleSeconds));
    expect(column('window_minutes')).toBe(String(d.windowMinutes));
    expect(column('min_approved_passkeys')).toBe(String(d.minApprovedPasskeys));
    expect(column('reject_customer_password')).toBe(String(d.rejectCustomerPassword));
  });
});
