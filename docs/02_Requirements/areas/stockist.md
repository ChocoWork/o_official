# STOCKIST の要件

> 状態: 推定 | 確認日: 2026-10-29 | 対象: STOCKIST（取扱店の一覧 `/stockist`・ホームの取扱店の節の部品・管理の取扱店） | 基準コミット: `4facf63b`（作業ツリーに別の作業の未コミットの差分あり。取扱店のファイルは含まない）

## 概要

STOCKIST の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）の取扱店の行と、1.10 取扱店の節・1.16 管理の STOCKIST タブの要件を写し、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-STOCKIST-` に書いた。セキュリティ要件 `SEC-STOCKIST-` は脅威の文書（`docs/05_Quality/security/threats/stockist.md`）の `THR-STOCKIST-001〜021` から、同じ番号で起こした。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 3 | 既存の `FREQ-13`・`FREQ-18`・`FREQ-57`（新しい `SR-STOCKIST-` は無し） |
| 要件 | 13 | 既存の `FREQ-13-REQ-01`・`FREQ-18-REQ-01`・`FREQ-57-REQ-01`、`FR-STOCKIST-001`〜`008`・`010`、`FR-ADMIN-006` |
| 受け入れ条件 | 27 | 既存の `FREQ-NN-AC-NN` 5、新しい `FR-…-AC-NN` 22 |
| 派生要件 | 15 | `DRV-STOCKIST-001`〜`015` |
| セキュリティ要件 | 21 | `SEC-STOCKIST-001`〜`021`（受け入れ条件 `SEC-STOCKIST-NNN-AC-NN` 36。全部推定） |

- 状態: 全部「推定」。写した要求の行も、根拠が元の文書に書かれていない物はユーザーの確認を受けるまで「推定」にした。どちらが正しいかは決めず、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節（TM-STOCKIST-NN）に載せた
- 結論: 上位の無い要件は無かった。頁の要件（FR-STOCKIST-）は全部 FREQ-13（取扱店を確かめる）か FREQ-57（地方・都道府県の絞り込み）に、FR-ADMIN-006 は FREQ-18（管理）につないだ（つなぎは推定）。Google Maps のリンク（FR-STOCKIST-007 は WONT、コードはある）、モバイルのカードで隠す3行（FR-STOCKIST-002）、管理で作ると DB で落ちる恐れ（FREQ-18）は、ユーザーに決めてもらう

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 写した元 | `docs/02_Requirements/requirements.md`（冒頭の対応表の FREQ-13・FREQ-18 の行、1.10 取扱店の節、1.16 管理画面の STOCKIST タブの要件、要求トレーサビリティ追記の FREQ-57 の行）。元の行は消していない |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md`（要求定義表の FREQ-13・FREQ-18 の行） |
| 持ち主の決まり | 2つ以上の領域が触れる ID は、定義する領域を1つに決めた。STOCKIST が持つのは FREQ-13・FREQ-18・FREQ-57・FR-STOCKIST-・FR-ADMIN-006 とその子 |
| 対象のコード | `src/app/stockist/`、`src/app/admin/stockist/`、`src/app/api/admin/stockists/`、`src/components/StockistSection.tsx`、`src/features/stockist/` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |
| 範囲外の上位 | 全体の非機能要件 `NFR-SEO-003`・`NFR-A11Y-002`・`NFR-A11Y-005` と、持ち主の無い `FREQ-118-REQ-01` は定義を写さず、受け入れ条件の上位に `（範囲外）` の印で書く |

### 写した行と写さなかった行

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-118 | 持ち主が無い（AC は全部 ITEM 一覧の話）。STOCKIST の 4 列（2xl）だけを FR-STOCKIST-001-AC-02 の上位に `（範囲外）` で書いた |
| FREQ-119・274・275 | NEWS が定義済み（`docs/02_Requirements/areas/news.md`）。設計の上位に `（範囲外）` で書ける |
| FREQ-316・327・515 | 持ち主は AUTH で、`docs/02_Requirements/areas/auth.md` が定義済み。設計の上位に `（範囲外）` で書く |
| FREQ-519・540 | 持ち主なし（権限と売上の基盤の作業が書き換え中で、どの領域も定義しない）。範囲外の `requirements.md` にだけある。設計の上位に `（範囲外）` で書く |
| FREQ-202・203・238・253・314 | 管理の左のナビ・会計・管理の全画面の文字の話で、持ち主が無い |
| FR-HOME-005・FR-HOME-009 | HOME が持つ。ホームの取扱店の節の部品は STOCKIST の `PublicStockistGrid` だが、件数の要件は FR-STOCKIST-004 として STOCKIST が持つ |
| FR-ADMIN-001 | 持ち主が無い（共有の `src/app/admin/page.tsx` のタブの出し分け） |
| FR-STOCKIST-009 | `requirements.md` に定義が無い。E2E の名前だけにある番号なので要件にせず、動きを DRV-STOCKIST-012 に書いた |

### E2E と受け入れ条件の対応

`e2e/FR-STOCKIST-*` のファイルが試している受け入れ条件。テスト名に ID を付ける時に使う。`playwright.config.ts` の project は Desktop Chrome（chromium と、DB 全体を変える4本（FR-STOCKIST-017 など）だけを最後に1本ずつ流す isolated-global）。3つの幅（390・768・1280）で試す。HTTP だけの試験は幅ごとに繰り返さない。

| E2E のファイル | 受け入れ条件 | 今のテストとのずれ |
| --- | --- | --- |
| FR-STOCKIST-001 | FREQ-13-AC-01 | 2026-10-25 に、見本の店の名前と住所が出ることと `pageerror` が無いことまで見るようにした |
| FR-STOCKIST-002 | FR-STOCKIST-002-AC-01 | 2026-10-25 に、768px と 1280px で見本の店ごとに 5 つの文字を見るようにした |
| FR-STOCKIST-004 | FR-STOCKIST-004-AC-01 | 390px の「3 枚以下」の半分だけ。タブレット・デスクトップの 6 件は FR-STOCKIST-011 の AC-02 |
| FR-STOCKIST-005 | FR-STOCKIST-005-AC-01 | title は「STOCKIST \| Le Fil des Heures」の完全一致 |
| FR-STOCKIST-008 | FR-STOCKIST-008-AC-02 | 2026-10-25 に、各カードの h3 が 1 つで見本の店名と一致することを見るようにした。名前の重なり（AC-01）は FR-STOCKIST-012 |
| FR-STOCKIST-009 | 無し（DRV-STOCKIST-012 の動きを試す。受け入れ条件が無いので名前に付ける ID が無い） | 今は赤（カードの上の余白）。テスト名の先頭にあった `FR-STOCKIST-009` は範囲内に定義が無く、E2E の段に書ける受け入れ条件でもなかったので、2026-10-24 に名前から外した（`e2e/FR-STOCKIST-009-divider-spacing.spec.ts`）。今は ID の無い名前として `untagged-test` に数える。DRV-STOCKIST-012 を要件として認めれば、`SR-STOCKIST-001` と要件・受け入れ条件を起こし、テスト名をその受け入れ条件にする |
| FR-STOCKIST-010 の「地方（親）チェック」 | FREQ-57-AC-01 | 残ったカードの住所が近畿の府県だけであることまで見る。モバイル・タブレットでは FILTER の引き出しから選ぶ |
| FR-STOCKIST-010 の「都道府県（子）チェック」 | FREQ-57-AC-02 | 残ったカードの住所が大阪府だけであることまで見る |
| FR-STOCKIST-010 の「店舗が無い地方・都道府県」 | FR-STOCKIST-010-AC-01 | — |
| FR-STOCKIST-011 | FR-STOCKIST-001-AC-01・AC-02、002-AC-02、004-AC-02、006-AC-01、007-AC-01、010-AC-03・AC-04、FREQ-57-AC-03、SEC-STOCKIST-017-AC-01 | 見本の店の名前で絞って数える（同時に流れる他の試験の行に左右されない）。読むだけ |
| FR-STOCKIST-012 | FR-STOCKIST-003-AC-01、008-AC-01、010-AC-02、SEC-STOCKIST-001-AC-01・AC-02、016-AC-01・AC-02 | 手元の DB に `E2E-STK-` の行を足す。非公開の行はホームの最初の 6 件に入る小さい id で足す |
| FR-STOCKIST-013 | FR-ADMIN-006-AC-01〜05、FREQ-18-AC-01、SEC-STOCKIST-015-AC-01、019-AC-01・AC-02 | 本物の aal2 の店長・サポーターでログインする（`e2e/stockist-admin-test-utils.ts`） |
| FR-STOCKIST-014 | SEC-STOCKIST-004-AC-01・AC-02、005-AC-01、006-AC-01〜04、019-AC-03、020-AC-01、021-AC-01〜03 | HTTP だけ。幅ごとには繰り返さない。送り元は `x-real-ip`（波 4 で `x-forwarded-for` から替えた）。020-AC-01・021-AC-01 は波 4 で満たし、`test.fail` を外した |
| FR-STOCKIST-015 | SEC-STOCKIST-007-AC-01・AC-02、009-AC-01、010-AC-01、011-AC-01、012-AC-01、013-AC-01・AC-02、014-AC-01・AC-02 | HTTP だけ。管理 API の JWT は `e2e/admin-session-test-utils.ts`（FR-STOCKIST-016 と共有） |
| FR-STOCKIST-016 | SEC-STOCKIST-002-AC-01、003-AC-01〜03 | 002 は 3 つの幅、003 は HTTP だけ |
| FR-STOCKIST-017 | FR-STOCKIST-003-AC-02、SEC-STOCKIST-018-AC-01 | 全部の公開の店を巻き込むので、`playwright.config.ts` の project `isolated-global`（chromium の teardown）で最後に流す。1 つの試験の中で DB を 1 回だけ変え、3 つの幅をその窓で見る。公開の取り出しの上限は 200 件と決めた |

受け入れ条件があって範囲の E2E が無い物: `SEC-STOCKIST-008-AC-01`（PostgREST が出さない権限の問い合わせなので、`tests/integration/db/stockist_grants_admin_tables.integration.test.ts` の結合テストで確かめる）。範囲外の E2E だけがある物: `e2e/FR-HOME-005-stockist-home.spec.ts`（FR-HOME-005、ホームの取扱店の節）。2026-10-25 に、中身の無かった `FR-STOCKIST-003`・`006`・`007` の E2E ファイルを消した（003 は存在しない空の文を探して落ちない、006・007 は `test.skip` で何も見ていなかった。AC は FR-STOCKIST-011・012・017 が見る）。

