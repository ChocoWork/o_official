/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { readMigration } from '../../helpers/staged-supabase';

/**
 * LOOK の更新を 1 取引にする関数 admin_update_look（DATA-LOOK-001、API-LOOK-004、SEC-LOOK-015、ADR-0163）。
 * 手元の使い捨て DB でだけ流す。ふつうの試験は取引の中で動かして最後に巻き戻す。同時の更新の確かめだけは
 * 別の接続に commit した行を使うので、最後に必ず消す。
 */
const SIGNATURE = 'public.admin_update_look(bigint,integer,text,text,text,text[],text,bigint[])';
const CALL = `select public.admin_update_look($1::bigint, $2::int, $3::text, $4::text, $5::text, $6::text[], $7::text, $8::bigint[]) as previous`;

describe('DATA-LOOK-001 admin_update_look の移行の形（DB なし）', () => {
  const sql = readMigration('sec_rls_predicates_and_constraints');

  test('DATA-LOOK-001 関数は SECURITY INVOKER・search_path = ・service_role だけに EXECUTE を許す', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.admin_update_look(');
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.admin_update_look\([^)]*\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_update_look\([^)]*\)\s+TO service_role;/);
  });

  test('DATA-LOOK-001 行を FOR UPDATE で締め、NULL の画像は今の画像を保ち、関連の段の失敗に印を付け直す', () => {
    expect(sql).toContain('FROM public.looks AS l WHERE l.id = _look_id FOR UPDATE');
    expect(sql).toContain('image_urls = COALESCE(_image_urls, v_previous)');
    expect(sql).toContain('WHEN foreign_key_violation THEN');
    expect(sql).toContain("RAISE EXCEPTION 'LOOK_ITEMS_WRITE_FAILED' USING ERRCODE = 'P0001'");
    expect(sql).toContain("RAISE EXCEPTION 'LOOK_NOT_FOUND' USING ERRCODE = 'P0002'");
  });

  test('DATA-LOOK-001 移行のヘッダーに関数の DROP と、窓口も同時に戻す注記がある', () => {
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[])');
    expect(sql).toContain('revert the PUT route');
  });
});

