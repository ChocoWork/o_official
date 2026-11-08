// 会計の期間・設定・保存した仕訳の読みの型と、DB の拒否を HTTP へ直す表（計画1 の「共通の型・値・拒否」）。

import type { FilingDeadline, InterimFiling } from '@/lib/accounting/filing-deadlines';
import type { SavedJournalEntry } from '@/lib/accounting/journal-types';
import type { AccountingPeriod } from '@/lib/accounting/period';
import type { StartupDeadline } from '@/lib/accounting/startup-deadlines';

/**
 * DB message / SQLSTATE の完全一致だけで公開する。表に無い失敗は ACCOUNTING_TEXT.failed の500にする。
 * `ACCOUNTING_PERIOD_MISSING` だけは DETAIL の固定の語 `sole_ended_not_switched` で本文を選ぶ（生の DETAIL は返さない）。
 */
export const ACCOUNTING_ERRORS = {
	ACCOUNTING_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
	ACCOUNTING_FORBIDDEN: ['42501', 403, '会計を操作する権限がありません。'],
	ACCOUNTING_NOT_FOUND: ['P0002', 404, '会計の記録が見つかりません。'],
	ACCOUNTING_ENTRY_UNBALANCED: ['23514', 409, '仕訳の借方と貸方が合いません。'],
	ACCOUNTING_DEDUPE_CONTENT_MISMATCH: ['23505', 409, '同じ出来事で内容の違う仕訳は入れられません。'],
	ACCOUNTING_ALREADY_REVERSED: ['23505', 409, 'この仕訳は既に取り消されています。'],
	ACCOUNTING_DATE_OUT_OF_PERIOD: ['22023', 409, '仕訳の日が会計の期間に入っていません。'],
	ACCOUNTING_PERIOD_MISSING: ['55000', 409, 'この日付の会計の期間がありません。先に期間を作ってください。'],
	ACCOUNTING_PERIOD_OVERLAP: ['23514', 409, '会計の期間が重なっています。'],
	ACCOUNTING_PERIOD_GAP: ['23514', 409, '会計の期間にすき間があります。'],
	ACCOUNTING_PERIOD_TOO_LONG: ['23514', 409, '会計の期間は1年を超えられません。'],
	ACCOUNTING_PERIOD_SHORTEN_BLOCKED: [
		'55000',
		409,
		'やめた日を変えられません。やめた日より後の日付の仕訳が無いか確かめてください。',
	],
	ACCOUNTING_OPENING_TYPE_MISMATCH: ['55000', 409, '事業の形が違う期間から期首の残高は写せません。'],
	ACCOUNTING_OPENING_UNBALANCED: ['23514', 409, '期首の元入金が資産と負債の差と合いません。'],
	ACCOUNTING_SETTINGS_LOCKED: ['55000', 409, '開業日は一度入れると選び直せません。'],
	ACCOUNTING_VERSION_CONFLICT: ['40001', 409, '設定が変わりました。読み直してください。'],
	ACCOUNTING_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
	ACCOUNTING_HISTORY_IMMUTABLE: ['55000', 500, '会計の処理に失敗しました。'],
	// 計画2（計上待ち・支払いの取り消しの設定）。
	ACCOUNTING_EVENT_NOT_POSTABLE: ['55000', 409, 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。'],
	ACCOUNTING_PENDING_RESOLVED: ['55000', 409, 'この計上待ちは既に解決されています。'],
	ACCOUNTING_DISPUTE_ACCOUNT_INVALID: ['22023', 400, '選んだ勘定は、支払いの取り消しの振り替え先に使えません。'],
} as const satisfies Readonly<Record<string, readonly [sqlstate: string, status: number, message: string]>>;

export type AccountingErrorCode = keyof typeof ACCOUNTING_ERRORS;

export const ACCOUNTING_TEXT = {
	failed: '会計の処理に失敗しました。',
	invalid: '入力を確かめてください。',
	periodMissingSoleEnded:
		'やめた日より後の日付です。やめた日が正しいか確かめ、正しければ事業の形を法人へ切り替えてください。',
} as const;

/** `ACCOUNTING_PERIOD_MISSING` の DETAIL のうち、本文を選び分ける固定の語。 */
export const SOLE_ENDED_NOT_SWITCHED = 'sole_ended_not_switched';

/** 生の文を保持しない。未知の SQLSTATE だけを非列挙の診断用プロパティへ残す。 */
export class AccountingStoreError extends Error {
	readonly status: number;
	readonly code: AccountingErrorCode | null;
	readonly sqlstate?: string;
	/** `message` は route が固定の文で本文を置き換える時だけ渡す（DB の文は渡さない）。 */
	constructor(code?: string | null, sqlstate?: unknown, options?: { soleEndedNotSwitched?: boolean; message?: string }) {
		const entry =
			typeof code === 'string' && Object.hasOwn(ACCOUNTING_ERRORS, code)
				? ACCOUNTING_ERRORS[code as AccountingErrorCode]
				: undefined;
		const soleEnded = code === 'ACCOUNTING_PERIOD_MISSING' && options?.soleEndedNotSwitched === true;
		super(options?.message ?? (soleEnded ? ACCOUNTING_TEXT.periodMissingSoleEnded : entry ? entry[2] : ACCOUNTING_TEXT.failed));
		this.name = 'AccountingStoreError';
		this.status = entry ? entry[1] : 500;
		this.code = entry ? (code as AccountingErrorCode) : null;
		if (!entry && typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) {
			Object.defineProperty(this, 'sqlstate', { value: sqlstate, enumerable: false });
		}
	}
}

/**
 * 続きの目印（afterAt・afterId など）が古くて DB が 22023 で断った時。画面に一覧の最初から読み直させるため、
 * 一般の入力の誤り（400）と分けて 409 `ACCOUNTING_LIST_RESTART` で返す。
 */
export const ACCOUNTING_LIST_RESTART = {
	code: 'ACCOUNTING_LIST_RESTART',
	status: 409,
	message: '一覧が変わりました。最初から読み直してください。',
} as const;

export class AccountingListRestartError extends Error {
	constructor() {
		super(ACCOUNTING_LIST_RESTART.message);
		this.name = 'AccountingListRestartError';
	}
}

export type SoleEndChange = { previousEndedOn: string | null; newEndedOn: string; reason: string; changedAt: string };

export type AccountingSettings = {
	businessStartDate: string | null;
	cutoverOn: string;
	currentBusinessType: AccountingPeriod['businessType'];
	soleBusinessEndedOn: string | null;
	/** bigint の10進文字列。 */
	version: string;
	soleEndChanges: SoleEndChange[];
};

/** `signedAmount` は借方−貸方。行が1つも無ければ期首は無い（basis none）。 */
export type OpeningBalanceRow = { accountCode: string; signedAmount: number; basis: 'stored' | 'carryover' | 'none' };

export const MAX_JOURNAL_PAGE = 200;
export const DEFAULT_JOURNAL_PAGE = 100;

export type JournalCursor = { entryDate: string; entryNo: number };
export type SavedJournalQuery = {
	periodId: string;
	from?: string;
	to?: string;
	limit?: number;
	afterEntryDate?: string;
	afterEntryNo?: number;
};
export type SavedJournalPage = { entries: SavedJournalEntry[]; nextAfter: JournalCursor | null };

/**
 * 画面の出し分けに使う閲覧者の権限。manageSettings は admin.accounting.settings.manage。
 * manageFinance（admin.finance.manage: 計上係・補充・請求書・年末の印）と correctEntries（admin.accounting.entries.correct:
 * 計上待ちの確認済み・取り消しの振り替え）は、持つ時だけ true で付ける（無ければ鍵を付けない。計画1の応答の形を変えない）。
 */
export type AccountingPermissions = { manageSettings: boolean; manageFinance?: true; correctEntries?: true };

export type AccountingPeriodsData = {
	periods: AccountingPeriod[];
	settings: AccountingSettings;
	deadlines: Record<string, FilingDeadline[]>;
	interim: Record<string, InterimFiling[]>;
	startup: StartupDeadline[];
};

/** 出荷の仕訳に付ける、出荷した日と発送票を確定した日（6-c）。そのページの出荷の仕訳だけ。 */
export type ShipmentMeta = { entryId: string; slipNumber: string; shipmentDate: string; confirmedAt: string };

export type AccountingJournalData = SavedJournalPage & { opening: OpeningBalanceRow[]; shipmentMeta: ShipmentMeta[] };