## 要求

### FREQ-13 利用者が取扱店を確かめられる

| 属性 | 値 |
| --- | --- |
| 根拠 | 実物を見て買いたい人を、商品を扱う実店舗へ案内するため。stakeholder-requirements.md の要求定義表の行 |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/stakeholder-requirements.md`、`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-13） |

要求の文: エンドカスタマー（User）が取り扱い店舗（Stockist）を確認できること

### FREQ-18 管理画面で取扱店を登録・編集・削除する

| 属性 | 値 |
| --- | --- |
| 根拠 | 店長が開発の手を借りずに、取扱店の増減や営業時間の変更を載せられるようにするため。stakeholder-requirements.md の要求定義表の行 |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/stakeholder-requirements.md`、`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-18） |

要求の文: サイト管理者（Admin）が商品扱い店舗（Stockist）の登録と編集と削除ができること

### FREQ-57 取扱店の一覧に地方→都道府県の入れ子の絞り込みを付ける

| 属性 | 値 |
| --- | --- |
| 根拠 | 店が増えても、近くの店を地方と都道府県で探せるようにするため。LOOK・ITEM の一覧と同じ形のフィルターにそろえる、というユーザーの依頼 |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記」節の FREQ-57） |

要求の文: STOCKIST 一覧に地方→都道府県のネストチェックボックスフィルターを付けること

## 要件

### 要求の表から写した要件

文は `requirements.md` の要件の欄のまま。元の表に優先度は無い。

### FREQ-13-REQ-01 取扱店を確かめる機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | FREQ-13 の「確かめられる」を、取扱店の一覧の機能が動くことに置き換えた（元の表の書き方のまま。細かい形は FR-STOCKIST-001〜008・010 が持つ） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-13-REQ-01） |

取り扱い店舗確認機能が正常に動作すること

### FREQ-18-REQ-01 取扱店の管理の機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-18 |
| 根拠 | FREQ-18 の登録・編集・削除を、管理の機能が動くことに置き換えた（元の表の書き方のまま。細かい形は FR-ADMIN-006 が持つ） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-18-REQ-01） |

商品扱い店舗管理機能が正常に動作すること

### FREQ-57-REQ-01 ALL・地方・都道府県の入れ子のチェックボックスで絞り込む

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57 |
| 根拠 | 地方で一度に、都道府県で個別に絞れるようにし、県名は DB の列を足さず住所の先頭から決める。フィルターの置き場は LOOK・ITEM の一覧にそろえ、頁ごとに操作を覚え直さなくてよいようにする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記」節の FREQ-57-REQ-01） |

STOCKIST 一覧に `ALL`・地方（親）・都道府県（子・インデント）を同時に表示するネストしたチェックボックスツリー型フィルターを設けること。地方チェックで配下都道府県を一括選択し、都道府県チェックで個別に絞り込めること。選択中の都道府県は店舗住所の先頭都道府県名と突き合わせること。UI は LOOK/ITEM と統一し PC は左サイドバー、モバイル・タブレットは FILTER ボタンの drawer とすること

中身は FR-STOCKIST-010 と重なる（二重の定義。どちらかにまとめるかは未確認事項）。

### 取扱店の一覧・管理の要件

文は `requirements.md` の 1.10・1.16 のまま。「今のコード」は 2026-10-24 にコードを読んで分かったこと。元の文書に上位の記載は無く、頁の要件は FREQ-13（FR-STOCKIST-010 だけは FREQ-57）、管理の要件は FREQ-18 につないだ（中身が同じため。推定）。

### FR-STOCKIST-001 公開済みの取扱店を格子に並べ、幅に応じて列を変える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 店の数が増えても一覧で見渡せ、狭い画面でもカードが潰れないようにするため（FREQ-13） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-001） |

公開済みのストックリストを `PublicStockistGrid variant="catalog"` で表示し、レスポンシブグリッドレイアウトに対応する。

今のコード（推定）: 640px 未満で1列、640px 以上で2列、1280px 以上で3列、1536px 以上で4列（`src/features/stockist/components/PublicStockistGrid.tsx`）。4列は FREQ-118 で足した物で、requirements.md のレビューの注（3列まで）は古い。

### FR-STOCKIST-002 各カードに店舗名・住所・電話・営業時間・定休日を載せる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 来店の前に要る情報（どこに・いつ開いているか・連絡先）を1枚で分かるようにするため（FREQ-13）。ただし今のコードは 640px 未満で電話・営業時間・定休日を隠す（DRV-STOCKIST-004、食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-002） |

各ストックリストカードに店舗名・住所・電話番号・営業時間・定休日を含め、店舗情報を判別しやすくする。

今のコード（推定）: 店舗名は h3（`PublicStockistGrid.tsx`）。requirements.md のレビューの注・詳細設計 `10_stockist.md` は h2 と書き、画面の決まり `docs/03_BasicDesign/ui/design-guide.md` は h3。各行にアイコン（読み上げから外す）を付ける。電話が空の店は電話の行を出さない（DRV-STOCKIST-003）。

### FR-STOCKIST-003 公開の店だけを取り、取れない時は空として出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 準備中や閉じた店を訪問者に見せないため、公開の印の付いた店だけを取る。DB が一時的に落ちても頁全体をエラーにせず、空の表示で済ませるため（FREQ-13） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-003） |

Supabase の `stockists` テーブルから `status = 'published'` の店舗データを取得し、取得失敗時は空状態またはエラーハンドリングを行う。

今のコード（推定）: 取り出しで公開の印を絞り、返すのは6つの列（id・店舗名・住所・電話・営業時間・定休日）だけ（`src/features/stockist/services/public.ts`）。DB の誤りは記録して空の一覧を返す。一覧の頁では空の時「該当する取扱店舗がございません。」を出す（DRV-STOCKIST-007）。

### FR-STOCKIST-004 ホームは最大6件、モバイルは上の3件、タブレット以上で全部を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | ホームでは取扱店があることを短く知らせ、モバイルでは縦に長くなり過ぎないよう3件に抑えるため（FREQ-13）。ホームの節の置き場の要件は HOME の FR-HOME-005 が持ち、件数の決まりはこの要件が持つ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-004） |

HOME 用 `PublicStockistGrid variant="home"` は最大6件を優先表示し、モバイルでは上位3件を表示してタブレット以上で全件を見せる。

今のコード（推定）: DB から6件を取り（`public.ts`）、4件目以降は 768px 未満で隠す（`PublicStockistGrid.tsx`）。

### FR-STOCKIST-005 取扱店の頁の title と description を決めて出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 検索エンジンの結果と共有の時に、取扱店の頁だと分かる題と説明を出し、店を探す人をこの頁へ連れてくるため（FREQ-13。NFR-SEO-003 の決まりを取扱店の頁に当てる） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-005） |

STOCKIST ページに `generateMetadata` で `title` / `description` を設定する。

今のコード（推定）: 題は「STOCKIST | Le Fil des Heures」、説明は取扱店舗の一覧である旨の文（`src/app/stockist/page.tsx`）。requirements.md のレビューの注「generateMetadata がない」は古い。OGP も出す（DRV-STOCKIST-013）。

### FR-STOCKIST-006 言葉の検索・並び替え・ページ分けは今は作らない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 店の数が少ない今は、地方・都道府県の絞り込み（FR-STOCKIST-010）だけで探せるので、検索・並び替え・ページ分けは将来に回す（優先度 WONT） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | WONT |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-006） |

キーワード検索、ソート、ページネーションを提供する（将来対応）。

今のコード（推定）: どれも無い。全部の公開の店を1回で取り、1つの格子に並べる。

### FR-STOCKIST-007 地図のリンク・外のリンク・分類・画像は今は付けない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | カードは基本の情報だけで始め、付け足しは将来に回す（優先度 WONT）。ただし今のコードは住所を Google Maps の検索へのリンクにしている（DRV-STOCKIST-002、食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | WONT |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-007） |

ストックリストカードに Google Maps リンク・外部リンク・取扱カテゴリ・店舗画像またはロゴを含める（将来対応）。

今のコード（推定）: 取扱の分類・店舗の画像・ロゴは無い。地図のリンクはある（UI/UX のレビュー S-2 で足した、`docs/05_Quality/reviews/uiux/uiux_review_stockist.md`）。

### FR-STOCKIST-008 カードの区別に id を使い、読み上げで扱いやすくする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13 |
| 根拠 | 同じ名前の店が2つあってもカードが取り違えられず、並びが崩れないようにするため。店舗名を見出しにして、スクリーンリーダーでカードを辿れるようにするため（FREQ-13。NFR-A11Y-002 の決まりをカードに当てる） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-008） |

カードのキーには `shop.name` ではなく `id` やユニークキーを使用し、スクリーンリーダー対応を改善する。

今のコード（推定）: カードの区別は id（`PublicStockistGrid.tsx`、型 `src/features/stockist/types.ts`）。requirements.md のレビューの注「店舗名を使う」は古い。カードは article の要素で、店舗名は h3。

### FR-STOCKIST-010 地方→都道府県の入れ子の絞り込みを出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57 |
| 根拠 | FREQ-57 を頁の形に落とした。店のある地方・県だけを出して空振りの選択を無くし、県が1つの地方は親子に分けず1つの箱にして手数を減らす。置き場は LOOK・ITEM と同じにする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.10 節の FR-STOCKIST-010） |

STOCKIST 一覧に「地方（北海道/東北/関東/中部/近畿/中国/四国/九州・沖縄）→都道府県」のネストしたチェックボックスツリー型フィルターを提供する。`ALL` と、店舗が存在する地方（親）・その地方配下で店舗が存在する都道府県（子・インデント表示）のみを表示し、地方チェックで配下都道府県を一括選択、都道府県チェックで個別に絞り込める。複数都道府県を持つ地方（東北・関東など）は親要素を折りたたみ／展開でき、北海道のように単一都道府県の地方は親子に分けず1つのチェックボックスとする。フィルター UI は LOOK/ITEM 一覧と統一し、desktop は左サイドバー、tablet/mobile は FILTER ボタンと Drawer を表示する。選択中の都道府県は店舗住所の先頭都道府県名と突き合わせて絞り込む。

今のコード（推定）: 実体は `PublicStockistGrid.tsx` の一覧の部品と `src/features/stockist/region.ts`。requirements.md のレビューの注の `PublicStockistCatalog.tsx` は無いファイル。左の列は 1024px 以上で出し、未満は FILTER のボタンと左の引き出し。地方の箱は配下の県が全部選ばれている時だけ印が付き、もう一度押すと配下を全部外す。住所の先頭が県名でない店は、県を選んでいる間は出ない。選んだ県は URL に残す（DRV-STOCKIST-008）。FREQ-57-REQ-01 と中身が重なる。

