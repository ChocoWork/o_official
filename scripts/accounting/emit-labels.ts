// npx tsx scripts/accounting/emit-labels.ts
// ACCOUNTING_LABELS の各語を SQL の `U&'\XXXX'` 形で標準出力へ出す（計画2の移行 S7〜S11 の本文へ貼る）。

import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '../../src/lib/accounting/labels';

/** 語ごとに1行 `-- <語の名前>: U&'…'`。 */
export function buildLabelsSql(): string {
	return `${Object.entries(ACCOUNTING_LABELS)
		.map(([key, value]) => `-- ${key}: ${encodeSqlUnicodeLiteral(value)}`)
		.join('\n')}\n`;
}

if (require.main === module) {
	process.stdout.write(buildLabelsSql());
}
