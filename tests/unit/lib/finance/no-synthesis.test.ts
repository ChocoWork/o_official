import fs from 'node:fs';
import path from 'node:path';

// 画面は注文の売上と Stripe の仕訳を合成せず、保存した仕訳だけで数える（FREQ-570）。
// `mergeJournalEntries`（保存した仕訳と決算整理の仕訳を重ねない道具）と過去の履歴の文書は数えない。
// `order:` の文字列は数えない（entry-review.ts の `order:${…}` は合成でない）。
// `toOrderSalesTransaction`・`order-sales.ts` は KPI の route がまだ使っているので、数えるのは Task 13。

const SRC = path.join(process.cwd(), 'src');
const BANNED = ['buildStripeJournal', 'buildOrderSalesJournal', 'mapOrderIncome', 'stripe:sale:'] as const;

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
	});
}

describe('合成の仕訳が残っていない', () => {
	const files = sourceFiles(SRC);

	it('FREQ-570-AC-04: srcに buildStripeJournal・buildOrderSalesJournal・mapOrderIncome・stripe:sale: が残っていない', () => {
		expect(files.length).toBeGreaterThan(100);
		const found = files.flatMap((file) => {
			const text = fs.readFileSync(file, 'utf8');
			return BANNED.filter((word) => text.includes(word)).map((word) => `${path.relative(process.cwd(), file)}: ${word}`);
		});
		expect(found).toEqual([]);
	});

	it('FREQ-570-AC-04: 定数の書類（constants.ts）も数え、重ねる道具 mergeJournalEntries は残る', () => {
		expect(files.map((file) => path.relative(SRC, file).replaceAll('\\', '/'))).toContain('components/cost-profit/constants.ts');
		const merge = fs.readFileSync(path.join(SRC, 'lib/finance/stripe-journal.ts'), 'utf8');
		expect(merge).toContain('export function mergeJournalEntries');
	});
});
