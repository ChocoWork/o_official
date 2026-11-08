/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  seedGroupG1Allocation, seedGroupG1Shipment, restoreGroupG1Shipment, setOrderStatusForFixture, withGroupG1FixtureTransaction,
} from './helpers/group-g1-fixtures';
import { seedGroupG3Slip, setGroupG3PaidAt, withRolePermissions } from './helpers/group-g3-fixtures';
import {
  createCatalogFixture, insertOrderWithLines, shipFixtureOrder, withFixtureConsumption,
} from './helpers/order-fixtures';
import { createOrderStatusReturnsFixture } from './helpers/order-status-fixtures';
import { insertDeliveryFixture } from './helpers/delivery-tracking-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { G3A_REASON_CODES, replaceReasonCheckSql, runWithReasonCodes } from './helpers/group-g-allowlist';

/** Controller only: disposable localhost DB after reset. Expected failures never expose raw DB errors. */
jest.setTimeout(60000);
const directory = path.join(process.cwd(), 'supabase/migrations');
const names = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g3_shipping_foundation.sql'));
const sql = names.length === 1 ? fs.readFileSync(path.join(directory, names[0]), 'utf8') : '';
const TABLES = [
  'public.shipment_slips', 'public.shipment_slip_lines', 'public.shipment_slip_fulfillments',
  'public.shipment_slip_versions', 'public.shipment_date_history', 'private.shipment_tracking_registrations',
];
const HISTORY = 'GROUP_G_HISTORY_IMMUTABLE';
type Failure = { code?: string; message?: string; detail?: string; constraint?: string };

function finalBlock(tag: string): string {
  const section = sql.slice(sql.indexOf('-- G3A_FINAL_ASSERT_BEGIN'), sql.indexOf('-- G3A_FINAL_ASSERT_END'));
  const start = section.indexOf(`DO ${tag}`);
  const end = section.indexOf(`${tag};`, start + tag.length + 3);
  if (start < 0 || end < 0) throw new Error('G3_FINAL_ASSERT_MISSING');
  return section.slice(start, end + tag.length + 1);
}

async function failure(client: PgClient, run: () => Promise<unknown>): Promise<Failure> {
  await client.query('savepoint g3_expected');
  try { await run(); return {}; } catch (error) {
    const e = error as Failure;
    return { code: e.code, message: e.message, detail: e.detail, constraint: e.constraint };
  } finally {
    await client.query('rollback to savepoint g3_expected');
    await client.query('release savepoint g3_expected');
  }
}

async function rejected(client: PgClient, run: () => Promise<unknown>, message: string, code: string, detail?: string) {
  const caught = await failure(client, run);
  expect({ code: caught.code, message: caught.message === message ? message : 'G3_UNEXPECTED_DB_ERROR',
    ...(detail === undefined ? {} : { detail: caught.detail }) })
    .toEqual({ code, message, ...(detail === undefined ? {} : { detail }) });
}

async function flush(client: PgClient) {
  await client.query('set constraints all immediate');
  await client.query('set constraints all deferred');
}

async function base(client: PgClient, quantity = 4, allocatedQuantity = quantity) {
  const catalog = await createCatalogFixture(client, { stock: quantity });
  const order = await insertOrderWithLines(client, { status: 'paid', paidAmount: quantity * 5000,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, fulfillmentType: 'stock', reserved: false }] });
  await seedGroupG1Allocation(client, { orderItemId: order.orderItemIds[0], quantity: allocatedQuantity, kind: 'paid' });
  return { ...catalog, ...order, orderItemId: order.orderItemIds[0] };
}

async function bareFulfillment(client: PgClient, orderId: string, overrides: { cancelled?: boolean; legacy?: boolean } = {}) {
  return (await client.query(`insert into public.order_fulfillments
    (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipment_date,cancelled_at,legacy)
    select $1,coalesce(max(number),0)+1,gen_random_uuid(),null,null,false,false,
      (now() at time zone 'Asia/Tokyo')::date,case when $2::boolean then now() else null end,$3
    from public.order_fulfillments where order_id=$1 returning id`,
  [orderId, overrides.cancelled ?? false, overrides.legacy ?? false])).rows[0].id as string;
}

async function operation(client: PgClient, causeId: string): Promise<string> {
  return (await client.query(`insert into private.group_g_operations
    (id,operation,request_key,fingerprint,cause_type,cause_id,result)
    values(gen_random_uuid(),'fixture_release',gen_random_uuid(),repeat('b',64),'order',$1,'{}') returning id`,
  [causeId])).rows[0].id as string;
}

