import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('091_auth_session_revocation migration', () => {
  const migrationPath = join(
    process.cwd(),
    'migrations',
    '091_auth_session_revocation.sql',
  );

  const sql = readFileSync(migrationPath, 'utf8');

  it('exposes a session liveness check backed by auth.sessions', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.is_auth_session_active(p_session_id uuid)');
    expect(sql).toContain('FROM auth.sessions s');
    expect(sql).toContain('WHERE s.id = p_session_id');
    expect(sql).toContain('s.not_after IS NULL OR s.not_after > now()');
  });

  it('exposes admin-initiated session revocation', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.revoke_auth_sessions_for_user(p_user_id uuid)');
    expect(sql).toContain('DELETE FROM auth.sessions WHERE user_id = p_user_id');
  });

  it('pins search_path on every SECURITY DEFINER function', () => {
    // コメント行に登場する語を数えないよう、-- 以降を落としてから数える。
    const statements = sql.replace(/--.*$/gm, '');
    const definerCount = statements.match(/SECURITY DEFINER/g)?.length ?? 0;
    const searchPathCount = statements.match(/SET search_path = ''/g)?.length ?? 0;

    expect(definerCount).toBe(2);
    expect(searchPathCount).toBe(definerCount);
  });

  it('grants execute to service_role only', () => {
    for (const fn of ['is_auth_session_active', 'revoke_auth_sessions_for_user']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(uuid) FROM PUBLIC;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(uuid) FROM anon;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(uuid) FROM authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid) TO service_role;`);
    }
  });
});
