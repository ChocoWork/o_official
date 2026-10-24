/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb } from './helpers/local-db';
import {
  addItemVariant, createCatalogFixture, insertOrderWithLines, insertOrderWithStockLine, variantStock, withLedgerLock,
} from './helpers/order-fixtures';

/**
 * G-1 Task 2: 割当・履歴のモデル（private.group_g_operations・order_item_allocations・order_item_allocation_events・
 * order_item_state_events、orders.paid_at・stock_movements.allocation_operation_id）と、追記の守り・数の確かめ・個別の権限。
 * 実行は controller の使い捨てローカル DB（ふつうの db reset の後）。試験ごとに BEGIN … ROLLBACK で包み、
 * 想定の拒否は SAVEPOINT で回収する。遅延の確かめは `set constraints all immediate` で取引の中で発火させる。
 */

const NEW_TABLES = [
  'private.group_g_operations',
  'public.order_item_allocations',
  'public.order_item_allocation_events',
  'public.order_item_state_events',
];

const NEW_FUNCTIONS = [
  { signature: 'private.reject_group_g_event_mutation()', definer: false },
  { signature: 'private.guard_group_g_allocation_change()', definer: false },
  { signature: 'private.check_group_g_allocation_bounds()', definer: true },
  { signature: 'private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)', definer: true },
];

const OPERATION_FKEYS = [
  ['order_item_allocation_events', 'order_item_allocation_events_operation_id_fkey'],
  ['order_item_allocations', 'order_item_allocations_operation_id_fkey'],
  ['order_item_state_events', 'order_item_state_events_operation_id_fkey'],
  ['stock_movements', 'stock_movements_allocation_operation_id_fkey'],
  // G-2 Task 2: 発注書の追記専用の表のうち、操作の受付に結ぶ 5 つ
  ['purchase_order_revisions', 'purchase_order_revisions_operation_id_fkey'],
  ['purchase_order_receipts', 'purchase_order_receipts_operation_id_fkey'],
  ['purchase_order_attachment_reservations', 'purchase_order_attachment_reservations_operation_id_fkey'],
  ['purchase_order_attachments', 'purchase_order_attachments_operation_id_fkey'],
  ['purchase_order_attachment_revisions', 'purchase_order_attachment_revisions_operation_id_fkey'],
];

type DbFailure = { code?: string; message?: string; detail?: string; constraint?: string };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

