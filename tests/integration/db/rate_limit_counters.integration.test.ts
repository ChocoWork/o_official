export {};

const { Pool } = require('pg');

// Integration test for rate_limit_counters table. Requires DATABASE_URL env var.

describe('integration: rate_limit_counters', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
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

  test('can upsert and group by ip, endpoint, bucket', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const testIp = '127.0.0.1';
      const endpoint = '/api/auth/login';
      const bucket = new Date().toISOString();

      const firstResult = await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3) AS count`,
        [testIp, endpoint, bucket]
      );

      expect(firstResult.rowCount).toBe(1);
      expect(parseInt(firstResult.rows[0].count, 10)).toBe(1);

      const secondResult = await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3) AS count`,
        [testIp, endpoint, bucket]
      );

      expect(secondResult.rowCount).toBe(1);
      expect(parseInt(secondResult.rows[0].count, 10)).toBe(2);

      const storedCountRes = await client.query(`SELECT count FROM public.rate_limit_counters WHERE ip = $1 AND endpoint = $2 AND bucket = $3`, [testIp, endpoint, bucket]);
      expect(storedCountRes.rowCount).toBe(1);
      expect(parseInt(storedCountRes.rows[0].count, 10)).toBe(2);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 20000);

  // メールアドレスやセッション単位の回数は ip を NULL にして数える。
  // 一意制約が NULL 同士を別の値とみなすと ON CONFLICT が効かず、毎回「1回目」の行が増える。
  test('counts subject-based hits (null ip) in a single row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const endpoint = 'auth:login|acct:integration-test-subject';
      const bucket = new Date().toISOString();

      const firstResult = await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3) AS count`,
        [null, endpoint, bucket]
      );
      expect(parseInt(firstResult.rows[0].count, 10)).toBe(1);

      const secondResult = await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3) AS count`,
        [null, endpoint, bucket]
      );
      expect(parseInt(secondResult.rows[0].count, 10)).toBe(2);

      const storedCountRes = await client.query(
        `SELECT count FROM public.rate_limit_counters WHERE ip IS NULL AND endpoint = $1 AND bucket = $2`,
        [endpoint, bucket]
      );
      expect(storedCountRes.rowCount).toBe(1);
      expect(parseInt(storedCountRes.rows[0].count, 10)).toBe(2);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 20000);

  // 管理画面のアップロード容量はバイト数を加算する（重み付きの呼び出し）。こちらも ip は NULL。
  test('accumulates weighted subject-based increments (null ip) in a single row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const endpoint = 'admin:looks:create:upload-bytes|acct:integration-test-subject';
      const bucket = new Date().toISOString();

      await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3, $4) AS count`,
        [null, endpoint, bucket, 100]
      );
      const secondResult = await client.query(
        `SELECT public.increment_rate_limit_counter($1, $2, $3, $4) AS count`,
        [null, endpoint, bucket, 50]
      );
      expect(parseInt(secondResult.rows[0].count, 10)).toBe(150);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 20000);

  // 一意制約の索引と同じ列の通常索引は、回数を数えるたびに無駄な更新を増やすだけ。
  test('keeps a single index on (ip, endpoint, bucket)', async () => {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'rate_limit_counters'
         AND indexdef LIKE '%(ip, endpoint, bucket)%'`
    );

    expect(result.rows.map((row: { indexname: string }) => row.indexname)).toEqual(['rate_limit_counters_unique']);
  }, 20000);
});
