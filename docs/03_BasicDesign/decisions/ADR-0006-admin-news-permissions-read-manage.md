# ADR-0006 管理のニュースの権限を閲覧と管理の2つに分け、窓口で DB の ACL・session・aal2 を確かめる

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` | 基準コミット: `a03beaff`

## 概要

管理のニュースの窓口は、読むだけの操作に `admin.news.read`、書き換えに `admin.news.manage` を求め、どちらも DB の ACL・有効な session・aal2 で許す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-015、FREQ-316-REQ-02（範囲外）、FREQ-540-REQ-01（範囲外）、FR-ADMIN-003 |
| 対象のコード | `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/lib/auth/admin-rbac.ts`（範囲外の共有部品）、`supabase/migrations/20260901102912_remote_schema.sql` |
| 関連文書 | `docs/03_BasicDesign/architecture/hybrid-rbac.md`、`docs/superpowers/specs/2026-10-23-group-g-design.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0006 管理のニュースの権限を閲覧と管理の2つに分け、窓口で DB の ACL・session・aal2 を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-015、FREQ-316-REQ-02（範囲外）、FREQ-540-REQ-01（範囲外）、FR-ADMIN-003 |
| 根拠 | 画面を隠すだけでは窓口を直接叩かれた時に止められないため、窓口ごとに DB の ACL と有効な session と2要素認証（aal2）を確かめる（2026-10-23 の権限の作り直しの設計）。見るだけの人に書き換えを許さないよう、閲覧と管理の権限を分ける（ハイブリッドの RBAC の設計） |
| 状態 | 現行 |
| 出どころ | `docs/03_BasicDesign/architecture/hybrid-rbac.md`、`docs/superpowers/specs/2026-10-23-group-g-design.md` |

#### 背景

ハイブリッドの RBAC（git `58804871`）で、管理の画面ごとに `.read` と `.manage` の権限を置いた。2026-10-23 の権限の作り直しの設計は、UI の非表示や TS の役の一覧だけで許さず、DB の ACL・session・aal2 を確かめると決めた。

#### 決定

- 一覧と1件の GET は `admin.news.read`、POST・PUT・PATCH・DELETE は `admin.news.manage` を `authorizeAdminPermission` で求める
- `authorizeAdminPermission` は DB の ACL・有効な session・aal2 を確かめる（`src/lib/auth/admin-rbac.ts`）
- DB の RLS も同じ権限の名前で書く（`remote_schema.sql`）

#### 退けた案

記録なし

#### 結果

- 良くなること: 店長が権限の画面（FREQ-519（範囲外））で閲覧と管理を別々に付け外しできる
- 悪くなること: 管理の画面のタブは権限ではなく役で出し分ける（`src/app/admin/page.tsx`）。FREQ-519-REQ-01（範囲外） はこれを画面に出すと決めている
- 悪くなること: DB の段は aal を見ない（ADR-0005、SEC-NEWS-002）（2026-10-29 追記: 波 5 の移行 M2 を当てると、DB の `has_permission` が aal2 と結び付いた生きた session を求めるので、この点は直る。ADR-0418。M2 は 2026-10-29 に本番適用済み）
- 古い文書は役の名前と権限が合わない（`docs/04_DetailDesign/pages/16_admin.md` の `editor`・「supporter ✅」）

## 未確認事項

- 無し
