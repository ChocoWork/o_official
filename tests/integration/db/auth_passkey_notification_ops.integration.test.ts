/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeLocalDb } from './helpers/local-db';

// Passkey stage 3b Task 17 (migration I): the dead-notification check functions and the worker heartbeat job.
// DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a transaction that is rolled back.
const MIGRATION = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261119181323_passkey_notification_ops.sql'), 'utf8');
const KNOWN_8 = ['webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking', 'accounting_post'];
const FNS = ['public.list_unnotified_dead_passkey_notifications(integer)', 'public.mark_passkey_notification_dead_notified(uuid[])'];

describeLocalDb('passkey notification ops (migration I)', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.passkey_notification_outbox');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function dead(over: Record<string, unknown> = {}): Promise<string> {
    const v = { kind: 'staff_demoted', status: 'dead', attempts: 9, code: 'resend_rejected', finished: '2026-11-20T01:00:00Z', ...over };
    const r = await db().query(
      `insert into private.passkey_notification_outbox
         (user_id, kind, subject_is_staff, notify_subject, subject_email, status, attempts, last_error_code, finished_at)
       values ($1, $2, true, false, 'subject@example.com', $3, $4, $5, $6::timestamptz)
       returning id::text as id`,
      [randomUUID(), v.kind, v.status, v.attempts, v.code, v.finished],
    );
    return r.rows[0].id;
  }

  describe('ARC-AUTH-014 the heartbeat job', () => {
    test('ARC-AUTH-014 a heartbeat for passkey_notification_worker can be written; an unknown job is still refused', async () => {
      await db().query(`select public.record_ops_heartbeat('passkey_notification_worker', true, null)`);
      const r = await db().query(`select job from public.get_ops_heartbeats() where job = 'passkey_notification_worker'`);
      expect(r.rows).toHaveLength(1);
      await db().query('savepoint s');
      await expect(db().query(`select public.record_ops_heartbeat('other_job', true, null)`)).rejects.toBeTruthy();
      await db().query('rollback to savepoint s');
    });
  });

  describe('DATA-AUTH-022 list / mark functions', () => {
    test('DATA-AUTH-022 list returns only dead rows with dead_notified_at NULL, oldest finished_at first, with the total', async () => {
      const newer = await dead({ finished: '2026-11-20T03:00:00Z' });
      const older = await dead({ finished: '2026-11-20T01:00:00Z', kind: 'passkey_added' });
      await dead({ status: 'pending', code: null, finished: null });
      const stamped = await dead();
      await db().query('update private.passkey_notification_outbox set dead_notified_at = now() where id = $1', [stamped]);
      const r = await db().query('select * from public.list_unnotified_dead_passkey_notifications(50)');
      expect(r.rows.map((row) => row.id)).toEqual([older, newer]);
      expect(r.rows.map((row) => Number(row.total))).toEqual([2, 2]);
      expect(Object.keys(r.rows[0]).sort()).toEqual(['attempts', 'finished_at', 'id', 'kind', 'last_error_code', 'total']);
      const limited = await db().query('select * from public.list_unnotified_dead_passkey_notifications(1)');
      expect(limited.rows).toHaveLength(1);
      expect(Number(limited.rows[0].total)).toBe(2);
    });

    test('DATA-AUTH-022 mark stamps dead rows once (the second call returns 0) and never changes a pending row', async () => {
      const a = await dead();
      const pending = await dead({ status: 'pending', code: null, finished: null, attempts: 0 });
      expect((await db().query('select public.mark_passkey_notification_dead_notified($1::uuid[]) as n', [[a, pending]])).rows[0].n).toBe(1);
      expect((await db().query('select public.mark_passkey_notification_dead_notified($1::uuid[]) as n', [[a, pending]])).rows[0].n).toBe(0);
      const row = (await db().query('select status, dead_notified_at from private.passkey_notification_outbox where id = $1', [pending])).rows[0];
      expect(row).toEqual({ status: 'pending', dead_notified_at: null });
      expect((await db().query('select count(*)::int as n from public.list_unnotified_dead_passkey_notifications(50)')).rows[0].n).toBe(0);
    });

    test('DATA-AUTH-022 the two functions are service_role only; owner postgres, definer, empty search_path', async () => {
      for (const f of FNS) {
        const r = (await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                  has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                  exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) as pub,
                  (select p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = $1::regprocedure) as attrs`,
          [f],
        )).rows[0];
        expect(r).toEqual({ anon: false, auth: false, svc: true, pub: false, attrs: true });
      }
    });
  });

  describe('ARC-AUTH-014 the precheck compares the job SET, not the definition string', () => {
    const blocks = [...MIGRATION.matchAll(/^DO \$\$[\s\S]*?^\$\$;?$/gm)].map((m) => m[0]);
    const precheck = blocks[0];
    const rebuild = blocks[1];
    const run = async (sql: string): Promise<{ message?: string; detail?: string } | null> => {
      await db().query('savepoint guard');
      try {
        await db().query(sql);
        return null;
      } catch (caught) {
        return caught as { message?: string; detail?: string };
      } finally {
        await db().query('rollback to savepoint guard');
      }
    };
    const setCheck = (jobs: string[]) => db().query(
      `alter table public.ops_job_heartbeats drop constraint ops_job_heartbeats_job_check,
         add constraint ops_job_heartbeats_job_check check (job in (${jobs.map((j) => `'${j}'`).join(', ')}))`,
    );
    const jobsOf = async (): Promise<string[]> => (await db().query(
      `select array_agg(m[1] order by m[1]) as jobs from pg_constraint c,
         lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
        where c.conname = 'ops_job_heartbeats_job_check'`,
    )).rows[0].jobs;

    test('ARC-AUTH-014 the file has the precheck and the rebuild as the first two DO blocks', () => {
      expect(blocks.length).toBeGreaterThanOrEqual(3);
      expect(precheck).toContain('passkey_i_job_check_drift');
      expect(rebuild).toContain('ADD CONSTRAINT ops_job_heartbeats_job_check');
    });

    test('ARC-AUTH-014 case (a): exactly the known 8 passes, and the rebuild makes it 9', async () => {
      await setCheck(KNOWN_8);
      expect(await run(precheck)).toBeNull();
      await setCheck(KNOWN_8);
      await db().query(rebuild);
      expect(await jobsOf()).toEqual([...KNOWN_8, 'passkey_notification_worker'].sort());
    });

    test('ARC-AUTH-014 case (a) does not depend on the order of the names in the definition', async () => {
      await setCheck([...KNOWN_8].reverse());
      expect(await run(precheck)).toBeNull();
    });

    test('ARC-AUTH-014 case (b): a set that already holds passkey_notification_worker passes with a NOTICE and the rebuild leaves it alone', async () => {
      expect(await jobsOf()).toContain('passkey_notification_worker');
      expect(await run(precheck)).toBeNull();
      const before = (await db().query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ops_job_heartbeats_job_check'`)).rows[0].d;
      await db().query(rebuild);
      const after = (await db().query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ops_job_heartbeats_job_check'`)).rows[0].d;
      expect(after).toBe(before);
    });

    test.each([
      ['an extra job', [...KNOWN_8, 'other_job']],
      ['a missing job', KNOWN_8.slice(1)],
    ])('ARC-AUTH-014 drift (%s) stops with passkey_i_job_check_drift', async (_label, jobs) => {
      await setCheck(jobs);
      expect(await run(precheck)).toMatchObject({ message: 'PASSKEY_MIGRATION_PRECHECK_FAILED', detail: 'passkey_i_job_check_drift' });
    });

    test.each(['status', 'finished_at', 'last_error_code'])('ARC-AUTH-014 without the outbox column %s the precheck stops with passkey_i_precheck', async (column) => {
      await db().query(`alter table private.passkey_notification_outbox rename column ${column} to ${column}_x`);
      expect(await run(precheck)).toMatchObject({ message: 'PASSKEY_MIGRATION_PRECHECK_FAILED', detail: 'passkey_i_precheck' });
    });
  });
});
