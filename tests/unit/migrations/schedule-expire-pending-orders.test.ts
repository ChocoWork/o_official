import fs from 'node:fs';
import path from 'node:path';

/**
 * 未入金注文の掃除ジョブの登録（FREQ-368、レビュー指摘⑦）。
 *
 * Vault に秘密が無い環境（ローカル・CI・プレビュー）でマイグレーションが止まると、
 * 以降のマイグレーションも当たらず、DB を作り直せなくなる。マイグレーションは環境に
 * よらず同じ結果になるべきなので、ここでは止めない。
 *
 * 代わりにジョブ本体で秘密を確認する。実測では、秘密が欠けたまま本体を動かすと
 *   - 両方無い: url が null で not-null 違反（送信されない）
 *   - CRON_SECRET だけ無い: Authorization が null のまま送信される（実行のたびに 401）
 * となるため、送信前に止める。失敗は cron.job_run_details に残るので運用で拾える。
 */

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/pending/schedule_expire_pending_orders.sql',
);
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

/** cron.schedule に渡しているジョブ本体（$$ ... $$ の中身）。 */
const jobBody = sql.match(/cron\.schedule\([\s\S]*?\$\$([\s\S]*?)\$\$\s*\)/)?.[1] ?? '';

/** 呼ばれる側（Next.js のルート）が自分に許している時間。 */
const ROUTE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/app/api/cron/expire-pending-orders/route.ts'),
  'utf8',
);
const routeMaxDurationSec = Number(ROUTE_SRC.match(/export const maxDuration = (\d+)/)?.[1]);
const routeTimeBudgetMs = Number(
  (ROUTE_SRC.match(/const TIME_BUDGET_MS = ([\d_]+)/)?.[1] ?? '').replace(/_/g, ''),
);
const jobTimeoutMs = Number(jobBody.match(/timeout_milliseconds\s*:=\s*(\d+)/)?.[1]);

describe('未入金注文の掃除ジョブの登録', () => {
  it('pg_net を用意する', () => {
    expect(sql).toMatch(/create extension if not exists pg_net/i);
  });

  it('毎時0分に expire-pending-orders を登録する', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'expire-pending-orders'\s*,\s*'0 \* \* \* \*'/);
  });

  describe('Vault の秘密が無い環境でも止めない', () => {
    it('マイグレーション本体は例外で止めない', () => {
      // cron.schedule より前（＝マイグレーション本体）に raise exception を置かない
      const beforeSchedule = sql.slice(0, sql.search(/cron\.schedule\(/));
      expect(beforeSchedule).not.toMatch(/raise\s+exception/i);
    });

    it('秘密が足りないことは警告で知らせる', () => {
      const beforeSchedule = sql.slice(0, sql.search(/cron\.schedule\(/));
      expect(beforeSchedule).toMatch(/raise\s+warning/i);
      expect(beforeSchedule).toMatch(/cron_secret/);
      expect(beforeSchedule).toMatch(/app_base_url/);
    });
  });

  describe('ジョブ本体', () => {
    it('ジョブ本体が見つかる', () => {
      expect(jobBody).not.toBe('');
    });

    it('秘密は実行時に Vault から読む（定義に焼き込まない）', () => {
      expect(jobBody).toMatch(/vault\.decrypted_secrets/);
      expect(jobBody).toMatch(/name = 'app_base_url'/);
      expect(jobBody).toMatch(/name = 'cron_secret'/);
    });

    it('秘密が欠けていれば送信前に例外で止める', () => {
      const raiseIndex = jobBody.search(/raise\s+exception/i);
      const postIndex = jobBody.search(/net\.http_post/);
      expect(raiseIndex).toBeGreaterThan(-1);
      expect(postIndex).toBeGreaterThan(-1);
      expect(raiseIndex).toBeLessThan(postIndex);
    });

    it('例外文には秘密の名前だけを書き、値を出さない（ASVS 7.1.1）', () => {
      const raiseStatement = jobBody.match(/raise\s+exception[^;]*/i)?.[0] ?? '';
      expect(raiseStatement).toMatch(/app_base_url|cron_secret/);
      expect(raiseStatement).not.toMatch(/decrypted_secret/);
    });

    it('Authorization は Bearer で渡し、タイムアウトを指定する', () => {
      expect(jobBody).toMatch(/'Authorization',\s*'Bearer '/);
      expect(jobBody).toMatch(/timeout_milliseconds/);
    });
  });

  // 呼ぶ側が先に諦めると、ルートは働いているのに cron.job_run_details と net._http_response には
  // タイムアウトだけが残る。運用は「毎回失敗している」としか見えず、実際に何件片付いたのか分からない
  // （FREQ-389 と同じ回で直した優先度低の指摘）。
  it('pg_net のタイムアウトは、ルートが自分で打ち切るより後にする', () => {
    expect(jobTimeoutMs).toBeGreaterThan(routeTimeBudgetMs);
  });

  it('pg_net のタイムアウトは、ルートの実行上限より短くしない', () => {
    expect(jobTimeoutMs).toBeGreaterThanOrEqual(routeMaxDurationSec * 1000);
  });
});
