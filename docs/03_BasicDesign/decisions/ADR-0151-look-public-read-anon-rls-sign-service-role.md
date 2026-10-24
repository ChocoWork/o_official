# ADR-0151 公開の LOOK の読み出しは匿名の鍵で DB の方針（RLS）とアプリの公開の絞りの2段で行い、service role は画像の署名だけに使う

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/lib/look/server.ts` | 基準コミット: `4facf63b`

## 概要

`/look`・`/look/[id]`・ホームの LOOK の区画の取り出しは、匿名の鍵の DB の接続で読み、DB の方針と、アプリの `status = 'published'` の絞りの両方で公開済みだけを返す。関連の商品も公開中の物だけを付ける。RLS を越える service role の鍵は、非公開の置き場の画像に署名する時だけに使う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | SEC-LOOK-001、DRV-LOOK-004（SEC-LOOK-002 は今のコードが満たさないので上位にしない。「結果」を参照） |
| 対象のコード | `src/lib/look/server.ts`、`src/lib/supabase/server.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/code/2026-04-18-look-detail-review.md`、NEWS の同じ形の判断 `ADR-0004-public-read-anon-client.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0151 公開の LOOK の読み出しは匿名の鍵で DB の方針（RLS）とアプリの公開の絞りの2段で行い、service role は画像の署名だけに使う

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-001、DRV-LOOK-004 |
| 根拠 | 公開の頁の取り出しで RLS を越える鍵を使うと、絞りを1つ書き忘れただけで非公開の LOOK や商品が出るため。DB の方針とアプリの絞りの片方が崩れても漏れないよう2段にし、RLS を越える力は置き場の署名（ADR-0150）に要る所だけに閉じた |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/lib/look/server.ts` のコメント「anon client for DB reads (respects RLS; only published rows are accessible)」）、git `b1093406`（2026-04-19、匿名の接続を足したコミット）、`security_review_look.md`（Fixed） |

#### 背景

- LOOK の頁はログインせずに見られ、まだ公開していない LOOK と商品がある
- 画像の置き場は非公開なので（ADR-0150）、署名には RLS を越える鍵が要る

#### 決定

- DB の読み出しは匿名の接続で行う（`server.ts`）
- LOOK は `status = 'published'` で絞り、作った日時の新しい順に並べる（`server.ts`）
- 関連の商品は、`look_items` から ID を集めた後に `items` を `status = 'published'` で絞って取り、取れなかった商品は LOOK に付けない（`server.ts`）
- service role の接続は、LOOK と商品の画像の署名にだけ渡す（`server.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 全部を service role で読み、アプリの絞りだけで守る | 絞りを1つ忘れると非公開の行が出る。RLS が守りにならない（推定） |
| 画像も匿名の鍵で署名する | 置き場を非公開にしたので、匿名では署名できない（ADR-0150） |

#### 結果

- 良くなること: アプリの絞りと DB の方針のどちらかが崩れても、非公開の LOOK は公開の頁に出ない
- 悪くなること: `look_items` の匿名の読み出しの方針は「親の LOOK が公開」だけを見るので、Data API を直に読むと非公開の商品の ID が分かる（`security_review_look.md`、Open）。SEC-LOOK-002 は満たさないので、上位にしない。関連の取り出しに失敗した時は、署名していない元の道筋をそのまま返す（`server.ts`。SEC-LOOK-008 と合わない）
- 見直す条件: `look_items` の方針に商品の公開の条件を足す時、公開用の関数や見方（view）に置き換える時

## 未確認事項

- 2段の守りをユーザーが決めた記録（レビューの記録だけがある）
- 本番の DB の `looks`・`look_items` の方針が手元の移行と同じか
