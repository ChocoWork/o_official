import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { STAFF_PASSKEY_REQUIRED_MARKER, isStaffPasskeyRequiredError } from '@/lib/auth/staff-passkey-reject';

function readMigration(suffix: string): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((f) => f.endsWith(suffix));
  if (!file) throw new Error('migration not found: ' + suffix);
  return readFileSync(path.join(dir, file), 'utf8').replaceAll('\r\n', '\n');
}

describe('staff passkey reject helper', () => {
  it('DD-AUTH-044 印で始まる 403 は真', () => {
    expect(isStaffPasskeyRequiredError({ status: 403, message: `${STAFF_PASSKEY_REQUIRED_MARKER} staff must sign in` })).toBe(true);
    expect(isStaffPasskeyRequiredError({ status: 403, message: STAFF_PASSKEY_REQUIRED_MARKER })).toBe(true);
  });

  it('DD-AUTH-044 印の無い 403・印で始まる 401・印が文の途中・null・undefined・文が無い物は偽', () => {
    expect(isStaffPasskeyRequiredError({ status: 403, message: 'forbidden' })).toBe(false);
    expect(isStaffPasskeyRequiredError({ status: 401, message: `${STAFF_PASSKEY_REQUIRED_MARKER} x` })).toBe(false);
    expect(isStaffPasskeyRequiredError({ status: 403, message: `x ${STAFF_PASSKEY_REQUIRED_MARKER}` })).toBe(false);
    expect(isStaffPasskeyRequiredError({ status: 403 })).toBe(false);
    expect(isStaffPasskeyRequiredError({ message: STAFF_PASSKEY_REQUIRED_MARKER })).toBe(false);
    expect(isStaffPasskeyRequiredError(null)).toBe(false);
    expect(isStaffPasskeyRequiredError(undefined)).toBe(false);
  });

  it('DD-AUTH-044 お客さんのパスワード拒否の印 [customer-password-disabled] は店員の拒否として扱わない', () => {
    expect(isStaffPasskeyRequiredError({ status: 403, message: '[customer-password-disabled] password sign-in is no longer available' })).toBe(false);
    const sql = readMigration('_passkey_access_token_hook.sql');
    expect(sql).toContain("'[customer-password-disabled] ");
  });

  it('DD-AUTH-044 印は移行のフックの拒否の文の頭と同じ', () => {
    const sql = readMigration('_passkey_access_token_hook.sql');
    expect(sql).toContain(`'${STAFF_PASSKEY_REQUIRED_MARKER} `);
  });
});