describeLocalDb('integration: G-1 割当・履歴のモデル', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** SAVEPOINT の中で流し、失敗を回収して戻す（成功した時は空のオブジェクト） */
  async function failure(run: () => Promise<unknown>): Promise<DbFailure> {
    await db().query('savepoint expected_error');
    let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    finally { await db().query('rollback to savepoint expected_error'); }
    return (error ?? {}) as DbFailure;
  }

  /** 生の DB の文を出さないよう、記号が違う時は決まった文に置き換えて比べる */
  async function rejected(run: () => Promise<unknown>, message: string, code: string, detail?: string) {
    const caught = await failure(run);
    expect({
      message: caught.message === message ? message : 'G1_UNEXPECTED_DB_ERROR',
      code: caught.code,
      ...(detail === undefined ? {} : { detail: caught.detail }),
    }).toEqual({ message, code, ...(detail === undefined ? {} : { detail }) });
  }

  async function violated(run: () => Promise<unknown>, code: string, constraint: string) {
    const caught = await failure(run);
    expect({ code: caught.code, constraint: caught.constraint }).toEqual({ code, constraint });
  }

  const immediate = () => db().query('set constraints all immediate');

  async function bounds(run: () => Promise<unknown>, detail: string) {
    await rejected(async () => { await run(); await immediate(); }, 'GROUP_G_ALLOCATION_BOUNDS', '23514', detail);
  }

  /** ここまでの遅延の確かめを流してから、遅延へ戻す（受付の行を後から書く書き方のまま続けるため） */
  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  async function asRole(role: string, sql: string, params: unknown[] = []) {
    await db().query(`set local role ${role}`);
    return db().query(sql, params);
  }

  type Fixture = { itemId: number; variantId: number; otherVariantId: number; orderId: string; items: string[] };

  /** 同じ商品の 2 つの variant。明細は variant が 3・2、もう一方の variant が 2。在庫は 10 と 5 */
  async function fixture(): Promise<Fixture> {
    const catalog = await createCatalogFixture(db(), { stock: 10 });
    const other = await addItemVariant(db(), { itemId: catalog.itemId, colorName: 'WHITE', sizeLabel: 'L', stock: 5 });
    const order = await insertOrderWithLines(db(), {
      status: 'paid',
      lines: [
        { itemId: catalog.itemId, variantId: catalog.variantId, quantity: 3, fulfillmentType: 'stock', reserved: false },
        { itemId: catalog.itemId, variantId: catalog.variantId, quantity: 2, fulfillmentType: 'backorder' },
        { itemId: catalog.itemId, variantId: other.variantId, quantity: 2, fulfillmentType: 'stock', reserved: false },
      ],
    });
    return {
      itemId: catalog.itemId,
      variantId: catalog.variantId,
      otherVariantId: other.variantId,
      orderId: order.orderId,
      items: order.orderItemIds,
    };
  }

  async function insertOperation(id: string, operation = 'g1_model_test') {
    await db().query(
      `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
       values ($1, $2, gen_random_uuid(), $3, 'test', $4, '{}'::jsonb)`,
      [id, operation, sha256(id), id],
    );
  }

  async function movement(variantId: number, delta: number, reason: string, operationId: string | null, orderItemId: string | null = null): Promise<string> {
    // G-1 Task 14: 台帳のトリガーは共通の押さえを要る。押さえは書く間だけ持ち、試験の取引には残さない
    const res = await withLedgerLock(db(), () => db().query(
      `insert into public.stock_movements (variant_id, delta, reason, allocation_operation_id, order_item_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [variantId, delta, reason, operationId, orderItemId],
    ));
    return String(res.rows[0].id);
  }

  async function insertEvent(event: {
    allocationId: string; eventType: string; quantity: number; operationId: string; sequence?: number;
    counterpartAllocationId?: string | null; reversesEventId?: string | null; stockMovementId?: string | null;
  }): Promise<string> {
    const res = await db().query(
      `insert into public.order_item_allocation_events
         (allocation_id, event_type, quantity, operation_id, sequence, counterpart_allocation_id, reverses_event_id,
          stock_movement_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        event.allocationId, event.eventType, event.quantity, event.operationId, event.sequence ?? 1,
        event.counterpartAllocationId ?? null, event.reversesEventId ?? null, event.stockMovementId ?? null,
      ],
    );
    return res.rows[0].id as string;
  }

  /** 割当の行と作る履歴（transfer 以外は台帳の負数も）を書く。受付の行は呼ぶ側が後で書く */
  async function createAllocation(options: {
    orderItemId: string; variantId: number; quantity: number; operationId: string;
    kind?: 'paid' | 'payment_hold'; eventType?: 'allocate' | 'hold' | 'restore' | 'transfer';
    reversesEventId?: string; counterpartAllocationId?: string;
  }): Promise<{ allocationId: string; eventId: string }> {
    const kind = options.kind ?? 'paid';
    const eventType = options.eventType ?? (kind === 'paid' ? 'allocate' : 'hold');
    const movementId = eventType === 'transfer'
      ? null
      : await movement(options.variantId, -options.quantity, 'purchase', options.operationId, options.orderItemId);
    const allocation = await db().query(
      `insert into public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
       values ($1, $2, $3, $3, $4, $5) returning id`,
      [options.orderItemId, options.variantId, options.quantity, kind, options.operationId],
    );
    const allocationId = allocation.rows[0].id as string;
    const eventId = await insertEvent({
      allocationId, eventType, quantity: options.quantity, operationId: options.operationId,
      stockMovementId: movementId, reversesEventId: options.reversesEventId,
      counterpartAllocationId: options.counterpartAllocationId,
    });
    return { allocationId, eventId };
  }

  /** 1 つの操作で割当を作り、受付の行まで書く */
  async function allocated(orderItemId: string, variantId: number, quantity: number, kind: 'paid' | 'payment_hold' = 'paid') {
    const operationId = randomUUID();
    const created = await createAllocation({ orderItemId, variantId, quantity, kind, operationId });
    await insertOperation(operationId);
    return { ...created, operationId };
  }

  async function decrease(allocationId: string, quantity: number) {
    await db().query(
      `update public.order_item_allocations
       set remaining_quantity = remaining_quantity - $2, version = version + 1, updated_at = now()
       where id = $1`,
      [allocationId, quantity],
    );
  }

  async function ship(orderId: string, orderItemId: string, quantity: number) {
    const fulfillment = await db().query(
      `insert into public.order_fulfillments
         (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order)
       values ($1, 1, gen_random_uuid(), 'yamato', '1234-5678-9012', false, false) returning id`,
      [orderId],
    );
    await db().query(
      'insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, $3)',
      [fulfillment.rows[0].id, orderItemId, quantity],
    );
  }

  async function allocationTotals(variantId: number) {
    const res = await db().query(
      `select coalesce(sum(remaining_quantity), 0)::int as remaining, count(*)::int as rows
       from public.order_item_allocations where variant_id = $1`,
      [variantId],
    );
    return res.rows[0] as { remaining: number; rows: number };
  }

  describe('権限・RLS・所有者・search_path', () => {
    test('新しい 4 表は RLS と拒否のポリシーを持ち、所有者は postgres、権限は public の 3 表の service_role の SELECT だけ', async () => {
      for (const table of NEW_TABLES) {
        const relation = (await db().query(
          `select c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
                  exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_grant
           from pg_class c where c.oid = $1::regclass`,
          [table],
        )).rows[0];
        expect({ table, ...relation }).toEqual({ table, rls: true, owner: 'postgres', public_grant: false });

        const policies = (await db().query(
          `select p.polpermissive as permissive, p.polcmd::text as command,
                  array(select r.rolname::text from pg_roles r where r.oid = any (p.polroles) order by 1) as roles,
                  pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
           from pg_policy p where p.polrelid = $1::regclass`,
          [table],
        )).rows;
        expect({ table, policies }).toEqual({
          table,
          policies: [{ permissive: false, command: '*', roles: ['anon', 'authenticated'], using_expr: 'false', check_expr: 'false' }],
        });

        for (const role of ['anon', 'authenticated', 'service_role']) {
          const privileges = (await db().query(
            `select has_table_privilege($1, $2, 'SELECT') as read,
                    has_table_privilege($1, $2, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as write`,
            [role, table],
          )).rows[0];
          expect({ table, role, ...privileges }).toEqual({
            table, role, read: role === 'service_role' && table.startsWith('public.'), write: false,
          });
        }
      }
    });

    test('新しい関数は postgres の物で search_path が空、PUBLIC・anon・authenticated・service_role の EXECUTE を個別に剥がす', async () => {
      for (const fn of NEW_FUNCTIONS) {
        const row = (await db().query(
          `select p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
                  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
           from pg_proc p where p.oid = $1::regprocedure`,
          [fn.signature],
        )).rows[0];
        expect({ signature: fn.signature, ...row }).toEqual({
          signature: fn.signature, definer: fn.definer, owner: 'postgres', config: ['search_path=""'], public_execute: false,
        });
        for (const role of ['anon', 'authenticated', 'service_role']) {
          const allowed = (await db().query("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, fn.signature]))
            .rows[0].allowed;
          expect({ signature: fn.signature, role, allowed }).toEqual({ signature: fn.signature, role, allowed: false });
        }
      }
    });

    test('PostgREST の要求の前の処理は anon・authenticated から呼べ、役割を戻せる', async () => {
      for (const role of ['anon', 'authenticated']) {
        expect((await db().query("select has_schema_privilege($1, 'private', 'USAGE') as allowed", [role])).rows[0].allowed)
          .toBe(true);
        await db().query('savepoint pre_request');
        const caught = await asRole(role, 'select private.set_request_context()').then(() => null, (error: DbFailure) => error);
        await db().query('rollback to savepoint pre_request');
        expect({ role, code: caught?.code ?? null }).toEqual({ role, code: null });
        expect((await db().query('select current_user::text as name')).rows[0].name).toBe('postgres');
      }
    });

    test('anon・authenticated は新しい private の表・関数と public の 3 表に直接触れない（42501）', async () => {
      const f = await fixture();
      for (const role of ['anon', 'authenticated']) {
        for (const sql of [
          'select count(*) from private.group_g_operations',
          `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
           values (gen_random_uuid(), 'x', gen_random_uuid(), repeat('a', 64), 'x', 'x', '{}')`,
          'select count(*) from public.order_item_allocations',
          'select count(*) from public.order_item_allocation_events',
          'select count(*) from public.order_item_state_events',
        ]) {
          expect({ role, sql, code: (await failure(() => asRole(role, sql))).code }).toEqual({ role, sql, code: '42501' });
        }
        const call = await failure(() => asRole(
          role,
          'select private.ensure_group_g_payment_review_hold($1, null, null, $2, null)',
          [f.orderId, 'pi_denied'],
        ));
        expect({ role, code: call.code }).toEqual({ role, code: '42501' });
      }
    });
  });

  describe('足した列・外部キー・台帳の理由', () => {
    test('orders.paid_at と stock_movements.allocation_operation_id は空を許す列で、操作への外部キーは遅延・RESTRICT', async () => {
      const columns = (await db().query(
        `select table_name, column_name, data_type, is_nullable
         from information_schema.columns
         where table_schema = 'public'
           and ((table_name = 'orders' and column_name = 'paid_at')
             or (table_name = 'stock_movements' and column_name = 'allocation_operation_id'))
         order by table_name`,
      )).rows;
      expect(columns).toEqual([
        { table_name: 'orders', column_name: 'paid_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { table_name: 'stock_movements', column_name: 'allocation_operation_id', data_type: 'uuid', is_nullable: 'YES' },
      ]);

      const fkeys = (await db().query(
        `select c.conrelid::regclass::text as relation, c.conname as name, c.condeferrable as deferrable,
                c.condeferred as deferred, c.confdeltype as on_delete
         from pg_constraint c
         where c.contype = 'f' and c.confrelid = 'private.group_g_operations'::regclass
         order by c.conname`,
      )).rows.map((row) => ({ ...row, relation: String(row.relation).replace(/^public\./, '') })).sort(byName);
      expect(fkeys).toEqual(OPERATION_FKEYS
        .map(([relation, name]) => ({ relation, name, deferrable: true, deferred: true, on_delete: 'r' }))
        .sort(byName));

      // ほかの外部キーは遅延にせず RESTRICT
      const others = (await db().query(
        `select c.conname as name, c.condeferrable as deferrable, c.confdeltype as on_delete
         from pg_constraint c
         where c.contype = 'f'
           and c.conrelid in ('private.group_g_operations'::regclass, 'public.order_item_allocations'::regclass,
                              'public.order_item_allocation_events'::regclass, 'public.order_item_state_events'::regclass)
           and c.confrelid <> 'private.group_g_operations'::regclass
         order by c.conname`,
      )).rows.sort(byName);
      expect(others.map((row) => row.name)).toEqual([
        'group_g_operations_exception_id_fkey',
        'order_item_allocation_events_allocation_id_fkey',
        'order_item_allocation_events_counterpart_allocation_id_fkey',
        'order_item_allocation_events_reverses_event_id_fkey',
        'order_item_allocation_events_stock_movement_id_fkey',
        'order_item_allocations_order_item_id_fkey',
        'order_item_allocations_variant_id_fkey',
        'order_item_state_events_order_item_id_fkey',
      ]);
      for (const row of others) expect(row).toMatchObject({ deferrable: false, on_delete: 'r' });
    });

    test('台帳の理由に allocation_release（正数）が加わり、知らない理由は断る', async () => {
      const f = await fixture();
      const before = await variantStock(db(), f.variantId);
      await movement(f.variantId, 1, 'allocation_release', null);
      expect(await variantStock(db(), f.variantId)).toBe(before + 1);
      await violated(() => movement(f.variantId, 1, 'unknown_reason', null), '23514', 'stock_movements_reason_check');
    });

    test('受付の行が無い割当・履歴・台帳は、遅延の外部キーが取引の中で確かめる時に断る', async () => {
      const f = await fixture();
      await flush();
      for (const run of [
        () => createAllocation({ orderItemId: f.items[0], variantId: f.variantId, quantity: 1, operationId: randomUUID() }),
        () => movement(f.variantId, 1, 'restock', randomUUID()),
        () => db().query(
          `insert into public.order_item_state_events
             (order_item_id, unit_from, unit_to, from_status, to_status, operation_id, sequence, version)
           values ($1, 0, 1, null, 'in_production', gen_random_uuid(), 1, 1)`,
          [f.items[0]],
        ),
      ]) {
        const caught = await failure(async () => { await run(); await immediate(); });
        expect(caught.code).toBe('23503');
      }
    });
  });

  describe('追記だけの 3 表', () => {
    test('所有者からも service_role からも UPDATE・DELETE・TRUNCATE できない（GROUP_G_HISTORY_IMMUTABLE / 55000）', async () => {
      const f = await fixture();
      const { eventId, operationId } = await allocated(f.items[0], f.variantId, 1);
      const stateOperation = randomUUID();
      const state = await db().query(
        `insert into public.order_item_state_events
           (order_item_id, unit_from, unit_to, from_status, to_status, operation_id, sequence, version)
         values ($1, 0, 1, null, 'ready', $2, 1, 1) returning id`,
        [f.items[0], stateOperation],
      );
      await insertOperation(stateOperation);
      await flush();

      const rows: Array<[string, string, string]> = [
        ['public.order_item_allocation_events', 'reason = reason', eventId],
        ['public.order_item_state_events', 'reason = reason', state.rows[0].id as string],
        ['private.group_g_operations', 'actor_id = actor_id', operationId],
      ];
      const truncates = [
        'truncate public.order_item_allocation_events',
        'truncate public.order_item_state_events',
        // 操作の表は G-1 の 4 つの表と G-2 の発注書の 5 つの表から外部キーで指されるので、指す側（それを指す表も）を後ろに並べて
        // 操作の表の文のトリガーを先に発火させる
        `truncate private.group_g_operations, public.order_item_allocations, public.order_item_allocation_events,
           public.order_item_state_events, public.stock_movements, public.purchase_order_revisions,
           public.purchase_order_short_closures, public.purchase_order_receipts, public.purchase_order_receipt_lines,
           public.purchase_order_attachment_reservations, public.purchase_order_attachments,
           public.purchase_order_attachment_revisions`,
      ];

      for (const role of ['postgres', 'service_role']) {
        if (role === 'service_role') {
          for (const table of [
            ...rows.map(([table]) => table), 'public.order_item_allocations', 'public.stock_movements',
            ...['revisions', 'short_closures', 'receipts', 'receipt_lines', 'attachment_reservations', 'attachments', 'attachment_revisions']
              .map((name) => `public.purchase_order_${name}`),
          ]) {
            await db().query(`grant select, insert, update, delete, truncate on ${table} to service_role`);
          }
        }
        for (const [table, set, id] of rows) {
          await rejected(() => asRole(role, `update ${table} set ${set} where id = $1`, [id]), 'GROUP_G_HISTORY_IMMUTABLE', '55000');
          await rejected(() => asRole(role, `delete from ${table} where id = $1`, [id]), 'GROUP_G_HISTORY_IMMUTABLE', '55000');
        }
        for (const sql of truncates) {
          await rejected(() => asRole(role, sql), 'GROUP_G_HISTORY_IMMUTABLE', '55000');
        }
      }
    });
  });

  describe('割当の現在値の守り', () => {
    test('削除と、変えられない列・H→A 以外の種類・残数量の増加・version の飛ばしを断る', async () => {
      const f = await fixture();
      const { allocationId } = await allocated(f.items[0], f.variantId, 2);
      await flush();
      const reject = (set: string, params: unknown[] = []) => rejected(
        () => db().query(`update public.order_item_allocations set ${set} where id = $1`, [allocationId, ...params]),
        'GROUP_G_HISTORY_IMMUTABLE', '55000',
      );

      await rejected(
        () => db().query('delete from public.order_item_allocations where id = $1', [allocationId]),
        'GROUP_G_HISTORY_IMMUTABLE', '55000',
      );
      await reject('id = gen_random_uuid()');
      await reject('order_item_id = $2', [f.items[1]]);
      await reject('variant_id = $2', [f.otherVariantId]);
      await reject('quantity = 1');
      await reject('operation_id = gen_random_uuid()');
      await reject("created_at = created_at - interval '1 second'");
      await reject("kind = 'payment_hold', version = version + 1");
      await reject('remaining_quantity = 1');
      await reject('remaining_quantity = 1, version = version + 2');
      await reject('version = version + 1');

      // 減らした後に増やして戻すことはできない（戻す時は restore の新しい行）
      const release = randomUUID();
      await decrease(allocationId, 1);
      await insertEvent({
        allocationId, eventType: 'release', quantity: 1, operationId: release,
        stockMovementId: await movement(f.variantId, 1, 'allocation_release', release, f.items[0]),
      });
      await insertOperation(release);
      await flush();
      await reject('remaining_quantity = 2, version = version + 1');
    });

    test('残数量・種類の変更は同じ取引の履歴と合わなければ commit の前に断る。合えば通り、空き在庫も合う', async () => {
      const f = await fixture();
      const paid = await allocated(f.items[0], f.variantId, 2);
      const hold = await allocated(f.items[2], f.otherVariantId, 1, 'payment_hold');
      await flush();
      const stock = await variantStock(db(), f.variantId);

      await bounds(() => decrease(paid.allocationId, 1), 'remaining_events');
      await bounds(
        () => db().query("update public.order_item_allocations set kind = 'paid', version = version + 1 where id = $1", [hold.allocationId]),
        'kind_history',
      );
      // 台帳が合わない解放（数・variant・理由）は断る
      for (const [delta, variantId, reason] of [[2, f.variantId, 'allocation_release'], [1, f.otherVariantId, 'cancel'], [1, f.variantId, 'restock']] as const) {
        await bounds(async () => {
          const operationId = randomUUID();
          await decrease(paid.allocationId, 1);
          await insertEvent({
            allocationId: paid.allocationId, eventType: 'release', quantity: 1, operationId,
            stockMovementId: await movement(variantId, delta, reason, operationId, f.items[0]),
          });
          await insertOperation(operationId);
        }, 'stock_movement');
      }

      const release = randomUUID();
      await decrease(paid.allocationId, 1);
      await insertEvent({
        allocationId: paid.allocationId, eventType: 'release', quantity: 1, operationId: release,
        stockMovementId: await movement(f.variantId, 1, 'allocation_release', release, f.items[0]),
      });
      await insertOperation(release);
      const promote = randomUUID();
      await db().query("update public.order_item_allocations set kind = 'paid', version = version + 1 where id = $1", [hold.allocationId]);
      await insertEvent({ allocationId: hold.allocationId, eventType: 'promote', quantity: 1, operationId: promote });
      await insertOperation(promote);
      await flush();

      expect(await variantStock(db(), f.variantId)).toBe(stock + 1);
      const rows = (await db().query(
        'select id, kind, remaining_quantity, version from public.order_item_allocations where id = any($1::uuid[]) order by version, kind',
        [[paid.allocationId, hold.allocationId]],
      )).rows;
      expect(rows).toEqual(expect.arrayContaining([
        { id: paid.allocationId, kind: 'paid', remaining_quantity: 1, version: '1' },
        { id: hold.allocationId, kind: 'paid', remaining_quantity: 1, version: '1' },
      ]));
    });
  });

  describe('割当の数の確かめ', () => {
    test('variant は明細と同じ。H と A を同じ明細に同時に持たない。明細の数量から取り消していない発送を引いた数まで', async () => {
      const f = await fixture();
      await flush();

      await bounds(() => allocated(f.items[0], f.otherVariantId, 1), 'variant_mismatch');
      await bounds(async () => {
        await allocated(f.items[0], f.variantId, 1);
        await allocated(f.items[0], f.variantId, 1, 'payment_hold');
      }, 'hold_paid_overlap');
      await bounds(async () => {
        await allocated(f.items[0], f.variantId, 2);
        await allocated(f.items[0], f.variantId, 2);
      }, 'item_bounds');
      // 受注生産の明細も同じ上限（購入時の区分で分けない）
      await bounds(() => allocated(f.items[1], f.variantId, 3), 'item_bounds');
      await violated(async () => {
        const operationId = randomUUID();
        await db().query(
          `insert into public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
           values ($1, $2, 2, 3, 'paid', $3)`,
          [f.items[0], f.variantId, operationId],
        );
      }, '23514', 'order_item_allocations_remaining_check');

      // 2 個を発送した明細（3 個）は、残り 1 個まで
      await ship(f.orderId, f.items[0], 2);
      await bounds(() => allocated(f.items[0], f.variantId, 2), 'item_bounds');
      await allocated(f.items[0], f.variantId, 1);
      await allocated(f.items[1], f.variantId, 2);
      await flush();
      expect(await allocationTotals(f.variantId)).toEqual({ remaining: 3, rows: 2 });
    });

    test('作る履歴はちょうど 1 つで、数・操作・種類が行と合う。consume は A だけ', async () => {
      const f = await fixture();
      await flush();

      await bounds(async () => {
        const operationId = randomUUID();
        const { allocationId } = await createAllocation({ orderItemId: f.items[0], variantId: f.variantId, quantity: 1, operationId });
        await insertEvent({
          allocationId, eventType: 'allocate', quantity: 1, operationId, sequence: 2,
          stockMovementId: await movement(f.variantId, -1, 'purchase', operationId, f.items[0]),
        });
        await insertOperation(operationId);
      }, 'creation_event');
      await bounds(async () => {
        const operationId = randomUUID();
        await createAllocation({ orderItemId: f.items[0], variantId: f.variantId, quantity: 1, operationId, kind: 'payment_hold', eventType: 'allocate' });
        await insertOperation(operationId);
      }, 'kind_history');
      await bounds(async () => {
        const hold = await allocated(f.items[0], f.variantId, 1, 'payment_hold');
        const consume = randomUUID();
        await decrease(hold.allocationId, 1);
        await insertEvent({ allocationId: hold.allocationId, eventType: 'consume', quantity: 1, operationId: consume });
        await insertOperation(consume);
      }, 'consume_kind');
    });

    test('restore は別の割当の consume を同じ数で一度だけ戻して新しい A を作り、再送は一意の制約で断る', async () => {
      const f = await fixture();
      const source = await allocated(f.items[0], f.variantId, 2);
      await flush();

      const consume = randomUUID();
      await decrease(source.allocationId, 2);
      const consumeEventId = await insertEvent({ allocationId: source.allocationId, eventType: 'consume', quantity: 2, operationId: consume });
      await insertOperation(consume);
      await flush();
      const stock = await variantStock(db(), f.variantId);

      // 数の違う戻しと、consume 以外を指す戻しは断る
      await bounds(async () => {
        const operationId = randomUUID();
        await createAllocation({
          orderItemId: f.items[0], variantId: f.variantId, quantity: 1, operationId,
          eventType: 'restore', reversesEventId: consumeEventId,
        });
        await insertOperation(operationId);
      }, 'restore');
      await bounds(async () => {
        const operationId = randomUUID();
        await createAllocation({
          orderItemId: f.items[0], variantId: f.variantId, quantity: 1, operationId,
          eventType: 'restore', reversesEventId: source.eventId,
        });
        await insertOperation(operationId);
      }, 'restore');

      // 発送の取消: 戻し（restock +2）と再確保（purchase −2）の対で、手元の在庫だけ 1 回戻る
      const operationId = randomUUID();
      await movement(f.variantId, 2, 'restock', null);
      const restored = await createAllocation({
        orderItemId: f.items[0], variantId: f.variantId, quantity: 2, operationId,
        eventType: 'restore', reversesEventId: consumeEventId,
      });
      await insertOperation(operationId);
      await flush();
      expect(await variantStock(db(), f.variantId)).toBe(stock);
      expect(await allocationTotals(f.variantId)).toEqual({ remaining: 2, rows: 2 });

      // 同じ consume を二度戻さない
      await violated(async () => {
        const again = randomUUID();
        await movement(f.variantId, 2, 'restock', null);
        await createAllocation({
          orderItemId: f.items[0], variantId: f.variantId, quantity: 2, operationId: again,
          eventType: 'restore', reversesEventId: consumeEventId,
        });
      }, '23505', 'order_item_allocation_events_reverses_event_id_key');
      expect(restored.allocationId).not.toBe(source.allocationId);
    });

    test('transfer は同じ操作・同じ variant・同じ数の両側の履歴を持ち、割当の合計と在庫を変えない。片側だけ・数違い・variant 違いは断る', async () => {
      const f = await fixture();
      const source = await allocated(f.items[0], f.variantId, 2);
      await flush();
      const stock = await variantStock(db(), f.variantId);
      const movements = Number((await db().query('select count(*) from public.stock_movements where variant_id = $1', [f.variantId])).rows[0].count);

      async function transfer(options: { targetItem: string; targetVariant: number; targetQuantity: number; mirror: boolean; mirrorQuantity?: number }) {
        const operationId = randomUUID();
        await decrease(source.allocationId, 1);
        const target = await db().query(
          `insert into public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
           values ($1, $2, $3, $3, 'paid', $4) returning id`,
          [options.targetItem, options.targetVariant, options.targetQuantity, operationId],
        );
        const targetId = target.rows[0].id as string;
        await insertEvent({ allocationId: source.allocationId, eventType: 'transfer', quantity: 1, operationId, counterpartAllocationId: targetId });
        if (options.mirror) {
          await insertEvent({
            allocationId: targetId, eventType: 'transfer', quantity: options.mirrorQuantity ?? options.targetQuantity,
            operationId, counterpartAllocationId: source.allocationId,
          });
        }
        await insertOperation(operationId);
        return targetId;
      }

      await bounds(() => transfer({ targetItem: f.items[1], targetVariant: f.variantId, targetQuantity: 1, mirror: false }), 'transfer_pair');
      await bounds(() => transfer({ targetItem: f.items[1], targetVariant: f.variantId, targetQuantity: 2, mirror: true }), 'transfer_pair');
      // 出し手を先に確かめるので、相手の variant 違いは対の違反として断る
      await bounds(() => transfer({ targetItem: f.items[2], targetVariant: f.otherVariantId, targetQuantity: 1, mirror: true }), 'transfer_pair');

      const targetId = await transfer({ targetItem: f.items[1], targetVariant: f.variantId, targetQuantity: 1, mirror: true });
      await flush();
      expect(await allocationTotals(f.variantId)).toEqual({ remaining: 2, rows: 2 });
      expect(await variantStock(db(), f.variantId)).toBe(stock);
      expect(Number((await db().query('select count(*) from public.stock_movements where variant_id = $1', [f.variantId])).rows[0].count))
        .toBe(movements);
      const sides = (await db().query(
        `select allocation_id, counterpart_allocation_id, quantity from public.order_item_allocation_events
         where event_type = 'transfer' and allocation_id = any($1::uuid[]) order by allocation_id = $2 desc`,
        [[source.allocationId, targetId], source.allocationId],
      )).rows;
      expect(sides).toEqual([
        { allocation_id: source.allocationId, counterpart_allocation_id: targetId, quantity: 1 },
        { allocation_id: targetId, counterpart_allocation_id: source.allocationId, quantity: 1 },
      ]);
    });

    test('途中で失敗した割当の操作は、台帳・在庫・割当・履歴・受付を全部戻す（取引の中の SAVEPOINT）', async () => {
      const f = await fixture();
      await flush();
      const stock = await variantStock(db(), f.variantId);
      const counts = async () => (await db().query(
        `select (select count(*) from public.stock_movements where variant_id = $1)::int as movements,
                (select count(*) from public.order_item_allocations where variant_id = $1)::int as allocations,
                (select count(*) from public.order_item_allocation_events e
                   join public.order_item_allocations a on a.id = e.allocation_id where a.variant_id = $1)::int as events,
                (select count(*) from private.group_g_operations)::int as operations`,
        [f.variantId],
      )).rows[0];
      const before = await counts();

      await bounds(async () => {
        const operationId = randomUUID();
        await createAllocation({ orderItemId: f.items[0], variantId: f.variantId, quantity: 2, operationId });
        await createAllocation({ orderItemId: f.items[0], variantId: f.variantId, quantity: 2, operationId });
        await insertOperation(operationId);
      }, 'item_bounds');

      expect(await variantStock(db(), f.variantId)).toBe(stock);
      expect(await counts()).toEqual(before);
    });
  });

  test('commit の時にも数を確かめ、失敗した取引は材料ごと何も残さない', async () => {
    const client = await connectLocalDb();
    let itemId: number | null = null;
    let operationId: string | null = null;
    try {
      await client.query('begin');
      await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const catalog = await createCatalogFixture(client, { stock: 5 });
      itemId = catalog.itemId;
      const order = await insertOrderWithLines(client, {
        status: 'paid',
        lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }],
      });
      operationId = randomUUID();
      const moved = await client.query(
        `insert into public.stock_movements (variant_id, delta, reason, allocation_operation_id, order_item_id)
         values ($1, -2, 'purchase', $2, $3) returning id`,
        [catalog.variantId, operationId, order.orderItemIds[0]],
      );
      const allocation = await client.query(
        `insert into public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
         values ($1, $2, 2, 2, 'paid', $3) returning id`,
        [order.orderItemIds[0], catalog.variantId, operationId],
      );
      await client.query(
        `insert into public.order_item_allocation_events (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id)
         values ($1, 'allocate', 2, $2, 1, $3)`,
        [allocation.rows[0].id, operationId, moved.rows[0].id],
      );
      await client.query(
        `insert into private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, result)
         values ($1, 'g1_model_test', gen_random_uuid(), $2, 'test', $3, '{}'::jsonb)`,
        [operationId, sha256(operationId), operationId],
      );
      let caught: DbFailure | null = null;
      try { await client.query('commit'); } catch (error) { caught = error as DbFailure; }
      expect({ message: caught?.message, code: caught?.code, detail: caught?.detail })
        .toEqual({ message: 'GROUP_G_ALLOCATION_BOUNDS', code: '23514', detail: 'item_bounds' });
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }

    const left = (await db().query(
      `select (select count(*) from public.items where id = $1)::int as items,
              (select count(*) from private.group_g_operations where id = $2)::int as operations`,
      [itemId, operationId],
    )).rows[0];
    expect(left).toEqual({ items: 0, operations: 0 });
  });

  describe('操作の受付', () => {
    test('保留は要対応が要り、要対応は保留にだけ付く。指紋は 64 桁の小文字の 16 進。種別と番号は一意', async () => {
      const f = await fixture();
      const exception = await db().query(
        `insert into public.payment_exceptions (payment_ref, reason, order_id)
         values ($1, 'paid_amount_mismatch', $2) returning id`,
        [`cs_model_${randomUUID()}`, f.orderId],
      );
      const exceptionId = exception.rows[0].id as string;
      const insert = (values: { operation: string; requestKey?: string; fingerprint?: string; causeType?: string; causeId?: string; exceptionId?: string | null; result?: unknown }) =>
        db().query(
          `insert into private.group_g_operations
             (id, operation, request_key, fingerprint, cause_type, cause_id, exception_id, result)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [
            values.operation, values.requestKey ?? randomUUID(), values.fingerprint ?? sha256(randomUUID()),
            values.causeType ?? 'payment_exception', values.causeId ?? exceptionId,
            values.exceptionId === undefined ? exceptionId : values.exceptionId,
            JSON.stringify(values.result ?? { active: true, order_id: f.orderId }),
          ],
        );

      await violated(() => insert({ operation: 'payment_review_hold', exceptionId: null }), '23514', 'group_g_operations_exception_check');
      await violated(() => insert({ operation: 'g1_model_test' }), '23514', 'group_g_operations_exception_check');
      await violated(() => insert({ operation: 'payment_review_hold', causeType: 'order' }), '23514', 'group_g_operations_review_hold_check');
      await violated(() => insert({ operation: 'payment_review_hold', causeId: randomUUID() }), '23514', 'group_g_operations_review_hold_check');
      await violated(() => insert({ operation: 'payment_review_hold', result: { active: false, order_id: f.orderId } }), '23514', 'group_g_operations_review_hold_check');
      // CHECK を通す形（cause_id = exception_id）で、実在しない要対応を指すと外部キーが断る
      const missingException = randomUUID();
      await violated(
        () => insert({ operation: 'payment_review_hold', exceptionId: missingException, causeId: missingException }),
        '23503', 'group_g_operations_exception_id_fkey',
      );
      await violated(() => insert({ operation: 'payment_review_hold', fingerprint: sha256('x').toUpperCase() }), '23514', 'group_g_operations_fingerprint_check');

      const requestKey = randomUUID();
      await insert({ operation: 'payment_review_hold', requestKey });
      await violated(() => insert({ operation: 'payment_review_hold', requestKey }), '23505', 'group_g_operations_operation_request_key_key');
    });

    test('支払額の違いの保留: 共通の在庫 lock の下で、要対応と保留を同じ取引で一度だけ作る', async () => {
      const f = await fixture();
      const sessionId = (await db().query('select checkout_session_id from public.orders where id = $1', [f.orderId])).rows[0]
        .checkout_session_id as string;
      const ensure = (orderId: string, paymentIntentId: string) => db().query(
        'select private.ensure_group_g_payment_review_hold($1, $2, $3, $4, null) as id',
        [orderId, 'ref_from_caller', 'cs_from_caller', paymentIntentId],
      ).then((res) => res.rows[0].id as string);

      await rejected(() => ensure(f.orderId, 'pi_model_1'), 'GROUP_G_INVENTORY_LOCK_REQUIRED', '55000');
      await db().query('select pg_advisory_xact_lock(190521, 1)');

      const first = await ensure(f.orderId, 'pi_model_1');
      const second = await ensure(f.orderId, 'pi_model_1');
      expect(second).toBe(first);
      const row = (await db().query(
        `select payment_ref, reason, detail, order_id, payment_intent_id, checkout_session_id, detection_count, resolved_at
         from public.payment_exceptions where id = $1`,
        [first],
      )).rows[0];
      expect(row).toEqual({
        payment_ref: sessionId, reason: 'paid_amount_mismatch', detail: null, order_id: f.orderId,
        payment_intent_id: 'pi_model_1', checkout_session_id: 'cs_from_caller', detection_count: 2, resolved_at: null,
      });
      const holds = (await db().query(
        `select cause_type, cause_id, actor_id, result, fingerprint ~ '^[0-9a-f]{64}$' as fingerprint_ok,
                request_key = md5('review-hold:' || exception_id::text)::uuid as request_key_ok
         from private.group_g_operations where operation = 'payment_review_hold' and exception_id = $1`,
        [first],
      )).rows;
      expect(holds).toEqual([{
        cause_type: 'payment_exception', cause_id: first, actor_id: null,
        result: { active: true, order_id: f.orderId }, fingerprint_ok: true, request_key_ok: true,
      }]);

      // 注文に Checkout Session が無い時は支払いの番号でまとめる
      const catalog = await createCatalogFixture(db(), { stock: 0 });
      const withoutSession = await insertOrderWithStockLine(db(), {
        status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: false,
        checkoutSessionId: null,
      });
      const paymentIntentId = `pi_model_${randomUUID()}`;
      const byIntent = await ensure(withoutSession.orderId, paymentIntentId);
      expect((await db().query('select payment_ref from public.payment_exceptions where id = $1', [byIntent])).rows[0].payment_ref)
        .toBe(paymentIntentId);

      // 解決済みの要対応は開き直さず、保留も作らない
      const resolvedOrder = await insertOrderWithStockLine(db(), {
        status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: false,
      });
      const resolvedSession = (await db().query('select checkout_session_id from public.orders where id = $1', [resolvedOrder.orderId]))
        .rows[0].checkout_session_id as string;
      const resolved = await db().query(
        `insert into public.payment_exceptions (payment_ref, reason, order_id, resolved_at)
         values ($1, 'paid_amount_mismatch', $2, now()) returning id`,
        [resolvedSession, resolvedOrder.orderId],
      );
      expect(await ensure(resolvedOrder.orderId, 'pi_model_resolved')).toBe(resolved.rows[0].id);
      const after = (await db().query(
        `select (select resolved_at is not null from public.payment_exceptions where id = $1) as still_resolved,
                (select count(*) from private.group_g_operations where exception_id = $1)::int as holds`,
        [resolved.rows[0].id],
      )).rows[0];
      expect(after).toEqual({ still_resolved: true, holds: 0 });

      // 別の注文の要対応には保留を付けない
      const otherOrder = await insertOrderWithStockLine(db(), {
        status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: false,
      });
      const otherSession = (await db().query('select checkout_session_id from public.orders where id = $1', [otherOrder.orderId]))
        .rows[0].checkout_session_id as string;
      await db().query(
        `insert into public.payment_exceptions (payment_ref, reason, order_id) values ($1, 'paid_amount_mismatch', $2)`,
        [otherSession, f.orderId],
      );
      await rejected(() => ensure(otherOrder.orderId, 'pi_model_conflict'), 'GROUP_G_PAYMENT_REVIEW_CONFLICT', '55000');
    });
  });

  describe('品物の状態の履歴', () => {
    test('12 の値・区間・遷移の形を守り、数量は区間の幅。操作・明細・順番・区間の始まりで一意', async () => {
      const f = await fixture();
      const operationId = randomUUID();
      const insert = (values: { from?: string | null; to?: string | null; unitFrom?: number; unitTo?: number; sequence?: number; version?: number }) =>
        db().query(
          `insert into public.order_item_state_events
             (order_item_id, unit_from, unit_to, from_status, to_status, operation_id, sequence, version)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning quantity`,
          [
            f.items[0], values.unitFrom ?? 0, values.unitTo ?? 2,
            values.from === undefined ? null : values.from, values.to === undefined ? 'in_production' : values.to,
            operationId, values.sequence ?? 1, values.version ?? 1,
          ],
        );

      const statuses = [
        'unpaid', 'payment_expired', 'in_production', 'ready', 'shipped', 'delivered',
        'cancel_requested', 'cancelled', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned',
      ];
      for (const [index, status] of statuses.entries()) {
        const res = await insert({ from: null, to: status, sequence: index + 1 });
        expect(res.rows[0].quantity).toBe(2);
      }
      await insert({ from: 'ready', to: null, sequence: 20 });
      await insertOperation(operationId);
      await flush();

      await violated(() => insert({ to: 'paid', sequence: 30 }), '23514', 'order_item_state_events_to_status_check');
      await violated(() => insert({ from: 'pending', sequence: 30 }), '23514', 'order_item_state_events_from_status_check');
      await violated(() => insert({ from: 'ready', to: 'ready', sequence: 30 }), '23514', 'order_item_state_events_transition_check');
      await violated(() => insert({ from: null, to: null, sequence: 30 }), '23514', 'order_item_state_events_transition_check');
      await violated(() => insert({ unitFrom: 2, unitTo: 2, sequence: 30 }), '23514', 'order_item_state_events_unit_to_check');
      await violated(() => insert({ unitFrom: -1, sequence: 30 }), '23514', 'order_item_state_events_unit_from_check');
      await violated(() => insert({ version: 0, sequence: 30 }), '23514', 'order_item_state_events_version_check');
      await violated(() => insert({ sequence: 0 }), '23514', 'order_item_state_events_sequence_check');
      await violated(() => insert({ sequence: 1 }), '23505', 'order_item_state_events_operation_key');
    });
  });
});
