/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import { loginWithPasskey, provisionStaff } from '../../../scripts/e2e/passkey-staff';

// Passkey stage 1a Task 7: the soft authenticator + provisionStaff / loginWithPasskey drive the local GoTrue end to end.
// DB suite: needs the local Supabase (DATABASE_URL) and its Auth. provisionStaff commits (GoTrue writes on its own
// connection), so each case uses a fresh user and the rows are left for db reset (same as the other E2E helpers).
function claims(token: string): { amr?: Array<{ method: string; timestamp: number }>; aal?: string; session_id?: string; sub?: string } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describeLocalDb('passkey staff provisioning and login helpers', (db) => {
  jest.setTimeout(60_000);

  test('DATA-AUTH-015 provisionStaff registers and approves two passkeys, and the role is active last', async () => {
    const staff = await provisionStaff(db(), { role: 'admin', approvedPasskeys: 2 });
    expect(staff.authenticators).toHaveLength(2);
    expect(staff.authenticators[0].credentialId.equals(staff.authenticators[1].credentialId)).toBe(false);

    const approved = await db().query(
      `select a.approved_via from private.approved_passkeys a where a.user_id = $1::uuid`,
      [staff.userId],
    );
    expect(approved.rows).toHaveLength(2);
    expect(approved.rows.every((r) => r.approved_via === 'script')).toBe(true);
    expect((await db().query('select public.passkey_approved_count($1::uuid) as n', [staff.userId])).rows[0].n).toBe(2);

    const role = await db().query(
      `select r.code, ur.active from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1::uuid`,
      [staff.userId],
    );
    expect(role.rows).toEqual([{ code: 'admin', active: true }]);
  });

  test('DATA-AUTH-015 loginWithPasskey returns a session whose JWT has amr passkey, aal1 and a session_id', async () => {
    const staff = await provisionStaff(db(), { role: 'supporter', approvedPasskeys: 2 });
    const { session } = await loginWithPasskey({ email: staff.email, authenticator: staff.authenticators[1] });
    const c = claims(session.access_token);
    expect(c.sub).toBe(staff.userId);
    expect(c.amr?.some((a) => a.method === 'passkey')).toBe(true);
    expect(c.aal).toBe('aal1');
    expect(c.session_id).toBeTruthy();
    expect(staff.authenticators[1].signCount).toBe(1);
  });

  test('DATA-AUTH-015 approvedPasskeys 0 registers nothing and an existing email throws', async () => {
    const staff = await provisionStaff(db(), { role: 'admin', approvedPasskeys: 0 });
    expect(staff.authenticators).toHaveLength(0);
    expect((await db().query('select 1 from private.approved_passkeys where user_id = $1::uuid', [staff.userId])).rowCount).toBe(0);
    await expect(provisionStaff(db(), { role: 'admin', approvedPasskeys: 1, email: staff.email })).rejects.toThrow('既にいる');
  });
});
