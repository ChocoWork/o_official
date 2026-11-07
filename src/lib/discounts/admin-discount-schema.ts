import { z } from 'zod';
import type { DiscountActivationCode, DiscountFilters } from './admin-discount-types';
import {
  MAX_AUTOMATIC_DISCOUNTS, MAX_DISCOUNT_BATCH, MAX_STACKABLE_AUTOMATIC_PER_CLASS, type DiscountDefinition,
} from './discount-types';

const INT_MAX = 2147483647;
const BIGINT_MAX = '9223372036854775807';
export const MAX_ADMIN_DISCOUNT_PAGE = 100000;
const KINDS = ['order_percent', 'order_amount', 'product', 'repeat', 'set'] as const;
const STATUSES = ['scheduled', 'active', 'expired', 'stopped'] as const;
const CODE_PATTERN = /^[A-Z0-9-]{1,64}$/;
const PREFIX_PATTERN = /^[A-Z0-9]([A-Z0-9-]{0,53}[A-Z0-9])?$/;

export const uuidSchema = z.string().uuid();
const BIGINT_PATTERN = /^(0|[1-9][0-9]*)$/;
// zod 4 は regex が外れても refine を走らせる。BigInt('v1') の例外で500にしないよう、形が合う時だけ比べる。
export const bigintStringSchema = z.string().regex(BIGINT_PATTERN).refine((v) => !BIGINT_PATTERN.test(v) || BigInt(v) <= BigInt(BIGINT_MAX));
const isoSchema = z.string().datetime({ offset: true });
const codeSchema = z.string().trim().toUpperCase().regex(CODE_PATTERN);
const prefixSchema = z.string().trim().toUpperCase().regex(PREFIX_PATTERN);
const uniqueUuids = (min: number, max: number) => z.array(uuidSchema).min(min).max(max).refine((a) => new Set(a.map((v) => v.toLowerCase())).size === a.length);

const valueSchema = z.object({ type: z.enum(['percent', 'amount']), value: z.number().int().min(1).max(INT_MAX) }).strict()
  .refine((v) => v.type !== 'percent' || v.value <= 99);
export const minimumSchema = z.union([
  z.object({ type: z.literal('none'), value: z.literal(0) }).strict(),
  z.object({ type: z.enum(['amount', 'quantity']), value: z.number().int().min(1).max(INT_MAX) }).strict(),
]);
const itemIdsSchema = z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).max(1000).refine((a) => new Set(a).size === a.length);

const fields = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(KINDS), method: z.enum(['code', 'automatic']), value: valueSchema,
  targetMode: z.enum(['all', 'exclude', 'include']), itemIds: itemIdsSchema, minimum: minimumSchema,
  audience: z.enum(['assigned', 'anyone']), allowGuests: z.boolean(), firstOrderOnly: z.boolean(),
  usageLimit: z.number().int().min(1).max(INT_MAX).nullable(), oncePerCustomer: z.boolean(),
  startsAt: isoSchema, endsAt: isoSchema.nullable(), stopped: z.boolean(),
  combinesWithProduct: z.boolean(), combinesWithOrder: z.boolean(), advertise: z.boolean(),
  advertisingText: z.string().trim().min(1).max(200).nullable(), repeatPrevious: z.boolean(), repeatInOrder: z.boolean(),
};

type Definition = Omit<DiscountDefinition, 'id' | 'version'>;

/** kind別の対象・値・最低条件・guest・広告の整合。DBのgroup_h_candidateと同じ規則。 */
function definitionIssues(d: Definition): string[] {
  const issues: string[] = [];
  const order = d.kind === 'order_percent' || d.kind === 'order_amount';
  if (d.kind === 'order_percent' && d.value.type !== 'percent') issues.push('value');
  if (d.kind === 'order_amount' && d.value.type !== 'amount') issues.push('value');
  if (d.value.type === 'amount' && (d.minimum.type !== 'amount' || d.minimum.value <= d.value.value)) issues.push('minimum');
  if (order && d.targetMode !== 'all') issues.push('targetMode');
  if (d.kind === 'product' && d.targetMode === 'include') issues.push('targetMode');
  if ((d.kind === 'repeat' || d.kind === 'set') && d.targetMode !== 'include') issues.push('targetMode');
  if (d.targetMode === 'all' && d.itemIds.length > 0) issues.push('itemIds');
  if (d.kind === 'set' && (d.itemIds.length < 2 || d.itemIds.length > 10)) issues.push('itemIds');
  if (d.kind === 'repeat' && (d.itemIds.length === 0 || (!d.repeatPrevious && !d.repeatInOrder))) issues.push('repeat');
  if (d.audience === 'assigned' && d.allowGuests) issues.push('allowGuests');
  if (d.method === 'automatic' && (d.audience !== 'anyone' || !d.allowGuests)) issues.push('audience');
  if (d.advertise && d.method !== 'automatic') issues.push('advertise');
  if (d.endsAt !== null && Date.parse(d.endsAt) <= Date.parse(d.startsAt)) issues.push('endsAt');
  return issues;
}

