import fs from 'node:fs';
import path from 'node:path';

/**
 * 開店のときに当てる定期処理の登録（設計書 2026-10-05 グループ B の 4-1・8-3）。
 * 見回りの登録（schedule_expire_pending_orders.sql）と同じ形: マイグレーション本体は止めず、
 * ジョブ本体は Vault の秘密が欠けていれば送る前に止める。
 */
function readPending(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'supabase/pending', file), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.each([
  {
    file: 'schedule_stripe_webhook_worker.sql',
    job: 'process-stripe-webhooks',
    schedule: '* * * * *',
    endpoint: '/api/cron/process-stripe-webhooks',
  },
  {
    file: 'schedule_stripe_reconcile.sql',
    job: 'stripe-reconcile',
    schedule: '0 18 * * *',
    endpoint: '/api/cron/stripe-reconcile',
  },
])('$file', ({ file, job, schedule, endpoint }) => {
  const sql = readPending(file);
  const beforeSchedule = sql.slice(0, sql.search(/cron\.schedule\(/i));
  const jobBody = sql.match(/cron\.schedule\([\s\S]*?\$\$([\s\S]*?)\$\$\s*\)/i)?.[1] ?? '';

  it(`${job} を ${schedule} で登録する`, () => {
    expect(sql).toMatch(new RegExp(`cron\\.schedule\\(\\s*'${escapeRegExp(job)}'\\s*,\\s*'${escapeRegExp(schedule)}'`, 'i'));
  });

  it('pg_net を用意し、秘密が無くてもマイグレーション本体は止めずに警告する', () => {
    expect(sql).toMatch(/create extension if not exists pg_net/i);
    expect(beforeSchedule).not.toMatch(/raise\s+exception/i);
    expect(beforeSchedule).toMatch(/raise\s+warning/i);
  });

  it('秘密は実行のときに Vault から読み、欠けていれば送る前に止める', () => {
    expect(jobBody).toMatch(/vault\.decrypted_secrets/i);
    expect(jobBody).toMatch(/name = 'app_base_url'/);
    expect(jobBody).toMatch(/name = 'cron_secret'/);
    const raiseIndex = jobBody.search(/raise\s+exception/i);
    const postIndex = jobBody.search(/net\.http_post/i);
    expect(raiseIndex).toBeGreaterThan(-1);
    expect(raiseIndex).toBeLessThan(postIndex);
  });

  it('入口へ Bearer の合言葉を付けて POST し、60秒まで待つ', () => {
    expect(jobBody).toContain(endpoint);
    expect(jobBody).toMatch(/'Authorization',\s*'Bearer '\s*\|\|\s*v_cron_secret/);
    expect(jobBody).toMatch(/timeout_milliseconds\s*:=\s*60000/);
  });
});

describe('worker の登録（R-32）', () => {
  it('10秒ごとの登録を残さない', () => {
    expect(readPending('schedule_stripe_webhook_worker.sql')).not.toMatch(/'10 seconds'/);
  });
});
