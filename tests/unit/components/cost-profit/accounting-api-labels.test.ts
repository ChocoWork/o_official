import { eventKindLabel } from '@/components/cost-profit/accounting-api';

// 仕訳帳の種類の呼び名（計画2 T12 N1 の申し送り。preflight #28）。計画3の種類を「仕訳」にしない。

describe('出来事の種類の呼び名', () => {
	it('FREQ-575-AC-03: 返品の届いた日の直しの仕訳は「返品の届いた日の直し」と出し、知らない種類だけを「仕訳」にする', () => {
		expect(eventKindLabel('return_arrival_redated')).toBe('届いた日の直し');
		expect(eventKindLabel('return_refund')).toBe('返品の返金');
		expect(eventKindLabel('a_kind_nobody_knows')).toBe('仕訳');
	});
});
