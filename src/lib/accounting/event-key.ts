// 出来事の印（dedupe_key）。`<前置き>:<番号>[:<番号>…]` の形で、番号は `:` を含まないので
// 種類と番号の組が違えば印も違う。SQL の private.accounting_event_key(_kind,_parts) と同じ文字列を作る。

import {
	ACCOUNTING_EVENT_KINDS,
	EVENT_KEY_ARITY,
	EVENT_KEY_PREFIX,
	isAccountingEventKind,
	type AccountingEventKind,
} from '@/lib/accounting/event-kinds';

export type EventKeyParts = readonly string[];
export type AccountingEventKey = `${string}:${string}`;

const PART_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export class AccountingEventKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AccountingEventKeyError';
	}
}

export function buildEventKey(kind: AccountingEventKind, parts: EventKeyParts): AccountingEventKey {
	if (typeof kind !== 'string' || !isAccountingEventKind(kind)) {
		throw new AccountingEventKeyError('unknown event kind');
	}
	if (parts.length !== EVENT_KEY_ARITY[kind]) {
		throw new AccountingEventKeyError(`event key for ${kind} needs ${EVENT_KEY_ARITY[kind]} parts`);
	}
	for (const part of parts) {
		if (typeof part !== 'string' || !PART_PATTERN.test(part)) {
			throw new AccountingEventKeyError(`invalid event key part for ${kind}`);
		}
	}
	return `${EVENT_KEY_PREFIX[kind]}:${parts.join(':')}` as AccountingEventKey;
}

export function parseEventKey(key: string): { kind: AccountingEventKind; parts: string[] } | null {
	for (const kind of ACCOUNTING_EVENT_KINDS) {
		const head = `${EVENT_KEY_PREFIX[kind]}:`;
		if (!key.startsWith(head)) continue;
		const parts = key.slice(head.length).split(':');
		if (parts.length !== EVENT_KEY_ARITY[kind] || !parts.every((part) => PART_PATTERN.test(part))) return null;
		return { kind, parts };
	}
	return null;
}
