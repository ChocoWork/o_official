# SEARCH の要件

> 状態: 推定 | 確認日: 2026-10-24 | 対象: SEARCH（検索のページ `/search`・検索の窓口 `/api/search`・候補の窓口 `/api/suggest`・ホームの `/?q=` のプレビュー） | 基準コミット: `973dc336`（作業ツリー）

## 概要

SEARCH の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）の検索にかかる行を丸ごと写し、上位の無い要件（`FR-SEARCH-001`〜`005`）には新しい要求 `SR-SEARCH-001` を起こし、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-SEARCH-` に書いた。セキュリティ要件 `SEC-SEARCH-` は脅威の文書（`docs/05_Quality/security/threats/search.md`）の `THR-SEARCH-` から起こした。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 18 | 既存の `FREQ-` 17、新しい `SR-SEARCH-001` |
| 要件 | 35 | 既存の `FREQ-NN-REQ-NN` 30、`FR-SEARCH-001`〜`005`（うち廃止1） |
| 受け入れ条件 | 77 | 既存の `FREQ-NN-AC-NN` 45、新しい `FR-SEARCH-…-AC-NN` 8、セキュリティ要件の `SEC-SEARCH-…-AC-NN` 24 |
| 派生要件 | 10 | `DRV-SEARCH-001`〜`010` |
| セキュリティ要件 | 21 | `SEC-SEARCH-001`〜`021`（全部推定。どれも下に受け入れ条件を持つ） |

- 状態: 写した行のうち、要求の文や要件の文に理由が書かれている行は「現行」。理由が元の行に書かれておらず書き手が補った行・後の要求が一部を置き換えた行・コードと合わない行・新しく起こした項目・実装から読み取った項目は「推定」。要求の表に「廃止」と書かれた `FR-SEARCH-005` だけを「廃止」にした。どちらが正しいかは決めず、食い違いは [trace-matrix.md](../../05_Quality/reports/trace-matrix.md) の「食い違い」節に載せた
- 結論: 検索の要求は FREQ-01（商品の検索）しか無く、ルック・ニュースまで探す要求は `SR-SEARCH-001` を推定で起こした。後の要求（FREQ-191〜200）が前の要求の値を置き換えた所が多く、前の行の受け入れ条件のいくつか（FREQ-184-AC-01・02、FREQ-190-AC-01、FREQ-191-AC-01、FREQ-199-AC-01）は今は成り立たない。廃止にするかはユーザーに決めてもらう

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 写した元 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-01 の行、「1.19 検索ページ（SEARCH）」節、「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-184〜201）。元の行は消していない。別の作業が同じファイルを書き換え中で、節の中身は動きうる |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md` の要求定義表（FREQ-01）、`docs/02_Requirements/use-cases.md` の主要ユースケース（FREQ-01 の入口が検索のページ） |
| 対象のコード | `src/app/search/`、`src/app/api/search/`、`src/app/api/suggest/`、`src/features/search/` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |
| 下調べ | コードと移行を読み、`docs/05_Quality/reviews/` の過去の指摘と照らした。見つけた食い違いは [trace-matrix.md](../../05_Quality/reports/trace-matrix.md) の「食い違い」節に載せた |
| 範囲外の上位 | 全体の非機能要件（`NFR-SEC-003`・`NFR-SEC-007`・`NFR-PERF-007`・`NFR-SEO-003`・`NFR-A11Y-001`・`NFR-A11Y-002`）は誰も定義しない。根拠の文で触れるだけにした |

### 写した行と写さなかった行

写したのは、持ち主の表で SEARCH が持つ行と、持ち主の表に無く検索のページだけにかかる行（FR-SEARCH-004・005、FREQ-186〜189・191・195〜198）。

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-185（REQ-01、AC-01・02） | NEWS が定義済み（`docs/02_Requirements/areas/news.md`）。検索の設計からは上位として指すだけにする |
| FREQ-252 | NEWS が定義済み。検索の結果のサムネイルが画像を前提にする話は NEWS の項目にある |
| FREQ-194（REQ-01、AC-01・02） | ヘッダーのナビの下線の話で、持ち主は AUTH。確かめる E2E は SEARCH の `e2e/FR-SEARCH-013-underline-and-dropdown-edges.spec.ts` にある |
| FREQ-472 | 人気商品から交換の品の行を外す話で、返品の作業の物。人気商品の数え方は FREQ-186 の本文に注だけ書いた |
| FREQ-01 の1つ目の行（`requirements.md` の「要求と要件のトレーサビリティ」節） | 「ユーザーが基本機能を利用できること」は表の書き方の見本と推定（受け入れ基準 ID の形 `FREQ-AC-01-01-01` も違う）。誰も定義しない。同じ番号の2つ目の行を検索の要求として写し、番号はそのまま使った |
| WF-HOME-002・WF-COMMON-001 | ヘッダーの検索のアイコンの見取り図。ID の形が検査の種類に無いので上位に書けない。FR-SEARCH-002 の出どころで触れる |
| INT-004・INT-010・TECH-LIB-005・TECH-OPT-002 | 検索の仕組み（Meilisearch など）の技術の要件。設計判断（ADR）の退けた案の出どころにする |

### E2E と受け入れ条件の対応

`e2e/FR-SEARCH-*` のファイルが試している受け入れ条件。テスト名に ID を付ける時に使う。ファイル名の番号 006〜024 は要件の番号ではない（要件は FR-SEARCH-001〜005 だけ）。

| E2E のファイル | 受け入れ条件 |
| --- | --- |
| FR-SEARCH-001-cross-content-search | FR-SEARCH-001-AC-01・AC-02 |
| FR-SEARCH-002-search-entry-preview | FR-SEARCH-002-AC-01・AC-02 |
| FR-SEARCH-003-fulltext-highlight | FR-SEARCH-003-AC-01 |
| FR-SEARCH-004-empty-results | FR-SEARCH-004-AC-01 |
| FR-SEARCH-005-search-history | FREQ-189-AC-01・AC-02 |
| FR-SEARCH-006-two-column-redesign | FREQ-184-AC-03（LOAD MORE は固定の語で試す。8 件超は `q=Synthetic`、8 件以下は `q=Tsubame`）、FREQ-196-AC-01・02、FREQ-197-AC-01、FREQ-198-AC-02（テストの中の「AC-03」「AC-04」の注は FREQ-184 の AC-02・03 にずれている） |
| FR-SEARCH-007-thumbnail-signed-urls | FREQ-185-AC-01・02（NEWS の項目） |
| FR-SEARCH-008-popular-items-by-purchases | FREQ-186-AC-01（並びは見ない）・AC-02（購入数が無いことだけ）・AC-03 |
| FR-SEARCH-009-preview-flag-parsing | FREQ-187-AC-01〜03 |
| FR-SEARCH-010-full-height-layout | FREQ-188-AC-01・02（AC-02 は desktop 1280 だけ。tablet は FR-SEARCH-023 の FREQ-197-AC-02）、AC-03 の横スクロールも見る |
| FR-SEARCH-011-suggestions-combobox | FREQ-190-AC-01〜04（候補の高さは FREQ-192 の 40px で試す） |
| FR-SEARCH-012-compact-form-and-tab-underline | FREQ-192-AC-01〜03、FREQ-193-AC-01・02 |
| FR-SEARCH-013-underline-and-dropdown-edges | FREQ-194-AC-01・02（AUTH の項目）、FREQ-195-AC-01・02 |
| FR-SEARCH-014-tablet-desktop-parity-and-mobile-title | FREQ-197-AC-01・03、FREQ-198-AC-01〜03 |
| FR-SEARCH-015-mobile-density | FREQ-199-AC-02・AC-03（AC-01 は成り立たないので試験を置かない。FREQ-200-AC-01 を FR-SEARCH-016 で試す） |
| FR-SEARCH-016-tab-inset-and-letter-spacing | FREQ-200-AC-01〜03 |
| FR-SEARCH-017-item-meta-price | FREQ-201-AC-01〜03 |
| FR-SEARCH-018-search-page-flows | FREQ-01-AC-01、FR-SEARCH-001-AC-02・AC-03、FR-SEARCH-002-AC-02、FR-SEARCH-003-AC-02、FREQ-189-AC-02、SEC-SEARCH-011-AC-01、SEC-SEARCH-021-AC-01 |
| FR-SEARCH-019-search-api-contract-and-headers | FREQ-187-AC-01、SEC-SEARCH-004-AC-01、SEC-SEARCH-009-AC-02、SEC-SEARCH-010-AC-01、SEC-SEARCH-012-AC-01、SEC-SEARCH-014-AC-01、SEC-SEARCH-019-AC-01（HTTP だけ） |
| FR-SEARCH-020-search-db-function-grants | FREQ-186-AC-02、SEC-SEARCH-002-AC-01、SEC-SEARCH-007-AC-01、SEC-SEARCH-008-AC-01、SEC-SEARCH-009-AC-01（手元の DB の PostgREST を直接） |
| FR-SEARCH-021-search-injected-rows | SEC-SEARCH-001-AC-01・AC-02、SEC-SEARCH-003-AC-01（題に `\` を含む公開の商品を試験の中で足す）、SEC-SEARCH-013-AC-01、SEC-SEARCH-015-AC-01、SEC-SEARCH-016-AC-01 |
| FR-SEARCH-022-search-rate-limit | SEC-SEARCH-005-AC-01・AC-02、SEC-SEARCH-006-AC-01、SEC-SEARCH-017-AC-01（search_news の EXECUTE を外す）、SEC-SEARCH-020-AC-01。他の試験を壊すので、playwright.config.ts の isolated-global の project で最後に流す |
| FR-SEARCH-023-search-two-column-heading-results-header | FREQ-188-AC-03、FREQ-191-AC-02、FREQ-196-AC-01・02、FREQ-197-AC-01〜03、FREQ-198-AC-01・03 |
| FR-SEARCH-024-search-tab-rows-viewport-details | FREQ-192-AC-03、FREQ-193-AC-02、FREQ-195-AC-02、FREQ-199-AC-03、FREQ-200-AC-03、FREQ-201-AC-02 |

受け入れ条件があって範囲の E2E が無い物: 今は成り立たない FREQ-184-AC-01・02、FREQ-190-AC-01、FREQ-191-AC-01、FREQ-199-AC-01（ユーザーの判断待ち）と、サーバーの記録の中身を見る SEC-SEARCH-018-AC-01（ブラウザや HTTP から見えないので単体・結合の試験の仕事）。3つの幅で試していない E2E（001〜005・009・011、012 の1つ目、013 の FREQ-194、016 の1つ目）も残る。

## 要求

### SR-SEARCH-001 訪問者が語でサイトの商品・ルック・ニュースを横断して探せる

| 属性 | 値 |
| --- | --- |
| 根拠 | 要求の表の検索の要求は FREQ-01（商品を検索できる）だけだが、1.19 の要件（FR-SEARCH-001〜004）と今のコードはルック・ニュースも一緒に探し、見つからない時は人気商品を出す。服だけでなくルック（着こなし）やニュース（ブランドの発表）にも語でたどり着ければ、ブランドの世界観ごと見てもらえるため、FR-SEARCH-001〜005 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md` の 1.19 検索ページ、`docs/02_Requirements/stakeholder-requirements.md` の要求定義表（FREQ-01） |

訪問者（エンドカスタマー）が、ヘッダーの検索の入口から語を入れ、商品・ルック・ニュースを横断して探し、種別で切り替えて見られること。見つからない時も人気商品から次に見る物を選べること。

### FREQ-01 スマホ・PC・タブレットで商品を検索できる

| 属性 | 値 |
| --- | --- |
| 根拠 | お客様が欲しい商品の名前や語から直接たどり着けないと、一覧をたどる手間で離れてしまうため。stakeholder-requirements.md の要求定義表の最初の行で、use-cases.md も検索のページを入口にする。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節のFREQ-01 の行（同じ番号の1つ目の行は写していない） |

要求の文: エンドカスタマー（User）がスマホ、PC、タブレットで商品を検索できること

### FREQ-184 検索のページを2カラムの構成にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 参考デザインに合わせ、左に見出し・入力欄・種別の切り替え、右にサムネイル付きの結果を並べ、探す操作と結果を同時に見られるようにするため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

要求の文: searchページを参考デザインの2カラム構成（左=SEARCH見出し・下線検索フィールド・縦並び種別フィルタ、右=サムネイル付き結果リスト）に変更すること

### FREQ-186 POPULAR ITEMS を購入数の多い順にし、語が無くても出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 新着順では売れている商品が分からず、見つからなかった人への提案として弱いため、購入数の多い順に替える。語を入れる前の空の画面にも見る物を置くため、未入力でも出す。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

要求の文: searchページの POPULAR ITEMS を、ITEM の購入数が多い順に表示すること（従来の「新着（created_at 降順）」を本要件で置換）。あわせて検索語が未入力のときも POPULAR ITEMS を表示すること

