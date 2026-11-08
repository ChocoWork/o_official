// npx tsx scripts/accounting/emit-stripe-categories.ts
// src/lib/accounting/stripe-categories.ts の対応表から、SQL の private.accounting_stripe_category_kind の全文を標準出力へ出す
// （計画2の移行 S9 の `-- ACC_S9_CATEGORY_MAP_BEGIN`〜`END` の間へ貼る）。

import { buildStripeCategoryKindSql } from '../../src/lib/accounting/stripe-categories';

if (require.main === module) {
	process.stdout.write(buildStripeCategoryKindSql());
}
