# 1.16 管理画面（ADMIN）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ADMIN-001 | `/admin` ページは Supabase ACL のロールに基づき表示可能なタブを動的に制御する。`editor` は NEWS / ITEM / LOOK / STOCKIST タブのみ、`admin` は全タブを表示する | IMPL-ADMIN-001 | `src/app/admin/page.tsx`, `src/app/api/admin/acl/route.ts` | `visibleTabs` を `useMemo` で計算し `renderContent` でも二重チェックを実施。`acl_roles` テーブルとのロール照合 | 済 |
| FR-ADMIN-002 | KPI ダッシュボードタブでは期間選択（DateTimePicker）・売上・注文数・新規会員数・商品閲覧数の集計グラフを表示し KPI 目標値の設定機能を提供する | IMPL-ADMIN-002 | `src/components/KpiSection.tsx`, `src/app/api/admin/kpi/route.ts`, `src/app/api/admin/kpi/targets/route.ts` | `KpiSection` + `DateTimePicker` で期間・棒グラフ表示。`/api/admin/kpi/targets` で目標値の GET / PUT を実装 | 済 |
| FR-ADMIN-003 | NEWS 管理タブでは記事一覧・作成・編集・削除・公開ステータス変更を提供しカテゴリ・キーワード・ステータスフィルタを設ける | IMPL-ADMIN-003 | `src/components/NewsSection.tsx`, `src/app/api/admin/news/route.ts`, `src/app/api/admin/news/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装。`admin` ロールのみ新規作成ボタンを表示 | 済 |
| FR-ADMIN-004 | ITEM 管理タブでは商品一覧・作成・編集・削除・在庫/公開ステータス管理を提供する | IMPL-ADMIN-004 | `src/components/ItemSection.tsx`, `src/app/api/admin/items/route.ts`, `src/app/api/admin/items/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装。画像アップロード（`item-images` バケット）対応 | 済 |
| FR-ADMIN-005 | LOOK 管理タブではルック一覧・作成・編集・削除・アイテムタグ付けを提供する | IMPL-ADMIN-005 | `src/components/LookSection.tsx`, `src/app/api/admin/looks/route.ts`, `src/app/api/admin/looks/[id]/route.ts` | 一覧・作成・編集モーダル・削除を実装。`look_items` テーブルでアイテムタグ付け対応 | 済 |
| FR-ADMIN-006 | STOCKIST 管理タブでは店舗一覧・作成・編集・削除・公開ステータス管理を提供する | IMPL-ADMIN-006 | `src/components/StockistSection.tsx`, `src/app/api/admin/stockists/route.ts`, `src/app/api/admin/stockists/[id]/route.ts` | 一覧・作成・編集モーダル・削除・公開切替を実装 | 済 |
| FR-ADMIN-007 | USER 管理タブは `admin` ロール専用とし `roles` テーブルの編集・ACL 付与・ユーザー一覧を提供する | IMPL-ADMIN-007 | `src/components/UserSection.tsx`, `src/app/api/admin/users/route.ts`, `src/app/api/admin/users/[id]/role/route.ts` | ユーザー一覧・ロール変更フォームを実装。`admin` ロールのみ表示（`visibleTabs` で制御） | 済 |
| FR-ADMIN-008 | ORDER 管理タブでは注文一覧・ステータスフィルタ・キーワード検索・ページネーション（20件ずつ）・CSV エクスポートを提供する | IMPL-ADMIN-008 | `src/components/OrderSection.tsx`, `src/app/api/admin/orders/route.ts` | ページネーション（pageSize=20）はサーバ側で実装。キーワード検索・ステータスフィルタはクライアント側フィルタ（現在ページ20件のみ対象）のため全件検索には非対応 | 済 |
---

## 実装タスク管理 (ADMIN-01)

**タスクID**: ADMIN-01  
**ステータス**: 一部未実装  
**元ファイル**: `docs/tasks/05_admin_ticket.md`

### 実装完了項目

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| ADMIN-01-001 | ITEM CRUD（作成/編集/削除/公開切替） | IMPL-ADMIN-ITEM-01 | `src/app/admin/items/`, `src/app/api/admin/items/` | 全 CRUD + 公開切替実装済み | 済 |
| ADMIN-01-002 | カラープリセット DB 永続化、再利用 | IMPL-ADMIN-COLOR-01 | `src/app/api/admin/color-presets/route.ts` | DB 永続化 + 再利用実装済み | 済 |
| ADMIN-01-003 | LOOK CRUD | IMPL-ADMIN-LOOK-01 | `src/app/admin/looks/`, `src/app/api/admin/looks/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-004 | NEWS CRUD | IMPL-ADMIN-NEWS-01 | `src/app/admin/news/`, `src/app/api/admin/news/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-005 | STOCKIST CRUD | IMPL-ADMIN-STOCKIST-01 | `src/app/admin/stockists/`, `src/app/api/admin/stockists/` | 全 CRUD 実装済み | 済 |
| ADMIN-01-006 | USER タブ（権限変更含む） | IMPL-ADMIN-USER-01 | `src/app/admin/users/`, `src/app/api/admin/users/` | ユーザー管理 + 権限変更実装済み | 済 |
| ADMIN-01-007 | ORDER タブ（ページング/期間フィルタ/CSV/ステータス変更/返金） | IMPL-ADMIN-ORDER-01 | `src/app/admin/orders/`, `src/app/api/admin/orders/` | ページング/フィルタ/CSV/ステータス/返金 実装済み | 済 |
| ADMIN-01-008 | KPI タブ（実データ集計/目標値編集） | IMPL-ADMIN-KPI-01 | `src/app/admin/kpi/`, `src/app/api/admin/kpi/` | 実データ集計 + 目標値編集実装済み | 済 |
| ADMIN-01-009 | `admin-rbac.ts` ハイブリッド RBAC | IMPL-ADMIN-RBAC-01 | `src/lib/admin-rbac.ts` | ハイブリッド RBAC 実装済み | 済 |

