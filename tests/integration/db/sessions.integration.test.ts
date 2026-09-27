export {};

const { Pool } = require('pg');

// Integration tests for sessions table. Requires DATABASE_URL (service role / admin) in env.
// These tests are safe: they run inside a transaction and roll back at the end.

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: sessions table', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  // auth.users を作って消すテストなので、使い捨てのローカル DB でだけ動かす。
  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error(
        'auth.users を作成・削除するため、localhost 以外の DATABASE_URL では実行しない',
      );
    });
    return;
  }

  // pg は型定義パッケージが無く require が any を返すため、明示的に any を置く。
  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('can insert session and FK enforces cascade on user delete (transactional)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 試験用の auth ユーザーを作る。auth.users.id には既定値が無いので明示的に採番する
      // （省略すると not-null 制約で落ちる）。
      const createUser = await client.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         RETURNING id`,
        [`test+sessions-${Date.now()}@example.com`]
      );
      const userId = createUser.rows[0].id;

      // Insert a session for that user (use digest in SQL to simulate hash)
      const insertSession = await client.query(
        `INSERT INTO public.sessions (user_id, refresh_token_hash, current_jti, ip, user_agent, device_name, expires_at)
         VALUES ($1, encode(digest($2, 'sha256'), 'hex'), gen_random_uuid()::text, $3, $4, $5, now() + interval '30 days')
         RETURNING id`,
        [userId, 'test-refresh-token', '127.0.0.1', 'pg-test', 'integration-device']
      );
      expect(insertSession.rowCount).toBe(1);
      const sessionId = insertSession.rows[0].id;

      // Query session by user_id should return it
      const sel = await client.query('SELECT id, user_id FROM public.sessions WHERE user_id = $1', [userId]);
      expect(sel.rowCount).toBe(1);
      expect(sel.rows[0].id).toEqual(sessionId);

      // Confirm index exists for sessions (index presence check)
      const idx = await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' AND schemaname = 'public'");
      const idxNames = idx.rows.map((r: { indexname: string }) => r.indexname);
      expect(idxNames).toContain('idx_sessions_user_id');

      // Test FK cascade: delete user and session should be removed (within transaction)
      await client.query('DELETE FROM auth.users WHERE id = $1', [userId]);
      const selAfterDelete = await client.query('SELECT COUNT(*)::int AS cnt FROM public.sessions WHERE user_id = $1', [userId]);
      expect(selAfterDelete.rows[0].cnt).toBe(0);

      // Rollback at end
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 20000);
});
