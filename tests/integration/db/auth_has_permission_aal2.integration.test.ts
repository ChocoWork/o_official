/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createLiveAppSession, jwtClaims } from './helpers/app-session';

/**
 * SEC-AUTH-010-AC-03 / DATA-AUTH-008: 波 5 の M2。`public.has_permission` は aal2 と、結び付いた生きた session を
 * 求める。会員の本人の行の表（profiles・orders・order_items）は RESTRICTIVE の方針で、結び付いた生きた session を求める。
 * 手元の使い捨て DB（M1・M2 を当てた後）でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 * 計画: docs/superpowers/plans/2026-10-29-wave5-session-binding-aal2-db.md（Task 6）
 */
type Claims = Record<string, unknown>;
type Outcome = { rows: any[]; rowCount: number } | { code: string };
type Role = 'anon' | 'authenticated';

const ADMIN_PERMISSION = 'admin.orders.read';

describeLocalDb('integration: has_permission の aal2 と結び付き（M2）', (db) => {
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
    await db().query('savepoint aal2_attempt');
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
      await db().query('rollback to savepoint aal2_attempt');
      await db().query('release savepoint aal2_attempt');
    }
  }

  async function allowed(claims: Claims, userId?: string): Promise<boolean> {
    const outcome = await attempt('authenticated', claims, `select public.has_permission('${ADMIN_PERMISSION}') as value`);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code} for ${userId ?? 'actor'}`);
    return outcome.rows[0].value;
  }

  test('DATA-AUTH-008 ①aal2 かつ結び付いた生きた session の管理者は true', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal2' });

    expect(await allowed(jwtClaims(admin, session, 'aal2'))).toBe(true);
  });

  test('DATA-AUTH-008 ②aal1 の claims は、結び付いた生きた session があっても false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin, { aal: 'aal1' });

    expect(await allowed(jwtClaims(admin, session, 'aal1'))).toBe(false);
  });

  test('DATA-AUTH-008 ③aal が無い claims は aal1 として false', async () => {
    const admin = await insertUser('admin');
    const session = await createLiveAppSession(db(), admin);
    const claims = jwtClaims(admin, session);
    delete claims.aal;

    expect(await allowed(claims)).toBe(false);
  });

  test('DATA-AUTH-008 ④session_id が無い claims は false', async () => {
    const admin = await insertUser('admin');
    await createLiveAppSession(db(), admin);

    expect(await allowed({ sub: admin, role: 'authenticated', aal: 'aal2' })).toBe(false);
  });

  test.each(['not-a-uuid', '', '00000000-0000-0000-0000-00000000000z', 'DROP TABLE x'])(
    'DATA-AUTH-008 ⑤形が悪い session_id（%j）は例外でなく false',
    async (bad) => {
      const admin = await insertUser('admin');
      await createLiveAppSession(db(), admin);

      expect(await allowed({ sub: admin, role: 'authenticated', aal: 'aal2', session_id: bad })).toBe(false);
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

  test('DATA-AUTH-008 ⑨ACL の無い会員は、aal2 で結び付いた生きた session でも false', async () => {
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

    test('DATA-AUTH-008 ⑫aal2 で結び付いた生きた session の管理者は、他人の注文を読める。aal1 の結び付いた管理者は読めない', async () => {
      const owner = await insertUser(null);
      const { orderId } = await seedMemberOrder(owner, `guest-${randomUUID()}`);
      const admin = await insertUser('admin');
      const aal2 = await createLiveAppSession(db(), admin, { aal: 'aal2' });
      const aal1 = await createLiveAppSession(db(), admin, { aal: 'aal1' });

      const read = async (claims: Claims) => {
        const outcome = await attempt('authenticated', claims, 'select id from public.orders where id = $1', [orderId]);
        return 'code' in outcome ? outcome.code : outcome.rowCount;
      };
      expect(await read(jwtClaims(admin, aal2, 'aal2'))).toBe(1);
      expect(await read(jwtClaims(admin, aal1, 'aal1'))).toBe(0);
    });
  });

  test('DATA-AUTH-008 ⑬aal1 の会員は public.sessions・auth.sessions に行が無くても、例外でなく false を返す', async () => {
    const member = await insertUser(null);

    expect(await allowed({ sub: member, role: 'authenticated', aal: 'aal1', session_id: randomUUID() })).toBe(false);
    const outcome = await attempt('authenticated', { sub: member, role: 'authenticated', aal: 'aal1' }, "select public.has_permission('admin.items.read') as value");
    expect(outcome).toMatchObject({ rows: [{ value: false }] });
  });
});
