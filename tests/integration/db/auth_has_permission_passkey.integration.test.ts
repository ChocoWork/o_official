/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createLiveAppSession, jwtClaims, seedApprovedPasskeys } from './helpers/app-session';
import { amrCases } from '../../unit/helpers/staff-claims';

/**
 * SEC-AUTH-010-AC-03 / DATA-AUTH-008 / SEC-AUTH-039 / SEC-AUTH-040: `public.has_permission` は、管理の入口の3条件
 * （amr に passkey・24時間以内・DB で数えた認めたパスキー2本以上。SR-AUTH-014）と、結び付いた生きた session を求める（波 5 の M2 を、
 * パスキーの入口に切り替えた移行 E）。JWT の aal・staff_passkeys_ok は見ない。会員の本人の行の表（profiles・orders・order_items）は
 * RESTRICTIVE の方針で、結び付いた生きた session を求める（変わらない）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 * 古い名前の aal1・aal2 は、認めたパスキー1本・2本に読み替える（helpers/app-session.ts）。
 */
type Claims = Record<string, unknown>;
type Outcome = { rows: any[]; rowCount: number } | { code: string };
type Role = 'anon' | 'authenticated';

const ADMIN_PERMISSION = 'admin.orders.read';

describeLocalDb('integration: has_permission の管理の入口の3条件と結び付き（移行 E）', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertUser(roleCode: string | null = null): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, $2, jsonb_build_object('role', $3::text), '{}'::jsonb, now(), now())`,
      [id, `integration-aal2-${randomUUID()}@example.com`, roleCode ?? 'user'],
    );
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active)
         select $1, id, true from public.roles where code = $2
         on conflict (user_id, role_id) do update set active = true, expires_at = null`,
        [id, roleCode],
      );
    }
    return id;
  }

  /** PostgREST が取引ごとに入れる役と claims を再現する。断られても取引を壊さないよう savepoint で包む。 */
  async function attempt(role: Role, claims: Claims | string | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint passkey_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (claims !== null) {
        await db().query("select set_config('request.jwt.claims', $1, true)", [
          typeof claims === 'string' ? claims : JSON.stringify(claims),
        ]);
      }
      const result = await db().query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint passkey_attempt');
      await db().query('release savepoint passkey_attempt');
    }
  }

  async function allowed(claims: Claims, userId?: string): Promise<boolean> {
    const outcome = await attempt('authenticated', claims, `select public.has_permission('${ADMIN_PERMISSION}') as value`);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code} for ${userId ?? 'actor'}`);
    return outcome.rows[0].value;
  }

  test('DATA-AUTH-008 ①今の passkey の amr・認めたパスキー2本・結び付いた生きた session の管理者は true（aal は aal1 のまま）', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal2' });

    const claims = jwtClaims(admin, session, 'aal2');
    expect(claims.aal).toBe('aal1');
    expect(await allowed(claims)).toBe(true);
  });

  test('DATA-AUTH-008 ②認めたパスキーが1本の店員は、今の passkey の amr・結び付いた生きた session があっても false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal1' });

    expect(await allowed(jwtClaims(admin, session, 'aal2'))).toBe(false);
  });

  test('DATA-AUTH-016 ②認めたパスキーが0本の店員は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal1' });
    await db().query('delete from private.approved_passkeys where user_id = $1', [admin]);

    expect(await allowed(jwtClaims(admin, session, 'aal2'))).toBe(false);
  });

  test('DATA-AUTH-016 ②JWT の印 staff_passkeys_ok が真でも、認めたパスキーが1本なら false（印は判定に使わない）', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal1' });

    expect(await allowed({ ...jwtClaims(admin, session), staff_passkeys_ok: true })).toBe(false);
  });

  test('DATA-AUTH-016 ②認めた鍵が GoTrue で消された直後（更新を待たない）は、JWT の印が真のままでも false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims = { ...jwtClaims(admin, session), staff_passkeys_ok: true };
    expect(await allowed(claims)).toBe(true);

    await db().query(
      'delete from auth.webauthn_credentials where id = (select id from auth.webauthn_credentials where user_id = $1 order by created_at limit 1)',
      [admin],
    );

    expect(await allowed(claims)).toBe(false);
  });

  test('DATA-AUTH-016 ②認めた鍵が足りなくなった後に別の鍵を認めて2本に戻すと true に戻る', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims = jwtClaims(admin, session);
    await db().query(
      'delete from auth.webauthn_credentials where id = (select id from auth.webauthn_credentials where user_id = $1 order by created_at limit 1)',
      [admin],
    );
    expect(await allowed(claims)).toBe(false);

    await seedApprovedPasskeys(db(), admin, 2);

    expect(await allowed(claims)).toBe(true);
  });

  test('DATA-AUTH-016 ③認めていない鍵（GoTrue に直に足した鍵）は数えない', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal1' });
    await db().query(
      `insert into auth.webauthn_credentials (user_id, credential_id, public_key, friendly_name)
       values ($1::uuid, gen_random_bytes(32), gen_random_bytes(32), 'direct')`,
      [admin],
    );

    expect(await allowed(jwtClaims(admin, session))).toBe(false);
  });

  // 表の時刻は、取引の中で固定の now()（DB の秒）を基準に作り直す（86400秒ちょうどの境が、試験の動いた時間でずれないように）
  test.each(amrCases(0).filter((c) => c.claims !== null).map((c) => c.name))(
    'DATA-AUTH-016 ③amr の値の表（TS と同じ表）: %s',
    async (name) => {
      const dbNow = Number((await db().query('select floor(extract(epoch from now()))::bigint as n')).rows[0].n);
      const amrCase = amrCases(dbNow).find((c) => c.name === name);
      if (!amrCase) throw new Error(`表に無い: ${name}`);
      const admin = await insertUser('admin');
      const session = await createLiveAppSession(db(), admin);
      const claims: Claims = { ...jwtClaims(admin, session) };
      const given = (amrCase.dbClaims ?? amrCase.claims) as { amr?: unknown };
      if ('amr' in given) claims.amr = given.amr;
      else delete claims.amr;

      expect(await allowed(claims)).toBe(amrCase.amrOk);
    },
  );

  test('DATA-AUTH-008 ③aal が aal2 でも passkey の amr が無ければ false（aal は見ない）', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims: Claims = { ...jwtClaims(admin, session), aal: 'aal2' };
    delete claims.amr;

    expect(await allowed(claims)).toBe(false);
  });

  test('DATA-AUTH-008 ③amr が otp だけの claims（パスワード・メールのコードの通行証）は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims: Claims = { ...jwtClaims(admin, session), amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] };
    delete claims.aal;

    expect(await allowed(claims)).toBe(false);
  });

  test('DATA-AUTH-008 ④session_id が無い claims は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims = jwtClaims(admin, session);
    delete claims.session_id;

    expect(await allowed(claims)).toBe(false);
  });

  test.each(['not-a-uuid', '', '00000000-0000-0000-0000-00000000000z', 'DROP TABLE x'])(
    'DATA-AUTH-008 ⑤形が悪い session_id（%j）は例外でなく false',
    async (bad) => {
      const admin = await insertUser('admin');
      const session = await createLiveAppSession(db(), admin);

      expect(await allowed({ ...jwtClaims(admin, session), session_id: bad })).toBe(false);
    },
  );

  test('DATA-AUTH-008 ⑥auth.sessions だけにあり public.sessions に行が無い（アプリを通らない）session は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { bind: false });

    expect(await allowed(jwtClaims(admin, session))).toBe(false);
  });

  test('DATA-AUTH-008 ⑦public.sessions の行が失効した後は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    expect(await allowed(jwtClaims(admin, session))).toBe(true);

    await db().query('update public.sessions set revoked_at = now() where auth_session_id = $1', [session.sessionId]);

    expect(await allowed(jwtClaims(admin, session))).toBe(false);
  });

  test('DATA-AUTH-008 ⑧auth.sessions の行を消した後は false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    expect(await allowed(jwtClaims(admin, session))).toBe(true);

    await db().query('delete from auth.sessions where id = $1', [session.sessionId]);

    expect(await allowed(jwtClaims(admin, session))).toBe(false);
  });

  test('DATA-AUTH-008 ⑨ACL の無い会員は、認めたパスキー2本・今の passkey・結び付いた生きた session でも false', async () => {
    const member = await insertUser(null);
    const session = await createLiveAppSession(db(), member, { aal: 'aal2' });

    expect(await allowed(jwtClaims(member, session, 'aal2'))).toBe(false);
  });

  test('DATA-AUTH-008 ⑩EXECUTE は authenticated と service_role に有り、anon に無い', async () => {
    const result = await db().query(
      `select has_function_privilege('authenticated', 'public.has_permission(text)', 'EXECUTE') as authenticated,
              has_function_privilege('anon', 'public.has_permission(text)', 'EXECUTE') as anon,
              has_function_privilege('service_role', 'public.has_permission(text)', 'EXECUTE') as service_role`,
    );
    expect(result.rows[0]).toEqual({ authenticated: true, anon: false, service_role: true });
  });

  test('DATA-AUTH-008 ⑪公開の読み方針は aal1 の一般会員（結び付き無し）でも止まらず、非公開の行は見えない', async () => {
    const member = await insertUser(null);
    const marker = `aal2-public-${randomUUID()}`;
    const published = await db().query(
      `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'EVENT', '2026-05-01', 'news/integration/aal2.png', 'summary', 'body', 'published') returning id::text as id`,
      [marker],
    );
    const draft = await db().query(
      `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'EVENT', '2026-05-01', 'news/integration/aal2.png', 'summary', 'body', 'private') returning id::text as id`,
      [`${marker}-private`],
    );
    // 結び付いていない aal1 の通行証（session_id も無い）
    const claims = { sub: member, role: 'authenticated', aal: 'aal1' };

    const outcome = await attempt(
      'authenticated',
      claims,
      'select id::text as id from public.news_articles where id::text = any($1::text[]) order by id',
      [[published.rows[0].id, draft.rows[0].id]],
    );
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    expect(outcome.rows.map((row) => row.id)).toEqual([published.rows[0].id]);
  });

  describe('会員の本人の行（profiles・orders・order_items）', () => {
    async function seedMemberOrder(userId: string, guestSession: string) {
      await db().query(
        `insert into public.profiles (user_id, display_name) values ($1, 'before') on conflict (user_id) do nothing`,
        [userId],
      );
      const order = await db().query(
        `insert into public.orders (session_id, user_id, status, subtotal_amount, shipping_amount, total_amount, currency)
         values ($1, $2, 'pending'::public.order_status, 5000, 0, 5000, 'jpy') returning id::text as id`,
        [guestSession, userId],
      );
      const orderId = order.rows[0].id as string;
      const item = await db().query('select id from public.items order by id limit 1');
      const line = await db().query(
        `insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total)
         values ($1, $2, 'aal2 test', 5000, 1, 5000) returning id::text as id`,
        [orderId, item.rows[0].id],
      );
      return { orderId, lineId: line.rows[0].id as string };
    }

    async function visibleRows(claims: Claims, userId: string, orderId: string) {
      const profiles = await attempt('authenticated', claims, 'select user_id from public.profiles where user_id = $1', [userId]);
      const orders = await attempt('authenticated', claims, 'select id from public.orders where id = $1', [orderId]);
      const items = await attempt('authenticated', claims, 'select id from public.order_items where order_id = $1', [orderId]);
      const count = (outcome: Outcome) => ('code' in outcome ? outcome.code : outcome.rowCount);
      return { profiles: count(profiles), orders: count(orders), items: count(items) };
    }

    test('DATA-AUTH-008 ⑫結び付いた生きた session の本人は、自分の行を読み書きできる', async () => {
      const member = await insertUser(null);
      const { orderId } = await seedMemberOrder(member, `guest-${randomUUID()}`);
      const session = await createLiveAppSession(db(), member, { aal: 'aal1' });
      const claims = jwtClaims(member, session, 'aal1');

      expect(await visibleRows(claims, member, orderId)).toEqual({ profiles: 1, orders: 1, items: 1 });
      const update = await attempt('authenticated', claims, "update public.profiles set display_name = 'after' where user_id = $1", [member]);
      expect(update).toMatchObject({ rowCount: 1 });
    });

    test.each([
      ['結び付いていない session', { bind: false }],
      ['失効した session', { revoked: true }],
    ] as const)('DATA-AUTH-008 ⑫%s の本人は、自分の行が 0 行で、更新も 0 行', async (_label, options) => {
      const member = await insertUser(null);
      const { orderId } = await seedMemberOrder(member, `guest-${randomUUID()}`);
      const session = await createLiveAppSession(db(), member, { aal: 'aal1', ...options });
      const claims = jwtClaims(member, session, 'aal1');

      expect(await visibleRows(claims, member, orderId)).toEqual({ profiles: 0, orders: 0, items: 0 });
      const update = await attempt('authenticated', claims, "update public.profiles set display_name = 'after' where user_id = $1", [member]);
      expect(update).toMatchObject({ rowCount: 0 });
    });

    test('DATA-AUTH-008 ⑫session_id の無い本人（anon キーで取った通行証）も 0 行', async () => {
      const member = await insertUser(null);
      const { orderId } = await seedMemberOrder(member, `guest-${randomUUID()}`);

      expect(await visibleRows({ sub: member, role: 'authenticated', aal: 'aal1' }, member, orderId)).toEqual({
        profiles: 0,
        orders: 0,
        items: 0,
      });
    });

    test('DATA-AUTH-008 ⑫anon の app.session_id の注文は今までどおり読める', async () => {
      const member = await insertUser(null);
      const guestSession = `guest-${randomUUID()}`;
      const { orderId } = await seedMemberOrder(member, guestSession);

      await db().query('savepoint guest_read');
      await db().query('set local role anon');
      await db().query("select set_config('app.session_id', $1, true)", [guestSession]);
      const orders = await db().query('select id::text as id from public.orders where id = $1', [orderId]);
      const items = await db().query('select id from public.order_items where order_id = $1', [orderId]);
      await db().query('rollback to savepoint guest_read');
      await db().query('release savepoint guest_read');

      expect(orders.rows).toEqual([{ id: orderId }]);
      expect(items.rows).toHaveLength(1);
    });

    test('DATA-AUTH-008 ⑫認めたパスキー2本で結び付いた生きた session の管理者は、他人の注文を読める。1本の管理者は読めない', async () => {
      const owner = await insertUser(null);
      const { orderId } = await seedMemberOrder(owner, `guest-${randomUUID()}`);
      const admin = await insertUser('admin');
      // 認めた本数は利用者ごとなので、1本の対照は別の店員で作る
      const aal2 = await createLiveAppSession(db(), admin, { aal: 'aal2' });
      const other = await insertUser('admin');
      const aal1 = await createLiveAppSession(db(), other, { aal: 'aal1' });

      const read = async (claims: Claims) => {
        const outcome = await attempt('authenticated', claims, 'select id from public.orders where id = $1', [orderId]);
        return 'code' in outcome ? outcome.code : outcome.rowCount;
      };
      expect(await read(jwtClaims(admin, aal2, 'aal2'))).toBe(1);
      expect(await read(jwtClaims(other, aal1, 'aal2'))).toBe(0);
    });
  });

  test('DATA-AUTH-008 ⑬aal1 の会員は public.sessions・auth.sessions に行が無くても、例外でなく false を返す', async () => {
    const member = await insertUser(null);

    expect(await allowed({ sub: member, role: 'authenticated', aal: 'aal1', session_id: randomUUID() })).toBe(false);
    const outcome = await attempt('authenticated', { sub: member, role: 'authenticated', aal: 'aal1' }, "select public.has_permission('admin.items.read') as value");
    expect(outcome).toMatchObject({ rows: [{ value: false }] });
  });

  // 移行 E の前の確かめ（本番に当てる時の締め出しの防止）。移行ファイルの DO ブロックをそのまま取り出して流す
  describe('移行 E の前の確かめ（締め出しの防止・土台の本体の一致）', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20261117013000_passkey_staff_entry_conditions.sql'),
      'utf8',
    );
    const block = (tag: string): string => {
      const found = new RegExp(`DO \\$${tag}\\$[\\s\\S]*?\\$${tag}\\$;`).exec(migration);
      if (!found) throw new Error(`移行に DO ブロックが無い: ${tag}`);
      return found[0];
    };
    const run = async (sql: string): Promise<string | null> => {
      await db().query('savepoint guard');
      try {
        await db().query(sql);
        return null;
      } catch (caught) {
        return (caught as { message?: string }).message ?? 'unknown';
      } finally {
        await db().query('rollback to savepoint guard');
      }
    };
    const GUARD = 'passkey_entry_staff_guard';
    // 取引の中だけで、いまいる店員を外した扱いにする（取引は afterEach で巻き戻る）
    const noStaff = () => db().query(
      "update public.user_roles set active = false where role_id in (select id from public.roles where code in ('admin','supporter'))",
    );

    test('DATA-AUTH-008 ⑭有効な店員がいなければ（手元の db reset と同じ空の状態）前の確かめは通る', async () => {
      await noStaff();
      expect(await run(block(GUARD))).toBeNull();
    });

    test('DATA-AUTH-008 ⑭有効な店員がいて、認めた鍵が足りる店員が1人もいなければ PASSKEY_MIGRATION_PRECHECK_FAILED で止まる（0本）', async () => {
      await noStaff();
      await insertUser('admin');
      expect(await run(block(GUARD))).toBe('PASSKEY_MIGRATION_PRECHECK_FAILED');
    });

    test('DATA-AUTH-008 ⑭店員が認めた鍵1本だけ（足りない）でも止まる。supporter でも同じ', async () => {
      await noStaff();
      const supporter = await insertUser('supporter');
      await seedApprovedPasskeys(db(), supporter, 1);
      expect(await run(block(GUARD))).toBe('PASSKEY_MIGRATION_PRECHECK_FAILED');
    });

    test('DATA-AUTH-008 ⑭認めた鍵が足りる店員が1人でもいれば通る（ほかに0本の店員がいても）', async () => {
      await noStaff();
      await insertUser('admin');
      const ready = await insertUser('admin');
      await seedApprovedPasskeys(db(), ready, 2);
      expect(await run(block(GUARD))).toBeNull();
    });

    test('DATA-AUTH-008 ⑭外した店員（active=false）と会員だけなら、鍵が0本でも通る', async () => {
      await noStaff();
      const gone = await insertUser('admin');
      await db().query('update public.user_roles set active = false where user_id = $1', [gone]);
      await insertUser(null);
      expect(await run(block(GUARD))).toBeNull();
    });

    test('DATA-AUTH-008 ⑭has_permission の本体が土台と違えば（移行 E の後の本体は違う）PASSKEY_MIGRATION_PRECHECK_FAILED で止まる。値を今の本体に合わせれば通る', async () => {
      const baseline = block('passkey_entry_baseline');
      expect(await run(baseline)).toBe('PASSKEY_MIGRATION_PRECHECK_FAILED');
      const current = (await db().query("select md5(prosrc) as m from pg_proc where oid = 'public.has_permission(text)'::regprocedure")).rows[0].m;
      expect(await run(baseline.replace('3c4826933eca194a3486f430d361891c', current))).toBeNull();
    });

    test('DATA-AUTH-008 ⑭本当の置き換える前の本体（20261029120100）に戻すと、土台の確かめがそのまま通る（値の書き損じを手元で気付ける）', async () => {
      const old = readFileSync(
        join(process.cwd(), 'supabase', 'migrations', '20261029120100_sec_has_permission_aal2_member_rls.sql'),
        'utf8',
      );
      const body = /^CREATE OR REPLACE FUNCTION public\.has_permission[\s\S]*?\$function\$;/m.exec(old);
      if (!body) throw new Error('20261029120100 に本体が無い');
      await db().query('savepoint pre_e');
      try {
        await db().query(body[0]);
        expect(await run(block('passkey_entry_baseline'))).toBeNull();
      } finally {
        await db().query('rollback to savepoint pre_e');
      }
    });
  });
});