### FREQ-187 preview を付けない検索がプレビュー扱いになる不具合を直す

| 属性 | 値 |
| --- | --- |
| 根拠 | 文字の 'false' も真と読む変換のせいで、通常の検索が件数3件・回数の制限20回に落ちていた。通常の検索とホームのプレビューで決めた件数と回数を効かせるため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-187 の行 |

要求の文: /api/search が preview パラメータ未指定でも常にプレビュー扱いになる不具合を解消すること（`z.coerce.boolean()` は `Boolean('false')` により文字列 'false' も true になるため、未指定時の既定値 'false' が true と解釈されていた）

### FREQ-188 検索のページを画面の縦いっぱいに出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 結果が少ない時にフッターが最初の画面に見えると、ページが途中で切れたように見えるため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

要求の文: searchページを画面の縦いっぱいに表示すること（従来はコンテンツ分の高さしか持たず、結果が少ないときにフッターがファーストビュー内に見えていた）

### FREQ-189 RECENT SEARCHES の表示を消す

| 属性 | 値 |
| --- | --- |
| 根拠 | 検索の履歴を出す要求（FR-SEARCH-005）をやめ、入力中の候補は SUGGESTIONS（FREQ-190）に任せるため。読む所の無い保存も残さない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-189 の行 |

要求の文: searchページの RECENT SEARCHES（検索履歴）の表示を削除すること（FR-SEARCH-005 の「検索履歴を localStorage に保持し再訪時にサジェスト表示する」要求を本要件で廃止）

### FREQ-190 入力中の予測候補を combobox の定石に沿って直す

| 属性 | 値 |
| --- | --- |
| 根拠 | 候補の出し方・キー操作・読み上げを WAI-ARIA 1.2 の combobox と Baymard の指針にそろえ、マウスでもキーボードでも読み上げでも候補を選べるようにするため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

要求の文: 入力中の予測候補（SUGGESTIONS）を、国際的な検索UXの定石（WAI-ARIA 1.2 combobox パターン / Baymard のオートコンプリート指針）に沿って改善すること

### FREQ-191 結果の見出しの行から「SORT BY」を消し RELEVANCE だけにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 並び順を選べないのに「SORT BY」と書くと操作できるように見えるため、語を減らした。ただし RELEVANCE を出す部分は FREQ-196 が置き換えて今は出さない（状態は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-191 の行 |

要求の文: 検索結果リストのヘッダー行から「SORT BY」ラベルを削除し、並び順の表示を「RELEVANCE」のみにすること（FREQ-184-REQ-02 / AC-02 の「SORT BY RELEVANCE」表記を本要件で置換）

### FREQ-192 フォームと候補を詰め、種別のタブの下線をヘッダーのナビにそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 入力欄と候補の縦幅が大きく間延びして見えるため詰める。種別のタブの下線の動きをヘッダーのナビと同じにし、サイトの中で触れた時の見え方を1つにするため。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

要求の文: searchページの検索フォームと予測候補の縦幅を詰め、種別フィルタ（ALL / ITEM / LOOK / NEWS）のホバー・選択時の見え方をヘッダーナビゲーションと同じ下線アニメーションに揃えること（FREQ-190-REQ-01 の候補行 44px 指定を本要件で置換）

### FREQ-193 種別のタブの下線を文字の真下にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 字間（letter-spacing）が最後の文字の右にも空きを作り、幅いっぱいの下線が文字より右へはみ出して見えたため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-193 の行 |

要求の文: 種別フィルタ（ALL / ITEM / LOOK / NEWS）の下線が文字より右へはみ出す問題を解消し、文字の真下に引かれるようにすること（letter-spacing は最後の文字の右側にも字間を作るため、幅 100% の下線がその分だけ右へ伸びていた）

### FREQ-195 候補のドロップダウンの後ろから「ALL」が覗くのを直す

| 属性 | 値 |
| --- | --- |
| 根拠 | 書体（acumin-pro）の「A」の字の形が文字の枠より約 1px 左へ出るので、候補のリストの左端と同じ位置だと外へ覗いて見えたため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-195 の行 |

要求の文: searchページで予測候補のドロップダウン表示中に、背後の種別フィルタ「ALL」の文字がリストの左端からわずかに覗く問題を解消すること（書体 acumin-pro の「A」はグリフのインクが文字ボックスより約 1px 左へ食み出すため、リスト左端と文字左端が同一 x のとき外側に露出していた）

### FREQ-196 並び順の表示（RELEVANCE）をいったん隠す

| 属性 | 値 |
| --- | --- |
| 根拠 | RELEVANCE は固定で操作もできない飾りで、並び替えの機能をどうするかが決まっていないため。後で戻せるよう、消さずに隠す |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-196 の行 |

要求の文: 検索結果リストのヘッダー右側の並び順表示（RELEVANCE）を、いったん非表示にすること（FREQ-191 の「RELEVANCE を表示する」指定を本要件で置換）。現状の表示は RELEVANCE 固定かつ操作もできない飾りであり、ソート機能の実装方針が未定のため

### FREQ-197 タブレットの見た目を PC と同じにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 768px の幅なら2カラムに十分な横幅があり、タブレットだけ縦に積むと PC との見た目がずれるため。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-197 の行 |

要求の文: searchページのタブレット表示を PC と同じ見た目にすること（FREQ-184-REQ-01 / FREQ-188-REQ-02 の「lg 以上で2カラム」指定を本要件で置換。従来 tablet は mobile と同じ縦積み1カラムだった）

### FREQ-198 モバイルで「SEARCH」の見出しを見せない

| 属性 | 値 |
| --- | --- |
| 根拠 | モバイルの狭い画面では見出しが場所を取るため、見た目からは外す。読み上げの見出しの移動からは失わせない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-198 の行 |

要求の文: searchページのモバイル表示で「SEARCH」の見出しを表示しないこと

### FREQ-199 モバイルの文字の大きさと余白を詰める

| 属性 | 値 |
| --- | --- |
| 根拠 | 参考デザインに合わせ、モバイルの狭い画面に結果を多く並べるため。要素は増減させず、md 以上は今の値を保つ。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

要求の文: searchページのモバイル表示の文字サイズと余白を参考デザインに合わせて詰めること（要素の増減は行わない。md 以上は従来の値を維持する）

### FREQ-200 モバイルの種別のタブを端から離し、字間を詰める

| 属性 | 値 |
| --- | --- |
| 根拠 | 端いっぱいに並べた先頭と末尾のタブが画面の縁に付いて窮屈に見え、字間も広すぎたため。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

要求の文: searchページの種別フィルタ（ALL / ITEM / LOOK / NEWS）のモバイル横並びで、先頭タブ（ALL）と末尾タブ（NEWS）をタブ列の左右端から内側に離し、あわせて各タブの文字の字間を詰めること

### FREQ-201 ITEM のメタの表示を価格にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 種別のカテゴリ（OUTERWEAR など）より価格の方が、買う前の比べる手掛かりになるため。商品のカード（ItemCard）と同じ書き方にそろえる。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

要求の文: search ページの ITEM 検索結果行および POPULAR ITEMS のメタ表示を、種別カテゴリ（OUTERWEAR / BOTTOMS 等）から価格に変更すること（LOOK=シーズン、NEWS=公開日 のメタは変更しない）

## 要件

### 要求の表から写した要件

文は `requirements.md` の要件の欄のまま。元の表に優先度は無い。「今のコード」は 2026-10-24 にコードを読んで分かったこと。

### FREQ-01-REQ-01 ヘッダーの虫眼鏡のアイコンから語で商品を探せる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01 |
| 根拠 | FREQ-01 の「検索できる」を、どの画面にもあるヘッダーの入口から語で探す形に決めた。どのページからでも探し始められるようにするため。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節のFREQ-01 の行 |

Userがヘッダーの虫眼鏡アイコンをクリックし、単語で商品を検索できること

今のコード: ヘッダーの検索のアイコンは `/search` へ移る（ヘッダーは AUTH の範囲）。語を入れると商品だけでなくルック・ニュースも探す（FR-SEARCH-001）。

### FREQ-01-REQ-02 ヘッダーの虫眼鏡のアイコンから語で商品を探せる（2つ目）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01 |
| 根拠 | 元の行に FREQ-01-REQ-01 と同じ文で2回目として書かれている。書き写しの誤りと推定するが、番号を消すかはユーザーに聞くため、写して残した |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節のFREQ-01 の行 |

Userがヘッダーの虫眼鏡アイコンをクリックし、単語で商品を検索できること

### FREQ-184-REQ-01 1024px 以上は黄金比の2カラムにし、左を sticky にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184 |
| 根拠 | FREQ-184 の2カラムを、38.2% / 61.8% の比で分け、左の探す操作を画面に留めて結果を読み進めても切り替えられるようにするため。ただし2カラムに切り替える幅は FREQ-197 が md（768px）へ下げた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

lg（1024px）以上は黄金比 38.2% / 61.8% の2カラムグリッドとし、左カラム（h1「SEARCH」・下線ボーダーの検索フィールド＋虫眼鏡アイコン（細線ストロークSVG）・ALL/ITEM/LOOK/NEWS の縦並びタブ。アクティブタブは下線表示）を sticky 配置し、右カラムに結果リストを表示すること。lg 未満は縦積み1カラム（見出し→検索フィールド→横並びタブ→結果リスト）とすること

今のコード: 2カラムと sticky は md 以上（`SearchPageClient.tsx`、FREQ-197）。

### FREQ-184-REQ-02 結果の見出しの行と、結果の行の作り、ALL の混ぜ方

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184 |
| 根拠 | 結果の数と1行ごとの種別・題・メタ・サムネイルを同じ形で並べ、種別をまたいでも読み比べやすくするため。ALL は種別ごとに区切らず混ぜ、どの種別も上の方に出るようにする。ただし「SORT BY RELEVANCE」は FREQ-191・196 が、ITEM のメタのカテゴリは FREQ-201 が置き換えた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

結果リスト上部に「{件数} RESULTS」と「SORT BY RELEVANCE」のヘッダー行を表示し、各結果行はサムネイル（3:4・なければ #f5f5f5 のプレースホルダー枠）・種別ラベル・タイトル（一致箇所ハイライト維持）・メタ情報（ITEM=カテゴリ、LOOK=シーズン、NEWS=公開日 YYYY.MM.DD）・右矢印（FREQ-182 と同じ細線ストロークSVG）で構成し、行間を 1px の区切り線（黒10%）で区切ること。ALL タブは種別セクション分割をやめ、item/look/news を交互に混在させた1本のリストとすること

今のコード: 見出しの行は「{件数} RESULTS」だけ（並び順の表示は隠してある）。ITEM のメタは価格。ALL は item・look・news の順に1件ずつ交互に並べる。

### FREQ-184-REQ-03 初めは8行、LOAD MORE で8行ずつ足し、条件を変えたら戻す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184 |
| 根拠 | 一度に長い一覧を出さず、見たい人だけが続きを開けるようにするため。語やタブを変えた時は新しい結果の頭から見せる。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

結果は初期 8 行まで表示し、超過分がある場合はリスト下部中央に下線スタイルの「LOAD MORE」ボタンを表示してクリックごとに 8 行ずつ追加表示すること。クエリまたはタブ変更時は表示行数を初期値に戻すこと

今のコード（推定）: 窓口が1種別あたり8件までしか返さない（FREQ-187）ので、ITEM・LOOK・NEWS のタブでは LOAD MORE が出ない。ALL でも最大24件。

### FREQ-186-REQ-01 購入数を paid の注文の数量の合計とし、公開の ITEM を多い順に返す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186 |
| 根拠 | 支払いが済んだ注文だけを「買われた」と数え、保留・失敗・取り消しで順位が動かないようにするため。売れていない商品も後ろに並べ、一覧が足りなくならないようにする。後の要求 FREQ-472（範囲外）が数え方を狭め、今の定義は `line_kind='order'` の行だけを足す（`supabase/migrations/20261013001143_order_return_receipts.sql`）ので、この行の「order_items.quantity の合計」は一部が置き換わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

購入数を「status='paid' の注文に紐づく order_items.quantity の合計」と定義し（pending / failed / cancelled は購入未成立として除外）、公開中（status='published'）の ITEM を購入数の降順、同数のときは created_at の降順で返す RPC `get_popular_items(limit_count)` を追加すること。購入実績のない ITEM も後順で返し、リストが不足しないようにすること

今のコード: 今の DB の定義は、交換の品の行も数えない（FREQ-472、返品の移行）。全部を発送した注文（状態が shipped）は数えない。移行の注は「既存の paid の注文の対象範囲は変えない」と書く。

### FREQ-186-REQ-02 RPC は service_role だけが呼び、購入数を応答に出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186 |
| 根拠 | 注文の表は RLS で本人と管理者だけに絞ってあり、商品ごとの売れ行きは外へ出さない情報のため、サーバーの service role から呼び、数そのものは返さない。関数の権限の種類が要件の文と違う点は SEC-SEARCH-009 に書いた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | 結合テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