/** An internally valid restore, deliberately leaving its original fulfillment uncancelled. */
async function restoreWithoutCancel(client: PgClient, fulfillmentId: string) {
  const consumed = (await client.query(`select e.id,e.quantity,a.order_item_id,a.variant_id,f.order_id
    from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
    join public.order_fulfillment_lines l on l.order_item_id=a.order_item_id
    join public.order_fulfillments f on f.id=l.fulfillment_id
    where f.id=$1 and e.event_type='consume' order by e.id limit 1`, [fulfillmentId])).rows[0];
  const op = await operation(client, consumed.order_id);
  await client.query(`insert into public.stock_movements(variant_id,delta,reason,order_id,order_item_id)
    values($1,$2,'restock',$3,$4)`, [consumed.variant_id, consumed.quantity, consumed.order_id, consumed.order_item_id]);
  const movement = (await client.query(`insert into public.stock_movements
    (variant_id,delta,reason,order_id,order_item_id,allocation_operation_id) values($1,-$2::integer,'purchase',$3,$4,$5) returning id`,
  [consumed.variant_id, consumed.quantity, consumed.order_id, consumed.order_item_id, op])).rows[0].id;
  const allocation = (await client.query(`insert into public.order_item_allocations
    (order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id) values($1,$2,$3,$3,'paid',$4) returning id`,
  [consumed.order_item_id, consumed.variant_id, consumed.quantity, op])).rows[0].id;
  await client.query(`insert into public.order_item_allocation_events
    (allocation_id,event_type,quantity,operation_id,sequence,reverses_event_id,stock_movement_id,reason)
    values($1,'restore',$2,$3,1,$4,$5,'shipment_cancel')`, [allocation, consumed.quantity, op, consumed.id, movement]);
}

