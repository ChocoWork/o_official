import { FIXED_PERMISSION_CODES, ROLE_PERMISSION_CATALOG, getMissingPermissionDependencies } from '@/lib/auth/role-permission-catalog';

// Task 1 の表示表。実装側の配列から期待値を生成しない。
const ROWS = [
  ['利用者', '利用者の閲覧', 'admin.users.read'],
  ['利用者', '利用者の管理', 'admin.users.manage'],
  ['商品', '商品の閲覧', 'admin.items.read'],
  ['商品', '商品の管理', 'admin.items.manage'],
  ['お知らせ', 'お知らせの閲覧', 'admin.news.read'],
  ['お知らせ', 'お知らせの管理', 'admin.news.manage'],
  ['LOOK', 'LOOKの閲覧', 'admin.looks.read'],
  ['LOOK', 'LOOKの管理', 'admin.looks.manage'],
  ['取扱店', '取扱店の閲覧', 'admin.stockists.read'],
  ['取扱店', '取扱店の管理', 'admin.stockists.manage'],
  ['注文', '注文一覧・詳細・CSV・履歴・要対応の閲覧', 'admin.orders.read'],
  ['注文', '未入金取消・取消申請審査・要確認解消・メール再送', 'admin.orders.manage'],
  ['問い合わせ', '問い合わせの閲覧', 'admin.contact.read'],
  ['問い合わせ', '問い合わせの管理', 'admin.contact.manage'],
  ['会計', '会計の閲覧', 'admin.finance.read'],
  ['会計', '会計の管理', 'admin.finance.manage'],
  ['監査', '監査の閲覧', 'admin.audit.read'],
  ['注文', '返金・返金再試行・金額決定', 'admin.orders.refund'],
  ['ショップ設定', 'ショップ設定', 'admin.settings.manage'],
  ['注文', '返品作成・審査・受取・検品・取消・開き直し・金額相談', 'admin.orders.return'],
  ['在庫', '在庫一覧', 'admin.stock.read'],
  ['在庫', '入荷・棚卸・割当強制解除', 'admin.stock.manage'],
  ['注文', '割り当てを入れ替える', 'admin.orders.allocate'],
  ['発注', '発注一覧・発注書・取引添付の閲覧/取得', 'admin.purchase_orders.read'],
  ['発注', '発注入力/確認/確定・数量/単価訂正・添付追加・打切り/再確定', 'admin.purchase_orders.manage'],
  ['受け取り', '全部/一部受取・受取取消/訂正', 'admin.receiving.manage'],
  ['発送', '荷作り・発送票閲覧', 'admin.shipping.read'],
  ['発送', '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消', 'admin.shipping.manage'],
  ['発送', '確定後の出荷日訂正', 'admin.shipping.correct_date'],
  ['権限管理', '権限設定の閲覧・保存', 'admin.permissions.manage'],
] as const;

test('全30行の表示順・分野・ラベルと固定2件・準備中9件を返す', () => {
  expect(ROLE_PERMISSION_CATALOG.map(({ area, label, code }) => [area, label, code])).toEqual(ROWS);
  expect(FIXED_PERMISSION_CODES).toEqual(['admin.users.manage', 'admin.permissions.manage']);
  expect(ROLE_PERMISSION_CATALOG.filter((p) => p.fixed).map((p) => p.code)).toEqual(['admin.users.manage', 'admin.permissions.manage']);
  expect(ROLE_PERMISSION_CATALOG.filter((p) => p.upcoming).map((p) => p.code)).toEqual(ROWS.slice(20, 29).map((r) => r[2]));
});

test('依存のある7行だけに指定順の必要コードを表示する', () => {
  expect(Object.fromEntries(ROLE_PERMISSION_CATALOG.filter((p) => p.requires.length).map((p) => [p.code, p.requires]))).toEqual({
    'admin.stock.manage': ['admin.stock.read'],
    'admin.orders.allocate': ['admin.orders.read'],
    'admin.purchase_orders.manage': ['admin.purchase_orders.read'],
    'admin.receiving.manage': ['admin.purchase_orders.read'],
    'admin.shipping.read': ['admin.orders.read'],
    'admin.shipping.manage': ['admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'],
    'admin.shipping.correct_date': ['admin.shipping.read', 'admin.orders.read'],
  });
});

test('依存不足は重複なし辞書順で返し、入力に権限を追加しない', () => {
  const codes = ['admin.shipping.manage', 'admin.shipping.correct_date', 'admin.stock.manage', 'admin.receiving.manage'] as const;
  expect(getMissingPermissionDependencies(codes)).toEqual(['admin.orders.manage', 'admin.orders.read', 'admin.purchase_orders.read', 'admin.shipping.read', 'admin.stock.read']);
  expect(codes).toHaveLength(4);
  expect(getMissingPermissionDependencies(['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'])).toEqual([]);
  expect(getMissingPermissionDependencies([])).toEqual([]);
});
