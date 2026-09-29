/** @jest-environment node */
export {};

const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 未入金注文の掃除ジョブの登録（FREQ-368、レビュー指摘⑦）。
 *
 * Vault に秘密が無い環境でもマイグレーションを止めないこと、代わりにジョブ本体が
 * 送信前に止まることを、実際の DB で確かめる。すべてロールバックするので、
 * 実際に HTTP リクエストが送られることはない（pg_net はコミットされた行だけを送る）。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/expire_pending_orders_job
 */

const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION_SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/pending/schedule_expire_pending_orders.sql',
  ),
  'utf8',
);

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: expire-pending-orders の登録', () => {
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

  async function createVaultSecrets() {
    await dropVaultSecrets();
    await client.query("select vault.create_secret('test-cron-secret', 'cron_secret')");
    await client.query("select vault.create_secret('http://localhost:3000', 'app_base_url')");
  }

  async function applyMigration() {
    await client.query(MIGRATION_SQL);
  }

  async function scheduledCommand(): Promise<string> {
    const res = await client.query(
      "select command from cron.job where jobname = 'expire-pending-orders'",
    );
    expect(res.rowCount).toBe(1);
    return res.rows[0].command;
  }

  async function queuedRequestCount(): Promise<number> {
    const res = await client.query('select count(*)::int as count from net.http_request_queue');
    return res.rows[0].count;
  }

  test('Vault の秘密が無くてもマイグレーションは通り、ジョブが登録される', async () => {
    await dropVaultSecrets();

    await applyMigration();

    const job = await client.query(
      "select schedule, active from cron.job where jobname = 'expire-pending-orders'",
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].schedule).toBe('0 * * * *');
    expect(job.rows[0].active).toBe(true);
  }, 60000);

  test('秘密が欠けているとジョブは失敗し、リクエストを積まない', async () => {
    await createVaultSecrets();
    await applyMigration();
    const command = await scheduledCommand();

    // CRON_SECRET だけ欠けている状態が一番危ない（認証ヘッダが空のまま送られうる）
    await client.query("delete from vault.secrets where name = 'cron_secret'");
    const before = await queuedRequestCount();

    await client.query('savepoint before_job');
    let message = '';
    try {
      await client.query(command);
      message = '(エラーにならなかった)';
    } catch (error: any) {
      message = error.message;
    }
    await client.query('rollback to savepoint before_job');

    expect(message).toMatch(/cron_secret|app_base_url/);
    // 秘密の値そのものは出さない（ASVS 7.1.1）
    expect(message).not.toMatch(/test-cron-secret/);
    expect(await queuedRequestCount()).toBe(before);
  }, 60000);

  test('秘密が揃っていれば Authorization 付きで1件だけ積む', async () => {
    await createVaultSecrets();
    await applyMigration();
    const command = await scheduledCommand();

    const before = await queuedRequestCount();
    await client.query(command);

    expect(await queuedRequestCount()).toBe(before + 1);

    const queued = await client.query(
      'select url, headers from net.http_request_queue order by id desc limit 1',
    );
    expect(queued.rows[0].url).toBe('http://localhost:3000/api/cron/expire-pending-orders');
    expect(queued.rows[0].headers.Authorization).toBe('Bearer test-cron-secret');
  }, 60000);
});
