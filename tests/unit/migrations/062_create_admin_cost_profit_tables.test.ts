export {};

const fs = require('fs');
const path = require('path');

describe('062_create_admin_cost_profit_tables migration', () => {
	const sql = fs.readFileSync(
		path.join(process.cwd(), 'migrations', '062_create_admin_cost_profit_tables.sql'),
		'utf8',
	);

	it('会計3テーブルとRLSを作成する', () => {
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.admin_finance_seasons');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.admin_finance_expenses');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.admin_product_costs');
		expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
	});

	it('管理者の会計権限と初期データを登録する', () => {
		expect(sql).toContain("'admin.finance.read'");
		expect(sql).toContain("'admin.finance.manage'");
		expect(sql).toContain("'2026SS'");
		expect(sql).toContain("'LFDH-SS26-T001'");
	});
});