### FR-ADMIN-006 STOCKIST タブで店の一覧・作成・編集・削除・公開の切り替えをする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-18 |
| 根拠 | 店長が管理画面の STOCKIST タブで取扱店の出し入れと公開の切り替えをできるようにするため（FREQ-18 を管理画面の形に落とした）。作る時に DB の必須の列 `type` を入れず作成が失敗した食い違いは、移行 `stockists_type_optional` で `type` の NOT NULL を外して直した（2026-10-26。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1. ページ別機能要件」の 1.16 節の FR-ADMIN-006） |

STOCKIST タブで店舗の一覧・作成・編集・削除・ステータス管理を行う。

今のコード（推定）: 一覧（`src/components/StockistSection.tsx`）はカードごとに「公開中」「非公開」の札と、公開の切り替え・編集・削除のボタンを出す。作成と編集は別の頁（`/admin/stockist/create`・`/admin/stockist/edit/<id>`）の同じフォーム。タブと「新規作成」は店長の役の時だけ出し（共有の `src/app/admin/page.tsx`、範囲外）、窓口は権限（admin.stockists.read・admin.stockists.manage）で許す。作成の窓口（`src/app/api/admin/stockists/route.ts`）とフォームは `type` を送らない。DB の `type` の列は本番から取った写し（`supabase/migrations/20260901102912_remote_schema.sql`）では NOT NULL で既定値が無く、作成がいつも失敗したが、移行 `stockists_type_optional`（2026-10-26。`supabase/migrations/`）で NOT NULL を外した。列と CHECK（`FLAGSHIP STORE`・`STORE`・`SELECT SHOP`）は残し、`type` は NULL のまま作られる。

## 受け入れ条件

### 要求の表から写した受け入れ条件

### FREQ-13-AC-01 取扱店の確認でエラーが出ず、正しい店の情報が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-13-REQ-01 |
| 根拠 | FREQ-13-REQ-01 を、頁がエラーにならず店の情報が出ることで確かめる。「正しい」を何と比べるかは書かれていない（未確認事項） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-13-AC-01） |

取り扱い店舗確認でエラーが発生せず、正しい店舗情報が表示されること

### FREQ-18-AC-01 取扱店の管理でエラーが出ず登録・編集・削除が終わる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-18-REQ-01 |
| 根拠 | FREQ-18-REQ-01 を、登録・編集・削除が最後まで終わることで確かめる。登録で DB の必須の列を入れず失敗した食い違い（FR-ADMIN-006）は、移行 `stockists_type_optional` で `type` の NOT NULL を外して直した（2026-10-26。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-18-AC-01） |

商品扱い店舗管理でエラーが発生せず、登録・編集・削除が完了すること

### FREQ-57-AC-01 地方を選ぶとその地方の県の店だけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57-REQ-01 |
| 根拠 | FREQ-57-REQ-01 の「地方チェックで一括選択」を、出る店の住所の県で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記」節の FREQ-57-AC-01） |

STOCKIST 一覧で地方（親）チェックを入れるとその地方配下の都道府県の店舗のみが表示されること

### FREQ-57-AC-02 都道府県を選ぶとその県の店だけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57-REQ-01 |
| 根拠 | FREQ-57-REQ-01 の「都道府県チェックで個別に絞り込み」を、出る店の住所の県で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記」節の FREQ-57-AC-02） |

都道府県（子）チェックを入れるとその都道府県の店舗のみが表示されること

### FREQ-57-AC-03 モバイル・タブレットでは FILTER の引き出しから絞れる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57-REQ-01 |
| 根拠 | FREQ-57-REQ-01 の「モバイル・タブレットは FILTER ボタンの drawer」を、ボタンを押して開くことと、その中で絞れることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記」節の FREQ-57-AC-03） |

モバイル・タブレットで FILTER ボタンを押すと drawer が開き地方・都道府県を絞り込めること

### 一覧・管理の要件から起こした受け入れ条件

### FR-STOCKIST-001-AC-01 一覧の列の数が幅で変わる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-001 |
| 根拠 | FR-STOCKIST-001 の「レスポンシブグリッド」を、3つの幅での列の数で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-001）。列の数は今のコード |

公開の店が3件以上ある時、`/stockist` のカードの格子が 390px で1列、768px で2列、1280px で3列であること。

### FR-STOCKIST-001-AC-02 1536px 以上では4列になる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-001、FREQ-118-REQ-01（範囲外） |
| 根拠 | FREQ-118-REQ-01 が決めた「STOCKIST の格子は 2xl で4列」を、一覧の格子の列の数で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-001、FREQ-118-REQ-01） |

公開の店が4件以上ある時、1536px 以上の幅で `/stockist` のカードの格子が4列であること。

### FR-STOCKIST-002-AC-01 640px 以上のカードに5つの情報が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-002 |
| 根拠 | FR-STOCKIST-002 の5つの情報を、カードの中の文字で確かめる。今のコードは 640px 以上で全部を出すので、幅は 768px と 1280px にした |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-002） |

768px と 1280px の幅で、`/stockist` の各カードに店舗名（見出し）・住所・電話番号・営業時間・定休日の文字が出ること（電話番号が空の店は電話の行が無くてよい）。

### FR-STOCKIST-002-AC-02 モバイルのカードに店舗名と住所が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-002 |
| 根拠 | 今のコードがモバイルで残す2つの情報を確かめる。電話・営業時間・定休日を隠すことが要件と合うかは未確認（DRV-STOCKIST-004） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

390px の幅で、`/stockist` の各カードに店舗名（見出し）と住所が出ること。

### FR-STOCKIST-003-AC-01 非公開の店が一覧とホームに出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-003 |
| 根拠 | FR-STOCKIST-003 の「公開の店だけ」を、非公開の店の名前が出ないことで確かめる。今の見本の取扱店は全部公開で、この形を試すには非公開の店を足す必要がある |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-003） |

非公開の店を1件置いた時、`/stockist` とホームの取扱店の節にその店の名前が出ないこと。

### FR-STOCKIST-003-AC-02 公開の店が無い時も頁が出て、空の文が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-003 |
| 根拠 | FR-STOCKIST-003 の「取得失敗時は空状態」を、店が0件の時に頁がエラーにならず空の文が出ることで確かめる。取得の失敗はコードの上で0件と同じ道を通る |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-003）。文は今のコード（`PublicStockistGrid.tsx`） |

公開の店が0件の時、`/stockist` が 200 で返り、「該当する取扱店舗がございません。」が出ること。

### FR-STOCKIST-004-AC-01 モバイルのホームの取扱店は3件まで

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-004 |
| 根拠 | FR-STOCKIST-004 の「モバイルでは上位3件」を、見えているカードの数で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-004） |

390px の幅で、ホームの取扱店の節に見えているカードが3件以下であること。

### FR-STOCKIST-004-AC-02 タブレット以上のホームの取扱店は最大6件を全部出す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-004 |
| 根拠 | FR-STOCKIST-004 の「最大6件」「タブレット以上で全件」を、見えているカードの数で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-004） |

公開の店が6件以上ある時、768px と 1280px の幅で、ホームの取扱店の節に見えているカードがちょうど6件であること。

### FR-STOCKIST-005-AC-01 取扱店の頁の title と description が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-005、NFR-SEO-003（範囲外） |
| 根拠 | FR-STOCKIST-005 の設定を、頁の title と meta の description で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-005）。題は今のコード |

`/stockist` の title が「STOCKIST | Le Fil des Heures」で、meta の description が空でないこと。

### FR-STOCKIST-006-AC-01 一覧に言葉の検索・並び替え・ページ分けが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-006 |
| 根拠 | WONT の要件が今は作られていないことを、頁の部品が無いことで確かめる。作ると決めた時はこの受け入れ条件を廃止にする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-006） |

`/stockist` に言葉の検索の入力欄・並び替えの選択・ページ送りが無く、公開の店が全部1つの格子に出ること。

### FR-STOCKIST-007-AC-01 カードに取扱の分類と店の画像・ロゴが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-007 |
| 根拠 | WONT の要件のうち、今も作られていない物（分類・画像・ロゴ）を確かめる。地図のリンクは今のコードにあるので入れていない（DRV-STOCKIST-002、食い違い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-007） |

`/stockist` の各カードに img の要素と取扱の分類の表示が無いこと。

### FR-STOCKIST-008-AC-01 同じ名前の店が2つあっても両方のカードが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-008 |
| 根拠 | カードの区別に名前でなく id を使うことを、外から見える結果（同じ名前の2件がどちらも出る）で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-008） |

同じ店舗名の公開の店を2件置いた時、`/stockist` にその名前のカードが2枚出ること。

### FR-STOCKIST-008-AC-02 各カードの店舗名が見出しとして読める

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-008、NFR-A11Y-002（範囲外） |
| 根拠 | スクリーンリーダーでカードを辿れることを、カードごとに店舗名の見出しがあることで確かめる。見出しの段は今のコードの h3 にした（E2E は h2 を探す。食い違い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-008）。段は今のコード（`PublicStockistGrid.tsx`） |

`/stockist` の各カード（article）に、店舗名を文字に持つ h3 の見出しが1つあること。

### FR-STOCKIST-010-AC-01 店の無い地方と県はフィルターに出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-010 |
| 根拠 | FR-STOCKIST-010 の「店舗が存在する地方・都道府県のみを表示」を、フィルターの選択肢で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-010） |

`/stockist` のフィルターに、公開の店の住所に1つも無い地方・都道府県の選択肢が出ないこと。

### FR-STOCKIST-010-AC-02 県が1つの地方は1つのチェックボックスで出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-010 |
| 根拠 | FR-STOCKIST-010 の「単一都道府県の地方は1つのチェックボックス」を、北海道の選択肢の形で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-010） |

北海道に公開の店がある時、フィルターの「北海道」が開け閉めのボタンを持たない1つのチェックボックスで出て、選ぶと北海道の店だけが出ること。

### FR-STOCKIST-010-AC-03 ALL を選ぶと絞り込みが解けて全部の店が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-010 |
| 根拠 | FR-STOCKIST-010 の `ALL` を、選んだ県が外れて全部の公開の店に戻ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-010） |

県を1つ選んで絞った後に ALL を選ぶと、ALL に印が付き、公開の店が全部出ること。

