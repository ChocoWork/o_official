-- ============================================================
-- 028: Seed initial stockists
-- ============================================================

BEGIN;

WITH seed_data(type, name, address, phone, time, holiday, status, is_featured_home, display_order) AS (
  VALUES
    ('FLAGSHIP STORE', 'Le Fil des Heures Aoyama', '東京都港区南青山3-14-15', '03-1234-5678', '11:00 - 20:00', '水曜定休', 'published', true, 10),
    ('STORE', 'Le Fil des Heures Ginza', '東京都中央区銀座6-10-1', '03-2345-6789', '11:00 - 20:00', '不定休', 'published', true, 20),
    ('STORE', 'Le Fil des Heures Osaka', '大阪府大阪市北区梅田2-5-25', '06-3456-7890', '11:00 - 20:00', '水曜定休', 'published', true, 30),
    ('SELECT SHOP', 'Maison de Mode Tokyo', '東京都渋谷区神宮前5-10-1', '03-4567-8901', '12:00 - 20:00', '月曜定休', 'published', false, 40),
    ('SELECT SHOP', 'Atelier Blanc Kyoto', '京都府京都市中京区烏丸通三条上ル', '075-567-8901', '11:00 - 19:00', '火曜定休', 'published', true, 50),
    ('SELECT SHOP', 'Minimal Store Fukuoka', '福岡県福岡市中央区天神2-8-34', '092-678-9012', '11:00 - 20:00', '不定休', 'published', false, 60)
)
INSERT INTO public.stockists (type, name, address, phone, time, holiday, status, is_featured_home, display_order)
SELECT s.type, s.name, s.address, s.phone, s.time, s.holiday, s.status, s.is_featured_home, s.display_order
FROM seed_data s
WHERE NOT EXISTS (
  SELECT 1
  FROM public.stockists existing
  WHERE existing.name = s.name
    AND existing.address = s.address
);

COMMIT;
