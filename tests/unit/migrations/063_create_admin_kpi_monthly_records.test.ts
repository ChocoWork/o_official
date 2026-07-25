export {};

const fs = require('fs');
const path = require('path');

describe('063_create_admin_kpi_monthly_records migration', () => {
	const sql = fs.readFileSync(
		path.join(process.cwd(), 'migrations', '063_create_admin_kpi_monthly_records.sql'),
		'utf8',
	);

	it('月次記録テーブルと複合ユニーク・RLSを作成する', () => {
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS admin_kpi_monthly_records');
		expect(sql).toContain('month_key TEXT NOT NULL');
		expect(sql).toContain('metric_key TEXT NOT NULL');
		expect(sql).toContain('value NUMERIC NOT NULL');
		expect(sql).toContain('UNIQUE (month_key, metric_key)');
		expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
	});

	it('updated_at 自動更新トリガーを設定する', () => {
		expect(sql).toContain('update_admin_kpi_monthly_records_updated_at');
		expect(sql).toContain('BEFORE UPDATE ON admin_kpi_monthly_records');
	});
});