### FR-STOCKIST-010-AC-04 1024px 以上は左の列、未満は FILTER のボタンでフィルターを出す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-STOCKIST-010 |
| 根拠 | FR-STOCKIST-010 の「desktop は左サイドバー、tablet/mobile は FILTER ボタン」を、幅ごとに見える物で確かめる。境は今のコードの 1024px |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-STOCKIST-010）。境は今のコード（`PublicStockistGrid.tsx`） |

1280px の幅で左の列にフィルターが見え FILTER のボタンが見えないこと。390px と 768px の幅で左の列が見えず FILTER のボタンが見えること。

### FR-ADMIN-006-AC-01 STOCKIST タブに全部の店が公開の状態つきで出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006 |
| 根拠 | FR-ADMIN-006 の「一覧」「ステータス管理」を、非公開の店も含めて状態の札つきで出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-006） |

店長で `/admin?tab=STOCKIST` を開くと、公開と非公開の店が全部出て、それぞれに「公開中」か「非公開」の札が出ること。

### FR-ADMIN-006-AC-02 作成のフォームで保存すると一覧に新しい店が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006 |
| 根拠 | FR-ADMIN-006 の「作成」を、保存後に STOCKIST タブへ戻り新しい店が出ることで確かめる。DB の必須の列 `type` で落ちた食い違いは、移行 `stockists_type_optional` で直した（2026-10-26。この移行を当てた DB でだけ満たす） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-006） |

店長で `/admin/stockist/create` の5つの欄を埋めて保存すると、`/admin?tab=STOCKIST` に戻り、その店が一覧に出ること。

### FR-ADMIN-006-AC-03 編集のフォームで更新すると一覧の中身が変わる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006 |
| 根拠 | FR-ADMIN-006 の「編集」を、元の値が入ったフォームで直した値が一覧に出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-006） |

一覧の「編集」から開いたフォームに今の値が入っており、店舗名を変えて更新すると、一覧のその店の名前が新しい値になること。

### FR-ADMIN-006-AC-04 公開の切り替えで札と公開の頁が変わる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006 |
| 根拠 | FR-ADMIN-006 の「ステータス管理」を、管理の札と公開の頁の両方で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-006） |

公開中の店の「非公開」を押すと札が「非公開」になり、`/stockist` にその店が出なくなること。もう一度「公開」を押すと戻ること。

### FR-ADMIN-006-AC-05 削除を確かめると一覧から店が消える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006 |
| 根拠 | FR-ADMIN-006 の「削除」を、確かめの窓で取り消すと残り、受けると消えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-006） |

「削除」を押して確かめの窓で取り消すと店が残り、受けると一覧からその店が消えること。

## セキュリティ要件

### SEC-STOCKIST-001 公開の道は公開済みの店舗だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-001 |
| 根拠 | 取引の前・後の店舗を外へ出さないため。DB の RLS とアプリの取り出しの絞りの2段で守り、片方が崩れても漏れないようにする（過去のレビューが「Fixed」とした形）。全体の NFR-SEC-005（権限管理）を取扱店の公開の線引きに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | MUST |

`/stockist`・ホームの取扱店の節・anon と一般会員の JWT での PostgREST の読み出しは、`status='published'` の行だけを返す。今のコードは満たす（`src/features/stockist/services/public.ts`、`supabase/migrations/20260901102912_remote_schema.sql`）。試すテストは無い。

### SEC-STOCKIST-001-AC-01 anon と一般会員の直接の読み出しに非公開の店舗が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-001、NFR-SEC-005（範囲外） |
| 根拠 | RLS の段だけで守れているかを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に非公開の店舗を1件入れ、anon の鍵と一般会員の JWT で `stockists` を select する） |
| 出どころ | 実装から推定 |

非公開の店舗を1件入れた状態で、anon と一般会員の JWT の select の結果にその店舗が含まれないこと。

### SEC-STOCKIST-001-AC-02 公開の画面に非公開の店舗が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-001 |
| 根拠 | アプリの取り出しの段で守れているかを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

非公開の店舗を1件入れた状態で、`/stockist` とホームの取扱店の節に、その店舗の名前が表示されないこと。

### SEC-STOCKIST-002 公開の取り出しは閲覧者の session を引き継がない client で読む

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-002 |
| 根拠 | 管理の権限を持つ人がログインしたまま公開の画面を開いても、公開の取り出しが anon の権限で動き、RLS の段が効くようにするため。全体の NFR-SEC-005 の最小の権限を公開の道に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3（当てはめは推定）。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

公開の取扱店の取り出しは、ログインの Cookie を引き継がない client（`createPublicClient`）で読む。2026-10-26 に満たした（以前は `createClient` で読み、閲覧者の session を引き継いだ）。

- `getPublicStockists`（`/stockist` とホームの取扱店の節が使う）は `createPublicClient()` で読み、Cookie の session の client は使わない（IMPL-STOCKIST-103・104、DD-STOCKIST-003・004）
- 公開の取り出しの誤りは今までどおり空の配列にする（ADR-0253）

### SEC-STOCKIST-002-AC-01 管理の権限でログインしたまま公開の画面を開いても非公開の店舗が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-002、NFR-SEC-005（範囲外） |
| 根拠 | 閲覧者の権限によって公開の画面の中身が変わらないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.stockists.read` を持つ試し用の利用者でログインし、Google OAuth のログインが付ける `sb-<ref>-auth-token` の Cookie も持たせて、mobile 390・tablet 768・desktop 1280 で開く。メールとパスワードのログインだけでは公開の取り出しが anon で動き、脅威の道を試せない（THR-STOCKIST-002、推定）） |
| 出どころ | 実装から推定 |

非公開の店舗を1件入れ、`admin.stockists.read` を持つ利用者で、`sb-<ref>-auth-token` の Cookie を持ってログインした状態で、`/stockist` とホームの取扱店の節にその店舗の名前が表示されないこと。表示される店舗の数が、ログインしていない時と同じであること。

### SEC-STOCKIST-003 DB でも管理の権限を使う操作に2要素認証の済みと有効な session を求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-003 |
| 根拠 | パスワードだけで得た session や失効させた session の token で PostgREST を直接叩き、アプリの窓口の aal2・session・回数の制限・CSRF・監査を全部飛ばされないため。全体の NFR-SEC-008（RBAC）と FREQ-540（範囲外。DB の ACL・有効な session・2要素認証で管理操作を守る）を取扱店の表に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1 |
| 優先度 | MUST |

`stockists` の RLS のうち `admin.stockists.read`・`admin.stockists.manage` で許す方針は、JWT の `aal` が `aal2` で、JWT の session が有効な時だけ許す（または管理の書き換えを表の直接の権限から外し、窓口だけの道にする）。読みの側（AC-01）は、波 5 の移行 M2（`has_permission` に aal2 と結び付いた生きた session を求める。SEC-AUTH-010-AC-03、ADR-0418）を当てた DB で満たす（2026-10-29 に E2E の `test.fail` を外した。M2 は 2026-10-29 に本番適用済み）。書き込みの側（AC-02・AC-03）は、後者の道を取って満たした。2026-10-26 から anon・authenticated に `stockists` の INSERT・UPDATE・DELETE の権限が無い（SEC-STOCKIST-008、ADR-0414）ので、aal1 の JWT でも、失効させた session の token でも PostgREST から書けない（この移行を当てた DB でだけ満たす）。管理の窓口の書き込みは認可の後に service role で行う（ADR-0267）。

### SEC-STOCKIST-003-AC-01 aal1 の session では非公開の店舗を直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-003、NFR-SEC-008（範囲外） |
| 根拠 | 2要素認証を済ませていない session で、非公開の店舗の読み出しに届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.stockists.read` を持つ試し用の利用者の aal1 の JWT で、手元の Supabase の `stockists` を select する） |
| 出どころ | 実装から推定 |

`admin.stockists.read` を持つ利用者の aal1 の JWT で select した時、非公開の店舗が結果に含まれないこと。

