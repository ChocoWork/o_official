import type { PermissionCode } from '@/lib/auth/admin-rbac';
import type { PermissionDefinition } from '@/lib/auth/role-permission-types';

export const FIXED_PERMISSION_CODES = ['admin.users.manage', 'admin.permissions.manage'] as const;

// Task 1 の表示表と同じ順。既存 permission.name には依存しない。
const rows: readonly (readonly [PermissionCode, string, string])[] = [
  ['admin.users.read', '利用者', '利用者の閲覧'],
  ['admin.users.manage', '利用者', '利用者の管理'],
  ['admin.items.read', '商品', '商品の閲覧'],
  ['admin.items.manage', '商品', '商品の管理'],
  ['admin.news.read', 'お知らせ', 'お知らせの閲覧'],
  ['admin.news.manage', 'お知らせ', 'お知らせの管理'],
  ['admin.looks.read', 'LOOK', 'LOOKの閲覧'],
  ['admin.looks.manage', 'LOOK', 'LOOKの管理'],
  ['admin.stockists.read', '取扱店', '取扱店の閲覧'],
  ['admin.stockists.manage', '取扱店', '取扱店の管理'],
  ['admin.orders.read', '注文', '注文一覧・詳細・CSV・履歴・要対応の閲覧'],
  ['admin.orders.manage', '注文', '未入金取消・取消申請審査・要確認解消・メール再送'],
  ['admin.contact.read', '問い合わせ', '問い合わせの閲覧'],
  ['admin.contact.manage', '問い合わせ', '問い合わせの管理'],
  ['admin.finance.read', '会計', '会計の閲覧'],
  ['admin.finance.manage', '会計', '会計の管理'],
  ['admin.audit.read', '監査', '監査の閲覧'],
  ['admin.orders.refund', '注文', '返金・返金再試行・金額決定'],
  ['admin.settings.manage', 'ショップ設定', 'ショップ設定'],
  ['admin.orders.return', '注文', '返品作成・審査・受取・検品・取消・開き直し・金額相談'],
  ['admin.stock.read', '在庫', '在庫一覧'],
  ['admin.stock.manage', '在庫', '入荷・棚卸・割当強制解除'],
  ['admin.orders.allocate', '注文', '割り当てを入れ替える'],
  ['admin.purchase_orders.read', '発注', '発注一覧・発注書・取引添付の閲覧/取得'],
  ['admin.purchase_orders.manage', '発注', '発注入力/確認/確定・数量/単価訂正・添付追加・打切り/再確定'],
  ['admin.receiving.manage', '受け取り', '全部/一部受取・受取取消/訂正'],
  ['admin.shipping.read', '発送', '荷作り・発送票閲覧'],
  ['admin.shipping.manage', '発送', '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消'],
  ['admin.shipping.correct_date', '発送', '確定後の出荷日訂正'],
  ['admin.permissions.manage', '権限管理', '権限設定の閲覧・保存'],
];

const dependencies: Partial<Record<PermissionCode, PermissionCode[]>> = {
  'admin.stock.manage': ['admin.stock.read'],
  'admin.orders.allocate': ['admin.orders.read'],
  'admin.purchase_orders.manage': ['admin.purchase_orders.read'],
  'admin.receiving.manage': ['admin.purchase_orders.read'],
  'admin.shipping.read': ['admin.orders.read'],
  'admin.shipping.manage': ['admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'],
  'admin.shipping.correct_date': ['admin.shipping.read', 'admin.orders.read'],
};

export const ROLE_PERMISSION_CATALOG: readonly PermissionDefinition[] = rows.map(([code, area, label], index) => ({
  code,
  area,
  label,
  requires: dependencies[code] ?? [],
  fixed: FIXED_PERMISSION_CODES.some((fixed) => fixed === code),
  upcoming: index >= 20 && code !== 'admin.permissions.manage',
}));

/** 依存不足は表示用。保存入力に権限を足したり、保存を拒否したりしない。 */
export function getMissingPermissionDependencies(permissionCodes: readonly PermissionCode[]): PermissionCode[] {
  const granted = new Set(permissionCodes);
  return [...new Set(ROLE_PERMISSION_CATALOG
    .filter((permission) => granted.has(permission.code))
    .flatMap((permission) => permission.requires)
    .filter((code) => !granted.has(code)))].sort();
}
