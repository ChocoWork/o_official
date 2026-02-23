# ハイブリッド RBAC (Role-Based Access Control) アーキテクチャ

**ステータス**: 実装完料  
**最終更新**: 2026-02-23  
**Migration**: 023_add_acl_rbac_tables_and_policies.sql

---

## 概要

このプロジェクトは **トークンベース（高速パス）+ DB ACL（権限源）** のハイブリッド RBAC を採用しており、以下を実現します：

1. **UI/API レベルでの高速判定**: auth.app_metadata.role から直接ユーザー役割を各種判断
2. **DB レベルでの権限管理**: roles, permissions, role_permissions, user_roles テーブルで権限をモデル化
3. **RLS による強制**: PostgreSQL RLS ポリシーが権限のないアクセスをブロック
4. **監査対応**: user_roles テーブルで誰が誰の権限を付与/削除したかを記録

---

## アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────┐
│             フロントエンド（Next.js Client）                 │
├─────────────────────────────────────────────────────────────┤
│ 1. LoginContext から userRole を取得                         │
│    → auth.app_metadata.role を抽出                          │
│ 2. Header/AdminTabs: 役割に応じてUI表示/非表示              │
│    - MANAGE: admin/supporter のみ表示                       │
│    - AdminTabs: admin→全タブ, supporter→ORDER タブのみ      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│           API レイヤー（authorizeAdminPermission）          │
├─────────────────────────────────────────────────────────────┤
│ src/lib/auth/admin-rbac.ts:                                 │
│  - 引数: permission code (admin.items.manage など)          │
│  - 処理:                                                    │
│    1. トークン role='admin' → true (高速)                   │
│    2. role='supporter' → legacyPermissionMap で確認         │
│    3. その他 → DB クエリで権限確認                           │
│  - 戻り値: { ok: true/false, userId?, response? }          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│           DB レイヤー（RLS + ACL テーブル）                  │
├─────────────────────────────────────────────────────────────┤
│ テーブル構成:                                                 │
│ - roles: admin, supporter, user (3 固定役割)                │
│ - permissions: 10 個の permission code                      │
│ - role_permissions: role_id → permission_id (多対多)        │
│ - user_roles: user_id, role_id, active, expires_at         │
│                                                             │
│ RLS ポリシー:                                                │
│ - ACL テーブル: admin.users.read/.manage で制御             │
│ - ビジネステーブル: 対応する permission code で制御          │
│   (admin.items.read/.manage, admin.news.read/.manage など) │
└─────────────────────────────────────────────────────────────┘
```

---

## 権限コード一覧

Permission Codes:

| コード | 説明 | 役割 |
|--------|--------|--------|
| `admin.users.read` | ユーザー一覧表示 | admin, supporter |
| `admin.users.manage` | ユーザー権限変更・削除 | admin |
| `admin.items.read` | 商品一覧表示 | admin, supporter |
| `admin.items.manage` | 商品 CRUD | admin |
| `admin.news.read` | ニュース一覧表示 | admin |
| `admin.news.manage` | ニュース CRUD | admin |
| `admin.looks` | ルック一覧表示 | admin |
| `admin.looks.manage` | ルック CRUD | admin |
| `admin.orders.read` | 注文一覧表示 | supporter |
| `admin.orders.manage` | 注文操作（配送等） | supporter |

（user は上記権限なし）

---

## フロー例

### シナリオ：Supporter が items list を GET しようとする

```
1. API: GET /api/admin/items
   ├─ authorizeAdminPermission('admin.items.read')
   │  ├─ token role='supporter' → legacyPermissionMap 確認 → false
   │  └─ DB クエリ：
   │     SELECT role_permissions.permission_id
   │     FROM user_roles
   │     JOIN role_permissions ON user_roles.role_id = role_permissions.role_id
   │     WHERE user_id = 'supporter_id'
   │  ├─ role_permissions: supporter → orders only
   │  ├─ 結果: 権限なし → { ok: false, response: NextResponse(403) }
   └─ API 戻り値: 403 Forbidden

2. フロントエンド: タブ非表示
   ├─ ITEM タブ自体が表示されない（Admin ページで supporter は ORDER のみ）
   └─ ユーザーは操作不可
```

### シナリオ：Admin が item を PUT して更新する

```
1. API: PUT /api/admin/items/123
   ├─ authorizeAdminPermission('admin.items.manage')
   │  ├─ token role='admin' → true (高速)
   │  └─ 権限あり → { ok: true, userId: 'admin_id' }
   ├─ items テーブル更新 (RLS: admin.items.manage で allow)
   └─ 200 OK

2. Audit Trail
   ├─ user_roles テーブルの assigned_by: admin_id が記録
   ├─ 将来の監査: "Who changed what, when, why" の追跡可能
   └─ DB ログ: PostgreSQL audit extension との連携も可
