-- ============================================================
-- 026: Create admin_kpi_targets table for seasonal KPI planning
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_kpi_targets (
  id BIGSERIAL PRIMARY KEY,
  season_key TEXT NOT NULL,
  kpi_key TEXT NOT NULL,
  target_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_key, kpi_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_kpi_targets_season_key
  ON admin_kpi_targets(season_key);

CREATE INDEX IF NOT EXISTS idx_admin_kpi_targets_kpi_key
  ON admin_kpi_targets(kpi_key);

CREATE OR REPLACE FUNCTION update_admin_kpi_targets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_admin_kpi_targets_updated_at ON admin_kpi_targets;

CREATE TRIGGER trigger_admin_kpi_targets_updated_at
  BEFORE UPDATE ON admin_kpi_targets
  FOR EACH ROW EXECUTE FUNCTION update_admin_kpi_targets_updated_at();

ALTER TABLE admin_kpi_targets ENABLE ROW LEVEL SECURITY;

-- No direct user policies. Access through admin API with service role only.
