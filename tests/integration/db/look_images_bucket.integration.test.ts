/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * 画像の置き場 look-images（DATA-LOOK-005）。置き場の行は手元の見本 supabase/seed.sql が作る。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した物の行は残らない。
 */

type Outcome = { rows: any[]; rowCount: number } | { code: string };
type Role = 'anon' | 'authenticated' | 'service_role';

describeLocalDb('integration: look images bucket', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  // PostgREST が取引ごとに入れる役と JWT のクレームを再現する。権限の誤りで取引を壊さないよう savepoint で包む
  async function attempt(role: Role, claims: Record<string, unknown> | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint bucket_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (claims) await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint bucket_attempt');
      await db().query('release savepoint bucket_attempt');
    }
  }

  // 断られた（権限の誤り）か、行が1つも見えないかのどちらかなら「触れない」とみなす
  function untouched(outcome: Outcome): 'untouched' | Outcome {
    if ('code' in outcome) return outcome.code === '42501' ? 'untouched' : outcome;
    return outcome.rowCount === 0 ? 'untouched' : outcome;
  }

  function objectPath(): string {
    return `looks/2026-10-24/${randomUUID()}.png`;
  }

  async function insertObject(): Promise<string> {
    const res = await db().query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('look-images', $1, jsonb_build_object('mimetype', 'image/png', 'size', 1))
       returning id`,
      [objectPath()],
    );
    return res.rows[0].id as string;
  }

  const visitors: Array<[string, Role, Record<string, unknown> | null]> = [
    ['anon', 'anon', null],
    ['ログイン中の人', 'authenticated', { sub: randomUUID(), role: 'authenticated' }],
  ];

  test('DATA-LOOK-005 置き場 look-images は非公開で、大きさと種類の上限を付けない', async () => {
    const res = await db().query(
      `select id, name, public, file_size_limit, allowed_mime_types
       from storage.buckets
       where id = 'look-images'`,
    );
    expect(res.rows).toEqual([
      { id: 'look-images', name: 'look-images', public: false, file_size_limit: null, allowed_mime_types: null },
    ]);
  });

  test('DATA-LOOK-005 storage.objects に look-images の方針を作らない', async () => {
    const res = await db().query(
      `select count(*)::int as n
       from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and (coalesce(qual, '') like '%look-images%' or coalesce(with_check, '') like '%look-images%')`,
    );
    expect(res.rows[0].n).toBe(0);
  });

  test.each(visitors)('DATA-LOOK-005 %s は look-images の物を読めず、直せない', async (_label, role, claims) => {
    const id = await insertObject();

    expect(untouched(await attempt(role, claims, 'select id from storage.objects where id = $1', [id]))).toBe('untouched');
    expect(untouched(await attempt(role, claims,
      "select id from storage.objects where bucket_id = 'look-images'"))).toBe('untouched');
    expect(untouched(await attempt(role, claims,
      'update storage.objects set metadata = metadata where id = $1 returning id', [id]))).toBe('untouched');
  });

  test.each(visitors)('DATA-LOOK-005 %s は look-images に物を足せない（42501）', async (_label, role, claims) => {
    const outcome = await attempt(role, claims,
      "insert into storage.objects (bucket_id, name) values ('look-images', $1) returning id", [objectPath()]);
    expect(outcome).toEqual({ code: '42501' });
  });

  test('DATA-LOOK-005 service role は look-images の物を読める', async () => {
    const id = await insertObject();

    const outcome = await attempt('service_role', null, 'select id, bucket_id from storage.objects where id = $1', [id]);
    expect(outcome).toEqual({ rows: [{ id, bucket_id: 'look-images' }], rowCount: 1 });
  });
});