### SEC-STOCKIST-003-AC-02 aal1 の session では店舗を直接作る・書き換える・消すことができない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-003、NFR-SEC-008（範囲外） |
| 根拠 | 改ざんと消去の道も、読み出しと同じく aal2 で閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.stockists.manage` を持つ試し用の利用者の aal1 の JWT で insert・update・delete を送る） |
| 出どころ | 実装から推定 |

aal1 の JWT の insert・update・delete が、どれも行を変えずに終わること（権限の誤り `42501` で断られる。権限を外した後は0件の成功にならない）。

### SEC-STOCKIST-003-AC-03 失効させた session の token では店舗を直接書き換えられない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-003、NFR-SEC-008（範囲外） |
| 根拠 | ログアウトや強制の失効の後に、残った access token で書き換えられないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の利用者の session を失効させた後、その access token で update を送る） |
| 出どころ | 実装から推定 |

失効させた session の access token の update が、行を変えずに終わること（失効の前の update も、同じ権限の誤りで終わる。書き込みは窓口の service role だけ）。

### SEC-STOCKIST-004 変更の窓口は Origin と CSRF の token を確かめ、判定できない時は拒む

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-004 |
| 根拠 | 別のサイトからの送信で取扱店を変えさせないため。Origin の確かめ（FREQ-327（範囲外））と token の確かめの2段にし、拒否の結果を応答に変える所は、分からない値を「通す」に倒さない。全体の NFR-SEC-003（CSRF 対策）を取扱店の窓口に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.2.2。`docs/05_Quality/reviews/code/2026-04-18-stockist-review.md` |
| 優先度 | MUST |

POST・PUT・PATCH・DELETE は、許可のオリジンでない要求と、Cookie の session なのに CSRF の token が無い・違う要求を 403 で拒む。CSRF の確かめの結果が、拒否の応答でも「確かめ済み」でもない時は拒む。今のコードは Origin と token を確かめるが、分からない結果を通す。

### SEC-STOCKIST-004-AC-01 別のオリジンからの変更の要求は拒まれる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-004、NFR-SEC-003（範囲外） |
| 根拠 | 1段目の Origin の確かめが取扱店の窓口に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の Cookie で、`Origin` を別のオリジンにして POST・PUT・PATCH・DELETE を送る） |
| 出どころ | 実装から推定 |

どの要求も 403 になり、`stockists` の行が変わらないこと。

### SEC-STOCKIST-004-AC-02 CSRF の token が無い・違う変更の要求は拒まれる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-004、NFR-SEC-003（範囲外） |
| 根拠 | 2段目の token の確かめが、Origin が正しい要求にも効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の Cookie で、正しい Origin・`x-csrf-token` 無しと違う値で PATCH を送る） |
| 出どころ | 実装から推定 |

どちらの要求も 403 になり、店舗の公開状態が変わらないこと。

### SEC-STOCKIST-005 別のオリジンからの変更の要求は回数の枠を使う前に拒む

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-005 |
| 根拠 | 別のサイトからの送信で、管理者本人の変更の枠を使い切らせないため。窓口の中では回数の制限が token の確かめより前にあるので、その前の Origin の確かめで止める |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け。実装から推定（取扱店のコードと移行を読み直した） |
| 優先度 | SHOULD |

別のオリジンからの POST・PUT・PATCH・DELETE は、取扱店の窓口に届く前に拒み、回数の制限の数に入れない。今のコードは満たす（`src/proxy.ts` が窓口より前に拒む）。試すテストは無い。

### SEC-STOCKIST-005-AC-01 別のオリジンからの要求を続けて送っても本人の変更が 429 にならない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-005 |
| 根拠 | 拒まれた要求が本人の枠を減らさないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の Cookie で、別のオリジンの PATCH を21回送った後、正しい Origin と token の PATCH を送る） |
| 出どころ | 実装から推定 |

最後の正しい PATCH が 200 になり、429 にならないこと。

### SEC-STOCKIST-006 管理の窓口は署名を確かめた token・有効な session・DB の ACL の権限・aal2 を全部求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-006 |
| 根拠 | 未ログインの人・取扱店の権限を持たない人・2要素認証を済ませていない人に、管理の読み・変更をさせないため。認可を `authorizeAdminPermission` の1つの道にまとめる（FREQ-316（範囲外））。全体の NFR-SEC-005・008 を取扱店の窓口に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | MUST |

`/api/admin/stockists` と `/api/admin/stockists/<id>` は、読みに `admin.stockists.read`、変更に `admin.stockists.manage` を求め、token が無い・署名が違う・session が失効している時は 401、権限が無い・aal1 の時は 403 を返す。DB の client は、読み（GET）は利用者の JWT の物、書き込み（POST・PUT・PATCH・DELETE）は認可の後に service role の物を使う（ADR-0267）。今のコードは満たす（`src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts`、`src/lib/auth/admin-rbac.ts`）。試すテストは無い。

### SEC-STOCKIST-006-AC-01 未ログインの要求は 401 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、NFR-SEC-005（範囲外） |
| 根拠 | token の無い要求が、どの窓口でも読み・変更に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける。付けないと proxy が窓口より前に 403 `Forbidden origin` を返し、401 にならない） |
| 出どころ | 実装から推定 |

ログインしていない状態で、管理の取扱店の6つの窓口（GET 一覧・POST・GET 1件・PUT・PATCH・DELETE）を呼ぶと、どれも 401 になり、店舗の中身が応答に出ないこと。

### SEC-STOCKIST-006-AC-02 取扱店の権限を持たない管理者は 403 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、NFR-SEC-008（範囲外） |
| 根拠 | 店長は可・サポーターは不可の決まり（権限の設計の表）が窓口に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（サポーターの役割の aal2 の利用者で呼ぶ。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | `docs/superpowers/specs/2026-10-23-group-g-design.md` |

サポーターの役割の利用者が6つの窓口を呼ぶと、どれも 403 になり、店舗の行が変わらないこと。

### SEC-STOCKIST-006-AC-03 aal1 の session の要求は 403 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、NFR-SEC-008（範囲外） |
| 根拠 | 2要素認証を済ませていない session が、権限を持っていても窓口に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（店長の役割の aal1 の session で呼ぶ。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

店長の役割で aal1 の session の利用者が6つの窓口を呼ぶと、どれも 403（MFA required）になり、店舗の行が変わらないこと。

### SEC-STOCKIST-006-AC-04 読みの権限だけでは変更できない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、NFR-SEC-008（範囲外） |
| 根拠 | 読みと変更の権限の分け方が窓口に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.stockists.read` だけを持つ役割の aal2 の利用者で呼ぶ。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

GET の2つは 200 になり、POST・PUT・PATCH・DELETE は 403 になって店舗の行が変わらないこと。

### SEC-STOCKIST-007 管理の窓口は送り元と操作者の2本で回数を制限し、送り元は信頼できる値から取る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-007 |
| 根拠 | 漏れた session で短い時間に大量の列挙・書き換えをさせないため。送り元の見出しは偽れるので、操作者の枠を主にし、送り元は中継が付けた信頼できる値から取る |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | MUST |

読みは 120回/600秒、変更は 20回/600秒を、送り元と操作者のそれぞれで数え、超えたら 429 と `Retry-After` を返す。制限の DB が使えない時は 503 で閉じる。送り元は信頼できる中継の値だけから取る。数えるのは、時刻を 600 秒で割った境で区切った固定の窓（`floor(now/600s)`。動く窓ではない）なので、境をまたぐと最大で枠の2倍まで通る。受け入れ条件は同じ区切りの中で数える。今のコードは回数の制限を満たすが、送り元を `x-forwarded-for` から無条件に取る。

### SEC-STOCKIST-007-AC-01 変更の21回目は 429 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-007 |
| 根拠 | 変更の枠が実際に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、同じ 600 秒の区切りの中で PATCH を21回送る。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

21回目の PATCH が 429 になり、`Retry-After` の見出しが付き、店舗の公開状態が変わらないこと。

### SEC-STOCKIST-007-AC-02 送り元の見出しを変えても操作者の枠で止まる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-007 |
| 根拠 | 送り元の偽りで枠をすり抜けられないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、毎回違う `x-forwarded-for` を付けて PATCH を同じ 600 秒の区切りの中で21回送る。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

21回目の PATCH が 429 になること。

### SEC-STOCKIST-008 表・連番の権限は使う操作だけに絞る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-008 |
| 根拠 | RLS が止めない操作（TRUNCATE など）や連番の書き換えの道を、権限の段でも閉じるため。RLS の方針だけに頼らない。全体の NFR-SEC-005 の最小の権限を表に当てはめた |
| 状態 | 推定 |
| 確かめ方 | 結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3 |
| 優先度 | SHOULD |

`stockists` の表は anon・authenticated に SELECT だけを付ける（SEC-STOCKIST-003 の書き込みの穴を塞ぐため、authenticated の INSERT・UPDATE・DELETE も付けない。管理の書き込みは全部 service role の窓口で行う。ADR-0414、ADR-0267）。TRUNCATE・TRIGGER・REFERENCES・MAINTAIN も付けない。連番 `stockists_id_seq` は anon・authenticated に USAGE・SELECT・UPDATE のどれも付けず、service role に USAGE・SELECT を明示する。RLS の書き込み方針は消さず二重の守りとして残す。2026-10-26 に移行 `sec_grants_admin_tables` で満たした（この移行を当てた DB でだけ満たす。DATA-STOCKIST-002）。

### SEC-STOCKIST-008-AC-01 anon・authenticated に表の余分な権限が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-008、NFR-SEC-005（範囲外） |
| 根拠 | 移行の権限の付け方が、決めた最小の形になっていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 結合テスト（手元の DB に `has_table_privilege`・`has_sequence_privilege` で問い合わせる。PostgREST は TRUNCATE・TRIGGER・REFERENCES・MAINTAIN と連番の UPDATE を HTTP で出さないので E2E では確かめられない。`tests/integration/db/stockist_grants_admin_tables.integration.test.ts` と `stockist_rls.integration.test.ts` の「DATA-STOCKIST-002 … SELECT だけが付いている」「… 連番 … どれも付いていない」。結合テストは AC を指せない決まりなので、`validate-trace` の missing-child（e2e テスト無し）は知ったうえで残る） |
| 出どころ | 実装から推定 |

anon・authenticated の `stockists` の INSERT・UPDATE・DELETE・TRUNCATE・TRIGGER・REFERENCES・MAINTAIN の権限と、`stockists_id_seq` の USAGE・SELECT・UPDATE の権限が、どれも false であること（SELECT だけが true）。

### SEC-STOCKIST-009 管理の応答は画面で使う列だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-009 |
| 根拠 | 後から内部の列を足した時に、黙って外へ出さないため。公開の取り出しと同じく返す列を決める |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | SHOULD |

管理の一覧と1件の取得は、`id`・`name`・`address`・`phone`・`time`・`holiday`・`status`・`updated_at` だけを返す（列は案）。2026-10-26 に満たした（以前は `select('*')` で `type`・`created_at` も返した）。

- 一覧と1件の `select` は同じ定数 `ADMIN_STOCKIST_COLUMNS`（`src/features/stockist/schemas.ts`）を使う。後から表に列を足しても、この定数を直すまで外へ出ない
- 管理の画面（`StockistSection`・編集の頁）は `type`・`created_at` を読まない

### SEC-STOCKIST-009-AC-01 管理の応答に決めた列のほかが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-009 |
| 根拠 | 応答の形が決めた列に固定されていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で GET 一覧と GET 1件を呼ぶ） |
| 出どころ | 実装から推定 |

どちらの応答も、各店舗のキーが決めた列と同じで、`type`・`created_at` が含まれないこと。

### SEC-STOCKIST-010 管理の応答は共有のキャッシュに残さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-010 |
| 根拠 | 非公開の店舗を含む管理の応答を、中継やブラウザのキャッシュに残さないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.2.1。`docs/05_Quality/reviews/code/2026-04-29-stockist-review-addendum.md` |
| 優先度 | MUST |

管理の取扱店の窓口の応答は、成功・失敗・回数の制限の 429・503 のどれにも `Cache-Control: private, no-store` を付ける。各 route の `export` を共有の包み `withNoStore`（`src/lib/http/no-store.ts`）で返す形にして、2026-10-26 に満たした（ADR-0266）。`proxy.ts` が route に届く前に返す Origin の 403 には付かない（波 3）。

### SEC-STOCKIST-010-AC-01 管理の応答に no-store が付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-010 |
| 根拠 | 成功と失敗の両方の応答で、キャッシュの禁止が付いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長の GET 一覧・GET 1件、無い id の GET 1件、21回目の PATCH） |
| 出どころ | 実装から推定 |

どの応答の `Cache-Control` にも `no-store` と `private` が含まれること。

