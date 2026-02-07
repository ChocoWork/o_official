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

      // First insert
      await client.query(
        `INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (ip, endpoint, bucket) DO UPDATE SET count = rate_limit_counters.count + 1, last_seen_at = now()`,
        [testIp, endpoint, bucket]
      );

      // Upsert again (should increment count)
      await client.query(
        `INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (ip, endpoint, bucket) DO UPDATE SET count = rate_limit_counters.count + 1, last_seen_at = now()`,
        [testIp, endpoint, bucket]
      );

      const res = await client.query(
        `SELECT ip, endpoint, bucket, sum(count) as sum_count FROM public.rate_limit_counters WHERE ip = $1 AND endpoint = $2 AND bucket = $3 GROUP BY ip, endpoint, bucket`,
        [testIp, endpoint, bucket]
      );

      expect(res.rowCount).toBe(1);
      // After two upserts with initial value 1 and increment on conflict, the stored count should be 2
      const storedCountRes = await client.query(`SELECT count FROM public.rate_limit_counters WHERE ip = $1 AND endpoint = $2 AND bucket = $3`, [testIp, endpoint, bucket]);
      expect(parseInt(storedCountRes.rows[0].count, 10)).toBeGreaterThanOrEqual(2);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 20000);
});
