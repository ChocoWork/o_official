import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { minimumSchema, validateDiscountActivation } from './admin-discount-schema';
import {
  GROUP_H_ERRORS, GROUP_H_TEXT,
  type AdminDiscountDetailData, type DiscountAssignmentResult, type DiscountBatchResult, type DiscountCreateInput,
  type DiscountFilters, type DiscountListRow, type DiscountMember, type DiscountPatch, type DiscountWriteResult, type GroupHErrorCode,
} from './admin-discount-types';
import { DISCOUNT_PAGE_SIZE, MAX_DISCOUNT_BATCH } from './discount-types';

/** 生の文を保持しない。未知のSQLSTATEだけを非列挙の診断用プロパティへ残す。 */
export class AdminDiscountStoreError extends Error {
  readonly status: number;
  readonly code: GroupHErrorCode | null;
  readonly sqlstate?: string;
  constructor(code?: string | null, sqlstate?: unknown) {
    const entry = typeof code === 'string' && Object.hasOwn(GROUP_H_ERRORS, code) ? GROUP_H_ERRORS[code as GroupHErrorCode] : undefined;
    super(entry ? entry[2] : GROUP_H_TEXT.failed);
    this.name = 'AdminDiscountStoreError';
    this.status = entry ? entry[1] : 500;
    this.code = entry ? (code as GroupHErrorCode) : null;
    if (!entry && typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) {
      Object.defineProperty(this, 'sqlstate', { value: sqlstate, enumerable: false });
    }
  }
}

function sqlstateOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/** messageとSQLSTATEの両方が表の1行と一致した時だけ固定コードにする。 */
function classify(error: unknown): AdminDiscountStoreError {
  if (error !== null && typeof error === 'object' && 'message' in error && 'code' in error
    && typeof error.message === 'string' && Object.hasOwn(GROUP_H_ERRORS, error.message)
    && GROUP_H_ERRORS[error.message as GroupHErrorCode][0] === error.code) return new AdminDiscountStoreError(error.message);
  return new AdminDiscountStoreError(null, sqlstateOf(error));
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response;
  try { response = await client.rpc(name, args); } catch (error) { throw new AdminDiscountStoreError(null, sqlstateOf(error)); }
  if (response.error) throw classify(response.error);
  return response.data as unknown;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new AdminDiscountStoreError();
  return result.data;
}

const uuid = z.string().uuid();
const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)));
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const definitionFields = {
  name: z.string().min(1), kind: z.enum(['order_percent', 'order_amount', 'product', 'repeat', 'set']), method: z.enum(['code', 'automatic']),
  value: z.object({ type: z.enum(['percent', 'amount']), value: z.number().int().min(1) }).strict(),
  targetMode: z.enum(['all', 'exclude', 'include']), itemIds: z.array(z.number().int().min(1)),
  minimum: minimumSchema,
  audience: z.enum(['assigned', 'anyone']), allowGuests: z.boolean(), firstOrderOnly: z.boolean(),
  usageLimit: z.number().int().min(1).nullable(), oncePerCustomer: z.boolean(), startsAt: timestamp, endsAt: timestamp.nullable(),
  stopped: z.boolean(), combinesWithProduct: z.boolean(), combinesWithOrder: z.boolean(), advertise: z.boolean(),
  advertisingText: z.string().nullable(), repeatPrevious: z.boolean(), repeatInOrder: z.boolean(),
};
const candidateSchema = z.object(definitionFields).strict();
const definitionSchema = z.object({ id: uuid, version: z.string().regex(/^[1-9][0-9]*$/), ...definitionFields }).strict();
const attentionSchema = z.object({ openedAt: timestamp, count }).strict().nullable();
const listSchema = z.object({
  total: count,
  rows: z.array(z.object({
    id: uuid, name: z.string(), kind: definitionFields.kind, method: definitionFields.method,
    status: z.enum(['scheduled', 'active', 'expired', 'stopped']), startsAt: timestamp, endsAt: timestamp.nullable(),
    usedCount: count, usageLimit: z.number().int().min(1).nullable(), searchAttention: attentionSchema,
  }).strict()).max(DISCOUNT_PAGE_SIZE),
}).strict();
const assignmentSchema = z.object({
  rowId: z.string().min(1), codeId: uuid, code: z.string().min(1), userId: uuid.nullable(), assigneeDeleted: z.boolean(),
  assigneeName: z.string().nullable(), guestEmailMasked: z.string().nullable(), status: z.enum(['unused', 'reserved', 'confirmed']),
  usedAt: timestamp.nullable(), orderId: uuid.nullable(),
}).strict();
const detailSchema = z.object({
  discount: definitionSchema, used: z.boolean(), assignmentTotal: count,
  assignments: z.array(assignmentSchema).max(DISCOUNT_PAGE_SIZE), searchAttention: attentionSchema,
}).strict();
const writeSchema = z.object({ discountId: uuid, version: z.string().regex(/^[1-9][0-9]*$/), replayed: z.boolean() }).strict();
const assignResultSchema = z.object({ discountId: uuid, changedCount: z.number().int().min(0).max(MAX_DISCOUNT_BATCH), replayed: z.boolean() }).strict();
const batchSchema = z.object({
  discountId: uuid, batchId: uuid, replayed: z.boolean(),
  codes: z.array(z.object({ codeId: uuid, code: z.string().min(1), userId: uuid.nullable() }).strict()).min(1).max(MAX_DISCOUNT_BATCH),
}).strict();
const membersSchema = z.object({
  rows: z.array(z.object({ userId: uuid, name: z.string().nullable(), email: z.string().min(1) }).strict()).max(20),
}).strict();
const contextSchema = z.object({ candidate: candidateSchema, existing: z.array(definitionSchema) }).strict();