### SEC-STOCKIST-011 店舗の値は形の許可で確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-011 |
| 根拠 | 制御文字や電話でない字を店舗に入れさせず、公開の画面の表示と電話のリンクの食い違い、監査の記録の汚れを防ぐため。全体の NFR-SEC-003（入力検証）を取扱店の入力に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.1.3。`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | SHOULD |

作成と書き換えは、全部の文字の値で制御文字（改行を含む）を拒み、電話は数字・`+`・`-`・空白・括弧だけを許す。2026-10-26 に満たした（以前は長さだけを見た）。

- 店名（255 字）・住所（500 字）・営業時間（120 字）・定休日（120 字）は、前後の空白を除いた後に、制御文字（`\p{Cc}`。改行・タブを含む）・書式文字（`\p{Cf}`。ゼロ幅空白・双方向制御を含む）・行区切り（`\p{Zl}`）・段落区切り（`\p{Zp}`）を 1 字も含まない 1 行の文字だけを許す。全角の空白は通す
- 電話（50 字）は、前後の空白を除いた後に、半角の数字・`+`・`-`・半角の括弧・半角の空白・全角の括弧（`（）`）・全角の空白だけを許す。改行を含む `\s` は使わない。英字と「（代表）」のような漢字は拒む
- 前後の空白と改行は先に取り除くので、末尾だけの改行は取り除かれて保存される。途中の改行は拒む
- 既に保存されている店舗の値が許可の外の字を含むと、その店舗は編集で保存できなくなる。本番の確認は報告に書いた

### SEC-STOCKIST-011-AC-01 制御文字を含む値は保存されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-011、NFR-SEC-003（範囲外） |
| 根拠 | 許可の形の外の値が DB に入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、店名に改行を入れた POST と、電話に英字を入れた PUT を送る） |
| 出どころ | 実装から推定 |

どちらも 400 になり、店舗の行が増えない・変わらないこと。

### SEC-STOCKIST-012 監査の記録は信頼できる送り元と、整えた値で残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-012 |
| 根拠 | 不正や誤りの調べで、送り元を追え、記録の行を読み違えないようにするため。全体の NFR-SEC-011（監査ログの改ざん防止）を取扱店の監査に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-29-stockist-review-addendum.md` |
| 優先度 | SHOULD |

監査の `ip` は信頼できる中継の値だけから取り、要求の見出しの値をそのまま入れない。監査の `detail` に入れる店名は、改行と制御文字を除く。2026-10-28（波 4）に満たした。変更の 4 つの窓口は監査の `ip` を `getClientIp`（`src/lib/request-ip.ts`。Vercel の `x-vercel-forwarded-for`・`x-real-ip` だけを読み、`x-forwarded-for` は読まない。ADR-0416）から取り、形が IP でない・信頼する見出しが無い時は null のまま残す。店名の制御文字は、共有の `maskAuditEvent`（`src/lib/audit.ts`）が `detail` と `metadata` の文字列から除く（`[\p{Cc}\p{Cf}]` を空白にする）。

### SEC-STOCKIST-012-AC-01 偽の送り元の見出しが監査の ip にそのまま入らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-012、NFR-SEC-011（範囲外） |
| 根拠 | 監査の送り元を要求の側から偽れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、`x-forwarded-for: 203.0.113.9` と、別の信頼する `x-real-ip` を付けて PATCH を送り、手元の Supabase の `audit_logs` を読む） |
| 出どころ | 実装から推定 |

その PATCH の監査の行の `ip` が `x-real-ip` の値で、`203.0.113.9` でないこと。

### SEC-STOCKIST-013 変更の監査は実際に変わった行だけを成功とし、消した中身を残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-013 |
| 根拠 | 無い店舗への操作を成功に見せず、消した店舗を監査から戻せるようにするため。全体の NFR-SEC-005・011（監査ログ）を取扱店の変更に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。実装から推定（取扱店のコードと移行を読み直した） |
| 優先度 | SHOULD |

PUT・PATCH・DELETE は、変わった行が0件の時は 404 を返し、成功の監査を残さない。削除の監査には、消した店舗の名前と住所を残す。2026-10-26 に満たした（以前は 0 件でも 200 と成功の監査だった）。

- PUT・PATCH は `.update(...).eq('id', id).select('id')`、DELETE は `.delete().eq('id', id).select('id, name, address, status')` で行を受け取る。0 行（無い）は 404 `{ error: 'Stockist not found' }` と、結果 `failure`・`detail='Stockist not found'` の監査 1 行にする。成功の監査は書かない
- 管理の窓口は認可の後に service role の client で書くので（ADR-0267）、RLS は行を隠さず、0 行は「その id の店が無い」だけを表す
- 削除が 1 行を返した時の成功の監査は `metadata.deleted = { id, name, address, status }` だけを残す（電話・営業時間は残さない）。`detail` は今までどおり `Deleted stockist id: <id>`
- 道の `id` は安全に表せる正の整数だけを受け、そうでなければ DB に渡さず 400 を返す（桁あふれを 500 にしない）

### SEC-STOCKIST-013-AC-01 無い店舗への変更は 404 になり成功の監査が残らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-013、NFR-SEC-005（範囲外） |
| 根拠 | 0件の変更が成功として記録されないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、無い id に PUT・PATCH・DELETE を送り、`audit_logs` を読む。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

どれも 404 になり、`outcome='success'` の監査の行が増えないこと。

### SEC-STOCKIST-013-AC-02 削除の監査に消した店舗の中身が残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-013、NFR-SEC-011（範囲外） |
| 根拠 | 誤って消した店舗を監査から戻せることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で店舗を1件消し、`audit_logs` を読む） |
| 出どころ | 実装から推定 |

削除の成功の監査の行に、消した店舗の名前と住所が含まれること。

### SEC-STOCKIST-014 誤りの応答は決まった文だけを返し、記録には要る項目だけを書く

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-014 |
| 根拠 | 誤りの応答と記録から、入力の制約や DB の内部の様子を出さないため。壊れた本文は利用者の誤りとして 400 で返す |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V7.4.1（当てはめは推定）。`docs/05_Quality/reviews/code/2026-04-29-stockist-review-addendum.md` |
| 優先度 | SHOULD |

検証の誤りは決まった誤りの文（と必要なら項目の名前）だけを返す。本文が JSON でない時は 400 を返す。サーバーの記録には誤りの種類と code だけを書き、例外や DB の誤りを丸ごと渡さない。AC-01・AC-02 と、窓口の中の DB の誤りの記録（`{ code }`）は 2026-10-26 に満たした（以前は `details` に zod の内訳を返し、壊れた JSON は 500 だった）。各 route の外側の `catch` の記録と公開の取り出し（`getPublicStockists`）の記録も、`describeErrorForLog`（`src/lib/logging/safe-error.ts`）で名前と符号だけにして、2026-10-26 に満たした。

- 検証の誤りは 400 `{ error: 'Invalid request', fields: [誤りのあった項目の名前（重複なし）] }`。`details`・`fieldErrors`・`formErrors`・入力の値は含めない（`toInvalidStockistResponse`、IMPL-STOCKIST-149）
- 壊れた JSON（と JSON の `null`）は 400 `{ error: 'Invalid request' }` と、結果 `failure`・`detail='Invalid JSON'` の監査 1 行にする。表には触らない
- DB の誤りの記録は `console.error('Failed to ...:', { code })` にし、Supabase の誤りの本文を渡さない。窓口の外側の `catch` と公開の取り出しの記録は `describeErrorForLog` で `{ name, code }` だけにし、例外や Supabase の誤りの `message`・`details`・`hint`・`stack` を渡さない

### SEC-STOCKIST-014-AC-01 検証の誤りの応答に制約の中身が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-014 |
| 根拠 | 応答から項目ごとの制約を読み取れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、店名を空にした POST を送る） |
| 出どころ | 実装から推定 |

応答が 400 で、本文に `fieldErrors`・`formErrors` が含まれないこと。

### SEC-STOCKIST-014-AC-02 JSON でない本文は 400 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-014 |
| 根拠 | 壊れた本文が例外の 500 にならず、利用者の誤りとして扱われることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で、JSON でない本文の POST・PUT・PATCH を送る） |
| 出どころ | 実装から推定 |

どれも 400 になり、店舗の行が増えない・変わらないこと。

### SEC-STOCKIST-015 編集の頁は id を正の整数と確かめてから API の道を組む

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-015 |
| 根拠 | 細工した URL で、管理者の権限のまま取扱店でない管理 API を呼ばせないため。窓口の側の id の確かめは、道が変わると届かない |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。実装から推定（取扱店のコードと移行を読み直した） |
| 優先度 | SHOULD |

`/admin/stockist/edit/<id>` は、id が正の整数でない時は API を呼ばずに誤りを表示する。今のコードは満たさない。

### SEC-STOCKIST-015-AC-01 数でない id の編集の頁は API を呼ばない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-015 |
| 根拠 | 頁がパスを組む前に id を絞っていることを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で `/admin/stockist/edit/..%2Fsettings` などを開き、送られた要求を見る。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/api/admin/stockists/` で始まらない管理 API への要求が送られず、誤りの文が表示されること。

### SEC-STOCKIST-016 店舗の値は文字として出し、外へのリンクは決まった形で作る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-016 |
| 根拠 | 店舗の値に台本や URL を入れられても、閲覧者のブラウザで動かさず、決まった先にしか連れて行かないため。全体の NFR-SEC-003（XSS 対策）を公開の画面に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V5.3.3（当てはめは推定）。`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 優先度 | MUST |

店舗の値は HTML として出さない。住所のリンクは Google Maps の検索の固定の頭に `encodeURIComponent` した住所を付けて作り、`rel="noopener noreferrer"` で開く。電話のリンクは数字と `+` だけで作る。今のコードは満たす（`src/features/stockist/components/PublicStockistGrid.tsx`）。試すテストは無い。

### SEC-STOCKIST-016-AC-01 店名と住所に入れた台本が動かず文字として出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-016、NFR-SEC-003（範囲外） |
| 根拠 | 保存された値による XSS が起きないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、店名と住所に `<img src=x onerror=…>` を入れた公開の店舗を1件入れ、mobile 390・tablet 768・desktop 1280 で `/stockist` を開く） |
| 出どころ | 実装から推定 |

台本が動かず（dialog が出ない）、入れた字がそのまま文字として表示されること。

### SEC-STOCKIST-016-AC-02 住所のリンクは決まった先にだけ向く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-016 |
| 根拠 | 住所に URL や `&` を入れても、リンクの先が変わらないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（住所に `https://example.com/&query=x` を入れた公開の店舗で確かめる） |
| 出どころ | 実装から推定 |

住所のリンクの `href` が `https://www.google.com/maps/search/?api=1&query=` で始まり、`rel` に `noopener` と `noreferrer` が含まれること。電話のリンクの `href` が `tel:` と数字・`+` だけでできていること。

