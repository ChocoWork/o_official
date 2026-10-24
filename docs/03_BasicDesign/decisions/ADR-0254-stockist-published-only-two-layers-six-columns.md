# ADR-0254 公開の道は公開済みの店だけを RLS と取り出しの絞りの2段で返し、返す列を6つに絞る

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/stockist/services/public.ts`、`supabase/migrations/20260901102912_remote_schema.sql` | 基準コミット: `4facf63b`

## 概要

公開の画面に出す取扱店は、DB の RLS とアプリの取り出しの条件の両方で公開済みだけに絞り、返す列は店舗の表示に要る6つだけにする。過去の安全のレビューがこの形を「Fixed」とした。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-001、FR-STOCKIST-003 |
| 対象のコード | `src/features/stockist/services/public.ts`、`supabase/migrations/20260901102912_remote_schema.sql` |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_stockist.md`、`docs/05_Quality/reviews/security/security_review_home.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0254 公開の道は公開済みの店だけを RLS と取り出しの絞りの2段で返し、返す列を6つに絞る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-001、FR-STOCKIST-003 |
| 根拠 | 準備中や閉じた店を外へ出さないため、片方が崩れても漏れないよう DB の RLS とアプリの絞りの2段にする。管理の列（公開の状態・作った日時など）は公開の画面で使わないので返さない。安全のレビューが2段の絞りと6列の返却を「Fixed」「維持」とした |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/security/security_review_stockist.md`（公開/非公開の分離、Fixed）、`docs/05_Quality/reviews/security/security_review_stockist.md`（公開の最小の返却、Fixed） |

#### 背景

- ログイン中の利用者は authenticated の方針で読み、取扱店の閲覧の権限があれば非公開の店も読める（`remote_schema.sql`）
- anon の方針は公開済みだけを読ませる

#### 決定

- 取り出しの条件で公開済みだけに絞る（`public.ts`）
- 返すのは id・店舗名・住所・電話・営業時間・定休日の6つ（`public.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| RLS だけに頼る | 閲覧の権限を持つ人がログインしたまま公開の画面を開くと、authenticated の方針で非公開の店も読めてしまう |
| アプリの絞りだけに頼る | 絞りを書き忘れた道から非公開の店が漏れる |

#### 結果

- 良くなること: 公開の画面と応答に非公開の店と管理の列が出ない
- 悪くなること: 公開の取り出しは閲覧者の Cookie に結びついた client を使う（`public.ts`）。閲覧者が管理者なら RLS の段は authenticated の方針になり、守りはアプリの絞りの1段だけになる。SEC-STOCKIST-002 の求める形（session を引き継がない client）と合わない（`security_review_home.md`、Open）

## 未確認事項

- 本番の RLS の方針が写し（`remote_schema.sql`）と同じか（DB は読んでいない）