const offsetOf = (page: number): number => {
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new AdminDiscountStoreError('GROUP_H_ARGUMENT_INVALID');
  return (page - 1) * DISCOUNT_PAGE_SIZE;
};

/** DBへ渡す本文。codeModeは保存しない。コードの無い作成はcodeキー自体を送らない。 */
function dbPayload(payload: DiscountCreateInput | DiscountPatch | { stopped: false }): Record<string, unknown> {
  const body: Record<string, unknown> = { ...payload };
  delete body.codeMode;
  if (body.code === null) delete body.code;
  return body;
}

export async function listAdminDiscounts(client: SupabaseClient, actorId: string, filters: DiscountFilters, page: number): Promise<{ total: number; rows: DiscountListRow[] }> {
  const offset = offsetOf(page);
  const raw = await rpc(client, 'list_admin_discounts', { _filters: filters, _limit: DISCOUNT_PAGE_SIZE, _offset: offset, _actor_id: actorId });
  return parse(listSchema, raw) as { total: number; rows: DiscountListRow[] };
}

/** DB順（コード→rowId）のまま返す。並べ直さない。 */
export async function getAdminDiscount(client: SupabaseClient, actorId: string, id: string, page: number): Promise<AdminDiscountDetailData> {
  const offset = offsetOf(page);
  const raw = await rpc(client, 'get_admin_discount', { _discount_id: id, _assignment_limit: DISCOUNT_PAGE_SIZE, _assignment_offset: offset, _actor_id: actorId });
  const detail = parse(detailSchema, raw);
  if (!sameId(detail.discount.id, id)) throw new AdminDiscountStoreError();
  return detail as AdminDiscountDetailData;
}

/**
 * 保存前の確認（dry-run）。候補と重なる期間の目録を読み、有効数と共有itemを純粋schemaで先に確かめる。
 * 要求キーを知らないので、書込みの前提には使わない（下のcreate/update/resumeは呼ばずwriterの答えを正とする）。
 * 確認中に他の設定が変わっても、writerが鍵の下で同じ検査を行う。
 */
export async function validateAdminDiscountActivation(
  client: SupabaseClient, actorId: string, id: string | null, patch: DiscountCreateInput | DiscountPatch | { stopped: false },
): Promise<void> {
  const raw = await rpc(client, 'get_admin_discount_activation_context', { _discount_id: id, _patch: dbPayload(patch), _actor_id: actorId });
  const context = parse(contextSchema, raw);
  const result = validateDiscountActivation(context.candidate, context.existing, id ?? undefined);
  if (!result.ok) throw new AdminDiscountStoreError(result.code);
}

/*
 * create / update / resume は writer を必ず呼ぶ。writer は鍵の下で最初に同じ要求キーの再送を探して元の結果を返し、
 * 再送でなければ有効数・コード・使用後の固定項目を同じ固定コードで断る。
 * 保存前の目録の読取（validateAdminDiscountActivation）は要求キーを知らないので、再送の時に自分が作った行を
 * 「既に使われている」「上限に達した」と数えて断る。そのためここでは単独の拒否の根拠にせず、呼ばない。
 */
