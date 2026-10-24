# ADR-0004 公開の取り出しは anon の鍵の client で行い、service role は画像の署名だけに使う

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/news/services/public.ts` | 基準コミット: `a03beaff`

## 概要

公開の取り出しは session の無い anon の client で表を読み、service role の client は画像の署名にだけ渡す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-001、DRV-NEWS-008 |
| 対象のコード | `src/features/news/services/public.ts`、`src/lib/supabase/server.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0004 公開の取り出しは anon の鍵の client で行い、service role は画像の署名だけに使う

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-001、DRV-NEWS-008 |
| 根拠 | 公開の読み出しにも RLS を効かせ、ADR-0003 の DB の段を公開の道で外さないため（推定。記録は無い）。画像は非公開の置き場にあるので、署名だけは置き場を読める service role が要る |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

#### 背景

公開のページは利用者のログインに依らず同じ記事を出す。表を読むのに要る権限と、非公開の置き場の画像に署名するのに要る権限が違う。

#### 決定

- 表は `createPublicClient()`（anon の鍵、session なし）で読む（`public.ts`）
- `createServiceRoleClient()` は `signNewsImageFields` に渡すだけで、表の読み出しには使わない（`public.ts`）

#### 退けた案

記録なし

#### 結果

- 良くなること: 公開の読み出しで RLS を素通りしない
- 悪くなること: 画像を出さない一覧でも毎回 service role の client を作って署名するので、service role の障害が一覧全体を止める（`security_review_news.md`、Open）
- 見直す条件: 公開の画面が画像を出さないまま続くなら、公開の応答に画像の道筋を載せない案（SEC-NEWS-005）と一緒に見直す

## 未確認事項

- service role の client を作れない時に一覧の表示がどうなるかは試していない
- 判断の理由はユーザーの確認を受けていない
