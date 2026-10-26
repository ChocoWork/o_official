# ADR-0163 LOOK の更新は `admin_update_look` の1取引にし、更新前の画像を返す

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `admin_update_look`（`supabase/migrations/20261026130500_sec_rls_predicates_and_constraints.sql`）、`PUT /api/admin/looks/[id]`（`src/app/api/admin/looks/[id]/route.ts`） | 基準コミット: `10b211a8`（作業ツリー）

## 概要

管理の LOOK の更新（`PUT /api/admin/looks/[id]`）が行っていた「`looks` の更新 → `look_items` の全削除 → 追加」の 3 回の要求を、DB の関数 `admin_update_look` の rpc 1 回にする。関数は 1 つの取引で 3 つを行い、途中の失敗は全部を戻す。更新前の `image_urls` を返し、窓口はそれから差し替えた古い画像を置き場から消す。新しい画像が無い時は `_image_urls` に NULL を渡し、今の画像を関数の中で保つ。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK（波 2 の Task 7） |
| 対応する ID | SEC-LOOK-015、THR-LOOK-015、API-LOOK-004、DATA-LOOK-002、DD-LOOK-064、ADR-0160 |
| 対象のコード | 関数 `admin_update_look(bigint, integer, text, text, text, text[], text, bigint[]) returns text[]`、`src/app/api/admin/looks/[id]/route.ts` の PUT（`classifyUpdateLookFailure`） |
| 関連文書 | `docs/02_Requirements/areas/look.md`、`docs/05_Quality/security/threats/look.md`、`docs/04_DetailDesign/pages/16-3_admin_look.md`、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md`（Task 7、P9）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（R5-5） |
| 調べた時点 | 2026-10-26（移行を読み、窓口の単体・結合試験を流した。関数の DB 結合試験は書いただけで流していない） |

## 判断

### ADR-0163 LOOK の更新は `admin_update_look` の1取引にし、更新前の画像を返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-015 |
| 根拠 | 更新の途中の失敗で、公開中の LOOK が関連商品 0 件や新旧の混ざった形で残らないようにするため（THR-LOOK-015）。supabase-js の連続した呼び出しは別々の要求なので、1 取引にするには DB の関数にまとめるしかない。波 1-C のレビューが記録した「同じ LOOK に PUT が同時に来ると、先に終えた方が上げた新しい画像が置き場に残る」弱さ（ADR-0160）も、行の締めと「更新前の画像を同じ取引で返す」ことで閉じられる |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R5-5）、`wave2-decisions.md`（ユーザーが「波 2 に進んで」と承認した 2026-10-26） |

#### 背景

- 窓口は `looks` の update、`look_items` の delete、`look_items` の insert を別々に呼んでいた。insert が失敗すると LOOK は関連 0 件のまま残った（`16-3_admin_look.md` の旧い異常フロー）
- 窓口は先に読んだ `image_urls` を使って、画像を付けない PUT でも「今の並び」を書き戻していた。同時の PUT が差し替えた画像を、古い値で上書きしうる
- 応答の契約は変えない: 関連の段の失敗は 500 `Failed to update linked items`（監査 `Failed to update look-item links`）。`FR-LOOK-SEC-004` の `SEC-LOOK-015-AC-01` と単体・結合試験がこの文を確かめる

#### 決定

- 関数: `LANGUAGE plpgsql`・SECURITY INVOKER・`SET search_path = ''`。`REVOKE ALL … FROM PUBLIC, anon, authenticated`、`GRANT EXECUTE … TO service_role`
- 先頭で `SELECT image_urls INTO v_previous FROM public.looks WHERE id = _look_id FOR UPDATE`。行が無ければ `RAISE EXCEPTION 'LOOK_NOT_FOUND' USING ERRCODE = 'P0002'`
- `_image_urls` が NULL なら `image_urls = COALESCE(_image_urls, v_previous)` で今の画像を保つ。空の配列は「画像を空にする」で NULL とは別
- 関連の段（`DELETE`・`INSERT … SELECT DISTINCT unnest(COALESCE(_item_ids, '{}'))`）は入れ子の `BEGIN … EXCEPTION` の中。外部キー違反（`23503`）はそのまま投げ直し、それ以外は `RAISE EXCEPTION 'LOOK_ITEMS_WRITE_FAILED' USING ERRCODE = 'P0001'` に付け直す。投げれば行の更新も戻る
- 戻りは更新前の `image_urls`（`text[]`）。窓口は `listRemovableLookImagePaths(戻り, 新しい画像)` で古い画像を決め、成功した後に消す
- 窓口: 先に読む `existingLook`（404 の早い判定・監査の `previous_status`、列は `id,status`）と商品の存在の確かめは残す。rpc の失敗は `P0002` → 404、`23503` → 400 `Some linked items do not exist`、`LOOK_ITEMS_WRITE_FAILED` → 500 `Failed to update linked items`、その他 → 500 `Failed to update look`。どれも新しく上げた画像を消し、古い画像は消さない。監査の `image_count` は新しい画像の数、無ければ戻りの数
- 窓口の変更と移行は同じ日に移す。移行の前に窓口だけを出すと rpc が `PGRST202` で落ち、LOOK の更新が全部 500 になる。関数を消す時は窓口も同時に戻す

#### 業界の定番との突き合わせ

| 論点 | 定番 | この決定 |
| --- | --- | --- |
| 複数の書き込みを 1 取引にする | supabase-js では複数の文を 1 取引にできないので、Postgres の関数を `rpc` で呼ぶ（Supabase 公式「Database Functions」・「Calling Postgres functions」） | 関数にまとめて rpc 1 回 |
| 関数の権限 | Data API に出る関数は、使う役にだけ EXECUTE を渡す。`SET search_path` を固定する（公式「Securing your API」・「Hardening the Data API」） | service_role だけ。`search_path = ''` |
| 同時更新 | 読んでから書く更新は `SELECT … FOR UPDATE` で行を締める（PostgreSQL の明示的なロック） | 先頭で行を締める |
| Shopify | 商品のメディアの差し替えは Shopify の API が一括の変更として受ける（出典は未確認）。店側が取引を組む形ではない | 比較の対象にしない |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 窓口で 3 つを順に呼び、失敗したら手で元に戻す | 戻す処理自体が失敗する。作成が行を消して戻す形はあるが、更新の「元の関連」を持ち直すのは複雑で、同時の更新とも競合する |
| 戻り値を `void` にし、窓口が先に読んだ `image_urls` で古い画像を決める | 同時の PUT で、先に読んだ値が古くなる。行を締めた取引の中の値を返す方が正しい |
| 新しい画像が無い時も先に読んだ `image_urls` を渡す | 同時の PUT が差し替えた画像を古い値で上書きし、その新しい画像が誰も指さない残骸になる。NULL で関数が保つ |
| 関連の段の失敗を `WHEN OTHERS` で握りつぶして続ける | 行の更新だけが残る。投げて全部戻す |
| SECURITY DEFINER にする | 呼べるのは service_role だけで、RLS を迂回する理由が無い。INVOKER のまま service_role の権限で動かす |

#### 結果

- 良くなること: 更新の途中の失敗で LOOK の関連商品が消えたまま残らない。同時の PUT で画像が残骸にならない。窓口の呼び出しが 3 回から 1 回になる
- 悪くなること: 窓口と DB の移行の順序の縛りができる（同じ日に当てる）。LOOK の更新の細かい誤りは、DB の関数の誤りの符号（`P0002`・`23503`・`P0001`）から窓口が文を作る形になる
- 見直す条件: `looks` に列を足す時（引数と更新の文を直す）、NEWS・取扱店の更新にも同じ形が要る時

## 未確認事項

- 関数が本番の PostgREST の schema cache に載るまでの時間（移行の末尾の `NOTIFY pgrst, 'reload schema'` で足りるか）
- 同時の PUT の行の締めの待ちが長引いた時の挙動（接続のタイムアウト）。DB 結合試験は `lock_timeout` の `55P03` で締めの有無だけを確かめる