集計元の orders / order_items は RLS で本人・管理者のみに制限されているため、RPC は SECURITY INVOKER とし、EXECUTE を service_role のみに付与（anon / authenticated からは REVOKE）して、サーバー側の service role クライアントから呼び出すこと。購入数そのものは API レスポンスに含めないこと

今のコード: EXECUTE は service_role だけ。応答の形に購入数は無い。関数の権限の種類の食い違いは SEC-SEARCH-009。

### FREQ-186-REQ-03 語が無くても検索の窓口を呼び、POPULAR ITEMS を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186 |
| 根拠 | 語を入れる前の画面にも見る物を置くため。取り出している間に案内の文を出すと、すぐ一覧に入れ替わってちらつくので出さない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

検索語が未入力（q が空）のときも検索 API を呼び出し、POPULAR ITEMS の一覧を表示すること。取得中は未入力時の案内文を表示しないこと

### FREQ-187-REQ-01 preview は文字が 'true' の時だけ真とし、件数と回数の制限を分ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-187 |
| 根拠 | 通常の検索は件数8件・120回/600秒、ホームのプレビューは件数3件・20回/600秒と、決めた値を効かせるため。正しくない値で断らず通常の検索として扱い、壊れた URL でも検索は動かす |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-187 の行 |

preview の解釈を `z.coerce.boolean()` から「文字列が 'true' のときのみ true」とする明示的な変換に変更すること。これにより通常の検索はレート制限 search:public（120回/600秒）・1種別あたり最大 8 件、プレビュー（preview=true）はレート制限 search:preview（20回/600秒）・1種別あたり最大 3 件と、本来意図された値が適用されること。不正値は 400 とせず false（通常検索）として扱うこと

### FREQ-188-REQ-01 ページの入れ物の最小の高さを画面の高さから余白を引いた値にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-188 |
| 根拠 | main の上下の余白の分だけ引いた高さにすれば、最初の画面がちょうど縦いっぱいになり、フッターが見えないため。幅ごとに余白が違うので値も幅ごとに決める |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

ページ直下のコンテナに min-height `calc(100svh - X)` を設定し、ファーストビューが画面の縦いっぱいになるようにすること。X は main の上下マージン（52/54/56/58/60px）＋上下パディング（0/4/8/12px）の合計とし、6.5rem / sm 7.25rem / md 8rem / lg 8.75rem / xl 9rem をブレークポイントごとに適用すること

### FREQ-188-REQ-02 左のカラムをヘッダーの下に画面の高さで留め、中身を縦の中央に置く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-188 |
| 根拠 | 縦いっぱいの画面で左の操作が上に寄ると下が空いて見えるため、縦の中央に置く。ただし対象の幅は FREQ-197 が lg から md に下げた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

lg 以上では左カラム（SEARCH 見出し・検索フィールド・種別フィルタ）をヘッダー下（top 3.5rem）にビューポート高（min-height `calc(100svh - 3.5rem)`）で sticky 配置し、内容を縦中央（justify-center）に置くこと。lg 未満は従来どおり縦積みで上から並べること

今のコード: md 以上で sticky・縦の中央（FREQ-197）。

### FREQ-189-REQ-01 RECENT SEARCHES の表示と search.history の保存・読み出しを外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-189 |
| 根拠 | 表示をやめると、利用者の端末に残す検索の履歴を読む所が無くなるため、保存も一緒に外す。使わない履歴を端末に残さない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-189 の行 |

検索フィールド下の RECENT SEARCHES 見出しと履歴候補の表示を撤去し、表示の唯一の利用先であった `localStorage` の `search.history` への保存・読み出しも合わせて撤去すること（読み手のいない保存を残さない）

### FREQ-190-REQ-01 候補を入力欄の下に重ねて出し、一致を描き分け、最大8件にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190 |
| 根拠 | 候補が種別のタブを押し下げると画面が動いて押し間違えるため、重ねて出す。どこが一致したか・どの種別かが一目で分かるようにし、選ぶ数を8件に抑えて迷わせないため。ただし行の高さ 44px は FREQ-192 が 40px に置き換えた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

候補を入力欄直下のドロップダウン（オーバーレイ）として表示し、下部の種別フィルタを押し下げないこと。各候補は「ラベル（入力語との一致箇所を黒・font-medium、それ以外を Graphite Grey #474747 で描き分ける）」と「右端の種別ラベル（ITEM / LOOK / NEWS）」で構成し、行の最小高さを 44px（タッチターゲット下限）とすること。表示件数は最大 8 件とすること

### FREQ-190-REQ-02 combobox の ARIA とキー操作、選択の縦線、件数の読み上げ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190 |
| 根拠 | キーボードと読み上げだけで候補を選べるようにするため（WAI-ARIA 1.2 の combobox）。選んだ行を色だけで示すと色が分からない人に伝わらないので、縦の線も付ける。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

入力欄を `role="combobox"`・`aria-expanded`・`aria-controls`・`aria-autocomplete="list"`・`aria-activedescendant` とし、候補リストを `role="listbox"`、各候補を `role="option"`・`aria-selected` とすること。↓／↑ で候補を巡回選択（端で反対側へループ）、Enter で選択中の候補を確定、未選択のまま Enter は入力語で検索、Escape で閉じることができること。候補の選択状態は背景色に加えて黒 2px の縦線でも示し、色以外の手掛かりを与えること。候補件数を `aria-live` で通知すること

### FREQ-190-REQ-03 ラベルに入力語を含む候補だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190 |
| 根拠 | 説明や本文だけに一致した候補はラベルに一致が見えず、なぜ出たのか利用者に分からないため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

サジェストは入力語がラベル自体に含まれる候補のみを返すこと（説明文・本文・カテゴリだけに一致した候補は、ラベル上で一致箇所を示せず候補理由が不明なため除外する）

### FREQ-191-REQ-01 並び順の表示から「SORT BY」を消し、RELEVANCE とシェブロンだけにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-191 |
| 根拠 | 操作できない並び順を「SORT BY」と書いて選べるように見せないため。ただし RELEVANCE とシェブロンを出す部分は FREQ-196 が置き換え、今は並び順の表示ごと隠してある（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-191 の行 |

ヘッダー右側の並び順表示から「SORT BY」の語を削除し、「RELEVANCE」とシェブロンアイコンのみを表示すること。左側の「{件数} RESULTS」表示は変更しないこと

### FREQ-192-REQ-01 入力欄・送信のボタン・候補の行の高さを詰める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-192 |
| 根拠 | 間延びを減らしつつ、40px なら WCAG 2.2 の 2.5.8（最小 24px）を十分に上回り、押しやすさを損なわないため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

検索フォームの入力欄の上下パディングを 0.625rem から 0.5rem、送信ボタンを 44px 角から 40px 角に縮め、予測候補の行の最小高さを 44px から 40px に詰めること。40px は WCAG 2.2 の達成基準 2.5.8 Target Size (Minimum) が求める 24px を十分に上回るため、操作性を損なわない範囲の圧縮とすること

### FREQ-192-REQ-02 種別のタブの下線をヘッダーのナビと同じ伸びる線にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-192 |
| 根拠 | ヘッダーのナビと同じ共通の線の動き（左から 300ms で伸びる 1px）を使い、サイトの中で触れた時の見え方を1つにするため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

種別フィルタの下線を、従来の常時表示のボーダー（選択時のみ黒・非選択時は透明）から、ヘッダーナビゲーションと同一のクラス `underline-animation-left2right`（要素下端に絶対配置した高さ 1px の黒帯を `origin-left` で 300ms かけて水平方向にスケールさせる）に統一すること。選択中は `scale-x-100` で常時表示、非選択時は `scale-x-0` とし親の `group-hover` で `scale-x-100` へ伸ばすこと。文字色は非選択 #474747、選択時およびホバー時は黒を維持すること

### FREQ-193-REQ-01 下線の幅から末尾の字間の分を引く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-193 |
| 根拠 | 下線の幅から字間と同じ値を引けば、最後の文字の右の空きの分だけはみ出さなくなるため。ただし引く値は FREQ-200 が字間を詰めた時に 0.2em から 0.1em に置き換えた（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-193 の行 |

下線の幅を `100%` から `calc(100% - 0.2em)`（タブの tracking と同値）に変更し、末尾の字間分を差し引くこと。下線の開始位置（左端）・太さ・色・アニメーションは変更しないこと

### FREQ-195-REQ-01 候補のドロップダウンを左右に 1px ずつ広げる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-195 |
| 根拠 | 1px 広げれば後ろの「A」の出っ張りを覆え、入力欄との左端のずれも小さく済むため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-195 の行 |

候補ドロップダウンの水平位置を `left: 0 / right: 0` から `left: -1px / right: -1px` に変更し、左右へ 1px ずつ広げて背後の文字を覆うこと。幅の変更は 1px に留め、入力欄との左端の見た目のズレを最小限にすること

### FREQ-196-REQ-01 並び順の表示を消さずにコメントにして残す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-196 |
| 根拠 | 並び替えの機能を作る時にすぐ戻せるようにするため、消さずに残す。この表示だけで使っていたアイコンと文字の大きさの定義も一緒に止め、使わない定義を生かしたままにしない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-196 の行 |

並び順表示のブロックをコードから削除せずコメントアウトし、ソート機能を実装する際に復帰できる状態で残すこと。あわせてこの表示専用だったシェブロンアイコン定義とフォントサイズ指定もコメントアウトし、未使用の定義を残さないこと。左側の「{件数} RESULTS」表示は従来どおり維持すること

今のコード（推定）: 見出しの行の部品は並び順を出すかの値を受け取るが使っていない。

### FREQ-197-REQ-01 2カラムにする幅を md（768px）に下げる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-197 |
| 根拠 | タブレットを PC と同じ見た目にするため、2カラム・sticky・縦の中央・タブの縦並びを全部 md から効かせる。最小の高さの値は main の余白に合わせた物なので変えない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-197 の行 |

2カラム化のブレークポイントを lg（1024px）から md（768px）へ引き下げること。対象は、黄金比 38.2% / 61.8% のグリッド・列間・上下パディング、左カラムのヘッダー下 sticky（top 3.5rem・min-height `calc(100svh - 3.5rem)`）と内容の縦中央寄せ、種別フィルタの縦並び。min-height のブレークポイント別の値（6.5 / 7.25 / 8 / 8.75 / 9rem）は main の余白に対応するものであり変更しないこと

### FREQ-198-REQ-01 見出しを md 未満で sr-only にし、DOM には残す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-198 |
| 根拠 | h1 はページの構造に要り、読み上げの見出しの移動からも失わせないため、消さずに見た目だけ隠す。sr-only は絶対位置なので、並びの間隔の空きも残らない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-198 の行 |

見出しは DOM から削除せず、md 未満で `sr-only`、md 以上で `not-sr-only` とし、視覚的にのみ隠すこと。h1 はページの文書構造として必要で、スクリーンリーダーの見出しナビゲーションからも失わせないため。`sr-only` は position absolute のため、フレックスの gap による余白も残らないこと

### FREQ-199-REQ-01 モバイルの種別のタブを全幅に均等に並べる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199 |
| 根拠 | 参考デザインに合わせ、4つのタブを横幅いっぱいに散らして押しやすくするため。md 以上の縦並びは変えない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

モバイルの種別フィルタ（ALL / ITEM / LOOK / NEWS）を左寄せの固定間隔から全幅への均等配置（justify-between）に変更すること。md 以上は従来どおり左寄せの縦並びとすること

### FREQ-199-REQ-02 モバイルの文字の大きさを LiftKit の段で1段ずつ下げる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199 |
| 根拠 | モバイルの狭い幅で結果の行を詰めて多く見せるため。入力欄とタブの文字は押しやすさのため変えない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

モバイルの文字サイズを LiftKit スケールで1段階ずつ下げること。結果行の種別ラベルを 2xs→3xs、タイトルを md→sm、メタ情報を xs→2xs、結果ヘッダー（{件数} RESULTS / POPULAR ITEMS）と LOAD MORE を xs→2xs とすること。検索フィールドと種別フィルタの文字サイズ（md）は変更しないこと。md 以上は従来のサイズを維持すること

### FREQ-199-REQ-03 モバイルの余白を詰める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199 |
| 根拠 | モバイルの最初の画面に結果を多く入れるため。md 以上の値は変えない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

モバイルの余白を詰めること。左カラム内の間隔を 2rem→1.5rem、左カラムと結果リストの間隔を 2.5rem→2rem、結果行の上下パディングを 1rem→0.75rem とすること。md 以上は従来の値を維持すること

### FREQ-200-REQ-01 モバイルのタブの列に左右の内側の余白を足す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-200 |
| 根拠 | 先頭と末尾のタブを画面の縁から離し、窮屈に見えないようにするため。md 以上の縦並びは余白を 0 に戻す。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

