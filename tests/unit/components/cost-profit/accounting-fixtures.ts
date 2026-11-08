// 計画2の会計の画面の試験で使う作り物（Task 10 の route の答えの形。snake_case と camelCase は route のとおり混ぜる）。
import type { PendingEvent } from '@/lib/accounting/posting-types';
import { uuid } from './settings-fixtures';

export { uuid };

export const BASE = '/api/admin/accounting';

export type Flags = { manageSettings?: boolean; manageFinance?: true; correctEntries?: true };

/** route の読みの封筒。権限の旗は持つ時だけ true で付く。 */
export function envelope(data: unknown, flags: Flags = {}) {
	return { data, permissions: { manageSettings: false, ...flags } };
}

export const ALL_FLAGS: Flags = { manageSettings: true, manageFinance: true, correctEntries: true };

export function pendingEvent(n: number, overrides: Partial<PendingEvent> = {}): PendingEvent {
	return {
		id: uuid(200 + n),
		eventKind: 'shipment_confirmed',
		sourceTable: 'shipment_slips',
		sourceId: uuid(500 + n),
		orderId: uuid(600 + n),
		reason: 'payment_journal_missing',
		detail: { order_count: 1 },
		firstDetectedAt: '2026-11-08T01:00:00+00:00',
		lastDetectedAt: '2026-11-09T01:00:00+00:00',
		detectionCount: 2,
		resolvedAt: null,
		resolvedEntryId: null,
		...overrides,
	};
}

export function pendingPage(events: PendingEvent[], extra: Record<string, unknown> = {}) {
	return { events, nextAfterAt: null, nextAfterId: null, openCount: events.length, byReason: {}, ...extra };
}

export function dispute(n: number, overrides: Record<string, unknown> = {}) {
	return {
		dispute_id: `dp_${String(n).padStart(4, '0')}`,
		reason: 'fraudulent',
		status: 'under_review',
		amount: 30000,
		order_id: uuid(700 + n),
		stripe_created_at: '2026-10-20T03:00:00+00:00',
		withdrawn_on: '2026-10-20',
		confirmed_on: null,
		assigned_account_code: null,
		pending_reasons: [],
		...overrides,
	};
}

export function disputePage(disputes: unknown[], extra: Record<string, unknown> = {}) {
	return { disputes, next_after_at: null, next_after_id: null, ...extra };
}