const initialBatchSchema = z.object({
  prefix: prefixSchema, userIds: uniqueUuids(0, MAX_DISCOUNT_BATCH), count: z.number().int().min(1).max(MAX_DISCOUNT_BATCH),
}).strict().refine((b) => b.userIds.length === 0 || b.userIds.length === b.count);

export const discountCreateInputSchema = z.object({
  ...fields, code: codeSchema.nullable(), codeMode: z.enum(['shared', 'batch']), initialBatch: initialBatchSchema.optional(),
}).strict().superRefine((d, ctx) => {
  for (const path of definitionIssues(d)) ctx.addIssue({ code: 'custom', message: 'invalid', path: [path] });
  // 初回の束は割引と同じトランザクションで作る。共有・自動には束を受け付けない。
  const batch = d.method === 'code' && d.codeMode === 'batch';
  if (batch !== (d.initialBatch !== undefined)) ctx.addIssue({ code: 'custom', message: 'initialBatch', path: ['initialBatch'] });
  if (batch && d.initialBatch && ((d.audience === 'assigned') !== (d.initialBatch.userIds.length > 0))) ctx.addIssue({ code: 'custom', message: 'audience', path: ['audience'] });
  if (d.method === 'automatic' && d.code !== null) ctx.addIssue({ code: 'custom', message: 'code', path: ['code'] });
  if (d.method === 'code' && d.codeMode === 'shared' && d.code === null) ctx.addIssue({ code: 'custom', message: 'code', path: ['code'] });
  if (d.method === 'code' && d.codeMode === 'batch' && d.code !== null) ctx.addIssue({ code: 'custom', message: 'code', path: ['code'] });
});

const patchObject = z.object(fields).omit({ stopped: true }).extend({ code: codeSchema }).partial().strict()
  .refine((p) => Object.keys(p).length > 0);
const acknowledgeSchema = z.object({ acknowledgeSearchAttention: z.literal(true) }).strict();
/** stopped は専用の stop / resume だけ。空patchと未知キーは400。制御patchはtrue単独だけ。 */
export const discountPatchSchema = z.union([acknowledgeSchema, patchObject]);

const strictBody = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const createBodySchema = strictBody({ input: discountCreateInputSchema, requestKey: uuidSchema });
export const patchBodySchema = strictBody({ patch: discountPatchSchema, expectedVersion: bigintStringSchema, requestKey: uuidSchema });
export const stopBodySchema = strictBody({ expectedVersion: bigintStringSchema, requestKey: uuidSchema });
export const duplicateBodySchema = strictBody({ requestKey: uuidSchema });
export const assignBodySchema = strictBody({ codeId: uuidSchema, userIds: uniqueUuids(1, MAX_DISCOUNT_BATCH), requestKey: uuidSchema });
export const unassignBodySchema = strictBody({ codeId: uuidSchema, userId: uuidSchema, requestKey: uuidSchema });
export const codesBodySchema = strictBody({
  prefix: prefixSchema, userIds: uniqueUuids(0, MAX_DISCOUNT_BATCH),
  count: z.number().int().min(1).max(MAX_DISCOUNT_BATCH), requestKey: uuidSchema,
}).refine((b) => b.userIds.length === 0 || b.userIds.length === b.count);

export type CreateBody = z.output<typeof createBodySchema>;
export type PatchBody = z.output<typeof patchBodySchema>;


/** 未知のキーと重複を拒否して、許可したキーだけの辞書にする。 */
function strictParams(params: URLSearchParams, allowed: readonly string[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) return null;
    result[key] = params.get(key) as string;
  }
  return result;
}
const pageSchema = z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number).refine((n) => n <= MAX_ADMIN_DISCOUNT_PAGE);