export async function createAdminDiscount(client: SupabaseClient, actorId: string, input: DiscountCreateInput, requestKey: string): Promise<DiscountWriteResult> {
  const raw = await rpc(client, 'admin_create_discount', { _input: dbPayload(input), _request_key: requestKey, _actor_id: actorId });
  return parse(writeSchema, raw);
}

export async function updateAdminDiscount(
  client: SupabaseClient, actorId: string, id: string, patch: DiscountPatch, expectedVersion: string, requestKey: string,
): Promise<DiscountWriteResult> {
  const raw = await rpc(client, 'admin_update_discount', { _discount_id: id, _patch: dbPayload(patch), _expected_version: expectedVersion, _request_key: requestKey, _actor_id: actorId });
  const result = parse(writeSchema, raw);
  if (!sameId(result.discountId, id)) throw new AdminDiscountStoreError();
  return result;
}

export async function setAdminDiscountStopped(
  client: SupabaseClient, actorId: string, id: string, stopped: boolean, expectedVersion: string, requestKey: string,
): Promise<DiscountWriteResult> {
  const raw = await rpc(client, 'admin_set_discount_stopped', { _discount_id: id, _stopped: stopped, _expected_version: expectedVersion, _request_key: requestKey, _actor_id: actorId });
  const result = parse(writeSchema, raw);
  if (!sameId(result.discountId, id)) throw new AdminDiscountStoreError();
  return result;
}

export async function duplicateAdminDiscount(client: SupabaseClient, actorId: string, id: string, requestKey: string): Promise<DiscountWriteResult> {
  const raw = await rpc(client, 'admin_duplicate_discount', { _discount_id: id, _request_key: requestKey, _actor_id: actorId });
  const result = parse(writeSchema, raw);
  if (sameId(result.discountId, id)) throw new AdminDiscountStoreError();
  return result;
}

export async function assignAdminDiscount(
  client: SupabaseClient, actorId: string, id: string, codeId: string, userIds: readonly string[], requestKey: string,
): Promise<DiscountAssignmentResult> {
  if (userIds.length < 1 || userIds.length > MAX_DISCOUNT_BATCH) throw new AdminDiscountStoreError('GROUP_H_ARGUMENT_INVALID');
  const raw = await rpc(client, 'admin_assign_discount', { _discount_id: id, _code_id: codeId, _user_ids: userIds, _request_key: requestKey, _actor_id: actorId });
  const result = parse(assignResultSchema, raw);
  if (!sameId(result.discountId, id) || result.changedCount > userIds.length) throw new AdminDiscountStoreError();
  return result;
}

export async function unassignAdminDiscount(
  client: SupabaseClient, actorId: string, id: string, codeId: string, userId: string, requestKey: string,
): Promise<DiscountAssignmentResult> {
  const raw = await rpc(client, 'admin_unassign_discount', { _discount_id: id, _code_id: codeId, _user_id: userId, _request_key: requestKey, _actor_id: actorId });
  const result = parse(assignResultSchema, raw);
  if (!sameId(result.discountId, id) || result.changedCount > 1) throw new AdminDiscountStoreError();
  return result;
}

/** userIdsが空なら誰でも使える束。入っていれば人数=countの会員限定の束。 */
export async function generateAdminDiscountCodes(
  client: SupabaseClient, actorId: string, id: string, prefix: string, userIds: readonly string[], count: number, requestKey: string,
): Promise<DiscountBatchResult> {
  if (userIds.length > MAX_DISCOUNT_BATCH || (userIds.length > 0 && userIds.length !== count)) throw new AdminDiscountStoreError('GROUP_H_ARGUMENT_INVALID');
  const raw = await rpc(client, 'admin_generate_discount_codes', {
    _discount_id: id, _prefix: prefix, _user_ids: userIds.length > 0 ? userIds : null, _count: count, _request_key: requestKey, _actor_id: actorId,
  });
  const result = parse(batchSchema, raw);
  const assigned = userIds.length > 0;
  if (!sameId(result.discountId, id) || result.codes.length !== count
    || result.codes.some((c, i) => (assigned ? c.userId === null || !sameId(c.userId, userIds[i]) : c.userId !== null))) throw new AdminDiscountStoreError();
  return result;
}

export async function searchAdminDiscountMembers(client: SupabaseClient, actorId: string, query: string): Promise<DiscountMember[]> {
  const raw = await rpc(client, 'search_admin_discount_members', { _query: query, _limit: 20, _actor_id: actorId });
  return parse(membersSchema, raw).rows;
}
