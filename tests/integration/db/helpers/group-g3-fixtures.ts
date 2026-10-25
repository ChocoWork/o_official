import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { withGroupG1FixtureTransaction } from './group-g1-fixtures';

type SlipStage = 'draft' | 'confirmed' | 'cancelled' | 'discarded';
export type GroupG3SlipInput = {
  id?: string; number?: string; stage?: SlipStage; actorId?: string;
  customerKind?: 'member' | 'guest'; customerUserId?: string; customerEmail?: string;
  draftLines?: unknown[]; shipmentDate?: string; shippingCarrier?: 'yamato' | 'sagawa' | 'japanpost';
  trackingNumber?: string; confirmRequestKey?: string; confirmOperationId?: string;
};

/** Local DB material only; the caller's transaction must already hold the common advisory. */
export async function seedGroupG3Slip(client: PgClient, input: GroupG3SlipInput = {}): Promise<string> {
  return withGroupG1FixtureTransaction(client, async () => {
    const id = input.id ?? randomUUID();
    const actor = input.actorId ?? randomUUID();
    const stage = input.stage ?? 'draft';
    const confirmed = stage === 'confirmed' || stage === 'cancelled';
    const operationId = confirmed ? input.confirmOperationId ?? randomUUID() : null;
    if (confirmed && !input.confirmOperationId) {
      await client.query(`insert into private.group_g_operations
        (id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
        values ($1,'shipment_slip_confirm',$2,repeat('a',64),'shipment_slip',$3,$4,'{}')`,
      [operationId, randomUUID(), id, actor]);
    }
    // INSERT is outside the UPDATE/DELETE guard; no operation mark is needed here.
    const result = await client.query(`insert into public.shipment_slips
      (id,number,stage,customer_kind,customer_user_id,customer_email,
       ship_to_full_name,ship_to_postal_code,ship_to_prefecture,ship_to_city,ship_to_address,ship_to_phone,
       draft_lines,shipping_carrier,tracking_number,notify_customer,shipment_date,expires_at,
       confirm_request_key,confirm_operation_id,confirmed_at,confirmed_by,cancelled_at,cancelled_by,
       discarded_at,discarded_by,created_by)
      values ($1,coalesce($2::text, 'SL-29991231-' || lpad((coalesce((select max(right(number,4)::integer)
        from public.shipment_slips where number like 'SL-29991231-%'),0)+1)::text,4,'0')),
        $3,$4,$5,$6,'Fixture','0000000','Fixture','Fixture','Fixture','0000000000',
        $7::jsonb,$8,$9,case when $10::boolean then false else null end,
        case when $10::boolean then coalesce($11::date,(now() at time zone 'Asia/Tokyo')::date) else null end,
        case when $3::text='draft' then now()+interval '7 days' else null end,
        $12,$13,case when $10::boolean then now() else null end,case when $10::boolean then $14::uuid else null end,
        case when $3::text='cancelled' then now() else null end,case when $3::text='cancelled' then $14::uuid else null end,
        case when $3::text='discarded' then now() else null end,case when $3::text='discarded' then $14::uuid else null end,$14)
      returning id`,
    [id, input.number ?? null, stage, input.customerKind ?? 'guest',
      input.customerKind === 'member' ? input.customerUserId ?? randomUUID() : null,
      input.customerKind === 'member' ? null : input.customerEmail ?? 'fixture@example.invalid',
      JSON.stringify(input.draftLines ?? []), input.shippingCarrier ?? null, input.trackingNumber ?? null,
      confirmed, input.shipmentDate ?? null, confirmed ? input.confirmRequestKey ?? randomUUID() : null, operationId, actor]);
    return result.rows[0].id as string;
  });
}

/** Set the first paid_at before marking the order paid; the database guard permits NULL -> value once. */
export async function setGroupG3PaidAt(client: PgClient, orderId: string, paidAt: string): Promise<void> {
  await withGroupG1FixtureTransaction(client, async () => {
    const result = await client.query(
      'update public.orders set paid_at=$2::timestamptz where id=$1 and paid_at is null returning id', [orderId, paidAt]);
    if (result.rowCount !== 1) throw new Error('GROUP_G_FIXTURE_PAID_AT_ALREADY_SET');
  });
}

/** Permissions belong to roles. Restore exactly the affected role/permission pairs after a successful run. */
export async function withRolePermissions<T>(
  client: PgClient, roleCode: 'admin' | 'supporter', grant: string[], revoke: string[], run: () => Promise<T>,
): Promise<T> {
  return withGroupG1FixtureTransaction(client, async () => {
    const codes = [...new Set([...grant, ...revoke])];
    const prior = (await client.query(`select rp.permission_id from public.role_permissions rp
      join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where r.code=$1 and p.code=any($2::text[])`, [roleCode, codes])).rows.map((row) => String(row.permission_id));
    await client.query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [roleCode, grant]);
    await client.query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in(select id from public.permissions where code=any($2::text[]))`, [roleCode, revoke]);
    const result = await run();
    await client.query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in(select id from public.permissions where code=any($2::text[]))`, [roleCode, codes]);
    // Permission IDs are bigint in this project; node-pg returns them as strings.
    await client.query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.id::text=any($2::text[])
      on conflict do nothing`, [roleCode, prior]);
    return result;
  });
}
