/** @jest-environment node */
export {};

const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 照合の定期処理の登録（設計書 2026-10-05 グループ B の 4-1・8-3）。
 * Vault に秘密が無くても登録は通ること、揃っていれば照合の入口へ POST を1件積むことを、
 * 実際の DB で確かめる。すべてロールバックするので、HTTP の要求は送られない（pg_net はコミットされた行だけを送る）。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/stripe_reconcile_job
 */

const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'supabase/pending/schedule_stripe_reconcile.sql'),
  'utf8',
);

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: stripe-reconcile の登録', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error('Vault の秘密を消すため、localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('begin');
  });

  afterEach(async () => {
    // 送信も登録も残さない
    await client.query('rollback');
  });

  async function dropVaultSecrets() {
    await client.query("delete from vault.secrets where name in ('cron_secret', 'app_base_url')");
  }

  test('Vault の秘密が無くても登録は通り、毎日 18:00 UTC のジョブができる', async () => {
    await dropVaultSecrets();

    await client.query(MIGRATION_SQL);

    const job = await client.query(
      "select schedule, active, command from cron.job where jobname = 'stripe-reconcile'",
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].schedule).toBe('0 18 * * *');
    expect(job.rows[0].active).toBe(true);
    expect(job.rows[0].command).toContain('/api/cron/stripe-reconcile');
  }, 60000);

  test('秘密が揃っていれば、照合の入口へ Authorization 付きの POST を1件積む', async () => {
    await dropVaultSecrets();
    await client.query("select vault.create_secret('test-cron-secret-0123456789abcdef', 'cron_secret')");
    await client.query("select vault.create_secret('http://localhost:3000/', 'app_base_url')");
    await client.query(MIGRATION_SQL);
    const command = (await client.query(
      "select command from cron.job where jobname = 'stripe-reconcile'",
    )).rows[0].command;

    const before = (await client.query('select count(*)::int as count from net.http_request_queue')).rows[0].count;
    await client.query(command);

    const after = (await client.query('select count(*)::int as count from net.http_request_queue')).rows[0].count;
    expect(after).toBe(before + 1);
    const queued = await client.query(
      'select method, url, headers from net.http_request_queue order by id desc limit 1',
    );
    expect(queued.rows[0].method).toBe('POST');
    // 住所の最後の「/」は落とす
    expect(queued.rows[0].url).toBe('http://localhost:3000/api/cron/stripe-reconcile');
    expect(queued.rows[0].headers.Authorization).toBe('Bearer test-cron-secret-0123456789abcdef');
  }, 60000);
});
