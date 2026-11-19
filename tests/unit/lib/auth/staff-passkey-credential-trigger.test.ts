import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PASSKEY_OUTBOX_KINDS, isPasskeyOutboxKind } from '@/lib/auth/staff-passkey-credential-events';

// DD-AUTH-045: the order inside the trigger function is a safety rule (approval delete first, outside the exception
// block; FOUND read on the very next statement). The DB suite proves the behaviour; this reads the migration text so a
// careless edit of the order fails fast without a database.
function readMigration(suffix: string): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((f) => f.endsWith(suffix));
  if (!file) throw new Error('migration not found: ' + suffix);
  return readFileSync(path.join(dir, file), 'utf8').replaceAll('\r\n', '\n');
}

const sql = readMigration('_passkey_credential_events.sql');
const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION private.passkey_credentials_notify()'));
const exceptionBlockStart = body.indexOf('  BEGIN\n    SELECT EXISTS');

describe('passkey credential trigger migration text', () => {
  it('DD-AUTH-045 outbox の種類の表は、移行 A の CHECK 制約と引き金が積む種類に同じ', () => {
    const foundation = readMigration('_passkey_foundation_tables.sql');
    for (const kind of PASSKEY_OUTBOX_KINDS) {
      expect(foundation).toContain(`'${kind}'`);
      expect(sql).toContain(`'${kind}'`);
      expect(isPasskeyOutboxKind(kind)).toBe(true);
    }
    expect(isPasskeyOutboxKind('passkey_other')).toBe(false);
    expect(isPasskeyOutboxKind(null)).toBe(false);
    expect(isPasskeyOutboxKind(1)).toBe(false);
  });

  it('DD-AUTH-045 認めの行の削除は RETURNING を使わず、次の文で FOUND を控える', () => {
    const deletes = body.match(/DELETE FROM private\.approved_passkeys WHERE passkey_id = OLD\.id;\n\s+v_was_approved := FOUND;/g);
    expect(deletes).toHaveLength(2);
    expect(body).not.toMatch(/DELETE FROM private\.approved_passkeys[^;]*RETURNING/);
  });

  it('DD-AUTH-045 認めの削除は例外の囲みの外、outbox の書き込みだけが囲みの中', () => {
    expect(exceptionBlockStart).toBeGreaterThan(0);
    const beforeBlock = body.slice(0, exceptionBlockStart);
    const inBlock = body.slice(exceptionBlockStart, body.indexOf('RETURN NULL;\nEND'));
    expect(beforeBlock).toContain('DELETE FROM private.approved_passkeys');
    expect(inBlock).not.toContain('DELETE FROM private.approved_passkeys');
    expect(inBlock).toContain('INSERT INTO private.passkey_notification_outbox');
    expect(inBlock).toContain('EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING');
  });

  it('DD-AUTH-045 店員は user_roles の有効な admin・supporter か、認めた鍵だったか（フックと同じ規則）', () => {
    expect(sql).toContain("r.code IN ('admin', 'supporter')");
    expect(sql).toContain('v_is_staff := COALESCE(v_is_staff, false) OR v_was_approved;');
  });

  it('DD-AUTH-045 開いている登録の窓の人も店員として積む（窓の枝は認めた鍵の判定の後、例外の囲みの中）', () => {
    const inBlock = body.slice(exceptionBlockStart, body.indexOf('RETURN NULL;\nEND'));
    const windowBranch = inBlock.indexOf('FROM private.passkey_registration_windows w');
    expect(windowBranch).toBeGreaterThan(inBlock.indexOf('OR v_was_approved;'));
    expect(inBlock).toContain('w.user_id = v_user AND w.closed_at IS NULL AND w.expires_at > now()');
    expect(inBlock.indexOf('IF NOT v_is_staff THEN')).toBeGreaterThan(-1);
    expect(inBlock.indexOf('IF NOT v_is_staff THEN')).toBeLessThan(windowBranch);
    expect(windowBranch).toBeLessThan(inBlock.indexOf('INSERT INTO private.passkey_notification_outbox'));
  });

  it('DD-AUTH-045 引き金は insert・update・delete の行ごとで、関数の execute は誰にも渡さない', () => {
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON auth.webauthn_credentials');
    expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION private.passkey_credentials_notify()');
    expect(sql).toContain('REVOKE ALL ON FUNCTION private.passkey_credentials_notify() FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION private\.passkey_credentials_notify/);
  });
});