/** 一覧の query: status,kind,method,query,page のみ。空のqueryは指定なし。 */
export function parseDiscountListQuery(params: URLSearchParams): { filters: DiscountFilters; page: number } | null {
  const raw = strictParams(params, ['status', 'kind', 'method', 'query', 'page']);
  if (!raw) return null;
  const parsed = z.object({
    status: z.enum(STATUSES).optional(), kind: z.enum(KINDS).optional(), method: z.enum(['code', 'automatic']).optional(),
    query: z.string().trim().max(100).optional(), page: pageSchema.optional(),
  }).strict().safeParse(raw);
  if (!parsed.success) return null;
  const { page, query, ...rest } = parsed.data;
  return { filters: { ...rest, ...(query ? { query } : {}) }, page: page ?? 1 };
}

export function parseDiscountDetailQuery(params: URLSearchParams): { page: number } | null {
  const raw = strictParams(params, ['page']);
  if (!raw) return null;
  const parsed = z.object({ page: pageSchema.optional() }).strict().safeParse(raw);
  return parsed.success ? { page: parsed.data.page ?? 1 } : null;
}

/** 会員検索の query は必須で、DBと同じ2〜100字。 */
export function parseDiscountMemberQuery(params: URLSearchParams): { query: string } | null {
  const raw = strictParams(params, ['query']);
  if (!raw) return null;
  const parsed = z.object({ query: z.string().trim().min(2).max(100) }).strict().safeParse(raw);
  return parsed.success ? { query: parsed.data.query } : null;
}

type Existing = Pick<DiscountDefinition, 'id' | 'method' | 'kind' | 'stopped' | 'startsAt' | 'endsAt' | 'combinesWithProduct' | 'combinesWithOrder' | 'itemIds'>;
type Candidate = Pick<DiscountDefinition, 'method' | 'kind' | 'stopped' | 'startsAt' | 'endsAt' | 'combinesWithProduct' | 'combinesWithOrder' | 'itemIds'>;

/**
 * 保存前の有効数検査。DBのgroup_h_check_catalogと同じ規則を、保存前に読んだ目録で先に確かめる。
 * 終わった期間（endsAt <= now）と停止中は、始点にも件数にも数えない。最終の判定は鍵の下のDBが行う。
 */
export function validateDiscountActivation(
  input: Candidate, existing: readonly Existing[], replacingId?: string, now: Date = new Date(),
): { ok: true } | { ok: false; code: DiscountActivationCode } {
  const nowMs = now.getTime();
  const live = (d: Candidate): boolean => !d.stopped && (d.endsAt === null || Date.parse(d.endsAt) > nowMs);
  const pool: Candidate[] = [...existing.filter((d) => d.id !== replacingId), input].filter(live);
  const startOf = (d: Candidate): number => Date.parse(d.startsAt);
  const covers = (d: Candidate, at: number): boolean => startOf(d) <= at && (d.endsAt === null || at < Date.parse(d.endsAt));
  const automatic = pool.filter((d) => d.method === 'automatic');
  if (automatic.some((edge) => automatic.filter((d) => covers(d, startOf(edge))).length > MAX_AUTOMATIC_DISCOUNTS)) {
    return { ok: false, code: 'GROUP_H_AUTOMATIC_LIMIT' };
  }
  const stackable = automatic.filter((d) => d.combinesWithProduct || d.combinesWithOrder);
  const orderSide = (d: Candidate): boolean => d.kind === 'order_percent' || d.kind === 'order_amount';
  if (stackable.some((edge) => stackable.filter((d) => orderSide(d) === orderSide(edge) && covers(d, startOf(edge))).length > MAX_STACKABLE_AUTOMATIC_PER_CLASS)) {
    return { ok: false, code: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' };
  }
  const sets = pool.filter((d) => d.kind === 'set' && d.combinesWithProduct);
  const overlap = (a: Candidate, b: Candidate): boolean => (a.endsAt === null || startOf(b) < Date.parse(a.endsAt)) && (b.endsAt === null || startOf(a) < Date.parse(b.endsAt));
  for (let n = 0; n < sets.length; n++) {
    for (let m = 0; m < n; m++) {
      if (overlap(sets[n], sets[m]) && sets[n].itemIds.some((id) => sets[m].itemIds.includes(id))) {
        return { ok: false, code: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' };
      }
    }
  }
  return { ok: true };
}