describeLocalDb('integration: G-3 発送票のモデル', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-540-AC-12: 新6表のRLS・restrictive deny・所有者・意味で比較するACL（PG17 MAINTAIN含む）', async () => {
    const maintain = (await db().query("select current_setting('server_version_num')::integer>=170000 as yes")).rows[0].yes;
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', ...(maintain ? ['MAINTAIN'] : [])];
    for (const table of TABLES) {
      const row = (await db().query(`select relrowsecurity as rls,pg_get_userbyid(relowner) as owner,
        exists(select 1 from aclexplode(coalesce(relacl,acldefault('r',relowner))) a where a.grantee=0) as public_grant
        from pg_class where oid=$1::regclass`, [table])).rows[0];
      expect({ table, ...row }).toEqual({ table, rls: true, owner: 'postgres', public_grant: false });
      expect((await db().query(`select polname,polpermissive,polcmd::text,
        array(select rolname::text from pg_roles where oid=any(polroles) order by 1) as roles,
        pg_get_expr(polqual,polrelid) as using_expr,pg_get_expr(polwithcheck,polrelid) as check_expr
        from pg_policy where polrelid=$1::regclass`, [table])).rows).toEqual([
        { polname: 'deny direct client access', polpermissive: false, polcmd: '*', roles: ['anon', 'authenticated'], using_expr: 'false', check_expr: 'false' },
      ]);
      for (const role of ['anon', 'authenticated', 'service_role', 'postgres']) {
        for (const privilege of privileges) {
          const allowed = (await db().query('select has_table_privilege($1,$2::regclass,$3) as allowed', [role, table, privilege])).rows[0].allowed;
          expect({ table, role, privilege, allowed }).toEqual({ table, role, privilege, allowed: role === 'postgres' });
        }
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed = (await db().query('select has_any_column_privilege($1,$2::regclass,$3) as allowed', [role, table, privilege])).rows[0].allowed;
          expect({ table, role, privilege, allowed }).toEqual({ table, role, privilege, allowed: role === 'postgres' });
        }
      }
    }
  });

  test('FREQ-540-AC-12: anon/authenticated/service_role は新6表のSELECTと直接DMLを拒否される', async () => {
    for (const table of TABLES) for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const statement of [`select * from ${table}`, `insert into ${table} default values`,
        `update ${table} set created_at=created_at`, `delete from ${table}`, `truncate ${TABLES.join(',')}`]) {
        const e = await failure(db(), async () => { await db().query(`set local role ${role}`); await db().query(statement); });
        expect({ table, role, code: e.code }).toEqual({ table, role, code: '42501' });
      }
    }
  });

  async function historyGraph() {
    const b = await base(db());
    const f = await seedGroupG1Shipment(db(), { orderId: b.orderId, lines: [{ orderItemId: b.orderItemId, quantity: 1 }], shippedAt: '2026-10-24T15:00:00Z' });
    const slip = await seedGroupG3Slip(db(), { stage: 'confirmed', shipmentDate: '2026-10-25' });
    const op = (await db().query('select confirm_operation_id from public.shipment_slips where id=$1', [slip])).rows[0].confirm_operation_id;
    await db().query('insert into public.shipment_slip_lines(slip_id,order_item_id,quantity) values($1,$2,1)', [slip, b.orderItemId]);
    await db().query('insert into public.shipment_slip_fulfillments(slip_id,order_id,fulfillment_id) values($1,$2,$3)', [slip, b.orderId, f]);
    await db().query(`insert into public.shipment_slip_versions
      (slip_id,version,kind,tracking_version,shipment_date,actor_id,operation_id) values($1,1,'confirm',1,'2026-10-25',$2,$3)`, [slip, randomUUID(), op]);
    await db().query(`insert into public.shipment_date_history
      (slip_id,version,kind,previous_date,new_date,actor_id,operation_id) values($1,1,'initial','2026-10-25','2026-10-25',$2,$3)`, [slip, randomUUID(), op]);
    await db().query(`insert into private.shipment_tracking_registrations
      (slip_id,tracking_version,leader_fulfillment_id,carrier,tracking_number,operation_id)
      values($1,1,$2,'yamato','G3-TRACKING',$3)`, [slip, f, op]);
    return { ...b, slip, f, op };
  }

  test('FREQ-540-AC-12: 所有者も追記専用5表のUPDATE/DELETE/TRUNCATEと票のDELETE/TRUNCATEを変えられない', async () => {
    const g = await historyGraph();
    // Pending deferred foreign-key events otherwise stop TRUNCATE before its rejection trigger can run.
    await flush(db());
    for (const table of TABLES.slice(1)) {
      await rejected(db(), () => db().query(`update ${table} set created_at=created_at where slip_id=$1`, [g.slip]), HISTORY, '55000');
      await rejected(db(), () => db().query(`delete from ${table} where slip_id=$1`, [g.slip]), HISTORY, '55000');
      await rejected(db(), () => db().query(`truncate ${table}`), HISTORY, '55000');
    }
    await rejected(db(), () => db().query('delete from public.shipment_slips where id=$1', [g.slip]), HISTORY, '55000');
    await rejected(db(), () => db().query(`truncate ${TABLES.join(",")}, public.accounting_g_slip_facts`), HISTORY, '55000');
  });

  type Mark = 'draft' | 'discard' | 'confirm' | 'tracking' | 'deliver' | 'date' | 'cancel';
  const marks: Mark[] = ['draft', 'discard', 'confirm', 'tracking', 'deliver', 'date', 'cancel'];
  const allowed: Record<Mark, string> = {
    draft: "draft_lines='[{\"orderItemId\":\"fixture\",\"quantity\":1}]'::jsonb, ship_to_building='B', expires_at=now()+interval '8 days'",
    discard: "stage='discarded',discarded_at=now(),discarded_by=gen_random_uuid(),expires_at=null",
    confirm: "stage='confirmed',confirmed_at=now(),confirmed_by=gen_random_uuid(),confirm_operation_id=gen_random_uuid(),confirm_request_key=gen_random_uuid(),shipment_date=current_date,notify_customer=false,expires_at=null",
    tracking: "shipping_carrier='yamato',tracking_number='G3-2',tracking_version=tracking_version+1",
    deliver: 'updated_at=now()', date: 'shipment_date=shipment_date+1',
    cancel: "stage='cancelled',cancelled_at=now(),cancelled_by=gen_random_uuid()",
  };
  async function updateSlip(id: string, mark: string, changes: string) {
    await db().query("select set_config('app.group_g_slip_change',$1,true)", [mark]);
    return db().query(`update public.shipment_slips set version=version+1,${changes} where id=$1`, [id]);
  }
  test.each(marks)('FREQ-540-AC-12: 操作印 %s は対応する列と段階だけを変更できる', async (mark) => {
    const stage = ['draft', 'discard', 'confirm'].includes(mark) ? 'draft' : 'confirmed';
    const slip = await seedGroupG3Slip(db(), { stage });
    await rejected(db(), () => updateSlip(slip, '', 'updated_at=now()'), HISTORY, '55000');
    for (const changes of ["number='SL-29990101-0001'", 'id=gen_random_uuid()', 'created_at=created_at+interval \'1 second\'',
      'created_by=gen_random_uuid()', mark === 'draft' ? 'tracking_version=tracking_version+1' : "draft_lines='[1]'::jsonb"]) {
      await rejected(db(), () => updateSlip(slip, mark, changes), HISTORY, '55000');
    }
    await rejected(db(), async () => {
      await db().query("select set_config('app.group_g_slip_change',$1,true)", [mark]);
      await db().query('update public.shipment_slips set version=version+2 where id=$1', [slip]);
    }, HISTORY, '55000');
    await db().query('savepoint valid_mark');
    await updateSlip(slip, mark, allowed[mark]);
    expect((await db().query('select version from public.shipment_slips where id=$1', [slip])).rows[0].version).toBe(2);
    await db().query('rollback to savepoint valid_mark');
    const wrongStage = await seedGroupG3Slip(db(), { stage: stage === 'draft' ? 'confirmed' : 'draft' });
    await rejected(db(), () => updateSlip(wrongStage, mark, allowed[mark]), HISTORY, '55000');
  });

  test.each(marks)('FREQ-540-AC-12: 操作印 %s と全変更列の許可表を突き合わせる（対の列は同時更新）', async (mark) => {
    const from = ['draft', 'discard', 'confirm'].includes(mark) ? 'draft' : 'confirmed';
    const id = await seedGroupG3Slip(db(), { stage: from, shipmentDate: '2026-10-24' });
    const actor = randomUUID();
    const timestamp = '2026-10-25T00:00:00Z';
    const confirmation = { stage: 'confirmed', confirmed_at: timestamp, confirmed_by: actor,
      confirm_operation_id: randomUUID(), confirm_request_key: randomUUID(), shipment_date: '2026-10-25',
      notify_customer: false, expires_at: null };
    const patches: Record<Mark, Record<string, unknown>> = {
      draft: {}, discard: { stage: 'discarded', discarded_at: timestamp, discarded_by: actor, expires_at: null },
      confirm: confirmation, tracking: { shipping_carrier: 'yamato', tracking_number: 'G3-MATRIX', tracking_version: 2 },
      deliver: {}, date: { shipment_date: '2026-10-25' },
      cancel: { stage: 'cancelled', cancelled_at: timestamp, cancelled_by: actor },
    };
    const columns: Record<Mark, string[]> = {
      draft: ['draft_lines', 'customer_kind', 'customer_user_id', 'customer_email', 'ship_to_full_name', 'ship_to_postal_code',
        'ship_to_prefecture', 'ship_to_city', 'ship_to_address', 'ship_to_phone', 'ship_to_building', 'expires_at'],
      discard: ['stage', 'discarded_at', 'discarded_by', 'expires_at'],
      confirm: ['stage', 'confirmed_at', 'confirmed_by', 'confirm_operation_id', 'confirm_request_key',
        'shipping_carrier', 'tracking_number', 'notify_customer', 'shipment_date', 'expires_at'],
      tracking: ['shipping_carrier', 'tracking_number', 'tracking_version'], deliver: [], date: ['shipment_date'],
      cancel: ['stage', 'cancelled_at', 'cancelled_by'],
    };
    const candidates: Array<Record<string, unknown>> = [
      { id: randomUUID() }, { number: 'SL-29991229-9999' }, { created_at: timestamp }, { created_by: actor },
      { customer_kind: 'member', customer_user_id: actor, customer_email: null },
      ...['full_name', 'postal_code', 'prefecture', 'city', 'address', 'phone', 'building'].map((part) => ({ [`ship_to_${part}`]: 'Changed' })),
      { draft_lines: [1] }, { shipping_carrier: 'sagawa', tracking_number: 'G3-MATRIX-2' }, { tracking_version: 3 },
      { notify_customer: true }, { shipment_date: '2026-10-26' },
      { expires_at: ['confirm', 'discard'].includes(mark) ? null : '2026-11-01T00:00:00Z' },
      { confirm_request_key: randomUUID() }, { confirm_operation_id: randomUUID() },
      { confirmed_at: timestamp }, { confirmed_by: actor }, { cancelled_at: timestamp }, { cancelled_by: actor },
      { discarded_at: timestamp }, { discarded_by: actor },
      { stage: mark === 'confirm' ? 'confirmed' : mark === 'cancel' ? 'cancelled' : 'discarded' },
    ];
    for (const candidate of candidates) {
      const keys = Object.keys(candidate);
      const permitted = keys.every((key) => columns[mark].includes(key));
      const patch = { ...patches[mark], ...candidate, version: 2, updated_at: timestamp };
      const fields = Object.keys(patch);
      const change = async () => {
        await db().query("select set_config('app.group_g_slip_change',$1,true)", [mark]);
        await db().query(`update public.shipment_slips s set ${fields.map((key) => `${key}=r.${key}`).join(',')}
          from jsonb_populate_record(null::public.shipment_slips,$2::jsonb) r where s.id=$1`, [id, JSON.stringify(patch)]);
      };
      if (permitted) {
        await db().query('savepoint matrix_allowed');
        await change();
        expect((await db().query('select version from public.shipment_slips where id=$1', [id])).rows[0].version).toBe(2);
        await db().query('rollback to savepoint matrix_allowed');
        await db().query('release savepoint matrix_allowed');
      } else {
        await rejected(db(), change, HISTORY, '55000');
      }
    }
  });

  test('FREQ-540-AC-12: draftの期限はNULLにできず、confirm/discardではNULLにする', async () => {
    const slip = await seedGroupG3Slip(db());
    const e = await failure(db(), () => updateSlip(slip, 'draft', 'expires_at=null'));
    expect(e.code).toBe('23514');
    for (const mark of ['confirm', 'discard'] as const) {
      const id = await seedGroupG3Slip(db());
      await updateSlip(id, mark, allowed[mark]);
      expect((await db().query('select expires_at from public.shipment_slips where id=$1', [id])).rows[0].expires_at).toBeNull();
    }
  });

  test('FREQ-533-AC-02: 非legacy発送の日付必須、運送会社・番号は両方NULL可、片方だけはCHECKで拒否', async () => {
    const b = await base(db());
    const f = await bareFulfillment(db(), b.orderId);
    expect((await db().query('select shipment_date::text as d from public.order_fulfillments where id=$1', [f])).rows[0].d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const e = await failure(db(), () => db().query(`insert into public.order_fulfillments
      (order_id,number,request_key,notify_customer,completes_order) values($1,90,gen_random_uuid(),false,false)`, [b.orderId]));
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23514', constraint: 'order_fulfillments_shipment_date_check' });
    for (const pair of [['yamato', null], [null, 'G3']] as const) {
      const caught = await failure(db(), () => db().query(`insert into public.order_fulfillments
        (order_id,number,request_key,notify_customer,completes_order,shipment_date,shipping_carrier,tracking_number)
        values($1,91,gen_random_uuid(),false,false,current_date,$2,$3)`, [b.orderId, ...pair]));
      expect({ code: caught.code, constraint: caught.constraint }).toEqual({ code: '23514', constraint: 'order_fulfillments_tracking_check' });
    }
    expect((await db().query(`insert into public.order_fulfillments
      (order_id,number,request_key,notify_customer,completes_order,legacy) values($1,92,gen_random_uuid(),false,false,true) returning shipment_date`, [b.orderId])).rows[0].shipment_date).toBeNull();
  });

  test('FREQ-533-AC-02: shipment_date印は日付だけ、既存tracking_edit/manual/tracking/取消の更新を保つ', async () => {
    const b = await base(db());
    const f = await bareFulfillment(db(), b.orderId);
    const edit = async (mark: string, changes: string) => {
      await db().query("select set_config('app.fulfillment_change',$1,true)", [mark]);
      await db().query(`update public.order_fulfillments set ${changes} where id=$1`, [f]);
    };
    await edit('shipment_date', 'shipment_date=shipment_date-1');
    for (const changes of ['shipment_date=shipment_date-1,tracking_version=tracking_version+1',
      'shipment_date=shipment_date-1,notify_customer=true', 'shipment_date=shipment_date-1,cancelled_at=now()']) {
      await rejected(db(), () => edit('shipment_date', changes), 'DELIVERY_RECORD_IMMUTABLE', '55000');
    }
    await edit('tracking_edit', "shipping_carrier='yamato',tracking_number='G3-EDIT',tracking_version=tracking_version+1");
    await edit('manual', "delivered_at=now(),delivery_status='delivered',delivery_status_at=now()");
    await edit('tracking', 'delivery_status_at=now()');
    await rejected(db(), () => edit('tracking', "delivery_status='confirmed'"), 'DELIVERY_RECORD_IMMUTABLE', '55000');
    await edit('', 'cancelled_at=now()');
    await rejected(db(), () => edit('shipment_date', 'shipment_date=shipment_date-1'), 'DELIVERY_RECORD_IMMUTABLE', '55000');
  });

  test('FREQ-533-AC-02: line_without_consumeを遅延で拒否し、同じ取引のconsumeは通る', async () => {
    // Leave room for one unbacked line under the older immediate shipped + paid allocation bound.
    const b = await base(db(), 4, 3);
    await flush(db());
    const f = await bareFulfillment(db(), b.orderId);
    await rejected(db(), async () => {
      await db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f, b.orderItemId]);
      await flush(db());
    }, 'GROUP_G_SHIPMENT_CONSUMPTION', '23514', 'line_without_consume');
    await withFixtureConsumption(db(), { orderId: b.orderId, lines: [{ order_item_id: b.orderItemId, quantity: 1 }] },
      () => db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f, b.orderItemId]));
    await flush(db());
  });

  test('FREQ-533-AC-02: consume_without_lineを遅延で拒否する', async () => {
    const b = await base(db());
    await flush(db());
    await rejected(db(), async () => {
      await withFixtureConsumption(db(), { orderId: b.orderId, lines: [{ order_item_id: b.orderItemId, quantity: 1 }] }, async () => undefined);
      await flush(db());
    }, 'GROUP_G_SHIPMENT_CONSUMPTION', '23514', 'consume_without_line');
  });

  test('FREQ-533-AC-02: withFixtureConsumptionは操作FKがIMMEDIATEでも発送材料を作れる', async () => {
    const b = await base(db());
    await flush(db());
    await db().query('set constraints order_item_allocation_events_operation_id_fkey, order_item_state_events_operation_id_fkey immediate');
    await withFixtureConsumption(db(), { orderId: b.orderId, lines: [{ order_item_id: b.orderItemId, quantity: 1 }] }, async () => {
      const f = await bareFulfillment(db(), b.orderId);
      await db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f, b.orderItemId]);
    });
    await flush(db());
  });

  test('FREQ-533-AC-02: cancel_without_restoreとrestore_without_cancelを遅延で拒否し、対で通る', async () => {
    const b = await base(db(), 4, 1);
    const f = await seedGroupG1Shipment(db(), { orderId: b.orderId, lines: [{ orderItemId: b.orderItemId, quantity: 1 }], shippedAt: '2026-10-24T15:00:00Z' });
    await flush(db());
    await rejected(db(), async () => { await db().query('update public.order_fulfillments set cancelled_at=now() where id=$1', [f]); await flush(db()); },
      'GROUP_G_SHIPMENT_CONSUMPTION', '23514', 'cancel_without_restore');
    await rejected(db(), async () => {
      await restoreWithoutCancel(db(), f);
      await flush(db());
    }, 'GROUP_G_SHIPMENT_CONSUMPTION', '23514', 'restore_without_cancel');
    await restoreGroupG1Shipment(db(), f, randomUUID());
    await flush(db());
  });

  test('FREQ-533-AC-02: 同じ票の片方の取消はslip_partial_cancel、両方の取消と最初から取消済みは通る', async () => {
    const first = await base(db());
    const second = await base(db());
    const slip = await seedGroupG3Slip(db(), { stage: 'confirmed' });
    const fulfillments: string[] = [];
    for (const b of [first, second]) {
      const f = await seedGroupG1Shipment(db(), { orderId: b.orderId, lines: [{ orderItemId: b.orderItemId, quantity: 1 }], shippedAt: '2026-10-24T15:00:00Z' });
      fulfillments.push(f);
      await db().query('insert into public.shipment_slip_fulfillments(slip_id,order_id,fulfillment_id) values($1,$2,$3)', [slip, b.orderId, f]);
    }
    await flush(db());
    await rejected(db(), async () => { await restoreGroupG1Shipment(db(), fulfillments[0], randomUUID()); await flush(db()); },
      'GROUP_G_SHIPMENT_CONSUMPTION', '23514', 'slip_partial_cancel');
    for (const f of fulfillments) await restoreGroupG1Shipment(db(), f, randomUUID());
    await flush(db());
    const cancelled = await base(db());
    await seedGroupG1Shipment(db(), { orderId: cancelled.orderId, lines: [{ orderItemId: cancelled.orderItemId, quantity: 1 }],
      shippedAt: '2026-10-24T15:00:00Z', cancelledAt: '2026-10-25T00:00:00Z' });
    await flush(db());
  });

  test('FREQ-533-AC-04: shipment_confirm/shipment_cancelは書け、未知の割当理由はCHECKで拒否', async () => {
    const b = await base(db(), 4, 1);
    const a = (await db().query('select id from public.order_item_allocations where order_item_id=$1 order by id limit 1', [b.orderItemId])).rows[0].id;
    const op = await operation(db(), b.orderId);
    await db().query(`update public.order_item_allocations
      set remaining_quantity=remaining_quantity-1,version=version+1,updated_at=now() where id=$1`, [a]);
    await db().query(`insert into public.order_item_allocation_events(allocation_id,event_type,quantity,operation_id,sequence,reason)
      values($1,'consume',1,$2,1,'shipment_confirm')`, [a, op]);
    const f = await bareFulfillment(db(), b.orderId);
    await db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f, b.orderItemId]);
    await flush(db());
    // Restore means restock + purchase into a new allocation reversing this consume, together with cancellation.
    await restoreWithoutCancel(db(), f);
    await db().query('update public.order_fulfillments set cancelled_at=now() where id=$1', [f]);
    await flush(db());
    expect((await db().query(`select e.reason from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id
      where a.order_item_id=$1 and e.event_type in ('consume','restore') order by e.reason`, [b.orderItemId])).rows)
      .toEqual([{ reason: 'shipment_cancel' }, { reason: 'shipment_confirm' }]);
    const e = await failure(db(), () => db().query(`insert into public.order_item_allocation_events
      (allocation_id,event_type,quantity,operation_id,sequence,reason) values($1,'consume',1,$2,3,'unknown')`, [a, op]));
    expect({ code: e.code, constraint: e.constraint }).toEqual({ code: '23514', constraint: 'order_item_allocation_events_reason_check' });
    await flush(db());
  });

  test('FREQ-540-AC-12: 票番号・確定キー・票×注文・発送IDの一意が効く', async () => {
    const g = await historyGraph();
    const row = (await db().query('select number,confirm_request_key from public.shipment_slips where id=$1', [g.slip])).rows[0];
    expect((await failure(db(), () => seedGroupG3Slip(db(), { number: row.number }))).code).toBe('23505');
    expect((await failure(db(), () => seedGroupG3Slip(db(), { stage: 'confirmed', confirmRequestKey: row.confirm_request_key }))).code).toBe('23505');
    const f2 = await bareFulfillment(db(), g.orderId);
    expect((await failure(db(), () => db().query('insert into public.shipment_slip_fulfillments(slip_id,order_id,fulfillment_id) values($1,$2,$3)', [g.slip, g.orderId, f2]))).code).toBe('23505');
    const slip2 = await seedGroupG3Slip(db());
    expect((await failure(db(), () => db().query('insert into public.shipment_slip_fulfillments(slip_id,order_id,fulfillment_id) values($1,$2,$3)', [slip2, g.orderId, g.f]))).code).toBe('23505');
  });

  test('FREQ-540-AC-12: G-2持ち越しM1は発注書だけがある商品の削除を止め、5列・元のACL/所有者を保つ', async () => {
    const b = await createCatalogFixture(db(), { stock: 0 });
    const po = (await db().query(`insert into public.purchase_orders(number,supplier_name,created_by)
      values('PO-29991231-9999','Fixture',gen_random_uuid()) returning id`)).rows[0].id;
    await db().query("insert into public.purchase_order_lines(purchase_order_id,line_no,variant_id,item_name,provisional_quantity) values($1,1,$2,'Fixture',1)", [po, b.variantId]);
    expect((await db().query('select * from public.item_delete_blockers($1::bigint[])', [[b.itemId]])).rows)
      .toEqual([{ item_id: String(b.itemId), has_orders: false, has_stock_movements: false, has_open_checkouts: false, has_purchase_orders: true }]);
    const p = (await db().query(`select pg_get_userbyid(proowner) as owner,prosecdef,provolatile,proconfig,
      array(select proargnames[i] from generate_subscripts(proallargtypes,1) i where proargmodes[i]='t') as outputs
      from pg_proc where oid='public.item_delete_blockers(bigint[])'::regprocedure`)).rows[0];
    expect(p).toEqual({ owner: 'postgres', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'],
      outputs: ['item_id', 'has_orders', 'has_stock_movements', 'has_open_checkouts', 'has_purchase_orders'] });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db().query("select has_function_privilege($1,'public.item_delete_blockers(bigint[])','EXECUTE') as yes", [role])).rows[0].yes).toBe(role === 'service_role');
    }
  });

  test('FREQ-540-AC-12: 新しい2守りのDEFINER/空search_path/ACL、既存更新守りの属性を保つ', async () => {
    for (const [signature, definer] of [['private.guard_group_g_shipment_slip_change()', true],
      ['private.check_group_g_shipment_consumption()', true], ['private.restrict_fulfillment_record_update()', false]] as const) {
      const p = (await db().query(`select pg_get_userbyid(proowner) as owner,prosecdef,proconfig,
        exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) where grantee=0 and privilege_type='EXECUTE') as public_execute
        from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
      expect({ signature, ...p }).toEqual({ signature, owner: 'postgres', prosecdef: definer, proconfig: ['search_path=""'], public_execute: false });
      if (definer) for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query("select has_function_privilege($1,$2,'EXECUTE') as yes", [role, signature])).rows[0].yes).toBe(false);
      }
    }
  });

  test('FREQ-540-AC-12: roleの権限差し替えはcreateActorの役割に効き、run後に元へ戻る', async () => {
    const actor = await createPurchaseFlow(db).createActor(['supporter']);
    const check = () => db().query("select private.group_g_actor_has_permissions($1,array['admin.shipping.read']) as yes", [actor]);
    const priorRows = (await db().query(`select p.code from public.role_permissions rp
      join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where r.code='supporter' and p.code='admin.shipping.read'`)).rows;
    expect(priorRows).toEqual([{ code: 'admin.shipping.read' }]);
    const prior = (await check()).rows[0].yes;
    expect(prior).toBe(true);
    await withRolePermissions(db(), 'supporter', [], ['admin.shipping.read'], async () => { expect((await check()).rows[0].yes).toBe(false); });
    expect((await check()).rows[0].yes).toBe(prior);
    const catalog = await createCatalogFixture(db(), { stock: 0 });
    const order = await insertOrderWithLines(db(), { status: 'pending',
      lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    await setGroupG3PaidAt(db(), order.orderId, '2026-10-24T14:59:59Z');
    await setOrderStatusForFixture(db(), [order.orderId], 'paid', { paidAmount: 5000 });
    expect((await db().query("select paid_at='2026-10-24T14:59:59Z'::timestamptz as yes from public.orders where id=$1", [order.orderId])).rows[0].yes).toBe(true);
  });

  describe('末尾assertの現在DBと改変の検出', () => {
    const objects = () => finalBlock('$g3a_final_objects$');
    const acl = () => finalBlock('$g3a_final_table_acl$');
    // Restore before any tamper, so the tamper itself is never erased by the restore.
    beforeEach(async () => { await db().query(replaceReasonCheckSql(G3A_REASON_CODES)); });
    test('FREQ-540-AC-12: 2つのDOは現在DBを通し、無関係なgranteeがあっても意味比較で通す', async () => {
      await runWithReasonCodes(db(), G3A_REASON_CODES, objects());
      await db().query(acl());
      const role = `g3_unrelated_${randomUUID().replaceAll('-', '')}`;
      await db().query(`create role ${role} nologin`);
      await db().query(`grant select on public.shipment_slips to ${role}`);
      await db().query(objects());
      await db().query(acl());
    });
    test('FREQ-540-AC-12: 過去取引の行は許し、この取引のcreated_atだけを拒否', async () => {
      const slip = await seedGroupG3Slip(db());
      await rejected(db(), () => db().query(objects()), 'GROUP_G_MIGRATION_ASSERTION_FAILED', '55000', 'shipping_table_rows');
      // Created_at cannot be changed through the guard: use an INSERT with a historical timestamp instead.
      await db().query('rollback');
      await db().query('begin');
      await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      await db().query(replaceReasonCheckSql(G3A_REASON_CODES));
      await db().query(`insert into public.shipment_slips
        (id,number,stage,customer_kind,customer_email,ship_to_full_name,ship_to_postal_code,ship_to_prefecture,
         ship_to_city,ship_to_address,ship_to_phone,expires_at,created_by,created_at)
        values($1,'SL-29991230-9999','draft','guest','fixture@example.invalid','F','0','F','F','F','0',now()+interval '7 days',gen_random_uuid(),now()-interval '1 day')`, [slip]);
      await db().query(objects());
    });
    test.each([
      ['drop table private.shipment_tracking_registrations', 'shipping_tables'],
      ['alter table public.shipment_slips disable row level security', 'shipping_tables'],
      ['alter table public.shipment_slips add column unexpected integer', 'shipping_tables'],
      ['drop policy "deny direct client access" on public.shipment_slip_lines', 'shipping_tables'],
      ['drop trigger shipment_slip_versions_no_update on public.shipment_slip_versions', 'shipping_table_triggers'],
      ['alter table public.order_fulfillment_lines disable trigger group_g_shipment_consumption', 'shipping_consumption_triggers'],
      ['alter table public.order_fulfillments drop constraint order_fulfillments_shipment_date_check', 'shipping_fulfillment_columns'],
      ["alter function private.guard_group_g_shipment_slip_change() set search_path=public", 'shipping_guard_functions'],
      ['alter table public.order_item_allocation_events drop constraint order_item_allocation_events_reason_check', 'shipping_reason_codes'],
      ['grant execute on function public.item_delete_blockers(bigint[]) to authenticated', 'shipping_delete_blockers'],
    ])('FREQ-540-AC-12: 末尾assertが改変を検出 %s', async (tamper, detail) => {
      await rejected(db(), async () => { await db().query(tamper); await db().query(objects()); }, 'GROUP_G_MIGRATION_ASSERTION_FAILED', '55000', detail);
    });
    test.each(['grant select on public.shipment_slips to anon', 'grant select(id) on public.shipment_slips to authenticated',
      'grant insert on public.shipment_slip_lines to service_role', 'grant select on public.shipment_slips to public'])('FREQ-540-AC-12: 表ACLの改変を検出 %s', async (tamper) => {
      await rejected(db(), async () => { await db().query(tamper); await db().query(acl()); }, 'GROUP_G_MIGRATION_ASSERTION_FAILED', '55000', 'shipping_table_acl');
    });
    test('FREQ-540-AC-12: PG17以降のMAINTAINの追加も拒否', async () => {
      if (!(await db().query("select current_setting('server_version_num')::integer>=170000 as yes")).rows[0].yes) return;
      await rejected(db(), async () => { await db().query('grant maintain on public.shipment_slips to service_role'); await db().query(acl()); },
        'GROUP_G_MIGRATION_ASSERTION_FAILED', '55000', 'shipping_table_acl');
    });
  });
});

/** These fixtures intentionally COMMIT synthetic rows; orders and histories cannot be deleted. Controller disposable DB only. */
describeLocalDb('group_g3_fixtures: 共有材料の実COMMIT', (db) => {
  async function assertDates(orderId: string) {
    const rows = (await db().query(`select shipment_date is not null and
      shipment_date=(shipped_at at time zone 'Asia/Tokyo')::date as valid
      from public.order_fulfillments where order_id=$1 and not legacy`, [orderId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.valid)).toBe(true);
  }
  test('FREQ-533-AC-02: seedGroupG1ShipmentのJST境界と取消済みの材料を実COMMITできる', async () => {
    let orderId = '';
    await withGroupG1FixtureTransaction(db(), async () => {
      const b = await base(db()); orderId = b.orderId;
      const f = await seedGroupG1Shipment(db(), { orderId, lines: [{ orderItemId: b.orderItemId, quantity: 1 }], shippedAt: '2026-10-24T15:00:00Z' });
      expect((await db().query('select shipment_date::text as d from public.order_fulfillments where id=$1', [f])).rows[0].d).toBe('2026-10-25');
      await restoreGroupG1Shipment(db(), f, randomUUID());
      await seedGroupG1Shipment(db(), { orderId, lines: [{ orderItemId: b.orderItemId, quantity: 1 }],
        shippedAt: '2026-10-24T14:59:59Z', cancelledAt: '2026-10-25T00:00:00Z' });
    });
    await assertDates(orderId);
  });
  test('FREQ-533-AC-02: order-fixturesのshipFixtureOrderを実COMMITできる', async () => {
    let orderId = '';
    await withGroupG1FixtureTransaction(db(), async () => {
      const b = await base(db()); orderId = b.orderId;
      await shipFixtureOrder(db(), { orderId, actorId: null, lines: [{ order_item_id: b.orderItemId, quantity: 1 }] });
    });
    await assertDates(orderId);
  });
  test('FREQ-533-AC-02: order-status-fixturesの交換の発送を実COMMITできる', async () => {
    let orderId = '';
    await withGroupG1FixtureTransaction(db(), async () => { orderId = (await createOrderStatusReturnsFixture(db(), 'exchange_shipped')).orderId; });
    await assertDates(orderId);
    expect(Number((await db().query(`select count(*) as n from public.order_fulfillment_lines l
      join public.order_items oi on oi.id=l.order_item_id where oi.order_id=$1 and oi.line_kind='exchange'`, [orderId])).rows[0].n)).toBeGreaterThan(0);
  });
  test('FREQ-533-AC-02: insertDeliveryFixtureとwithFixtureConsumptionを実COMMITできる', async () => {
    let orderId = '';
    await withGroupG1FixtureTransaction(db(), async () => {
      const b = await base(db()); orderId = b.orderId;
      await withFixtureConsumption(db(), { orderId, lines: [{ order_item_id: b.orderItemId, quantity: 1 }] }, async () => {
        const f = await insertDeliveryFixture(db(), { orderId, shippedAt: '2026-10-24T15:00:00Z' });
        await db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f.fulfillmentId, b.orderItemId]);
      });
    });
    await assertDates(orderId);
  });
  test('FREQ-533-AC-02: 自動コミットで発送行だけを足すと文の終わりに拒否され行が残らない', async () => {
    let f = ''; let item = '';
    await withGroupG1FixtureTransaction(db(), async () => {
      const b = await base(db(), 4, 3); item = b.orderItemId; f = await bareFulfillment(db(), b.orderId);
    });
    let result: Failure = {};
    try { await db().query('insert into public.order_fulfillment_lines values($1,$2,1)', [f, item]); }
    catch (caught) { const e = caught as Failure; result = { code: e.code, message: e.message === 'GROUP_G_SHIPMENT_CONSUMPTION' ? e.message : 'G3_UNEXPECTED_DB_ERROR', detail: e.detail }; }
    expect(result).toEqual({ code: '23514', message: 'GROUP_G_SHIPMENT_CONSUMPTION', detail: 'line_without_consume' });
    expect((await db().query('select count(*)::integer as n from public.order_fulfillment_lines where fulfillment_id=$1', [f])).rows[0].n).toBe(0);
  });
});