describeLocalDb('integration: admin_update_look', (db) => {
  let marker: string;
  let lookId: string;
  let itemA: string;
  let itemB: string;
  let itemC: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-look-update-${randomUUID()}`;
    lookId = await insertLook();
    itemA = await insertItem('a');
    itemB = await insertItem('b');
    itemC = await insertItem('c');
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2), ($1, $3)', [lookId, itemA, itemB]);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertLook(): Promise<string> {
    const result = await db().query(
      `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status)
       values (2026, 'SS', $1, 'before', ARRAY['looks/e2e/before-1.png', 'looks/e2e/before-2.png'], 'private')
       returning id::text as id`,
      [`${marker} look`],
    );
    return result.rows[0].id;
  }

  async function insertItem(suffix: string): Promise<string> {
    const result = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'integration item', 1000, 'TOPS', 'items/e2e/look-update.png', 'published')
       returning id::text as id`,
      [`${marker} item ${suffix}`],
    );
    return result.rows[0].id;
  }

  const args = (overrides: { id?: string; theme?: string; images?: string[] | null; items?: string[] | null } = {}) => [
    overrides.id ?? lookId,
    2027,
    'AW',
    overrides.theme ?? `${marker} after`,
    'after',
    'images' in overrides ? overrides.images : ['looks/e2e/after-1.png'],
    'published',
    'items' in overrides ? overrides.items : [itemB, itemC],
  ];

  /** service_role の役で 1 本流す。失敗しても取引が壊れないよう savepoint の中で流す。 */
  async function callAs(role: 'service_role' | 'anon' | 'authenticated', params: unknown[]): Promise<{ previous?: string[] | null; code?: string; message?: string }> {
    await db().query('savepoint as_role');
    try {
      await db().query(`set local role ${role}`);
      const result = await db().query(CALL, params);
      await db().query('reset role');
      await db().query('release savepoint as_role');
      return { previous: result.rows[0].previous };
    } catch (caught) {
      await db().query('rollback to savepoint as_role');
      const error = caught as { code?: string; message?: string };
      return { code: error.code, message: error.message };
    }
  }

  async function lookRow() {
    const result = await db().query(
      'select season_year, season_type, theme, theme_description, image_urls, status from public.looks where id = $1',
      [lookId],
    );
    return result.rows[0];
  }

  async function linkedItems(): Promise<string[]> {
    const result = await db().query('select item_id::text as item_id from public.look_items where look_id = $1 order by item_id', [lookId]);
    return result.rows.map((row) => row.item_id as string);
  }

  const sorted = (...ids: string[]): string[] => [...ids].sort((a, b) => Number(a) - Number(b));

  test('API-LOOK-004 DATA-LOOK-001 service_role で呼ぶと行と関連が更新され、戻り値は更新前の image_urls', async () => {
    const result = await callAs('service_role', args());

    expect(result).toEqual({ previous: ['looks/e2e/before-1.png', 'looks/e2e/before-2.png'] });
    expect(await lookRow()).toEqual({
      season_year: 2027,
      season_type: 'AW',
      theme: `${marker} after`,
      theme_description: 'after',
      image_urls: ['looks/e2e/after-1.png'],
      status: 'published',
    });
    expect(await linkedItems()).toEqual(sorted(itemB, itemC));
  });

  test('API-LOOK-004 DATA-LOOK-001 _image_urls が NULL なら今の画像を保ち、戻り値も今の画像（画像の無い PUT は他の PUT の画像を上書きしない）', async () => {
    const result = await callAs('service_role', args({ images: null }));

    expect(result.previous).toEqual(['looks/e2e/before-1.png', 'looks/e2e/before-2.png']);
    expect((await lookRow()).image_urls).toEqual(['looks/e2e/before-1.png', 'looks/e2e/before-2.png']);
    expect((await lookRow()).theme).toBe(`${marker} after`);
  });

  test('API-LOOK-004 DATA-LOOK-001 _image_urls が空の配列なら画像を空にする（NULL とは別）', async () => {
    const result = await callAs('service_role', args({ images: [] }));

    expect(result.previous).toEqual(['looks/e2e/before-1.png', 'looks/e2e/before-2.png']);
    expect((await lookRow()).image_urls).toEqual([]);
  });

  test('API-LOOK-004 DATA-LOOK-001 存在しない LOOK は SQLSTATE P0002・メッセージ LOOK_NOT_FOUND', async () => {
    const result = await callAs('service_role', args({ id: '9223372036854775000' }));

    expect(result).toEqual({ code: 'P0002', message: 'LOOK_NOT_FOUND' });
  });

  test('API-LOOK-004 SEC-LOOK-015 存在しない商品の id を含めると SQLSTATE 23503 で、行も関連も呼ぶ前のまま（1 取引で戻る）', async () => {
    const result = await callAs('service_role', args({ items: [itemC, '9223372036854775000'] }));

    expect(result.code).toBe('23503');
    expect(await lookRow()).toMatchObject({ theme: `${marker} look`, status: 'private', image_urls: ['looks/e2e/before-1.png', 'looks/e2e/before-2.png'] });
    expect(await linkedItems()).toEqual(sorted(itemA, itemB));
  });

  test('API-LOOK-004 SEC-LOOK-015 関連の段が外部キー違反以外で失敗したら LOOK_ITEMS_WRITE_FAILED（P0001）に印を付け直し、行の更新も戻る', async () => {
    // 関連の追加で必ず落ちるトリガーを、取引の中だけに作る（rollback で消える）
    await db().query(`create function public.integration_look_items_boom() returns trigger language plpgsql as
      $$ begin raise exception 'boom'; end $$`);
    await db().query(`create trigger integration_look_items_boom before insert on public.look_items
      for each row execute function public.integration_look_items_boom()`);

    const result = await callAs('service_role', args());

    expect(result).toEqual({ code: 'P0001', message: 'LOOK_ITEMS_WRITE_FAILED' });
    expect(await lookRow()).toMatchObject({ theme: `${marker} look`, status: 'private', image_urls: ['looks/e2e/before-1.png', 'looks/e2e/before-2.png'] });
    expect(await linkedItems()).toEqual(sorted(itemA, itemB));
  });

  test('API-LOOK-004 DATA-LOOK-001 CHECK に当たる値（201 字のテーマ）は 23514 で、行も関連も変わらない', async () => {
    const result = await callAs('service_role', args({ theme: 't'.repeat(201) }));

    expect(result.code).toBe('23514');
    expect((await lookRow()).theme).toBe(`${marker} look`);
    expect(await linkedItems()).toEqual(sorted(itemA, itemB));
  });

  test('API-LOOK-004 DATA-LOOK-001 重なった _item_ids は 1 行ずつ入る', async () => {
    await callAs('service_role', args({ items: [itemC, itemC, itemB, itemC] }));

    expect(await linkedItems()).toEqual(sorted(itemB, itemC));
  });

  test('API-LOOK-004 DATA-LOOK-001 空の配列・NULL の _item_ids は関連を 0 件にする', async () => {
    await callAs('service_role', args({ items: [] }));
    expect(await linkedItems()).toEqual([]);

    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [lookId, itemA]);
    await callAs('service_role', args({ items: null }));
    expect(await linkedItems()).toEqual([]);
  });

  test.each(['anon', 'authenticated'] as const)('API-LOOK-004 DATA-LOOK-001 %s は呼べず（42501）、何も変わらない', async (role) => {
    const result = await callAs(role, args());

    expect(result.code).toBe('42501');
    expect((await lookRow()).theme).toBe(`${marker} look`);
    expect(await linkedItems()).toEqual(sorted(itemA, itemB));
  });

  test('API-LOOK-004 DATA-LOOK-001 ACL: service_role だけが EXECUTE でき、PUBLIC の grantee が無い', async () => {
    const result = await db().query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service_role,
              exists (
                select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) as public_grantee`,
      [SIGNATURE],
    );

    expect(result.rows).toEqual([{ anon: false, authenticated: false, service_role: true, public_grantee: false }]);
  });

  test('DATA-LOOK-001 定義: SECURITY INVOKER・search_path が空・戻りは text[]', async () => {
    const result = await db().query(
      `select prosecdef, proconfig, pg_get_function_result(oid) as result
       from pg_proc where oid = $1::regprocedure`,
      [SIGNATURE],
    );

    expect(result.rows).toEqual([{ prosecdef: false, proconfig: ['search_path=""'], result: 'text[]' }]);
  });
});

describeLocalDb('integration: admin_update_look の同時の更新', () => {
  // 別の接続に commit した行を使う。最後に必ず消す（look_items は LOOK の削除で連鎖して消える）
  test('API-LOOK-004 SEC-LOOK-015 同じ LOOK の更新は行を締め、先の取引が終わるまで後の取引を待たせる（lock_timeout で 55P03）', async () => {
    const setup = await connectLocalDb();
    const first = await connectLocalDb();
    const second = await connectLocalDb();
    const marker = `integration-look-update-lock-${randomUUID()}`;
    let lookId: string | undefined;
    let itemId: string | undefined;
    try {
      lookId = (
        await setup.query(
          `insert into public.looks (season_year, season_type, theme, image_urls)
           values (2026, 'SS', $1, ARRAY['looks/e2e/lock.png']) returning id::text as id`,
          [marker],
        )
      ).rows[0].id;
      itemId = (
        await setup.query(
          `insert into public.items (name, description, price, category, image_url, status)
           values ($1, 'integration item', 1000, 'TOPS', 'items/e2e/look-update-lock.png', 'published') returning id::text as id`,
          [marker],
        )
      ).rows[0].id;
      const params = [lookId, 2026, 'SS', marker, '', null, 'private', [itemId]];

      await first.query('begin');
      await first.query('set local role service_role');
      await first.query(CALL, params);

      await second.query('begin');
      await second.query('set local role service_role');
      await second.query("set local lock_timeout = '300ms'");
      let code: string | undefined;
      try {
        await second.query(CALL, params);
      } catch (caught) {
        code = (caught as { code?: string }).code;
      }
      expect(code).toBe('55P03');
      await second.query('rollback');

      await first.query('commit');
      // 先の取引が終わった後は通る
      await second.query('begin');
      await second.query('set local role service_role');
      const after = await second.query(CALL, params);
      await second.query('commit');
      expect(after.rows[0].previous).toEqual(['looks/e2e/lock.png']);
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      await cleanup(setup, lookId, itemId);
      await Promise.all([setup.end(), first.end(), second.end()]);
    }
  });
});

async function cleanup(client: PgClient, lookId: string | undefined, itemId: string | undefined): Promise<void> {
  if (lookId) {
    await client.query('delete from public.looks where id = $1', [lookId]);
  }
  if (itemId) {
    await client.query('delete from public.items where id = $1', [itemId]);
  }
}
