const { Pool } = require('pg');

// Integration test for rate_limit_counters table. Requires DATABASE_URL env var.

describe('integration: rate_limit_counters', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool;
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
});