### SEC-STOCKIST-017 URL の pref は県名の許可の一覧で絞る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-017 |
| 根拠 | 細工した URL で画面を壊させず、ありえない絞り込みを見せないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V5.1.3（当てはめは推定） |
| 優先度 | SHOULD |

`pref` の値は県名の許可の一覧にある物だけを使い、ほかは捨てる。残りが空なら全件を出す。今のコードは満たす（`PublicStockistGrid.tsx`）。試すテストは無い。

### SEC-STOCKIST-017-AC-01 一覧に無い pref は無視され全件が出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-017 |
| 根拠 | 許可の一覧の外の値が絞り込みに入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`/stockist?pref=<script>,存在しない県` を mobile 390・tablet 768・desktop 1280 で開く） |
| 出どころ | 実装から推定 |

表示される店舗の数が `/stockist` を条件なしで開いた時と同じで、選ばれた県の印が1つも付かないこと。

### SEC-STOCKIST-018 公開の読み出しは件数と回数に上限を持つ

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-018 |
| 根拠 | 公開の画面と anon の直接の読み出しを大量に叩かれても、DB とほかの画面を止めないため |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4（当てはめは推定） |
| 優先度 | SHOULD |

公開の取り出しは件数の上限（例: 200 件）を必ず付ける。PostgREST の行の上限（`max_rows`）を本番でも設定する。画面の前の中継で回数の制限をかけるかは、本番の構成で決める。

- 件数の上限は 2026-10-26 に満たした。`getPublicStockists` は呼び出しの `limit` を `min(floor(limit), 200)` にし、`limit` が無い・0・負・NaN・無限でも 200 を掛ける（定数 `PUBLIC_STOCKIST_FETCH_LIMIT`）。ホームは今までどおり 6 件
- `max_rows` を本番で設定するか、中継の回数の制限は、本番の構成で決める事柄のままで、この直しの範囲外

### SEC-STOCKIST-018-AC-01 anon の直接の読み出しが行の上限を超えない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-018 |
| 根拠 | 店舗が増えても、1回の読み出しの量に天井があることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に公開の店舗を上限より多く入れ、anon の鍵で `stockists` を select し、`/stockist` を開く） |
| 出どころ | 実装から推定 |

select の結果の行の数が `max_rows` 以下で、`/stockist` に表示されるカードの数が公開の取り出しの上限以下であること。

公開の取り出しの上限は 200 件とする（2026-10-25 に例の 200 件を決めた値にした。E2E の定数 `PUBLIC_FETCH_LIMIT`、`e2e/FR-STOCKIST-017-global-state-windows.spec.ts`）。

### SEC-STOCKIST-019 管理の作成・編集の頁は入口で権限を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-019 |
| 根拠 | 権限の無い人に管理の画面を見せないため。データは窓口が守るので、画面の守りは2段目 |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け。実装から推定（取扱店のコードと移行を読み直した） |
| 優先度 | SHOULD |

`/admin/stockist/create`・`/admin/stockist/edit/<id>` は、未ログインの人と `admin.stockists.manage` を持たない人にフォームを出さない。作成の頁は 2026-10-28（波 4）に満たした。フォームを出す前に `GET /api/admin/stockists/access`（API-STOCKIST-007）を呼び、通るまで「読み込み中...」、通ればフォーム、401・403 は固定の誤りの文だけを出す（ADR-0269）。編集の頁は、今までどおり 1 件の取得（読みの権限）が通るとフォームを出す。`admin.stockists.read` だけの人には編集のフォームが出るが、書き込みは窓口が 403 で断る（作成の頁だけを直す決定。波 4 の決定 Q20）。

### SEC-STOCKIST-019-AC-01 未ログインで管理の作成の頁を開くとフォームが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-019、NFR-SEC-005（範囲外） |
| 根拠 | 頁の入口の守りが効いていることを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ログインしていない状態で `/admin/stockist/create` と `/admin/stockist/edit/1` を開くと、店舗の名前の入力欄が表示されないこと。

### SEC-STOCKIST-019-AC-02 取扱店の権限を持たない管理者には管理の作成の頁のフォームが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-019、NFR-SEC-008（範囲外） |
| 根拠 | 役割による頁の出し分けが効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（サポーターの役割の aal2 の利用者で、mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

サポーターの役割の利用者が `/admin/stockist/create` を開くと、店舗の名前の入力欄が表示されないこと。

### SEC-STOCKIST-019-AC-03 作成の頁の入口の窓口は店長に 204、サポーターに 403、未ログインに 401 を返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-019、NFR-SEC-008（範囲外） |
| 根拠 | 作成の頁が入口で呼ぶ確かめが、権限の有無を応答の状態で区別し、結果をキャッシュさせないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（店長・サポーターの aal2 の利用者と未ログインで `GET /api/admin/stockists/access` を送る。HTTP だけ） |
| 出どころ | 波 4 の決定（Q20） |

店長の aal2 は本文の無い 204、サポーターの aal2 は 403、未ログインは 401 になり、3 つとも `Cache-Control` に `no-store` が含まれること。

### SEC-STOCKIST-020 管理の窓口は認可の前に送り元の枠で回数を数える

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-020 |
| 根拠 | 認可で断られる要求でも、session の生存の確かめと ACL の照会で DB を往復させるので、断られる要求の量も抑えるため。全体の NFR-SEC-005 を管理の窓口の入口に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4（当てはめは推定）。2026-10-24 の脅威の見直し |
| 優先度 | SHOULD |

6つの窓口は、認可より前に送り元の枠で数え、超えたら 429 と `Retry-After` を返す。操作者の枠は今までどおり認可の後に数える。2026-10-28（波 4）に満たした。窓口の順序は「送り元の枠 → （道の id の形）→ 認可 → 操作者の枠 → （変更だけ）CSRF」で、送り元の枠は窓口の最初に置くので、形の悪い id の連打も数える。作成の頁の入口の窓口（`GET /api/admin/stockists/access`、API-STOCKIST-007）も同じ順序。限度は読み 120・変更 20 を 600 秒で、送り元の枠も操作者の枠も同じ値（ADR-0259）。送り元の枠は未ログインの 401・権限の無い 403・CSRF の拒否も数えるので、同じ送り元の店長が巻き添えで 429 になりうる（Vercel では送り元は単一の接続元）。

### SEC-STOCKIST-020-AC-01 権限の無い token の要求を続けて送ると 429 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-020、NFR-SEC-005（範囲外） |
| 根拠 | 認可で断られる要求も回数の枠で止まることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（取扱店の権限を持たない一般会員の token で、同じ 600 秒の区切りの中で GET を121回送る） |
| 出どころ | 実装から推定 |

121回目の GET が 403 でなく 429 になり、`Retry-After` の見出しが付くこと。

### SEC-STOCKIST-021 認可で断った管理の要求を監査に残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-STOCKIST-021 |
| 根拠 | 権限の無い人や aal1 の session による管理の窓口の探りを、後から追えるようにするため。全体の NFR-SEC-005・011（監査ログ）を認可の失敗に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V7.2.2（当てはめは推定）、V7.1.3。2026-10-24 の脅威の見直し |
| 優先度 | SHOULD |

管理の窓口が 401・403（権限・`MFA required`）を返した時は、要求した権限・結果・分かれば利用者の id を監査に残す。残すのは操作者が分かる拒否（失効した session の 401・権限不足と aal1 の 403）だけで、token の無い 401・失効を確認できない 503・内部の誤りの 500 は残さない。2026-10-28（波 4）に満たした。部品（`admin-rbac.ts` の `denial` と `audit-authz-denial.ts` の `auditAuthzDenial`）を Task 7 で足し、取扱店の 6 つの窓口と `access` が、認可の拒否の枝で `auditAuthzDenial` を呼ぶ（Task 8。ADR-0268）。action は `admin.stockists.list`・`create`・`get`・`update`・`patch`・`delete`・`access`、resource は `stockists`。`detail` は `Forbidden: <権限> (<理由>)` だが、共有の `maskAuditEvent` が `a.b.c` の形の文字列を伏せるので権限の符号は `[REDACTED_JWT]` になる。権限の符号は `metadata.permission` で確かめる。

### SEC-STOCKIST-021-AC-01 権限の無い管理の要求の監査が残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-021、NFR-SEC-011（範囲外） |
| 根拠 | 認可の失敗が監査の記録に残ることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（サポーターの役割の aal2 の利用者で `PATCH /api/admin/stockists/<id>` を送り、手元の Supabase の `audit_logs` を読む。変更の要求（POST・PUT・PATCH・DELETE）には許可のオリジンの `Origin` を付ける） |
| 出どころ | 実装から推定 |

その要求が 403 になり、`audit_logs` に、その利用者の id と権限 `admin.stockists.manage` と失敗の結果を持つ行が1つ増えること。

### SEC-STOCKIST-021-AC-02 token の無い 401 は監査に行を増やさない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-021、NFR-SEC-011（範囲外） |
| 根拠 | 操作者の分からない要求を全部書くと、未ログインの連打で監査の表が洪水になるため。残す対象は操作者が分かる拒否だけに絞る（波 4 の決定 Q22） |
| 状態 | 推定 |
| 確かめ方 | E2E（token を付けない `PATCH /api/admin/stockists/<id>` を、この試験の固定の `x-real-ip` で送り、`select count(*) from audit_logs where ip = $1 and resource = 'stockists'` が 0 のままであることを見る。並列の実行では `audit_logs` 全体の件数が揺れるので全体は数えない。対照として、同じ送り元でサポーターの 403 を 1 回送ると 1 になる） |
| 出どころ | 波 4 の決定（Q22） |

その要求が 401 になり、その送り元の `audit_logs`（resource が `stockists`）の行が増えないこと。

### SEC-STOCKIST-021-AC-03 同じ操作者の拒否の監査は 10 分に 20 行まで、21 回目にまとめの 1 行

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-021、NFR-SEC-011（範囲外） |
| 根拠 | 断られる要求を数えずに全部書くと監査の表が洪水になるため、上限を置く。上限を全体でなく操作者ごとに数えるのは、ある操作者が自分で断られ続けるだけで他の人の拒否の記録が消えるのを防ぐため（DD-STOCKIST-039） |
| 状態 | 推定 |
| 確かめ方 | E2E（取扱店の権限を持たない同じ利用者の GET を 25 回送り、その利用者の `audit_logs` を結果ごとに数える。HTTP だけ）。部品の単体テストは `tests/unit/lib/auth/audit-authz-denial.test.ts` |
| 出どころ | 波 4 の決定（Q22）、設計 R11-4 の洪水の防止 |

