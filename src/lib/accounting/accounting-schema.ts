// 会計の期間・設定・仕訳の読みの route が受ける本文と問い合わせの検査（I/O なし）。

import { z } from 'zod';
import { DEFAULT_JOURNAL_PAGE, MAX_JOURNAL_PAGE, type SavedJournalQuery } from '@/lib/accounting/accounting-types';
import { parseIsoDate } from '@/lib/accounting/period';

const BIGINT_MAX = BigInt('9223372036854775807');

export const uuidSchema = z.string().uuid();
/** 暦にある `YYYY-MM-DD` だけ。 */
export const isoDateSchema = z.string().refine((value) => {
	try {
		parseIsoDate(value);
		return true;
	} catch {
		return false;
	}
});
/** bigint の版（1 以上の10進文字列）。zod は形の誤りの後も refine を呼ぶので、refine の中でも形を確かめる。 */
export const versionSchema = z.string().refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX);
const businessTypeSchema = z.enum(['soleProprietor', 'corporation']);
const extensionSchema = z.union([z.literal(0), z.literal(1)]);

export const createPeriodBodySchema = z
	.object({ businessType: businessTypeSchema, startsOn: isoDateSchema, endsOn: isoDateSchema, requestKey: uuidSchema })
	.strict();
export type CreatePeriodBody = z.infer<typeof createPeriodBodySchema>;

/** `reason` は選び直しで必須（DB が判定する）。初めての登録は省略か null。 */
export const finalSoleBodySchema = z
	.object({
		endedOn: isoDateSchema,
		expectedPeriodVersion: versionSchema,
		expectedSettingsVersion: versionSchema,
		reason: z.string().trim().min(1).max(500).nullable().optional(),
		requestKey: uuidSchema,
	})
	.strict();
export type FinalSoleBody = z.infer<typeof finalSoleBodySchema>;

/** 消費税の延長は法人税の延長を受けた時だけ。免税は日付なし、課税は課税事業者になった日あり。 */
export const filingBodySchema = z
	.object({
		corporateTaxExtensionMonths: extensionSchema,
		consumptionTaxExtensionMonths: extensionSchema,
		consumptionTaxStatus: z.enum(['exempt', 'taxable']),
		consumptionTaxableFrom: isoDateSchema.nullable(),
		expectedVersion: versionSchema,
		requestKey: uuidSchema,
	})
	.strict()
	.refine((b) => b.consumptionTaxExtensionMonths <= b.corporateTaxExtensionMonths)
	.refine((b) => (b.consumptionTaxStatus === 'exempt') === (b.consumptionTaxableFrom === null));
export type FilingBody = z.infer<typeof filingBodySchema>;

export const settingsBodySchema = z
	.object({
		businessStartDate: isoDateSchema.nullable(),
		currentBusinessType: businessTypeSchema,
		expectedVersion: versionSchema,
		requestKey: uuidSchema,
	})
	.strict();
export type SettingsBody = z.infer<typeof settingsBodySchema>;

const JOURNAL_KEYS = new Set(['periodId', 'from', 'to', 'limit', 'afterEntryDate', 'afterEntryNo']);
const positiveInt = (max: number) => z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).pipe(z.number().int().min(1).max(max));
const journalQuerySchema = z
	.object({
		periodId: uuidSchema.optional(),
		from: isoDateSchema.optional(),
		to: isoDateSchema.optional(),
		limit: positiveInt(MAX_JOURNAL_PAGE).optional(),
		afterEntryDate: isoDateSchema.optional(),
		afterEntryNo: positiveInt(Number.MAX_SAFE_INTEGER).optional(),
	})
	.strict()
	.refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to)
	.refine((q) => (q.afterEntryDate === undefined) === (q.afterEntryNo === undefined));

/** 期間を省略した問い合わせは `periodId` が undefined。知らない鍵・重ねた鍵は断る（null）。 */
export function parseJournalQuery(
	params: URLSearchParams,
): (Omit<SavedJournalQuery, 'periodId'> & { periodId?: string; limit: number }) | null {
	const raw: Record<string, string> = {};
	for (const [key, value] of params) {
		if (!JOURNAL_KEYS.has(key) || Object.hasOwn(raw, key)) return null;
		raw[key] = value;
	}
	const parsed = journalQuerySchema.safeParse(raw);
	if (!parsed.success) return null;
	return { ...parsed.data, limit: parsed.data.limit ?? DEFAULT_JOURNAL_PAGE };
}