```

---

## 実装ファイル

### フロントエンド

- **src/app/components/LoginContext.tsx**: userRole extraction from auth.app_metadata
- **src/app/components/Header.tsx**: canManage = userRole === 'admin' || userRole === 'supporter'
- **src/app/admin/page.tsx**: visibleTabs 計算、tab フィルタリング、access guard
- **src/app/components/AdminTabs.tsx**: tabs prop で dynamic tab render

### API
- **src/lib/auth/admin-rbac.ts**: `authorizeAdminPermission(code)` ヘルパー
- **src/app/api/admin/users/route.ts**: GET (read), PATCH (manage) に guard
- **src/app/api/admin/items/route.ts**: GET/POST に permission guard
- **src/app/api/admin/items/[id]/route.ts**: GET/PUT/PATCH/DELETE に guards
- **src/app/api/admin/news/route.ts**: GET/POST に permission guard
- **src/app/api/admin/news/[id]/route.ts**: GET/PUT/PATCH/DELETE に guards
- **src/app/api/admin/looks/route.ts**: GET/POST に permission guard
- **src/app/api/admin/looks/[id]/route.ts**: GET/PUT/PATCH/DELETE に guards
- **src/app/api/admin/item-color-presets/route.ts**: GET/POST/DELETE に permission guard
- **src/app/api/admin/item-color-presets/[id]/route.ts**: DELETE に permission guard

### DB
- **migrations/023_add_acl_rbac_tables_and_policies.sql**: 全 ACL テーブル + RLS ポリシー + backfill

---

## トークンロール vs DB ACL

### トークンロール (auth.app_metadata.role)

**利点:**
- 高速（DB クエリ不要）
- オフライン判定可能
- JWT 検証済み

**用途:**
- UI 表示/非表示（Header, Tab filtering）
- API の第一段階判定（admin → 即座に true）

**設定方法:**
```typescript
// Auth admin 経由：
await admin.auth.admin.updateUserById(userId, {
  app_metadata: { role: 'admin' | 'supporter' | 'user' }
})
```

### DB ACL (user_roles + role_permissions)

**利点:**
- 権限のシングルソースオブトゥルース
- 時間制限 (expires_at) 対応可能
- 監査ログが自動で詳細記録
- 将来：細粒度権限 (店舗単位など) に拡張可能

**用途:**
- API の権限判定（Supporter など細粒度の確認）
- RLS ポリシー強制
- 監査・コンプライアンス

**設定方法:**
```typescript
// 新規ユーザーに Supporter 権限を付与
await supabase.from('user_roles').insert({
  user_id: userId,
  role_id: (SELECT id FROM roles WHERE name = 'supporter'),
  active: true,
  assigned_by: currentAdminId
})
```

---

## 権限追加時のチェックリスト

新しい権限コード (e.g., `admin.orders.manage`) を追加する場合：

1. **Migration で permission を追加**
   ```sql
   INSERT INTO permissions (code, description) 
   VALUES ('admin.orders.manage', 'Order management');
   ```

2. **`admin-rbac.ts` で PermissionCode 型を拡張**
   ```typescript
   export type PermissionCode = 
     | 'admin.items.read'
     | 'admin.items.manage'
     | 'admin.orders.manage';  // 追加
   ```

3. **必要な role_permissions を migration で設定**
   ```sql
   INSERT INTO role_permissions (role_id, permission_id)
   SELECT r.id, p.id 
   FROM roles r, permissions p
   WHERE r.name = 'admin' AND p.code = 'admin.orders.manage';
   ```

4. **API ルートに guard を追加**
   ```typescript
   const authz = await authorizeAdminPermission('admin.orders.manage');
   if (!authz.ok) return authz.response;
   ```

5. **テーブルに RLS ポリシーを追加** (該当テーブルがある場合)
   ```sql
   CREATE POLICY "admin_orders_manage" 
   ON orders FOR UPDATE
   USING (auth.has_permission('admin.orders.manage'));
   ```

---

## セキュリティノート

### ⚠️ Service Role の使用

`user_roles` テーブルへの INSERT/UPDATE は RLS でガード済みですが、Service Role API を使用する際は細心の注意を払ってください。

```typescript
// ✅ 正：Service Role で権限変更を明示的に検証
const admin = await getCurrentUser();
if (admin.role !== 'admin') throw new Error('Unauthorized');
await serviceRoleClient.from('user_roles').update(...);

// ❌ 誤：盲目的に Service Role で全操作
await serviceRoleClient.from('user_roles').update(...);  // RLS が適用されない
```

### ⚠️ トークン役割の詐称

`auth.app_metadata.role` はサーバーで検証可能です。あくまで UI 最適化用の「ヒント」とし、権限が重要な操作では必ず DB ACL を参照してください。

```typescript
// ✅ 推奨：DB ACL で最終検証
const authz = await authorizeAdminPermission('admin.orders.manage');
if (!authz.ok) return authz.response;

// ❌ 危険：トークン役割のみ信頼
if (token.app_metadata.role !== 'admin') return error;
```

---

## 監査ログ

`user_roles` テーブルの以下カラムが監査に使用できます：

- `assigned_by`: 権限を付与した Admin ユーザーの ID
- `assigned_at`: 付与日時 (DEFAULT NOW())
- `expires_at`: 権限の有効期限（実装時点は NULL）

将来、PostgreSQL の `audit` extension または Supabase Functions で自動監査ログを記録する場合、以下をトリガー化できます：

```sql
CREATE TRIGGER user_roles_audit
AFTER UPDATE ON user_roles
FOR EACH ROW
EXECUTE FUNCTION audit_log();
```

---

## 次のステップ

1. **Orders API** の実装
   - `orders` テーブルの schema 定義
   - `admin.orders.read/.manage` permission codes の活用

2. **権限時間制限** (expires_at)
   - Cron Job で期限切れ権限を `active: false` に
   - auth.app_metadata との同期メカニズム

3. **細粒度権限** (将来)
   - 店舗単位の権限 (`store_id` カラム追加)
   - 商品カテゴリ単位の権限など

4. **完全な監査ログ**
   - 全 admin API の変更を audit_logs テーブルに記録
   - Webhook で Slack 通知など
