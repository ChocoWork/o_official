// npx tsx scripts/accounting/emit-manual-account-map.ts
// 手入力の取引の勘定の対応表（S4 の `-- ACC_MANUAL_MAP_BEGIN/END` の間へ貼る INSERT の本文）を標準出力へ出す。
// - accounting_manual_category_map: ACCOUNTS の名前 → 符号（resolveAccount と同じく事業の形も向きも見ない）。
//   載っていない名前は、トリガーが 9999 に入れる。
// - accounting_manual_method_map: 入出金方法 × 向き × 事業の形 → 資金の科目の符号（paymentMethodAccountName を全部の組で
//   呼び、resolveAccount で符号にした結果）。載っていない方法は、トリガーがその文字を科目名として科目の対応表で引き、
//   それも無ければ 9999 に入れる（paymentMethodAccountName が知らない方法をそのまま返すのと同じ）。
// SQL は ASCII だけで書くため、日本語は U&'\XXXX' 形にする。

import { ACCOUNTS, resolveAccount, type BusinessType } from '../../src/lib/finance/accounts';
import {
	EXPENSE_PAYMENT_METHODS,
	INCOME_PAYMENT_METHODS,
	paymentMethodAccountName,
} from '../../src/lib/finance/payment-methods';

export type ManualDirection = 'expense' | 'income';
export const MANUAL_DIRECTIONS: readonly ManualDirection[] = ['expense', 'income'];
export const MANUAL_BUSINESS_TYPES: readonly BusinessType[] = ['soleProprietor', 'corporation'];

/**
 * 対応表に載せる入出金方法。画面の2つの選択肢に、payment-methods.ts の表にだけある名前（Stripe）を足した物。
 * Stripe は画面では選べないが、paymentMethodAccountName が科目名を変えるので表に載せる。
 */
export const MANUAL_PAYMENT_METHODS: readonly string[] = [
	...new Set<string>([...EXPENSE_PAYMENT_METHODS, ...INCOME_PAYMENT_METHODS, 'Stripe']),
];

export type CategoryMapRow = { sourceText: string; accountCode: string };
export type MethodMapRow = {
	sourceText: string;
	direction: ManualDirection;
	businessType: BusinessType;
	accountCode: string;
};

export function buildCategoryMapRows(): CategoryMapRow[] {
	return ACCOUNTS.map((account) => ({ sourceText: account.name, accountCode: account.code }));
}

export function buildMethodMapRows(): MethodMapRow[] {
	return MANUAL_PAYMENT_METHODS.flatMap((method) =>
		MANUAL_DIRECTIONS.flatMap((direction) =>
			MANUAL_BUSINESS_TYPES.map((businessType) => ({
				sourceText: method,
				direction,
				businessType,
				accountCode: resolveAccount(paymentMethodAccountName(method, businessType, direction)).code,
			})),
		),
	);
}

/** 文字列を SQL の文字の値にする。ASCII の印字できる字はそのまま、ほかは U&'\XXXX'（BMP 外は \+XXXXXX）。 */
export function sqlText(value: string): string {
	let body = '';
	let escaped = false;
	for (const char of value) {
		const point = char.codePointAt(0) ?? 0;
		if (char === "'") body += "''";
		else if (char === '\\') {
			body += '\\\\';
			escaped = true;
		} else if (point >= 0x20 && point <= 0x7e) body += char;
		else {
			escaped = true;
			body += point > 0xffff
				? `\\+${point.toString(16).toUpperCase().padStart(6, '0')}`
				: `\\${point.toString(16).toUpperCase().padStart(4, '0')}`;
		}
	}
	return escaped ? `U&'${body}'` : `'${body}'`;
}

export function buildManualAccountMapSql(): string {
	const categories = buildCategoryMapRows().map((row) => `  (${sqlText(row.sourceText)},'${row.accountCode}')`);
	const methods = buildMethodMapRows().map(
		(row) => `  (${sqlText(row.sourceText)},'${row.direction}','${row.businessType}','${row.accountCode}')`,
	);
	return `INSERT INTO public.accounting_manual_category_map (source_text,account_code) VALUES\n${categories.join(',\n')};\n`
		+ `INSERT INTO public.accounting_manual_method_map (source_text,direction,business_type,account_code) VALUES\n${methods.join(',\n')};\n`;
}

if (require.main === module) {
	process.stdout.write(buildManualAccountMapSql());
}