モバイルの横並びタブ列に左右パディング（px-4）を追加し、先頭タブの左端をタブ列の左端より内側、末尾タブの右端をタブ列の右端より内側に配置すること。md 以上の縦並びはパディングを 0 に戻し従来どおりとすること（FREQ-199-REQ-01 / AC-01 の「先頭タブの左端がタブ列の左端、末尾タブの右端がタブ列の右端に一致」を本要件で置換）

### FREQ-200-REQ-02 タブの字間を tracking-widest に詰め、下線の引く値を合わせる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-200 |
| 根拠 | 字間を詰めると末尾の空きも 0.1em に変わるので、下線の幅から引く値も同じにして文字の真下にそろえるため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

各タブのラベルの字間を tracking-[0.2em] から tracking-widest へ縮小すること。下線が末尾字間分だけ右へはみ出さないよう、下線幅を calc(100%-0.2em) から calc(100%-0.1em)（tracking と同値）へ合わせること（FREQ-193-REQ-01 の 0.2em 差し引きを本要件で置換）

### FREQ-201-REQ-01 ITEM の行のメタを「¥」とカンマ区切りの価格にし、RPC に price を足す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-201 |
| 根拠 | 商品のカードと同じ価格の書き方にそろえるため。価格を出すには RPC の返す列に定価が要る。定価は公開の商品の値で集計値ではないので、search_items は今までどおり anon・authenticated が呼べてよい |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

ITEM 行のメタを ItemCard と同一の「¥{ja-JP カンマ区切り}」形式（例: ¥49,800）の価格表示にすること。価格取得のため search_items / get_popular_items RPC の返却に price 列（items.price）を追加すること（migration 061。RETURNS TABLE の変更のため DROP + CREATE で再作成し、従来の EXECUTE 権限を維持する）。price は集計値ではなく公開 ITEM の定価であり、search_items は従来どおり anon / authenticated から実行可能とする

### FREQ-201-REQ-02 検索の応答の ITEM の meta を価格の文字にし、購入数は出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-201 |
| 根拠 | 画面が受け取った meta をそのまま出すので、窓口の側で価格の文字にしておくため。購入数は FREQ-186 のとおり外へ出さない。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

/api/search のレスポンスで ITEM（items / popularItems）の meta が価格文字列であること。購入数（purchase_count）は従来どおりレスポンスに含めないこと

### 検索ページの要件

文は `requirements.md` の 1.19 のまま。「今のコード」は 2026-10-24 にコードを読んで分かったこと。

### FR-SEARCH-001 /search?q= で語を URL から受け、3種を横断して探し、種別のタブで切り替える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01、SR-SEARCH-001 |
| 根拠 | 語と種別を URL に持たせれば、結果のページを共有したり、戻る・再読み込みで同じ結果に戻れるため。商品・ルック・ニュースを1つの入口で探せれば、どこにあるかを知らなくてもたどり着ける（SR-SEARCH-001）。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.19 検索ページ（SEARCH）」節のFR-SEARCH-001 の行 |

`/search?q=` ページは入力キーワードを URL パラメータとして受け取り、商品・ルック・ニュースを横断して検索し、種別タブで結果を切り替えられるようにする。

今のコード: タブは ALL・ITEM・LOOK・NEWS。語とタブを URL の `q`・`tab` に書く（DRV-SEARCH-004）。窓口は `tab` で結果を絞らず3種を全部返し、画面がタブに合わせて出し分ける。

