/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import { main } from '../../../scripts/dev/passkey-dev-staff';

// Passkey stage 1a Task 10: scripts/dev/passkey-dev-staff.ts against the local Supabase (default deps, no browser).
// DB suite: needs the local Supabase (DATABASE_URL) and `supabase status`. The user is left for db reset.
describeLocalDb('passkey dev staff script', (db) => {
  jest.setTimeout(120_000);

  test('DATA-AUTH-017 main creates a staff user whose only auth session is bound to a public.sessions row with csrf_token_hash', async () => {
    const email = `dev-staff-it-${Date.now().toString(36)}@example.com`;
    await main(['--email', email, '--role', 'supporter']);

    const user = await db().query('select id from auth.users where lower(email) = lower($1)', [email]);
    expect(user.rowCount).toBe(1);
    const userId = user.rows[0].id as string;
    const authSessions = await db().query('select id from auth.sessions where user_id = $1::uuid', [userId]);
    expect(authSessions.rowCount).toBe(1);
    const rows = await db().query(
      'select auth_session_id, csrf_token_hash, revoked_at, expires_at > now() + interval \'6 days\' as long_lived from public.sessions where user_id = $1::uuid',
      [userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].auth_session_id).toBe(authSessions.rows[0].id);
    expect(rows.rows[0].revoked_at).toBeNull();
    expect(rows.rows[0].csrf_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0].long_lived).toBe(true);
    expect((await db().query('select public.passkey_approved_count($1::uuid) as n', [userId])).rows[0].n).toBe(2);
  });
});
