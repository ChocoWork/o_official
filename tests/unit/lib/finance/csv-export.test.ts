import { buildCsvText } from '@/lib/finance/csv-export';

describe('共通のCSV関数', () => {
	it('FREQ-558-AC-01: 共通のCSV関数は全セルを引用符で囲み改行をCRLFにしBOMを付ける', () => {
		const text = buildCsvText([
			['a"b', 1],
			['c,d', 'e\nf'],
		]);
		expect(text).toBe('﻿"a""b","1"\r\n"c,d","e\nf"');
		expect(text.startsWith('﻿')).toBe(true);
	});
});
