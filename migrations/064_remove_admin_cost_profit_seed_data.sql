-- ============================================================
-- 064: Remove the sample rows previously inserted by migration 062
-- ============================================================

BEGIN;

DELETE FROM public.admin_finance_expenses
WHERE created_by IS NULL
  AND (season_key, expense_date, category, item_name, amount, payment_method, memo) IN (
    ('2026SS', DATE '2026-05-24', '販売費・マーケティング', 'Instagram広告費', 32000::bigint, 'クレジットカード', 'S/S 広告運用'),
    ('2026SS', DATE '2026-05-23', '材料費', 'サンプル生地費', 15400::bigint, '銀行振込', '生地サンプル代'),
    ('2026SS', DATE '2026-05-22', '外注費', '撮影費', 28600::bigint, '銀行振込', 'LOOK撮影'),
    ('2026SS', DATE '2026-05-21', '外注費', '外注パターン作成費', 22000::bigint, 'クレジットカード', 'パターン制作'),
    ('2026SS', DATE '2026-05-20', '荷造運賃', '梱包資材費', 8250::bigint, 'クレジットカード', '発送用資材'),
    ('2026SS', DATE '2026-05-18', '通信費', 'オンラインストレージ', 1980::bigint, 'クレジットカード', 'クラウド利用料'),
    ('2026SS', DATE '2026-05-15', '消耗品費', 'プリンター用紙・インク', 2750::bigint, 'クレジットカード', '事務用品'),
    ('2026SS', DATE '2026-05-14', '旅費交通費', '打ち合わせ交通費', 3420::bigint, '交通系IC', '都内打ち合わせ'),
    ('2026SS', DATE '2026-05-10', '水道光熱費', '電気代（自宅兼事務所）', 6180::bigint, '口座振替', '家事按分後'),
    ('2026SS', DATE '2026-05-05', '諸会費', '会計ソフト利用料', 1100::bigint, 'クレジットカード', '月額利用料'),
    ('2026SS', DATE '2026-04-28', '販売費・マーケティング', 'シーズン広告制作', 198000::bigint, '銀行振込', 'キービジュアル制作'),
    ('2026SS', DATE '2026-04-16', '人件費', '制作アシスタント', 160000::bigint, '銀行振込', '4月分'),
    ('2026SS', DATE '2026-04-03', '地代家賃', 'アトリエ賃料', 110000::bigint, '口座振替', '4月分'),
    ('2026SS', DATE '2026-03-29', 'その他経費', '展示会関連費', 60620::bigint, 'クレジットカード', '合同展示会')
  );

DELETE FROM public.admin_product_costs
WHERE created_by IS NULL
  AND (
    (
      season_key = '2026SS'
      AND sku = 'LFDH-SS26-T001'
      AND name = 'ドローストリングシャツ'
      AND category = 'トップス'
      AND production_method = '国内縫製'
      AND planned_quantity = 60
      AND selling_price = 24800
      AND material_cost = 3200
      AND sewing_cost = 3000
      AND pattern_cost = 500
      AND accessories_cost = 800
      AND processing_cost = 600
      AND finishing_cost = 900
    )
    OR
    (
      season_key = '2026SS'
      AND sku = 'LFDH-SS26-P001'
      AND name = 'ワイドテーパードパンツ'
      AND category = 'ボトムス'
      AND production_method = '国内縫製'
      AND planned_quantity = 65
      AND selling_price = 34800
      AND material_cost = 3800
      AND sewing_cost = 3900
      AND pattern_cost = 540
      AND accessories_cost = 720
      AND processing_cost = 650
      AND finishing_cost = 698
    )
  );

DELETE FROM public.admin_finance_seasons season
WHERE season.season_key = '2026SS'
  AND season.sales_revenue = 3240000
  AND season.opening_cash = 420000
  AND season.accounts_receivable = 324000
  AND season.fixed_assets = 260000
  AND season.accounts_payable = 430000
  AND season.opening_capital = 1091000
  AND NOT EXISTS (
    SELECT 1
    FROM public.admin_finance_expenses expense
    WHERE expense.season_key = season.season_key
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.admin_product_costs product
    WHERE product.season_key = season.season_key
  );

COMMIT;