同じ操作者の断った要求は、同じ 600 秒の区切りの中で、失敗の行が20行まで増え、21回目に `denied_burst` のまとめの行が1つ増え、22回目以降は増えないこと。別の操作者の断った要求は、その影響を受けず自分の20行まで増えること。数えに失敗した時は行を増やさず、窓口の応答は変わらないこと。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。

### DRV-STOCKIST-001 一覧は id の小さい順に並べる

| 属性 | 値 |
| --- | --- |
| 根拠 | 並びの要件が無いまま、取り出しのたびに並びが変わらないようにするため（推定）。id は登録の順なので、古くからの店が先に出る。ホームの6件もこの並びの先頭から取る |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/stockist/services/public.ts`、`src/app/api/admin/stockists/route.ts`） |

公開の一覧・ホーム・管理の一覧は、どれも id の昇順。

### DRV-STOCKIST-002 住所を Google Maps の検索へのリンクにし、別のタブで開く

| 属性 | 値 |
| --- | --- |
| 根拠 | 地図を埋め込まずに、住所から道順へすぐ移れる来店の導線を作るため（UI/UX のレビュー S-2 で足した）。別のタブで開き、元の頁へ戻りやすくする。FR-STOCKIST-007 は地図のリンクを WONT にしており、食い違う |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`、実装から推定（`src/features/stockist/components/PublicStockistGrid.tsx`） |

住所の文字を Google Maps の検索の URL（住所を URL 用に符号化して入れる）へのリンクにし、新しいタブで開く。開いた先から元の頁を触れないようにする印を付ける。

### DRV-STOCKIST-003 電話番号を押すと電話をかけられるようにし、電話の無い店は行を出さない

| 属性 | 値 |
| --- | --- |
| 根拠 | スマートフォンから店へすぐ問い合わせられるようにするため（UI/UX のレビューで足した、推定）。電話番号が空の店に空の行を出さないため |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`、実装から推定（`PublicStockistGrid.tsx`） |

電話番号の行は電話のリンクにし、リンク先には数字と + だけを残す。電話番号が空の店は電話の行を出さない。

### DRV-STOCKIST-004 640px 未満のカードでは電話・営業時間・定休日を隠す

| 属性 | 値 |
| --- | --- |
| 根拠 | モバイルではカードを短くし、店舗名と住所（地図のリンク）だけで一覧を見渡せるようにするため（推定。記録は見つからない）。FR-STOCKIST-002 の「各カードに5つの情報」と食い違う |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

640px 未満では、電話・営業時間・定休日の3行を出さない。一覧とホームの両方のカードが同じ。

### DRV-STOCKIST-005 ホームの取扱店は件数で列の数と幅を変える

| 属性 | 値 |
| --- | --- |
| 根拠 | 店が1・2件の時に広い格子の端へ寄って余白ばかりにならないよう、列を減らして中央に寄せるため（UI/UX のレビュー S-7） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`、実装から推定（`PublicStockistGrid.tsx`） |

1件は1列で狭い幅の中央、2件は 640px 以上で2列の中ほどの幅の中央、3件以上は 640px 以上で2列・1024px 以上で3列。

### DRV-STOCKIST-006 ホームの取扱店が0件の時、案内の文と VIEW COLLECTION を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 店が無い時に空の節で終わらせず、オンラインで買えることを伝えて商品の一覧へ進めるため（UI/UX のレビュー S-5） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`、実装から推定（`PublicStockistGrid.tsx`） |

「現在、取扱店舗はございません。オンラインストアにて販売中です。」と、`/item` へのボタン「VIEW COLLECTION」を出す。

### DRV-STOCKIST-007 一覧で該当の店が無い時、案内の文と「すべて見る」を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 絞り込みの結果が0件の時に行き止まりにせず、ひと押しで全部の店へ戻れるようにするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

「該当する取扱店舗がございません。」と、選んだ県を全部外すボタン「すべて見る」を出す。公開の店が0件の時も同じ表示になる。

### DRV-STOCKIST-008 選んだ県を URL の pref に残し、知らない県名は捨てる

| 属性 | 値 |
| --- | --- |
| 根拠 | 絞った状態の URL を人に送ったり、ブラウザの戻るで前の選択に戻ったりできるようにするため。URL に入れられた任意の文字で画面が乱れないよう、47都道府県の名前だけを受ける（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`）、`docs/03_BasicDesign/ui/screen-list.md` |

選んだ県は正式な名前をカンマでつないで `pref` に入れ、並びは地方の定義の順にそろえる。選択が無ければ `pref` を消す。選ぶたびに履歴を1つ足し、画面の位置は動かさない。URL の `pref` のうち47都道府県の名前でない物は無視する。

### DRV-STOCKIST-009 初めの表示では、選んだ県を含む地方だけを開く

| 属性 | 値 |
| --- | --- |
| 根拠 | URL で絞った状態から入った人に、選ばれている県がすぐ見えるようにし、ほかの地方は閉じてフィルターを短く保つため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

県が2つ以上ある地方のうち、選ばれた県を含む地方だけを初めから開く。開け閉めのボタンは、開いているかと行き先の地方の名前を読み上げに伝える。

### DRV-STOCKIST-010 モバイル・タブレットの FILTER のバーをヘッダーの真下に付けて一緒に動かす

| 属性 | 値 |
| --- | --- |
| 根拠 | スクロールしても FILTER のボタンにすぐ届くようにし、ヘッダーが隠れる時にバーが離れて隙間や重なりが出ないようにするため。NEWS の一覧（DRV-NEWS-002）と同じ形（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

1024px 未満で、FILTER のバーを画面に留め、位置はヘッダーの高さとずれの変数で決める。同じ高さの見えない置き台を一覧の頭に置き、初めの表示で先頭のカードと重ならないようにする。

### DRV-STOCKIST-011 デスクトップの左のフィルターをヘッダーの真下に留める

| 属性 | 値 |
| --- | --- |
| 根拠 | 長い一覧を下へ読んでも地方・県を選び直せるよう、左の列を画面に留めるため。NEWS の一覧（DRV-NEWS-003）と同じ形（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`PublicStockistGrid.tsx`） |

1024px 以上で、左の列をヘッダーの真下に留め、高さは画面からヘッダーを引いた分にし、はみ出す分は列の中だけで動かす。

### DRV-STOCKIST-012 カードの見出し・区切り線・詳細の間の余白を黄金比で決める

| 属性 | 値 |
| --- | --- |
| 根拠 | ブランドの見た目の決まり（黄金比の余白）をカードにも当て、ホームと一覧で同じ間合いにするため（推定）。要件の文は無く、E2E `FR-STOCKIST-009` だけがこの寸法を試す（今は赤。テスト名に付ける受け入れ条件が無いので、名前に ID は無い。「E2E と受け入れ条件の対応」を参照） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`e2e/FR-STOCKIST-009-divider-spacing.spec.ts`、コミット `f85b1d5f`、`src/styles/globals.css` の取扱店のカードの節） |

E2E が求める形: 見出しと区切り線の間・区切り線と詳細の間は見出しの文字の大きさを黄金比で割った値、詳細の行の間は本文の文字の大きさから決めた値、カードの上下の内側の余白は見出しの文字の大きさの約 1.06 倍。

### DRV-STOCKIST-013 取扱店の頁の OGP に題・説明・画像を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | SNS で頁を共有した時に、題と説明と画像のカードで出るようにするため。FR-STOCKIST-005 は title と description だけを求め、OGP は NFR-SEO-003 の決まりに合わせて足した（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/stockist/page.tsx`） |

OGP の題と説明は title・description と同じ。画像はサイトの主の写真（`/mainphoto.png`）。

### DRV-STOCKIST-014 管理で削除の前に確かめの窓を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 削除は DB から行を消して戻せないので、押し間違いで店を消さないようにするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/components/StockistSection.tsx`） |

「このSTOCKISTを削除してもよろしいですか？」の窓で受けた時だけ消す。公開の切り替え・削除に失敗した時は、知らせの窓を出す。

### DRV-STOCKIST-015 管理のフォームは5つの欄を必須にし、公開の状態の初めを非公開にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 作ったばかりの店が確かめる前に公開されないよう、初めは非公開にするため。カードの5つの情報（FR-STOCKIST-002）が欠けた店を作らないよう、全部の欄を必須にするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/admin/stockist/StockistForm.tsx`、`src/app/api/admin/stockists/route.ts`） |

画面は前後の空白を除いて空の欄があれば「必須項目を入力してください」を出して送らない。窓口も同じ5つを必須にし、長さの上限（店舗名 255・住所 500・電話 50・営業時間と定休日 120 文字）を見る。保存できたら `/admin?tab=STOCKIST` へ戻る。

## 未確認事項

- 地図のリンク: FR-STOCKIST-007（WONT）を直すか、DRV-STOCKIST-002 を要件として認めるか
- モバイルのカード: FR-STOCKIST-002（5つの情報）と DRV-STOCKIST-004（640px 未満で3行を隠す）のどちらが今の決まりか
- 管理の作成: 本番の DB の `stockists.type` が今も NOT NULL か（`select is_nullable from information_schema.columns where table_name = 'stockists' and column_name = 'type'`）。NOT NULL のままなら作成はいつも失敗し、FREQ-18-AC-01・FR-ADMIN-006-AC-02 を満たさない。移行 `stockists_type_optional` を本番に当てるまで本番では満たさない。`type` を列ごと消す案は、見本・E2E の補助・結合試験の全書き換えと本番の種別の消失を伴うので後回し
- FR-STOCKIST-010 と FREQ-57-REQ-01 の二重の定義をどちらかにまとめるか
- FREQ-13-AC-01 の「正しい店舗情報」と FREQ-18-AC-01 の「エラーが発生せず」を何で確かめるか（具体の形は FR-STOCKIST-・FR-ADMIN-006 の受け入れ条件に起こした）
- 頁の要件を FREQ-13 に、FR-ADMIN-006 を FREQ-18 につないだことの確認（`SR-STOCKIST-` を起こす案もある）
- E2E `FR-STOCKIST-009` の動き（DRV-STOCKIST-012）を要件として認めるか。認めれば `SR-STOCKIST-001` と要件・受け入れ条件を起こしてテスト名に付けられる。それまではテスト名に ID を付けず、検査は `untagged-test` に数える
- 店舗名の見出しの段（E2E と詳細設計は h2、コードと画面の決まりは h3）
- FREQ-118-AC-04・FREQ-274 の「STOCKIST は 1680px 据え置き」と、今の取扱店のコードに幅の上限が無いこと
