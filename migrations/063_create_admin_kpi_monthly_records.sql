-- ============================================================
-- 063: Create admin_kpi_monthly_records table for monthly KPI data entry
-- ============================================================
-- 月次記録タブの入力値を月ごとに保存する。metric_key は名前空間つき:
--   'src:<source_key>'  … 算出元データ（SNS・広告系の手入力、および order 由来の手動上書き）
--   'kpi:<kpi_key>'     … 自動計算KPIの手動上書き
-- 定義（源データ・算出式）はアプリ側 src/lib/kpi/monthly-metrics.ts に集約し、
-- 本テーブルは汎用の (month_key, metric_key) → value ストアとする（モデル変更で再マイグレーション不要）。

CREATE TABLE IF NOT EXISTS admin_kpi_monthly_records (
  id BIGSERIAL PRIMARY KEY,
  month_key TEXT NOT NULL,           -- 'YYYY-MM'（JST）
  metric_key TEXT NOT NULL,          -- 'src:*' or 'kpi:*'
  value NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month_key, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_kpi_monthly_records_month_key
  ON admin_kpi_monthly_records(month_key);

CREATE OR REPLACE FUNCTION update_admin_kpi_monthly_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_admin_kpi_monthly_records_updated_at ON admin_kpi_monthly_records;

CREATE TRIGGER trigger_admin_kpi_monthly_records_updated_at
  BEFORE UPDATE ON admin_kpi_monthly_records
  FOR EACH ROW EXECUTE FUNCTION update_admin_kpi_monthly_records_updated_at();

ALTER TABLE admin_kpi_monthly_records ENABLE ROW LEVEL SECURITY;

-- No direct user policies. Access through admin API with service role only.