---

## RBAC 権限設計（ADMIN-RBAC）

| 機能 | `admin` | `supporter` |
|---|---|---|
| 商品 CRUD | ✅ | 編集のみ |
| ニュース CRUD | ✅ | ✅ |
| 注文ステータス変更 | ✅ | ✅ |
| 返金処理 | ✅ | ❌ |
| クーポン作成 | ✅ | ❌ |
| ユーザー権限変更 | ✅ | ❌ |
| KPI ダッシュボード閲覧 | ✅ | ✅ |
| 監査ログ閲覧 | ✅ | ❌ |

> Supabase RLS で `acl_roles` テーブルのロール列を条件とするポリシーを設定し、テーブルレベルのアクセス制御を実施する。

---

## 管理者オンボーディング手順（ADMIN-ONBOARDING）

1. **申請**: 管理者アカウント発行はチケット経由で申請する。
2. **身元確認**: 申請者の所属・メールを確認し、担当者が 2FA 設定まで案内する。
3. **最小権限付与**: 初期は `supporter` 相当の限定権限を付与し、業務確認後に `admin` 権限を付与する。
4. **初回ログイン**: 初回ログイン時にパスワード変更と 2FA の有効化を必須化する。
5. **ドキュメント配布**: 管理操作の利用規約・ランブック・オンボーディングチェックリストを配布する。

### 2FA 有効化手順

1. 管理画面で "Enable 2FA" を選択
2. サーバが TOTP シークレットを発行し、QR コードを表示
3. 管理者は Authenticator アプリで QR をスキャンし、初回コードを入力して検証
4. 端末名を登録し、リカバリコード（ワンタイム）を発行・保存することを義務付ける
5. `admin` ロールの全ユーザは 2FA を必須とし、未設定時はアクセスをブロックする

---

## 監査ログ設計（ADMIN-AUDIT）

### ログスキーマ

```json
{
  "id": "uuid",
  "timestamp": "2025-01-01T12:00:00Z",
  "actor_id": "uuid",
  "actor_email": "admin@example.com",
  "action": "items.update",
  "resource": "items",
  "resource_id": "uuid",
  "ip": "203.0.113.1",
  "user_agent": "Mozilla/5.0...",
  "outcome": "success|failure",
  "metadata": { "diff": { "price": { "from": 1000, "to": 1200 } } }
}
```

### 保存期間

| 区分 | 期間 | 用途 |
|---|---|---|
| ホット（即時検索） | 1 年 | 障害調査・コンプライアンス監査 |
| コールド（アーカイブ） | 7 年 | 法規制・会計要件 |

- 監査ログは変更不可なストレージに保存し、整合性検証（ハッシュ）を定期実行する。
- 重要操作（権限変更・払い戻し・高額割引）は即時アラート対象とし、オンコール担当に通知する。

---

## API 仕様（ADMIN-API）

| エンドポイント | メソッド | 概要 | ロール要件 |
|---|---|---|---|
| `/api/admin/items/import` | POST | CSV バルクインポート（必須カラム/型チェック/重複 SKU 検出） | `admin` |
| `/api/admin/orders` | GET | 注文一覧（ページネーション・ステータスフィルタ） | `admin`, `supporter` |
| `/api/admin/orders/:id/status` | POST | 注文ステータス変更 | `admin`, `supporter` |
| `/api/admin/orders/:id/refund` | POST | 返金処理（Stripe Refund API） | `admin` |

> CSV インポート時は必須カラムチェック・型チェック・重複 SKU 検出を行い、エラー行は一覧で返す。
| ADMIN-01-010 | Migration 023: roles/permissions/role_permissions/user_roles + `has_permission()` | IMPL-ADMIN-MIG-023 | `migrations/023_add_acl_rbac_tables_and_policies.sql` | ACL/RBAC テーブル + RLS ポリシー作成済み | 済 |
| ADMIN-01-011 | CSV インポートジョブ実装 | IMPL-ADMIN-CSV-01 | `src/app/api/admin/import/route.ts` | 未実装 | 未 |
| ADMIN-01-012 | 監査ログ出力追加（部分未実装） | IMPL-ADMIN-AUDIT-01 | `src/lib/audit.ts` | 一部未実装 | 未 |

### 依存関係

- 監査ログ基盤: `audit_logs` テーブル（済み）
- 認証（管理者向け 2FA）: 未実装