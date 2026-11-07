import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, type BusinessType } from '@/lib/finance/accounts';
import { buildJournal, type EntryType } from '@/lib/finance/journal';
import {
	MANUAL_BUSINESS_TYPES,
	MANUAL_DIRECTIONS,
	MANUAL_PAYMENT_METHODS,
	buildCategoryMapRows,
	buildManualAccountMapSql,
	buildMethodMapRows,
	sqlText,
} from '@/../scripts/accounting/emit-manual-account-map';

// S4 の対応表（FREQ-556-AC-01・AC-03）。移行の行は生成スクリプトの出力そのままで、2つの表で引いた勘定は
// 全部の組で buildJournal の借方・貸方と同じになる。トリガーの引き方（科目は表→9999、方法は表→科目の表→9999）を
// ここで同じ順に書き、移行から読み戻した行で引く。
const directory = path.join(process.cwd(), 'supabase/migrations');
const s4Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_manual_entry_journal.sql'));
const s4Path = s4Files.length === 1 ? path.join(directory, s4Files[0]) : '';
const s4Sql = s4Path ? fs.readFileSync(s4Path, 'utf8') : '';
const mapBlock = s4Sql.split('-- ACC_MANUAL_MAP_BEGIN\n')[1]?.split('-- ACC_MANUAL_MAP_END')[0] ?? '';

/** SQL の文字の値（'...' か U&'...'）を元の文字へ戻す。 */
function decodeSqlText(literal: string): string {
	const unicode = literal.startsWith("U&'");
	const body = literal.slice(unicode ? 3 : 1, -1).replaceAll("''", "'");
	if (!unicode) return body;
	return body.replace(/\\(\\|\+[0-9A-F]{6}|[0-9A-F]{4})/g, (_, code: string) =>
		code === '\\' ? '\\' : String.fromCodePoint(parseInt(code.replace('+', ''), 16)));
}

const LITERAL = String.raw`(U&'(?:[^']|'')*'|'(?:[^']|'')*')`;
const categoryRows = [...mapBlock.matchAll(new RegExp(String.raw`^ {2}\(${LITERAL},'(\d{4})'\)[,;]$`, 'gm'))]
	.map((m) => ({ sourceText: decodeSqlText(m[1]), accountCode: m[2] }));
const methodRows = [...mapBlock.matchAll(new RegExp(String.raw`^ {2}\(${LITERAL},'(expense|income)','(soleProprietor|corporation)','(\d{4})'\)[,;]$`, 'gm'))]
	.map((m) => ({ sourceText: decodeSqlText(m[1]), direction: m[2], businessType: m[3], accountCode: m[4] }));

const categoryByName = new Map(categoryRows.map((row) => [row.sourceText, row.accountCode]));
const methodByKey = new Map(methodRows.map((row) => [`${row.sourceText}\u0000${row.direction}\u0000${row.businessType}`, row.accountCode]));

/** トリガーと同じ引き方で、借方・貸方の勘定の符号を返す。 */
function lookupFromTables(category: string, paymentMethod: string, entryType: EntryType, businessType: BusinessType) {
	const counter = categoryByName.get(category) ?? '9999';
	const funds = methodByKey.get(`${paymentMethod}\u0000${entryType}\u0000${businessType}`)
		?? categoryByName.get(paymentMethod) ?? '9999';
	return entryType === 'expense' ? { debit: counter, credit: funds } : { debit: funds, credit: counter };
}

function lookupFromBuildJournal(category: string, paymentMethod: string, entryType: EntryType, businessType: BusinessType) {
	const [entry] = buildJournal([{ id: 1, entryType, date: '2026-01-01', category, item: 'x', partner: '', amount: 100, paymentMethod, memo: '' }], businessType);
	const debit = entry.lines.filter((line) => line.debit > 0).map((line) => line.account.code);
	const credit = entry.lines.filter((line) => line.credit > 0).map((line) => line.account.code);
	expect({ debit: debit.length, credit: credit.length }).toEqual({ debit: 1, credit: 1 });
	return { debit: debit[0], credit: credit[0] };
}

describe('S4 の手入力の勘定の対応表', () => {
	test('FREQ-556-AC-01: 移行の対応表の行は生成スクリプトの出力と同じで、読み戻すと科目162行・方法は全部の組になる', () => {
		expect(s4Path).not.toBe('');
		expect(mapBlock).toBe(buildManualAccountMapSql());
		expect(mapBlock).not.toMatch(/[^\x00-\x7f]|\r/);
		expect(categoryRows).toEqual(buildCategoryMapRows());
		expect(categoryRows).toHaveLength(ACCOUNTS.length);
		expect(new Set(categoryRows.map((row) => row.sourceText)).size).toBe(ACCOUNTS.length);
		expect(methodRows).toEqual(buildMethodMapRows());
		expect(methodRows).toHaveLength(MANUAL_PAYMENT_METHODS.length * MANUAL_DIRECTIONS.length * MANUAL_BUSINESS_TYPES.length);
		// 「プライベート」は事業の形と向きで行き先が変わる（payment-methods.ts の説明どおり）。
		expect(methodRows.filter((row) => row.sourceText === 'プライベート').map((row) => [row.direction, row.businessType, row.accountCode]))
			.toEqual([['expense', 'soleProprietor', '2920'], ['expense', 'corporation', '2120'], ['income', 'soleProprietor', '1910'], ['income', 'corporation', '2120']]);
	});

	test('FREQ-556-AC-01: 手入力の対応表はbuildJournalの借方貸方と全部の組で一致する', () => {
		const names = ACCOUNTS.map((account) => account.name);
		const categories = [...names, '未登録の科目'];
		const methods = [...new Set([...MANUAL_PAYMENT_METHODS, ...names, '未登録の方法'])];
		let compared = 0;
		const mismatches: string[] = [];
		for (const category of categories) {
			for (const paymentMethod of methods) {
				for (const entryType of MANUAL_DIRECTIONS) {
					for (const businessType of MANUAL_BUSINESS_TYPES) {
						const fromTables = lookupFromTables(category, paymentMethod, entryType, businessType);
						const fromJournal = lookupFromBuildJournal(category, paymentMethod, entryType, businessType);
						compared += 1;
						if (fromTables.debit !== fromJournal.debit || fromTables.credit !== fromJournal.credit) {
							mismatches.push(`${category}/${paymentMethod}/${entryType}/${businessType}`);
						}
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
		expect(compared).toBe(categories.length * methods.length * 4);
	});

	test('FREQ-556-AC-03: 対応表に無い科目名と方法は9999になる', () => {
		expect(lookupFromTables('未登録の科目', '現金', 'expense', 'soleProprietor')).toEqual({ debit: '9999', credit: '1010' });
		expect(lookupFromTables('売上高', '未登録の方法', 'income', 'corporation')).toEqual({ debit: '9999', credit: '4010' });
		expect(lookupFromBuildJournal('未登録の科目', '未登録の方法', 'expense', 'soleProprietor')).toEqual({ debit: '9999', credit: '9999' });
	});

	test('FREQ-556-AC-01: 文字の値は ASCII だけで書き、引用符・逆斜線・BMP 外の字も元へ戻せる', () => {
		for (const value of ['現金', "a'b", 'a\\b', '\u{20BB7}野家', 'plain']) {
			const literal = sqlText(value);
			expect(literal).not.toMatch(/[^\x00-\x7f]/);
			expect(decodeSqlText(literal)).toBe(value);
		}
		expect(sqlText('現金')).toBe("U&'\\73FE\\91D1'");
		expect(sqlText('plain')).toBe("'plain'");
	});
});
