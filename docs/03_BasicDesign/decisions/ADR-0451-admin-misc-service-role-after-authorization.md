# ADR-0451 管理のそのほかの窓口は、認可の後に service role で DB を読み書きし、表への直接の読み書きは断る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/create-user/`、`src/app/api/admin/revoke-user-sessions/`、`src/app/api/admin/audit-logs/`、`src/app/api/admin/users/mfa/`、`src/app/api/admin/contact/`、`src/app/api/admin/item-color-presets/` | 基準コミット: `4facf63b`

## 概要

範囲の管理の窓口は、アプリの認可（ADR-0450）を通した後、service role の client で DB と Auth の管理の機能を使う。問い合わせ・監査ログの表は、ログインした利用者からの直接の読み書きを RLS の方針で全部断る。管理のニュース（ADR-0005）のような利用者の session の client は使わない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | NFR-SEC-005（範囲外）。SEC-ADMIN-003 は上位にしない（SEC-ADMIN-003 を参照） |
| 対象のコード | `src/app/api/admin/audit-logs/route.ts`、`src/app/api/admin/revoke-user-sessions/route.ts`、`src/app/api/admin/create-user/route.ts`、`src/app/api/admin/users/mfa/reset/route.ts`、`src/app/api/admin/contact/route.ts`、`src/app/api/admin/contact/[id]/reply/route.ts`、`src/app/api/admin/item-color-presets/route.ts` |
| DB | `supabase/migrations/20260901102912_remote_schema.sql`（監査ログ・問い合わせの3つの表・色見本の表） |
| 関連文書 | `docs/03_BasicDesign/architecture/hybrid-rbac.md`、`docs/05_Quality/reviews/code/2026-04-18-admin-security-review.md` |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0451 管理のそのほかの窓口は、認可の後に service role で DB を読み書きし、表への直接の読み書きは断る

| 属性 | 値 |
| --- | --- |
| 上位 | NFR-SEC-005（範囲外） |
| 根拠 | 利用者の作成・2要素の削除・他人の session の削除は Auth の管理の機能で、service role でしか呼べない。問い合わせの個人情報と監査ログは、ログインした人の JWT で直接読まれないよう表の方針で全部断り、読める道をアプリの認可を通った窓口だけにする（推定。判断の記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（上の対象のコード）、`supabase/migrations/20260901102912_remote_schema.sql`、`docs/03_BasicDesign/architecture/hybrid-rbac.md`（service role を使う時はアプリで権限を確かめてから、という注意） |

#### 背景

- 利用者の作成（`auth.admin.createUser`）・2要素の一覧と削除・他人の session の削除は、Supabase の管理の機能か service role だけが実行できる DB の関数で、利用者の token では呼べない（`revoke-user-sessions/route.ts`、git `d9d693bd` は関数の実行を service role だけに絞った）
- 監査ログと問い合わせの表は、anon と authenticated の読み書きを全部断る方針を持つ（`remote_schema.sql`）
- 管理のニュースは、表の読み書きを利用者の session の client で行い、RLS の権限を効かせる形を選んでいる（ADR-0005）

#### 決定

- 範囲の窓口は、認可が通った後にだけ service role の client を作り、表の読み書きと Auth の管理の機能をそれで行う
- 監査ログ・問い合わせ・返信のテンプレートの表は、ログインした利用者からの直接の読み書きを方針で断ったままにする
- 色見本の表だけは、権限の印（`admin.items.read`／`admin.items.manage`）を見る方針で authenticated の直接の読み書きも許している（`remote_schema.sql`）。窓口は同じく service role で読み書きする

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 利用者の session の client で読み書きし、RLS の権限で守る（ADR-0005 の形） | Auth の管理の機能と service role だけの DB の関数は呼べない。問い合わせと監査ログの表は直接の読み書きを全部断る方針なので、利用者の token では読めない（推定） |
| 表を authenticated に開き、権限の印を見る方針だけで守る | 個人情報と監査ログが、窓口の外から JWT だけで読めてしまう（推定） |

#### 結果

- 良くなること: 問い合わせの個人情報と監査ログを読む道が、認可を通った窓口だけになる
- 悪くなること: 窓口の中では RLS が効かないので、守りはアプリの認可だけになる（`2026-04-18-admin-security-review.md` の残りのリスク）。表の権限は anon・authenticated にも付いたままで、方針の段だけで断っている。表の権限との2段を求める SEC-ADMIN-003 は、この判断の上位にしない（SEC-ADMIN-003 を参照）
- 色見本は方針が直接の書き込みを許すので、窓口の認可（aal2）を通らない道が残る。DB が aal2 を見るかは確かめていない（SEC-ADMIN-002）
- 見直す条件: 管理の画面から DB を直接読む形に変える時、SEC-ADMIN-003 の表の権限を絞る時

## 未確認事項

- ADMIN と NEWS で client の選び方が違う理由の記録（ユーザーに確かめていない。TM-ADMIN-22）
