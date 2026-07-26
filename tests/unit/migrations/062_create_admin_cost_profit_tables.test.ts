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

	it('管理者の会計権限を登録し、ダミーデータは登録しない', () => {
		expect(sql).toContain("'admin.finance.read'");
		expect(sql).toContain("'admin.finance.manage'");
		expect(sql).not.toContain('INSERT INTO public.admin_finance_seasons');
		expect(sql).not.toContain('INSERT INTO public.admin_finance_expenses');
		expect(sql).not.toContain('INSERT INTO public.admin_product_costs');
	});
});