### FR-SEARCH-002 ヘッダーの検索のアイコンから検索のページへ移り、/?q= でホームにプレビューを出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01、SR-SEARCH-001 |
| 根拠 | どのページからでもヘッダーから探し始められるようにするため（ヘッダーの見取り図 WF-HOME-002・WF-COMMON-001 も検索のアイコンを置く）。ホームの `/?q=` では、ページを移らずに結果の一部を先に見せる。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md`（付録 D のワイヤーフレーム WF-HOME-002・WF-COMMON-001 を含む） |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.19 検索ページ（SEARCH）」節のFR-SEARCH-002 の行 |

ヘッダーの検索アイコンから検索ページへ遷移でき、`/?q=` ではホーム上で即時プレビューを表示する。

今のコード: ヘッダーのアイコンは `/search` へ移る（ヘッダーは AUTH の範囲）。ホームのプレビューの部品は HOME の頁が描く。画面の中に `/?q=` へ移る導線は無く、URL を直接開いた時だけ出る（推定）。旧版の詳細設計（`git show 40acae8a:docs/04_DetailDesign/pages/19_search.md` の機能要件対応表）は「検索モーダル」と書いたが、モーダルは無い（今の `19_search.md` の「旧版から引き継がなかった節」に残す）。

### FR-SEARCH-003 3種への検索と、結果の中の一致の強調

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01、SR-SEARCH-001 |
| 根拠 | 結果のどこが語に合ったかが見えれば、並んだ行から目当ての物を早く見分けられるため。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.19 検索ページ（SEARCH）」節のFR-SEARCH-003 の行 |

商品・ルック・ニュース各エンティティへの検索と、結果内の一致箇所ハイライトを提供する。

今のコード: DB の関数が公開済みの行だけを語の部分一致（大文字と小文字を区別しない）で探す。全文検索ではない。強調は結果の行の題の中だけで、説明の文は検索のページの行に出さない（ホームのプレビューには出す）。

### FR-SEARCH-004 0件の時は「○○ の検索結果はありません」と人気商品を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01、SR-SEARCH-001 |
| 根拠 | 何も出ない画面で終わると利用者が離れてしまうため、見つからなかったことをはっきり伝え、次に見る商品を差し出す。この理由は元の行に書かれておらず、書き手が補った（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.19 検索ページ（SEARCH）」節のFR-SEARCH-004 の行 |

検索結果ゼロの場合は「○○ の検索結果はありません」メッセージと人気商品の提案を表示する。

今のコード: 文は「「<語>」の検索結果はありません」と「別のキーワードをお試しください。人気商品もあわせてご覧いただけます。」。人気商品は購入数の順に4件（FREQ-186、DRV-SEARCH-005）。失敗の時の扱いは SEC-SEARCH-017（DRV-SEARCH-003）。

### FR-SEARCH-005 検索の履歴を localStorage に残し、再訪の時に候補に出す（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | SR-SEARCH-001 |
| 根拠 | 入力中の候補は SUGGESTIONS（FREQ-190）が受け持つことになり、履歴の表示と保存は FREQ-189 でやめた。番号を使い回さないため廃止で残す |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST（取り消し線付き） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.19 検索ページ（SEARCH）」節のFR-SEARCH-005 の行 |

~~検索履歴を `localStorage` に保持し、再訪時にサジェストとして表示する。~~ FREQ-189 により廃止。

## 受け入れ条件

### 要求の表から写した受け入れ条件

### FREQ-01-AC-01 商品の検索でエラーが出ず、関連する商品が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-01-REQ-01、FREQ-01-REQ-02 |
| 根拠 | FREQ-01-REQ-01（と同じ文の REQ-02）を、語で探して商品が出ることで確かめる。元の行に同じ ID が2回書かれているので1つにまとめた。まとめた理由は元の文書に書かれておらず、書き手の判断（推定）。何を「関連」とするかは書かれていない（未確認事項） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節のFREQ-01 の行 |

商品検索でエラーが発生せず、関連商品が表示されること

### FREQ-184-AC-01 1280px で左右の2カラム、390・768px で縦積みになり横にはみ出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184-REQ-01 |
| 根拠 | FREQ-184-REQ-01 の並びを、3つの幅のカラムの位置で確かめる。ただし tablet（768px）は FREQ-197 で2カラムになり、この文の tablet の部分は今は成り立たない（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

desktop（1280px）で SEARCH 見出し・検索フィールド・縦並びタブの左カラムと結果リストの右カラムが横並びに表示されること。mobile（390px）/ tablet（768px）では縦積み1カラムとなり、横スクロールが発生しないこと

### FREQ-184-AC-02 「N RESULTS」「SORT BY」「RELEVANCE」と、行の種別・題・サムネイル・矢印が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184-REQ-02 |
| 根拠 | FREQ-184-REQ-02 の見出しの行と結果の行の作りを、出る要素で確かめる。ただし「SORT BY」「RELEVANCE」は FREQ-191・196 で今は出ず、その部分は成り立たない（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

検索結果表示時に「N RESULTS」と「SORT BY」「RELEVANCE」が表示され、各結果行に種別ラベル・タイトル・サムネイル枠・矢印 SVG が表示されること

### FREQ-184-AC-03 8件を超える時だけ LOAD MORE が出て、押すと行が増える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-184-REQ-03 |
| 根拠 | FREQ-184-REQ-03 の8行ずつの出し方を、LOAD MORE の有無と押した後の行の数で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-184 の行 |

結果が 8 件を超える場合に LOAD MORE が表示され、クリックで表示行数が増えること。8 件以下の場合は LOAD MORE が表示されないこと

### FREQ-186-AC-01 RPC が paid の数量の合計の順に返し、popularItems は公開の ITEM だけ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186-REQ-01 |
| 根拠 | FREQ-186-REQ-01 の数え方と並びを RPC の定義で、公開の物だけであることを窓口の応答で確かめる。購入数は応答に出ないので、並びは画面からは確かめられない。後の要求 FREQ-472（範囲外）で今の定義は `line_kind='order'` の行だけを足すので、「quantity 合計」の文は一部が置き換わった |
| 状態 | 推定 |
| 確かめ方 | 結合テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

RPC 定義が「status='paid' の order_items.quantity 合計」を購入数とし、公開 ITEM を購入数 降順・created_at 降順（購入実績のない ITEM も LEFT JOIN で保持）で返すこと。かつ /api/search の popularItems が公開中の ITEM のみで構成されること（購入数は API に出さないため、並び順は RPC 定義側で検証する）

### FREQ-186-AC-02 anon・authenticated に EXECUTE が無く、応答に purchase_count が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186-REQ-02 |
| 根拠 | FREQ-186-REQ-02 の呼べる者の絞りと購入数を出さないことを、DB の権限と応答の形で確かめる。今の E2E は応答の側だけを見る |
| 状態 | 現行 |
| 確かめ方 | 結合テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

anon / authenticated ロールに RPC の EXECUTE 権限が付与されていないこと。/api/search のレスポンスに購入数（purchase_count）が含まれないこと

### FREQ-186-AC-03 3つの幅で語なしの /search に POPULAR ITEMS と ITEM の行が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186-REQ-03 |
| 根拠 | FREQ-186-REQ-03 の「未入力でも出す」を、語なしで開いた画面で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-186 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で /search を検索語なしに開いたとき、POPULAR ITEMS の見出しと ITEM 行が表示されること

### FREQ-187-AC-01 preview を付けない検索は1種別で3件を超えて返り得る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-187-REQ-01 |
| 根拠 | FREQ-187-REQ-01 の通常の検索の上限が 3 でなく 8 であることを、返る件数で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-187 の行 |

preview を指定しない /api/search で、いずれかの種別が 3 件を超えて返り得ること（1種別あたりの上限が 3 ではなく 8 であること）

### FREQ-187-AC-02 preview=true の検索は各種別3件以下

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-187-REQ-01 |
| 根拠 | FREQ-187-REQ-01 のプレビューの上限を、返る件数で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-187 の行 |

preview=true の /api/search では各種別の件数が 3 件以下であること

### FREQ-187-AC-03 preview を付けない検索を20回続けても 429 にならない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-187-REQ-01 |
| 根拠 | FREQ-187-REQ-01 の回数の制限の数え口が search:public であることを、プレビューの上限（20回）を超えても断られないことで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-187 の行 |

preview 未指定のリクエストがレート制限 search:preview（20回/600秒）ではなく search:public（120回/600秒）で計上されること（20回連続で呼び出しても 429 とならないこと）

### FREQ-188-AC-01 3つの幅でフッターが最初の画面に出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-188-REQ-01 |
| 根拠 | FREQ-188-REQ-01 の縦いっぱいを、フッターの上端が画面の高さより下にあることで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

mobile（390×844）/ tablet（768×1024）/ desktop（1280×800）で /search を開いたとき、フッターがファーストビュー内に表示されないこと（フッター上端がビューポート高以上であること）

### FREQ-188-AC-02 1280px で左のカラムの中身が縦の中央寄りにある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-188-REQ-02 |
| 根拠 | FREQ-188-REQ-02 の縦の中央を、見出しの上と種別のタブの下の両方に余白があることで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

desktop（1280×800）で左カラムの見出し上端と種別フィルタ下端の双方に余白があり、内容が縦方向の中央寄りに配置されていること（見出し上端 > ビューポート高の 10%、フィルタ下端 < ビューポート高の 95%）

### FREQ-188-AC-03 3つの幅で横にはみ出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-188-REQ-01、FREQ-188-REQ-02 |
| 根拠 | 高さを足しても横の幅が崩れていないことを、横のスクロールが出ないことで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-188 の行 |

同3ビューポートで横スクロールが発生しないこと

### FREQ-189-AC-01 語なしで入力欄に触れても RECENT SEARCHES が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-189-REQ-01 |
| 根拠 | FREQ-189-REQ-01 の表示を外したことを、履歴が出ていた場面（未入力で入力欄に触れた時）で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-189 の行 |

検索語が未入力の状態で検索フィールドをフォーカスしても RECENT SEARCHES が表示されないこと

### FREQ-189-AC-02 検索しても localStorage に search.history が残らない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-189-REQ-01 |
| 根拠 | FREQ-189-REQ-01 の保存を外したことを、検索の後の端末の保存で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-189 の行 |

検索を実行しても `localStorage` に `search.history` が保存されないこと

### FREQ-190-AC-01 入力すると種別付きの候補が最大8件、行の高さ 44px 以上で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190-REQ-01 |
| 根拠 | FREQ-190-REQ-01 の候補の出し方を、種別のラベル・行の高さ・件数で確かめる。ただし行の高さは FREQ-192 で 40px 以上 44px 未満になり、44px 以上の部分は今は成り立たない（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

入力時に候補ドロップダウンが表示され、各候補に種別ラベルが表示されること。候補行の高さが 44px 以上で、候補が最大 8 件であること

### FREQ-190-AC-02 combobox の ARIA が付き、↓ と Escape で状態が変わる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190-REQ-02 |
| 根拠 | FREQ-190-REQ-02 の ARIA とキー操作を、属性の値の変わり方で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

入力欄に `role="combobox"` と `aria-expanded="true"`・`aria-controls` が設定され、↓ キーで `aria-activedescendant` が候補 ID を指し、当該候補の `aria-selected` が true になること。Escape で閉じ `aria-expanded` が false になること

### FREQ-190-AC-03 選んだ候補を Enter かクリックで確定すると、URL の q と tab が候補に合う

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190-REQ-02 |
| 根拠 | FREQ-190-REQ-02 の確定の操作を、確定の後の URL で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

↓ で候補を選び Enter を押すと、その候補の語と種別で検索が実行されること（URL の q と tab が候補に一致すること）。候補のクリックでも同様に確定すること

### FREQ-190-AC-04 出る候補のラベルが全部入力語を含む

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-190-REQ-03 |
| 根拠 | FREQ-190-REQ-03 の絞りを、出た候補のラベルで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-190 の行 |

表示される全候補のラベルに入力語が含まれていること

### FREQ-191-AC-01 RELEVANCE が出て、SORT BY が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-191-REQ-01 |
| 根拠 | FREQ-191-REQ-01 の表示の形を、出る語で確かめる。ただし FREQ-196 で RELEVANCE を隠したので「RELEVANCE が出る」は今は成り立たない（状態は推定。廃止にするかはユーザーに聞く） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-191 の行 |

検索結果表示時に「RELEVANCE」が表示され、「SORT BY」が表示されないこと

### FREQ-191-AC-02 「{件数} RESULTS」が今までどおり出る（FREQ-191）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-191-REQ-01 |
| 根拠 | FREQ-191-REQ-01 が左の件数の表示を変えないことを、件数の表示が残っていることで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-191 の行 |

「{件数} RESULTS」の表示は従来どおり維持されること

### FREQ-192-AC-01 フォームの高さが 36px 以上 44px 未満、候補の行が 40px 以上 44px 未満

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-192-REQ-01 |
| 根拠 | FREQ-192-REQ-01 の詰め方を、フォームと候補の行の高さの幅で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

検索フォームの高さが 44px 未満かつ 36px 以上であること。予測候補の各行の高さが 40px 以上 44px 未満であること

### FREQ-192-AC-02 タブの下線が共通の線のクラスを持ち、高さ 1px・黒・0.3s

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-192-REQ-02 |
| 根拠 | FREQ-192-REQ-02 のヘッダーと同じ線を使っていることを、クラスと算出の値で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

各タブの下線要素が `underline-animation-left2right` クラスを持ち、高さ 1px・黒・トランジション時間 0.3s であること

### FREQ-192-AC-03 選んだタブの下線の横の伸びが 1、ほかは 0 で、触れると 1 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-192-REQ-02 |
| 根拠 | FREQ-192-REQ-02 の選択とホバーの時の見え方を、下線の横の伸びの値で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-192 の行 |

選択中タブの下線の水平スケールが 1、非選択タブは 0 であり、非選択タブをホバーすると 1 に変化すること

### FREQ-193-AC-01 3つの幅でタブの下線の右端が最後の文字の右端と 1px 以内

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-193-REQ-01 |
| 根拠 | FREQ-193-REQ-01 のはみ出しが無くなったことを、下線の右端と字の形の右端の差で確かめる。引く値が 0.1em に変わっても（FREQ-200）この条件は成り立つ |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-193 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、各タブの下線の右端と最後の文字のグリフ右端との差が 1px 以内であること

### FREQ-193-AC-02 3つの幅でタブの下線の左端が最初の文字の左端と 1px 以内

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-193-REQ-01 |
| 根拠 | FREQ-193-REQ-01 が下線の始まりの位置を変えないことを、左端の差で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-193 の行 |

同3ビューポートで、各タブの下線の左端と最初の文字の左端との差が 1px 以内であること

### FREQ-195-AC-01 3つの幅で候補のドロップダウンの左端が「ALL」の字の形の左端以下

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-195-REQ-01 |
| 根拠 | FREQ-195-REQ-01 で後ろの字を覆えたことを、ドロップダウンの左端と字の形の左端の位置で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-195 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、候補ドロップダウンの左端が「ALL」のグリフのインク左端（文字ボックス左端 − actualBoundingBoxLeft）以下であること

### FREQ-195-AC-02 3つの幅で横にはみ出さない（FREQ-195）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-195-REQ-01 |
| 根拠 | FREQ-195-REQ-01 で広げた 1px がページの横の幅を崩していないことを確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-195 の行 |

同3ビューポートで横スクロールが発生しないこと

### FREQ-196-AC-01 結果を出した時に RELEVANCE が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-196-REQ-01 |
| 根拠 | FREQ-196-REQ-01 で並び順の表示を隠したことを、画面に RELEVANCE が無いことで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-196 の行 |

検索結果表示時に「RELEVANCE」が表示されないこと

### FREQ-196-AC-02 「{件数} RESULTS」が今までどおり出る（FREQ-196）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-196-REQ-01 |
| 根拠 | FREQ-196-REQ-01 が左の件数の表示を残すことを確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-196 の行 |

「{件数} RESULTS」の表示は従来どおり維持されること

### FREQ-197-AC-01 768px で2カラムになり、タブが縦に並び、左が sticky

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-197-REQ-01 |
| 根拠 | FREQ-197-REQ-01 の幅の引き下げを、タブレットの並びと位置の値で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-197 の行 |

tablet（768×1024）で検索フィールドと結果ヘッダーが横並びの2カラムになり、種別フィルタが縦並びで表示されること。左カラムの position が sticky であること

### FREQ-197-AC-02 768px で左のカラムの中身が縦の中央寄りにある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-197-REQ-01 |
| 根拠 | FREQ-197-REQ-01 で縦の中央もタブレットに効いていることを、上下の余白で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-197 の行 |

tablet で左カラムの内容が縦中央寄りに配置されること（見出し上端 > ビューポート高の 10%、最後のフィルタ下端 < ビューポート高の 95%）

### FREQ-197-AC-03 390px は縦積み・タブ横並びのままで、どの幅も横にはみ出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-197-REQ-01 |
| 根拠 | FREQ-197-REQ-01 がモバイルの形を変えないことと、幅の崩れが無いことを確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-197 の行 |

mobile（390×844）は従来どおり縦積み1カラム・種別フィルタ横並びであり、各ビューポートで横スクロールが発生しないこと

### FREQ-198-AC-01 390px で h1 の描かれる高さが 1px 以下

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-198-REQ-01 |
| 根拠 | FREQ-198-REQ-01 の見た目だけ隠すことを、モバイルの h1 の高さで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-198 の行 |

mobile（390×844）で h1 の描画高さが 1px 以下であること（視覚的に表示されない）

### FREQ-198-AC-02 390px でも h1 が DOM にあり「SEARCH」の字を持つ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-198-REQ-01 |
| 根拠 | FREQ-198-REQ-01 が見出しを消さないことを、要素と字が残っていることで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-198 の行 |

mobile でも h1 要素自体は存在し、テキスト「SEARCH」を保持していること

### FREQ-198-AC-03 768・1280px で h1 が今までどおり見える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-198-REQ-01 |
| 根拠 | FREQ-198-REQ-01 が md 以上の見出しを変えないことを、描かれる高さで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-198 の行 |

tablet（768×1024）/ desktop（1280×800）では h1 が従来どおり表示されること（描画高さが 20px 以上）

### FREQ-199-AC-01 390px で4つのタブが横一列で、先頭と末尾がタブの列の端に合う

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199-REQ-01 |
| 根拠 | FREQ-199-REQ-01 の均等の並びを、タブの端の位置で確かめる。ただし「端に一致」は FREQ-200 が内側に離す形に置き換え、今は成り立たない（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

mobile（390×844）で 4 つのタブが横一列に並び、先頭タブの左端がタブ列の左端、末尾タブの右端がタブ列の右端に一致すること

### FREQ-199-AC-02 390px で結果の行の文字が 768・1280px より小さく、大小の順が保たれる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199-REQ-02 |
| 根拠 | FREQ-199-REQ-02 の1段ずつ下げたことを、ほかの幅と比べた算出の文字の大きさで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

mobile で結果行のタイトル・メタ・種別ラベルの算出 font-size が、それぞれ tablet / desktop の同要素より小さいこと。かつ大小関係がタイトル > メタ ≧ 種別ラベルの順であること

### FREQ-199-AC-03 390px の結果の行が 768・1280px より低く、どの幅も横にはみ出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-199-REQ-03 |
| 根拠 | FREQ-199-REQ-03 の余白を詰めたことを、結果の行の高さで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-199 の行 |

mobile の結果行の高さが tablet / desktop の同要素より小さいこと。各ビューポートで横スクロールが発生しないこと

### FREQ-200-AC-01 390px で先頭と末尾のタブがタブの列の端より 8px 以上内側にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-200-REQ-01 |
| 根拠 | FREQ-200-REQ-01 の内側の余白を、タブの端と列の端の差で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

mobile（390×844）で先頭タブの左端がタブ列の左端より内側にあり（差が 8px 以上）、末尾タブの右端がタブ列の右端より内側にあること（差が 8px 以上）。かつ横スクロールが発生しないこと

### FREQ-200-AC-02 3つの幅でタブの字間が文字の大きさの 0.1 倍

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-200-REQ-02 |
| 根拠 | FREQ-200-REQ-02 の字間を、算出の letter-spacing と文字の大きさの比で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、各タブの算出 letter-spacing が font-size の 0.1 倍（±0.5px）であること

### FREQ-200-AC-03 3つの幅で下線の両端が文字の両端と 1px 以内

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-200-REQ-02 |
| 根拠 | FREQ-200-REQ-02 で下線の引く値を合わせたことを、下線と字の形の両端の差で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-200 の行 |

同3ビューポートで、各タブの下線の右端と最後の文字のグリフ右端との差が 1px 以内、左端と最初の文字の左端との差が 1px 以内であること

### FREQ-201-AC-01 3つの幅で ITEM の行のメタが「¥」で始まる価格で、カテゴリ名でない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-201-REQ-01 |
| 根拠 | FREQ-201-REQ-01 の価格の表示を、画面の ITEM の行のメタで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で ITEM 検索結果行のメタが「¥」で始まる価格表記であり、カテゴリ名（OUTERWEAR / BOTTOMS 等）でないこと

### FREQ-201-AC-02 3つの幅で LOOK はシーズン、NEWS は公開日のまま

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-201-REQ-01 |
| 根拠 | FREQ-201-REQ-01 が ITEM 以外のメタを変えないことを確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

同3ビューポートで LOOK 行のメタがシーズン（例: 2027 SS）、NEWS 行のメタが公開日（YYYY.MM.DD）のままであること

### FREQ-201-AC-03 応答の items の meta が価格の形で、purchase_count が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-201-REQ-02 |
| 根拠 | FREQ-201-REQ-02 を、窓口の応答の meta の形と購入数の不在で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節のFREQ-201 の行 |

/api/search のレスポンスで items[].meta が /^¥[0-9,]+$/ に一致し、レスポンスに purchase_count が含まれないこと

### 新しく起こした受け入れ条件

要件の文から、画面の外から確かめられる形に起こした。ユーザーの確認を受けていないので「推定」。

### FR-SEARCH-001-AC-01 /search?q=<語> を開くと入力欄に語が入り、4つのタブが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-001 |
| 根拠 | FR-SEARCH-001 の「語を URL で受ける」と「種別のタブ」を、開いた直後の画面で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-001） |

`/search?q=<語>` を開くと、入力欄にその語が入り、ALL・ITEM・LOOK・NEWS の4つのタブが表示されること。

### FR-SEARCH-001-AC-02 タブを押すと URL の tab が変わり、その種別の結果が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-001 |
| 根拠 | FR-SEARCH-001 の「タブで切り替える」と URL の同期を、押した後の URL と結果で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-001） |

結果が出ている状態で ITEM・LOOK・NEWS のタブを押すと、URL の `tab` がそれぞれ `item`・`look`・`news` に変わり、その種別の結果だけが表示されること。

### FR-SEARCH-001-AC-03 tab 付きの URL を開くとそのタブが選ばれている

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-001 |
| 根拠 | FR-SEARCH-001 の URL で受ける形を、共有された URL を開いた時に同じ画面になることで確かめる。今この性質を試すテストが無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-001） |

`/search?q=<語>&tab=look` を開くと、LOOK のタブが選ばれた状態（`aria-selected` が true）で、LOOK の結果だけが表示されること。

### FR-SEARCH-002-AC-01 ヘッダーの検索のアイコンを押すと /search へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-002 |
| 根拠 | FR-SEARCH-002 の入口を、ホームのヘッダーから移れることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-002） |

ホームでヘッダーの検索のアイコンを押すと、`/search` のページへ移ること。

### FR-SEARCH-002-AC-02 /?q=<語> を開くとホームにプレビューが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-002 |
| 根拠 | FR-SEARCH-002 の即時プレビューを、ホームに見出しと一致する結果が出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-002） |

公開済みの商品の名前に含まれる語で `/?q=<語>` を開くと、ホームに「Search Preview」の見出しと、その商品の名前が表示されること。

### FR-SEARCH-003-AC-01 結果の題の中の語に合う部分が mark で強調される

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-003 |
| 根拠 | FR-SEARCH-003 の一致の強調を、題の中の mark の要素と中の字で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-003） |

商品の名前に含まれる語で検索すると、結果の行の題に `mark` の要素が表示され、その中の字が入力した語と（大文字と小文字を除いて）一致すること。

### FR-SEARCH-003-AC-02 商品・ルック・ニュースのそれぞれの題に含まれる語で、その種別の結果が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-003 |
| 根拠 | FR-SEARCH-003 の「3種への検索」を、種別ごとに結果が出ることで確かめる。今のテストは商品だけを見る |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-003） |

公開済みの商品の名前・ルックのテーマ・ニュースの題のそれぞれに含まれる語で検索すると、ITEM・LOOK・NEWS のタブにそれぞれその行が表示されること。

### FR-SEARCH-004-AC-01 一致の無い語で開くと、0件の文と POPULAR ITEMS が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-004 |
| 根拠 | FR-SEARCH-004 の0件の時の文と人気商品の提案を、どれにも合わない語で開いた画面で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-SEARCH-004） |

どの公開済みの行にも合わない語で `/search?q=<語>` を開くと、「「<語>」の検索結果はありません」の文と、POPULAR ITEMS の見出しと、商品の詳細（`/item/` で始まる行き先）へのリンクが表示されること。

## セキュリティ要件

脅威の文書の `THR-SEARCH-001`〜`021` への対策。上位に書ける種類は `THR-` だけなので、全体の要件（`NFR-SEC-001`〜`012`）は根拠の文で触れる。全部、脅威から起こした案で、ユーザーの確認を受けていないので「推定」。今のコードが満たさない所は本文に書いた。

### SEC-SEARCH-001 検索とサジェストは公開済みの商品・ルック・ニュースだけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-001 |
| 根拠 | 発表前の物を検索の語で先に引かれないため。検索の関数の中の絞りと表の RLS の2段で守り、片方が崩れても漏れないようにする（過去のレビューが Fixed とした形）。サジェストは題を候補に出すので、検索の結果と同じ線を引く。NFR-SEC-005（範囲外）の権限管理を検索の公開の線引きに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

`/search`・`/?q=`・`/api/search`・`/api/suggest` と人気商品は、`status='published'` の行だけを返す。今のコードは満たす（`supabase/migrations/20260901102912_remote_schema.sql`、`supabase/migrations/20261013001143_order_return_receipts.sql`）。下書きを入れて試すテストは無い。

#### SEC-SEARCH-001-AC-01 検索の結果とサジェストに非公開の物の題が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-001 |
| 根拠 | 利用者の見える所で、下書きが検索から漏れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、同じ語を題に含む非公開の商品・ルック・ニュースを1件ずつ入れる。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

その語で `/search?q=` を開くと、非公開の3件の題が結果の一覧に表示されないこと。同じ語の `/api/search` の `items`・`looks`・`news` と `/api/suggest` の `suggestions` に、非公開の3件の題が含まれないこと。

#### SEC-SEARCH-001-AC-02 人気商品に非公開の商品が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-001 |
| 根拠 | 人気商品は語が無くても出るので、検索の関数とは別の道で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、購入数の一番多い非公開の商品を1件入れる） |
| 出どころ | 実装から推定 |

`/api/search?q=` の `popularItems` にその商品の id が含まれないこと。

### SEC-SEARCH-002 検索の関数は呼び手の権限に関わらず、関数の中で公開済みに絞る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-002 |
| 根拠 | 検索は利用者の session で関数を呼び、管理の読み取りの権限を持つ session では RLS が下書きを通す（`has_permission` は `aal` を見ない）。関数の中の絞りを RLS に任せると、パスワードだけで得た管理の session で下書きを引けるため。FREQ-540（範囲外）の DB の ACL・session・aal2 で管理の操作を守る考えに照らした |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1（当てはめは推定）。実装から推定 |
| 優先度 | MUST |

`search_items`・`search_looks`・`search_news` は、呼び手が anon・一般会員・管理の権限を持つ人のどれでも、関数の中の条件で `status='published'` の行だけを返す。今のコードは満たす（`remote_schema.sql`）。表の RLS が `aal` を見ない点は表の持ち主（ITEM・LOOK・NEWS）の話で、検索の側では直さない。試すテストは無い。

#### SEC-SEARCH-002-AC-01 管理の読み取りの権限を持つ aal1 の session でも、検索の関数が下書きを返さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-002 |
| 根拠 | RLS が下書きを通す呼び手で、関数の中の絞りだけで守れているかを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に非公開の商品・ルックを入れ、`admin.items.read`・`admin.looks.read` を持つ人のパスワードだけで得た JWT で、PostgREST の `search_items`・`search_looks` を直接呼ぶ） |
| 出どころ | 実装から推定 |

2つの関数の結果に、非公開の商品・ルックが含まれないこと。

### SEC-SEARCH-003 検索の語は関数の引数で渡し、ILIKE の記号を字として扱う

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-003 |
| 根拠 | 語をフィルタの文字列や SQL につなぐと、条件を書き換えられるため（2026-04-18 の Must Fix の形を戻さない）。`%`・`_` を逃がさないと、語1字で全件の一致になる。NFR-SEC-007（範囲外）のパラメータ化クエリを検索に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V5.3.4。`docs/05_Quality/reviews/code/2026-04-18-search-review.md` |
| 優先度 | MUST |

検索とサジェストは、語を `search_items`・`search_looks`・`search_news` の引数として渡し、関数は `%`・`_`・`\` を逃がしてから ILIKE に使う。今のコードは `%`・`_` を逃がす（`src/features/search/services/search.service.ts`、`remote_schema.sql`）が、`\` を逃がさない。このため語の `\%`・`\_` は `\\%`・`\\_`（字の `\` の後に生きたワイルドカード）になり、`\` を含む行に広く当たる。

#### SEC-SEARCH-003-AC-01 記号だけの語で全件が返らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-003 |
| 根拠 | ワイルドカードが字として扱われ、条件が広がらないことを確かめるため。`\` を含む行が無いと `\` の道の誤りが見えないので、見本のデータに1件入れる |
| 状態 | 推定 |
| 確かめ方 | E2E（見本のデータに、題に `\` を含む公開の商品を1件（例: `A\B`）入れ、ほかの題・説明・本文には `%`・`_`・`\` を含めない） |
| 出どころ | 実装から推定 |

`/api/search?q=%`、`q=_`、`q=\%`、`q=\_`、`q=a,b).or(`、`q='--` のどれも 200 で応答し、`counts.all` が 0 であること。`q=\` は `\` を含む1件だけを返すこと。`/search?q=%` の画面に「検索結果はありません」が表示されること。

### SEC-SEARCH-004 検索とサジェストの入口は同じ決まりで語を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-004 |
| 根拠 | 2つの窓口は同じ関数に同じ語を渡すので、片方だけが緩いと守りの層の数を読み違えるため。コメントが実際の決まりと違うと、引数の渡し方を変えた時に守りが消える。NFR-SEC-003（範囲外）の入力検証に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V5.1.3（当てはめは推定）。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | SHOULD |

`/api/search` と `/api/suggest` の `q` は、前後の空白を落として100字まで、制御文字（0x00〜0x1F・0x7F）を含まない値だけを受け、外れたら 400 を返す。決まりを書いたコメントは実際の決まりと一致させる。今のコードは `/api/search` が制御文字を見ず、`/api/suggest` のコメントが `,().` も断ると書く。

#### SEC-SEARCH-004-AC-01 制御文字を含む語は検索でも 400 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-004 |
| 根拠 | 2つの窓口の入口の決まりがそろっていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`q` に `%00` または `%1F` を含む `/api/search` と `/api/suggest` が、どちらも 400 を返すこと。101字の `q` も、どちらも 400 を返すこと。

### SEC-SEARCH-005 公開の検索に回数の制限を掛け、画面は要らない呼び出しをしない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-005 |
| 根拠 | 1回の検索で3つの関数と人気商品・署名を呼ぶので、続けて叩かれると DB と署名の処理が詰まるため。画面が1文字ごと・タブごとに呼ぶと、普通の利用者まで制限に届く |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

`/api/search`・`/api/suggest` は送り元ごとに回数を数え、上限を超えたら 429 と `Retry-After` を返す。制限の DB が使えない時は 503 で閉じる。画面はサジェストを入力が止まってから呼び、タブを切り替えただけでは検索を呼び直さない。今のコードは窓口の制限を満たす（`src/app/api/search/route.ts`、`src/app/api/suggest/route.ts`、`src/features/auth/middleware/rateLimit.ts`）。画面のデバウンスが無く、タブで呼び直す。`preview` の数えが別にある。

#### SEC-SEARCH-005-AC-01 上限を超えた検索とサジェストは 429 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-005 |
| 根拠 | 窓口の回数の制限が効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（同じ送り元から続けて送る） |
| 出どころ | 実装から推定 |

`/api/search` に600秒の中で121回目を送ると 429 が返り、`Retry-After` の見出しが付くこと。`/api/suggest` の201回目も同じであること。

#### SEC-SEARCH-005-AC-02 速く打ってもサジェストは入力が止まってから呼ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-005 |
| 根拠 | 画面の作りで、普通の利用者が制限に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。`/api/suggest` の要求を数える） |
| 出どころ | `docs/05_Quality/reviews/security/security_review_search.md` |

検索の欄に5文字を続けて打った時、`/api/suggest` への要求が5回より少ないこと。ALL から ITEM へタブを切り替えた時、`/api/search` への新しい要求が送られないこと。

### SEC-SEARCH-006 回数の制限の送り元は、利用者が偽れない値から取る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-006 |
| 根拠 | 送り元の見出しを無条件に信じると、送るたびに見出しを変えて制限を逃れられ、数えの行も増え続けるため。共有部品の `rateLimit.ts`（範囲外）の直しが要り、NEWS の SEC-NEWS-011（範囲外）と同じ根 |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

検索とサジェストの回数の制限は、信頼できる中継が付けた送り元だけを使い、利用者が付けた `x-forwarded-for` を変えても同じ送り元として数える。今のコードは満たさない。

#### SEC-SEARCH-006-AC-01 送り元の見出しを変えても制限を逃れられない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-006 |
| 根拠 | 見出しの偽りで制限が外れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番と同じ中継の構成が要る。手元では中継の見出しの付け方をまねる） |
| 出どころ | 実装から推定 |

`x-forwarded-for` を毎回違う値にして `/api/search` を121回送ると、121回目が 429 になること。

### SEC-SEARCH-007 検索の関数は件数を上限に丸め、直接の呼び出しでも重くならない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-007 |
| 根拠 | anon の鍵で PostgREST から関数を直接呼ぶと、アプリの回数の制限も8件の上限も通らないため。アプリは利用者の session から関数を呼ぶので、EXECUTE を外すだけでは検索が止まる。上限は関数の中で持つ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。実装から推定 |
| 優先度 | SHOULD |

`search_items`・`search_looks` は `limit_count` を1以上・決めた上限以下（案: 8）に丸め、NULL も既定の値か上限に置き換える。今のコードは丸めず、NULL では `LIMIT NULL` で上限が無くなり、負の値では誤りになる。空の語は全部の公開の行に一致するので、上限が無いとまとめて取れる。`search_news` の分は SEC-NEWS-010（範囲外）が持つ。

#### SEC-SEARCH-007-AC-01 大きな件数で直接呼んでも上限を超えて返らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-007 |
| 根拠 | アプリの外の道でも件数の上限が効くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、語に一致する公開の商品・ルックを上限より多く入れ、anon の鍵で PostgREST の関数を直接呼ぶ） |
| 出どころ | 実装から推定 |

`search_items`・`search_looks` を `limit_count=100000`・`limit_count=null`（空の語を含む）で呼んだ結果の行の数が、決めた上限以下であること。`limit_count=-1` で呼んでも誤りにならず、上限以下の行を返すこと。

### SEC-SEARCH-008 使わない検索の関数を外へ開かない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-008 |
| 根拠 | 使われない `search_public_*` が PUBLIC に開き、ワイルドカードを逃がさないので、守りを見直す時に見落とされたまま重い一致を掛けられるため。DB の移行の直しは範囲外なので、直すかはユーザーが決める |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3（当てはめは推定）。実装から推定 |
| 優先度 | SHOULD |

`search_public_items`・`search_public_looks`・`search_public_news` は、消すか、PUBLIC・anon・authenticated から EXECUTE を外す。今のコードは満たさない。

#### SEC-SEARCH-008-AC-01 anon は使わない検索の関数を呼べない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-008 |
| 根拠 | 使われない入口が閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（anon の鍵で PostgREST の関数を直接呼ぶ） |
| 出どころ | 実装から推定 |

`search_public_items`・`search_public_looks`・`search_public_news` を anon の鍵で呼ぶと、権限の誤りか「関数が無い」の誤りが返り、行が返らないこと。

### SEC-SEARCH-009 人気商品は購入数を外へ出さず、集める関数は service_role だけが呼べる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-009 |
| 根拠 | 購入数は商品ごとの売れ行きで、外へ出すと競合に知られるため。集める関数は注文の表を読むので、anon・authenticated から呼べると RLS の外から注文を数えられる。公開の道で service role の client を使うので、使うのは人気商品の関数と署名だけに限る（FREQ-186-REQ-02） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3。FREQ-186-REQ-02・FREQ-186-AC-02 |
| 優先度 | MUST |

`/api/search` の `popularItems` に購入数の値を載せない。`get_popular_items` の EXECUTE は service_role だけに付ける。今のコードは満たす（`src/features/search/services/search.service.ts`、`supabase/migrations/20261013001143_order_return_receipts.sql`）。EXECUTE の権限を試すテストは無い。FREQ-186-REQ-02 は関数を SECURITY INVOKER と書くが、最後の定義は SECURITY DEFINER と空の search_path（古い移行 060・061 は INVOKER）。どちらが今の決まりかは決めていない（[trace-matrix.md](../../05_Quality/reports/trace-matrix.md) の「食い違い」節 TM-SEARCH-04）。

#### SEC-SEARCH-009-AC-01 anon と一般会員は人気商品の関数を呼べない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-009 |
| 根拠 | 注文の表を集める関数が、アプリの外から呼べないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（anon の鍵と一般会員の JWT で PostgREST の関数を直接呼ぶ） |
| 出どころ | FREQ-186-AC-02 |

`get_popular_items` を anon の鍵と一般会員の JWT で呼ぶと、どちらも権限の誤りが返り、行が返らないこと。

#### SEC-SEARCH-009-AC-02 検索の応答に購入数が含まれない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-009 |
| 根拠 | 写し方の誤りで購入数が応答に出ないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | FREQ-186-AC-02 |

`/api/search?q=` と `/api/search?q=<公開の商品の名前>` の応答の本文に、`purchase_count`・`purchaseCount` の字が含まれないこと。

### SEC-SEARCH-010 検索とサジェストの応答を共有のキャッシュに残させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-010 |
| 根拠 | 応答には利用者の検索語と、7日有効の ITEM の署名つき URL が入るので、中継のキャッシュに残ると別の利用者に渡るため。429・503 が残ると別の利用者まで断られる。NFR-PERF-007（範囲外）の Cache-Control の設定を検索の窓口に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.2.1。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

`/api/search`・`/api/suggest` の成功・失敗・429・503 の応答に `Cache-Control: private, no-store` を付ける。今のコードは満たさない。

#### SEC-SEARCH-010-AC-01 検索とサジェストの応答に no-store が付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-010 |
| 根拠 | キャッシュの見出しが成功と失敗の両方に付くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/search?q=<語>`・`/api/suggest?q=<語>` の 200 の応答と、`q` を101字にした 400 の応答の `Cache-Control` に `no-store` と `private` が含まれること。

### SEC-SEARCH-011 検索語を利用者の端末に保存しない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-011 |
| 根拠 | 共有の端末で前の利用者の検索語が残らないため（過去の検索の履歴の平文の保存を FREQ-189 で撤去した形を戻さない）。`q` を URL に残すのは FR-SEARCH-001 の決めた形で、URL・履歴に残る危険は受け入れる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.3.1（当てはめは推定）。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | SHOULD |

検索の画面は、検索語を localStorage・sessionStorage・Cookie に書かない。今のコードは満たす（`src/features/search/components/SearchPageClient.tsx` に端末の保存の呼び出しは無い）。

#### SEC-SEARCH-011-AC-01 検索の後に端末の保存の場所に検索語が残らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-011 |
| 根拠 | 撤去した保存が戻っていないことを、保存の場所全体で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

目印の語で検索を確定した後、localStorage・sessionStorage の全部の値と `document.cookie` に、その語が含まれないこと。

### SEC-SEARCH-012 検索の頁は Referer で検索語を外へ送らない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-012 |
| 根拠 | `q` を URL に残すので、外へ移る時や外の物を読む時に参照元として検索語が外のサイトの記録に残るため。守りは共有の `src/proxy.ts`（範囲外）にある |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V14.4.6。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

`/search` の頁と `/api/search`・`/api/suggest` の応答に `Referrer-Policy: no-referrer`（または参照元の道筋を外へ送らない値）を付ける。今のコードは満たす（`src/proxy.ts`）。

#### SEC-SEARCH-012-AC-01 検索の頁の応答に Referrer-Policy が付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-012 |
| 根拠 | 検索語を含む頁で見出しが効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/search?q=<語>` の頁の応答の `Referrer-Policy` が `no-referrer` であること。

### SEC-SEARCH-013 結果と候補の文字は HTML として解釈させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-013 |
| 根拠 | 題・本文は管理の人が書き、`q` は URL から誰でも入れられるので、HTML として出すと閲覧者の端末でスクリプトが動くため。ハイライトのために文字を区切っても、文字として出す形を崩さない。NFR-SEC-003（範囲外）の XSS 対策を検索の表示に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V5.3.3。`docs/05_Quality/reviews/code/2026-04-18-search-review.md` |
| 優先度 | MUST |

結果の題・メタ、候補のラベル、ホームの窓の題は、React の文字として出し、`dangerouslySetInnerHTML` を使わない。ハイライトの正規表現は語を逃がしてから作る。今のコードは満たす（`src/features/search/components/SearchPageClient.tsx`）。試すテストは無い。

#### SEC-SEARCH-013-AC-01 HTML を含む題と語が文字として表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-013 |
| 根拠 | 保存された値と URL の値の両方で、スクリプトが動かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、題に `<img src=x onerror=window.__xss=1>` を含む公開の商品を入れる。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

その題の一部で `/search?q=` を開くと、結果の題に `<img` の字がそのまま表示され、`window.__xss` が未定義のままであること。`q=<img src=x onerror=window.__xss=1>` で開いても `window.__xss` が未定義のままであること。

### SEC-SEARCH-014 検索の結果の画像の署名つき URL は短い期限にそろえる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-014 |
| 根拠 | 署名つき URL は取り消せないので、ITEM の7日の期限では、誤って公開した商品を戻しても長く画像が見えるため。LOOK・NEWS は1時間で、ITEM だけが長い。期限は共有の `lib/storage`（範囲外）の既定に頼らず、検索の側から渡す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（NEWS の SEC-NEWS-004（範囲外）の ITEM・LOOK 版） |
| 優先度 | SHOULD |

検索の応答に入る ITEM・LOOK・NEWS の画像の署名つき URL の期限を、決めた長さ以下（案: 1時間）にする。今のコードは ITEM が7日。

#### SEC-SEARCH-014-AC-01 検索の応答の画像の URL が1時間で切れる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-014 |
| 根拠 | 種別に関わらず期限がそろっていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（署名つき URL の token の `exp` と発行の時刻を読む） |
| 出どころ | 実装から推定 |

`/api/search` の `items`・`looks`・`news`・`popularItems` の `imageUrl` の署名の期限が、どれも応答の時刻から決めた長さ以内であること。

### SEC-SEARCH-015 署名に失敗した時は画像を出さず、失敗を記録に残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-015 |
| 根拠 | 失敗の時に元の値を返すと、非公開の置き場の道筋や DB に書かれた外の URL が閲覧者へ渡り、失敗や改ざんにも気づけないため（閉じる側へ倒す） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.5。実装から推定（NEWS の SEC-NEWS-008（範囲外）の ITEM・LOOK 版） |
| 優先度 | MUST |

検索の応答では、道筋にできない値と署名の失敗の時に `imageUrl` を `null` にする。今のコードは元の値を返す。

#### SEC-SEARCH-015-AC-01 署名できない画像の値は null になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-015 |
| 根拠 | 開く側へ倒れていないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、画像の値が置き場に無い道筋の公開の商品と、`https://example.com/x.jpg` の公開のルックを入れる） |
| 出どころ | 実装から推定 |

その2件を引く語の `/api/search` の応答で、2件の `imageUrl` が `null` であること。`/search` の画面で、その2件の行に画像が表示されないこと。

### SEC-SEARCH-016 署名する前に、道筋が自分の置き場の決まった場所にあることを確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-016 |
| 根拠 | service role で署名するので置き場の RLS が効かず、行の値を書き換えられると置き場の別の物を公開の応答から配れるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（NEWS の SEC-NEWS-007（範囲外）の ITEM・LOOK 版） |
| 優先度 | SHOULD |

ITEM・LOOK の画像は、URL のホストが自分の Supabase で、道筋が決まった場所の下にある時だけ署名する。今のコードは確かめない。

#### SEC-SEARCH-016-AC-01 決まった場所の外の道筋には署名しない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-016 |
| 根拠 | 道筋の確かめが署名の前に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に、画像の値が置き場の別の場所の道筋の公開の商品を入れる） |
| 出どころ | 実装から推定 |

その商品を引く語の `/api/search` の応答で、その商品の `imageUrl` が `null` であること。

### SEC-SEARCH-017 取り出しの失敗を「検索結果はありません」と区別する

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-017 |
| 根拠 | 関数の失敗を0件として返すと、障害や権限の誤り（EXECUTE を外した時など）が長く見過ごされ、利用者は「無い」と思って離れるため。NFR-AVAIL-002（範囲外）の監視・アラートに照らした |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（NEWS の SEC-NEWS-020（範囲外）と同じ形） |
| 優先度 | SHOULD |

検索の関数のどれかが失敗した時、`/api/search` は 200 の0件ではなく失敗の応答を返し、画面は「検索結果を読み込めませんでした」を出す。サジェストも関数の失敗を記録に残す。今のコードは満たさない。

#### SEC-SEARCH-017-AC-01 関数の失敗で「検索結果はありません」を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-017 |
| 根拠 | 失敗と0件が利用者の見える所で分かれることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で検索の関数の1つを呼べなくする。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

その状態で `/search?q=<語>` を開くと、「検索結果を読み込めませんでした」が表示され、「の検索結果はありません」が表示されないこと。

### SEC-SEARCH-018 記録に検索語と DB の誤りの中身を丸ごと書かない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-018 |
| 根拠 | 記録を読める者に、利用者の検索語や DB の構造・SQL の情報を渡さないため。今のコードは記録の側を満たさないので、満たす形の設計（`DD-`）を上位につなげない。確かめは受け入れ条件（サーバーの記録を集めて見る）で持つ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V7.1.2（当てはめは推定）。`docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | MUST |

検索とサジェストの失敗の記録は、決まった文と誤りの種類（code）だけを書き、例外や Supabase の誤りの全体と検索語を書かない。応答の本文は固定の文にする。今のコードは応答を満たし、記録を満たさない。直した時に、詳細設計の DD-SEARCH-004・005・006 の上位にも足す。

#### SEC-SEARCH-018-AC-01 検索とサジェストの失敗の記録に検索語と誤りの全体が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-018 |
| 根拠 | 記録の中身は画面に出ないので、窓口を失敗させた時のサーバーの記録を集めて、語と誤りの全体が書かれないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドのサーバーの標準出力・標準エラーを集める。DB の検索の関数を失敗させる手立てが要る） |
| 出どころ | 実装から推定 |

見分けやすい語（例: `trace-probe-語`）で `/api/search` と `/api/suggest` を呼び、検索の関数を失敗させた時、サーバーの記録にその語と Supabase の誤りの本文（`message`・`details`・`hint`）が無く、決まった文と誤りの種類（code）だけがあること。応答の本文が固定の文であること。

### SEC-SEARCH-019 応答の見出しに内部の処理の時間を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-019 |
| 根拠 | 処理の時間は重い語や DB の負荷の具合を探る手がかりになり、画面もテストも使わないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/05_Quality/reviews/security/security_review_search.md` |
| 優先度 | SHOULD |

`/api/search` の応答に `x-search-duration-ms` を付けない。今のコードは付ける。

#### SEC-SEARCH-019-AC-01 検索の応答に処理の時間の見出しが無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-019 |
| 根拠 | 見出しを外したことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/search?q=<語>` の応答に `x-search-duration-ms` の見出しが無いこと。

### SEC-SEARCH-020 回数の制限で、ほかの利用者を締め出させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-020 |
| 根拠 | 数えが送り元の IP だけで、その IP を他人が名乗れ、外のサイトからも閲覧者の端末に呼び出しを送らせられるので、攻撃者が狙った利用者の検索とホームのプレビューを止められるため。共有部品の `rateLimit.ts`（範囲外）の直しが要り、SEC-SEARCH-006 と根は同じ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4（当てはめは推定）。実装から推定（2026-10-24 のセキュリティの点検） |
| 優先度 | SHOULD |

検索とサジェストの回数の制限は、他人が名乗れない送り元で数え（SEC-SEARCH-006）、外のサイトの頁から送られた呼び出し（`Sec-Fetch-Site` が `cross-site` など）は閲覧者の分の数えに入れない。今のコードは満たさない。

#### SEC-SEARCH-020-AC-01 他人の送り元を名乗っても、その利用者の検索が止まらない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-020 |
| 根拠 | 締め出しの2つの道（送り元を名乗る・外のサイトから送らせる）が塞がったことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番と同じ中継の構成が要る。手元では中継の見出しの付け方をまねる） |
| 出どころ | 実装から推定 |

`x-forwarded-for` に利用者 A の送り元を書いて `/api/search?preview=true` を21回送った後も、利用者 A の `/?q=<語>` にプレビューが出ること。外のオリジンの頁から `/api/search?preview=true&q=x` を21回読み込ませた後も、同じ閲覧者の `/?q=<語>` にプレビューが出ること。

### SEC-SEARCH-021 ホームの文に利用者の語を埋めて出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-SEARCH-021 |
| 根拠 | `/?q=` のリンクで攻撃者の選んだ文をホームの文の一部として出せると、偽の知らせとして読まれるため。検索のページの0件の見出しは FR-SEARCH-004 が語を出すよう求めるので、この要件には入れない。受け入れる危険として残すかはユーザーが決める |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定（2026-10-24 のセキュリティの点検） |
| 優先度 | SHOULD |

ホームのプレビューは、URL の `q` を説明の文の中に埋めない。語を見せる時は、入力欄か、語だと分かる枠の中だけにする。今のコードは文に埋める（`src/features/search/components/SearchHomePreview.tsx`）。

#### SEC-SEARCH-021-AC-01 /?q=<文> で、ホームの説明の文にその文が埋まらない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-021 |
| 根拠 | ホームの文が語で偽られないことを、語を入れて開いた画面で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

公開の物に一致する語を含む文（例: `coat 本日休業のお知らせ`）を `q` に入れて `/` を開いた時、プレビューの区画の説明の文にその文が含まれないこと。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。回数の制限・入力の形の検査・ログ・キャッシュの見出しのような守りは、脅威の文書からセキュリティ要件として足したので、ここには書いていない。

### DRV-SEARCH-001 結果の並びはアプリで点を付けて並べ直す

| 属性 | 値 |
| --- | --- |
| 根拠 | 要件は並び順を決めていない（FREQ-196 で並び順の表示も隠した）。題の頭に語がある物を先に出すと目当ての物に早く届くため、DB からは新しい順に受け取り、アプリで点を付けて並べ直していると推定。DB の関数を語の関連度の順にする案（全文検索の順位など）を選ばなかった理由の記録は無い |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/services/search.service.ts` の `rankText`） |

DB の関数は、語全体を部分一致で含む公開済みの行を新しい順に、1種別あたり上限まで返す。アプリは、全体の一致に 40 点、題が語で始まれば 80 点（含むだけなら 50 点）、語を空白や記号で区切った1語ごとに題なら 18 点・ほかの欄なら 8 点を足し、点の高い順に並べる。点が 0 の行は捨てる。「N RESULTS」の数は、この上限で切った後の数。

### DRV-SEARCH-002 結果の説明は一致の前後を切り出し、合わなければ種別ごとの値にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 長い本文をそのまま出すと、どこが語に合ったか分からないため、一致の近くだけを見せると推定。今は検索のページの行は説明を出さず、ホームのプレビューのカードだけが出す |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/services/search.service.ts` の `buildSnippet`） |

説明（商品の説明・ルックのテーマの説明・ニュースの本文）の中で語が最初に合った所の前28字・後68字を切り出し、切った側に「…」を付ける。合わない時は、商品はカテゴリ、ルックはシーズン、ニュースは分類を出す。

### DRV-SEARCH-003 種別ごとの取り出しに失敗しても止めず、その種別を0件として返す

| 属性 | 値 |
| --- | --- |
| 根拠 | 1つの種別の取り出しが失敗しても、残りの種別の結果は見せるため（推定）。失敗と「見つからない」の区別は SEC-SEARCH-017 |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/services/search.service.ts` の `executeSearch`・`getSearchSuggestions`） |

検索は、商品・ルック・ニュースの3つの取り出しを同時に行い、失敗した種別はサーバーの記録に残して空として扱う。全部が空なら0件の画面（FR-SEARCH-004）になる。候補の取り出しは、失敗を記録にも残さず空として扱う。

### DRV-SEARCH-004 語とタブの変更は URL を置き換え、ブラウザの履歴を積まない

| 属性 | 値 |
| --- | --- |
| 根拠 | FR-SEARCH-001 は語とタブを URL に持たせることだけを求める。タブを切り替えるたびに履歴が積まれると、戻るボタンで検索のページから出るまで何度も押す手間になるため、置き換えにしたと推定。スクロールの位置も動かさない |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/components/SearchPageClient.tsx` の `commitSearch`） |

確定した語の前後の空白を除き、空なら `q` を外す。`tab` は毎回付ける。URL の書き換えは履歴を置き換える形で、スクロールの位置を保つ。URL の `tab` が4つの値に無い時は ALL として扱う。

### DRV-SEARCH-005 人気商品は毎回4件を取り、語があっても一緒に返す

| 属性 | 値 |
| --- | --- |
| 根拠 | FREQ-186 は人気商品を出すことだけを決め、件数を決めていない。0件の時（FR-SEARCH-004）と語の無い時（FREQ-186-REQ-03）にすぐ出せるよう、1回の応答に毎回含めていると推定 |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/services/search.service.ts` の `executeSearch`） |

検索の窓口は、語の有無にかかわらず、購入数の順の人気商品を4件取り、画像を署名した上で応答に含める。語が無い時は人気商品だけを返し、0件の扱いにしない。

### DRV-SEARCH-006 候補は種別と名前の重なりを除き、点の順に並べ、押すとその語と種別で探す

| 属性 | 値 |
| --- | --- |
| 根拠 | 同じ名前の候補が並ぶと選ぶ意味が無いため重なりを除く（推定）。FREQ-190-AC-03 が求める「候補の語と種別で検索」を、候補ごとの行き先に語と種別を持たせて行う |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/services/search.service.ts` の `getSearchSuggestions`） |

候補は検索と同じ点の付け方で並べ、同じ種別で同じ名前の物は点の高い1つだけを残し、最大8件にする。候補の行き先は、名前を語に、種別をタブにした `/search` の URL。画面は入力が変わるたびに候補を取り直す（待ち時間を置かない）。

### DRV-SEARCH-007 読み込み中・失敗・語の無い時の見せ方

| 属性 | 値 |
| --- | --- |
| 根拠 | 取り出しの間に何も無い画面や古い結果を見せると、壊れているか終わったかが分からないため、場合ごとに見せ方を分けたと推定（uiux レビューの SR-7 でスケルトンを足した） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_search.md`、実装から推定（`src/features/search/components/SearchPageClient.tsx`） |

語がある取り出しの間は、結果の行の形の灰色の枠を5行出す。取り出しに失敗した時は「検索結果を読み込めませんでした」を赤い字で、読み上げにも伝わる形で出す。語が無く人気商品も無い時は「気になる商品名やトピックを入力すると、商品・ルック・ニュースを横断した結果を表示します。」を出す。候補の数は「N 件の検索候補があります」として読み上げにだけ伝える。ページの最初の読み込みの間は「読み込み中...」を出す。

### DRV-SEARCH-008 検索の応答に処理にかかった時間の見出しを付ける

| 属性 | 値 |
| --- | --- |
| 根拠 | 付けた理由の記録は無い（推定）。旧版の詳細設計（`git show 40acae8a:docs/04_DetailDesign/pages/19_search.md` の実装タスク管理と API 仕様の表）が検索の応答の速さの目標（P95 < 200ms）を置いていたので、速さを外から測るために付けたと推定。今の `19_search.md` はこの目標をコードに無い物として引き継いでいない（「旧版から引き継がなかった節」）。要件に当たる行は無い（全体の性能の要件 NFR-PERF-002 は範囲外） |
| 状態 | 推定 |
| 出どころ | 旧版の詳細設計（`git show 40acae8a:docs/04_DetailDesign/pages/19_search.md`）、`docs/03_BasicDesign/api/api-spec.md`（見出しがあることだけを書く）、実装から推定（`src/app/api/search/route.ts`） |

成功の応答に、窓口の処理にかかったミリ秒を `x-search-duration-ms` の見出しで付ける。

### DRV-SEARCH-009 検索のページの title・description・OG の画像を決めて出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 共有した時や検索エンジンにページの中身が伝わるようにするため（全体の要件 NFR-SEO-003 は範囲外。1.19 の要件には無い）。canonical と robots は付けていない |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/search/page.tsx`） |

title は「Search | Le Fil des Heures」、description は「Le Fil des Heures の商品・ルック・ニュースを横断検索できるページです。」、OG の画像はトップの写真。

### DRV-SEARCH-010 ホームのプレビューは3種を合わせて最大3件と、全部を見る入口を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | FR-SEARCH-002 はプレビューを出すことだけを求める。ホームの中で場所を取りすぎないよう件数を絞り、続きは検索のページへ渡すと推定 |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/components/SearchHomePreview.tsx`） |

`/?q=` の語の前後の空白を除いて空でなければ、プレビューの窓口（1種別3件）を呼び、商品・ルック・ニュースの順に合わせて先頭3件をカード（メタ・題・説明）で出す。「VIEW ALL RESULTS」で `/search?q=<語>` へ移る。0件なら「プレビュー対象の検索結果は見つかりませんでした。」を出し、取り出しに失敗した時は区画ごと出さない。

## 未確認事項

- FREQ-01 の番号: 1つ目の行（`requirements.md` の「要求と要件のトレーサビリティ」節）を見本として誰も定義しないことにし、2つ目を番号のまま検索の要求にした。`SR-SEARCH-` に振り替えるかはユーザーに聞く。FREQ-01-REQ-02 と同じ文の REQ-01、2回書かれた AC-01 の扱いも同じ
- `SR-SEARCH-001`（ルック・ニュースも探す要求）を起こしたことの確認
- 後の要求で置き換わった行（FREQ-184-REQ-01・02・AC-01・02、FREQ-186-REQ-01・AC-01（FREQ-472 が数え方を `line_kind='order'` に狭めた）、FREQ-188-REQ-02、FREQ-190-REQ-01・AC-01、FREQ-191 の全部、FREQ-193-REQ-01、FREQ-199-AC-01）を「廃止」にするか、文を直すか
- SEC-SEARCH-020・021（2026-10-24 の点検で足した、他人の締め出しとホームの文の偽り）を要件として認めるか。SEC-SEARCH-021 は受け入れる危険として残す道もある
- SEC-SEARCH-018-AC-01 を E2E で確かめる手立て（サーバーの記録の集め方と、検索の関数を失敗させる方法）
- FREQ-186-REQ-02 の SECURITY INVOKER と今の DB の SECURITY DEFINER のどちらが今の決まりか
- 人気商品が全部を発送した注文（shipped）を数えないことを、このままにするか（返品の移行は「範囲を変えない」と書く）
- FREQ-01-AC-01 の「関連商品」を何で確かめるか
- 派生要件の動き（DRV-SEARCH-001〜010）を要件として認めるか。認めれば受け入れ条件を起こしてテストに付けられる
- 本番の PostgREST の返す行数の上限と、検索の関数の権限は確かめていない
