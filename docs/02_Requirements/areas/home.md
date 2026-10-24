# HOME の要件

> 状態: 推定 | 確認日: 2026-10-24 | 対象: HOME（ホーム `/` のヒーロー・区画の並び・ABOUT の区画・VIEW ALL のボタン・ヒーローの動き） | 基準コミット: `a03beaff`

## 概要

HOME の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）のうち HOME が持ち主の行（領域ごとの担当の割り当て）を丸ごと写し、上位の無い要件には新しい要求 `SR-HOME-` を起こし、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-HOME-` に書いた。セキュリティ要件は脅威の文書から起こした。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 11 | 既存の `FREQ-` 6（147・148・278・280・282・283）、新しい `SR-HOME-001`〜`005` |
| 要件 | 28 | 既存の `FREQ-NN-REQ-NN` 17、`FR-HOME-001`〜`009`、`NFR-HOME-001`〜`002` |
| 受け入れ条件 | 28 | 既存の `FREQ-NN-AC-NN` 17、新しい `FR-HOME-NNN-AC-01`・`NFR-HOME-NNN-AC-01` 11 |
| 派生要件 | 6 | `DRV-HOME-001`〜`006` |
| セキュリティ要件 | 20（うち 3 は廃止） | `SEC-HOME-001`〜`020`（脅威 `THR-HOME-001`〜`020` と1対1。`011`・`012`・`019` は持ち主の SEARCH の要件に移したので「廃止」で残した）、受け入れ条件 `SEC-HOME-NNN-AC-NN` 28（うち 3 は廃止） |

- 状態: 写した要求の行は「現行」。ただし元の行に理由の記述が無く、根拠の「なぜ」を推定で補った行や上位のつなぎは「推定」。コードと合わない行・新しく起こした項目・実装から読み取った項目も「推定」。どちらが正しいかは決めず、食い違いは各項目の本文と「未確認事項」に書き、`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節（TM-HOME-NN）に載せる
- 結論: ホームを見る要求は元の文書に無かった（`SR-HOME-001`〜`005` を推定で起こした）。ホームの ITEM・LOOK の表示件数（FREQ-147・148 の元の数と、置き換えた FREQ-276・277）、ヒーローの縦線（FREQ-278 と FREQ-282）、ヒーローに CTA を置くか（付録 D と UI/UX レビューの決定）は、ユーザーに決めてもらう

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME |
| 写した元 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節と、「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147・148・278・280・282・283 の行）。元の行は消していない |
| 持ち主の決め方 | 領域ごとの担当の割り当て（2026-10-24）。HOME が持つのは FR-HOME-002〜005・008・009 と FREQ-148。FR-HOME-001・006・007、NFR-HOME-001・002、FREQ-147・278・280・282・283 はほかの領域が触れないので HOME が持つ |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」、`docs/01_Planning/brand.md`、`requirements.md` の付録 D.1 トップページ |
| 対象のコード | `src/app/page.tsx`、`src/features/home/components/HomeSectionViewAll.tsx`、`src/components/animations/TextReveal.tsx` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |
| 範囲外の上位 | 全体の非機能要件 `NFR-SEO-003`・`NFR-A11Y-001` は定義を写さず、受け入れ条件の上位に `（範囲外）` の印で書く。取扱店の要求 `FREQ-13` は STOCKIST が持ち、FR-HOME-005 の上位に `（範囲外）` で書く |

### 写した行と写さなかった行

写したのは、HOME の範囲のコード（`page.tsx`・`HomeSectionViewAll.tsx`・`TextReveal.tsx`）がその一部を作っている行と、HOME の範囲の E2E が確かめている行。

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-126・146・149・275 | ホームの VIEW ALL と区画の見出しの行。NEWS が `docs/02_Requirements/areas/news.md` で定義済み。HOME の E2E（FR-HOME-012・013・017）はその受け入れ条件を確かめる |
| FREQ-13、FR-STOCKIST-004 | 取扱店の要求・要件で、STOCKIST が持つ。FR-HOME-005 と中身が重なる |
| FR-LOOK-ALL-004 | ホームの LOOK の区画の要件で、LOOK が持つ |
| FR-SEARCH-002 | ホームの検索の窓の要件で、SEARCH が持つ |
| FREQ-123〜125・127・128・137・138・140〜144・150・151・271〜273・279 | ITEM・LOOK のカードの見た目と動き。部品は `PublicItemGrid`・`PublicLookGrid`（範囲外） |
| FREQ-276・281 | 主な頁が ITEM（範囲に無い）。FREQ-276 は FREQ-147 の件数を置き換えた行 |
| FREQ-277 | LOOK が持つ（領域ごとの担当の割り当て）。ホームの LOOK の列数と表示数を決め、FREQ-148 の件数を置き換えた行 |
| FREQ-314 | 管理の全画面の文字の大きさの行で、持ち主なし（範囲外）。区画の見出しの大きさを `--lk-size-4xl`・`--lk-size-9xl` にし、FREQ-275-AC-02 の px の値を撤回した（FREQ-314-REQ-02）。HOME の E2E（FR-HOME-017）がその受け入れ条件を確かめる |
| FREQ-76 | `/loading` の見本（範囲外）。`TextReveal` の繰り返しの道はここで使う |
| 付録 D・B のワイヤー（`WF-HOME-001`〜`007`・`AC-WF-HOME-001`・`WF-HOME-B01`・`B02`） | ID の形が検査の種類に無く、項目として書けない（`scripts/trace/model.ts`）。目的の `WF-HOME-001` は SR-HOME-001・002 の出どころに書いた。ヒーローの CTA・スライダー・カルーセル（`WF-HOME-003`〜`005`・`AC-WF-HOME-001`）は今の作りに無く、DRV-HOME-001 の決定と逆（食い違い） |
| `AC-DES-001` | ホーム・商品・決済でブランドの色をそろえる全体の受け入れ条件。ID の形が検査の種類に無い |
| NFR-PERF-002・003・005、NFR-A11Y-002 | 全体の非機能要件。根拠の欄で触れるだけ |

### E2E と受け入れ条件の対応

`e2e/FR-HOME-*`・`e2e/NFR-HOME-*` のうち範囲の型に入るファイルが試している受け入れ条件。テスト名に ID を付ける時に使う。

| E2E のファイル | 受け入れ条件 |
| --- | --- |
| FR-HOME-001-hero-banner | FR-HOME-001-AC-01（古い代替テキストを探して落ちる。食い違い） |
| FR-HOME-002-home-sections | FR-HOME-002-AC-01 |
| FR-HOME-004-view-all-buttons | FR-HOME-004-AC-01 |
| FR-HOME-005-stockist-home | FR-HOME-005-AC-01（1280px だけ） |
| FR-HOME-006-007-011-home-quality | FR-HOME-006-AC-01・FR-HOME-007-AC-01・FR-HOME-009-AC-01・NFR-HOME-002-AC-01（1つのテストで4つ。名前の ID は1つなので分ける必要がある） |
| FR-HOME-006-home-metadata | FR-HOME-006-AC-01 |
| FR-HOME-007-hero-priority | FR-HOME-007-AC-01 |
| FR-HOME-008-about-image | FR-HOME-008-AC-01 |
| FR-HOME-009-heading-structure | FR-HOME-009-AC-01 |
| FR-HOME-012-view-all-button-ui | FREQ-146-AC-01・AC-02（NEWS が定義） |
| FR-HOME-013-section-display-limits | FREQ-147-AC-01〜03、FREQ-148-AC-01〜03、FREQ-149-AC-01・02（NEWS が定義）、FREQ-276-AC-03（範囲外、持ち主なし）、FREQ-277-AC-03（LOOK が定義）。1つのテストで5つの要求 |
| FR-HOME-017-section-title-common | FREQ-275-AC-01・AC-03（NEWS が定義）、FREQ-314-AC-02（範囲外、持ち主なし） |
| FR-HOME-018-hero-motion | 1つ目 FREQ-278-AC-01、2つ目 FREQ-282-AC-01 と FREQ-278-AC-03、3つ目 FREQ-278-AC-04、4つ目 FREQ-278-AC-05、5つ目 FREQ-280-AC-01・AC-02 |
| FR-HOME-019-hero-thread-loop | 1つ目 FREQ-282-AC-01、2つ目 FREQ-282-AC-02 |
| FR-HOME-020-hero-scroll-color | FREQ-283-AC-01 |
| NFR-HOME-001-home-performance | NFR-HOME-001-AC-01（3G を模していない。食い違い） |
| NFR-HOME-002-wcag-accessibility | NFR-HOME-002-AC-01（コントラスト比そのものは測っていない） |

受け入れ条件があって範囲の E2E が無い物: `FR-HOME-003-AC-01`、`FREQ-278-AC-02`・`AC-06`（縦線は FREQ-282 の動きに変わった）。E2E が今の値で試し、受け入れ条件の文と数が合わない物: `FREQ-147-AC-02`・`FREQ-148-AC-02`（1280px の件数）。

## 要求

### SR-HOME-001 訪問者がホームの最初の画面でブランドの世界観を感じ、ブランドの考えへ進める

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームは初めて来た人が最初に見る頁で、ここでブランドの空気（静かで強い、時を紡ぐ日常着）が伝わらないと、考えに共感して正価で買う人に届かない。要求の表にホームを見る要求が無いので、FR-HOME-001・003 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」（ブランドアイデンティティを反映した商品体験）、`docs/01_Planning/brand.md` のコンセプト「時を紡ぐニュートラルモードな日常着」、`docs/02_Requirements/requirements.md`（WF-HOME-001 の目的「ブランド訴求と導線」） |

訪問者（エンドカスタマー）が、ホームを開いた最初の画面でブランドの名前と世界観を感じ、ブランドの考え（`/about`）へ進めること。

### SR-HOME-002 訪問者がホームから ITEM・LOOK・NEWS・取扱店の新しい物を見て、それぞれの一覧へ進める

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームは各頁への入口なので、新しい商品・ルック・知らせ・取扱店を少しずつ見せ、気になった人がそのまま一覧へ進めるようにする。要求の表に当たる行が無いので、FR-HOME-002・004・005 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（1.1 の概要「ブランドのランディングページ兼各セクションへの入口」）、付録 D.1 トップページ（WF-HOME-001 の「導線への誘導」） |

訪問者が、ホームを下へ読むだけで新しい ITEM・LOOK・NEWS と取扱店を見られ、それぞれの一覧へ移れること。

### SR-HOME-003 検索や共有の場で、ホームが正しいブランド名と説明で示される

| 属性 | 値 |
| --- | --- |
| 根拠 | 検索の結果や SNS での共有に既定の文（create next app）が出ると、ブランドの信頼を損ない、見つけてもらえない。全体の NFR-SEO-003（メタ情報）をホームに当てはめる要求が無いので、FR-HOME-006 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FR-HOME-006 のレビュー）、5.5 節の NFR-SEO-003 |

ホームが検索の結果や共有の表示で、ブランドの名前とホーム用の説明で示されること。

### SR-HOME-004 ホームが携帯の回線でも速く、外のサービスが止まっても崩れずに出る

| 属性 | 値 |
| --- | --- |
| 根拠 | モバイルで初めて来た人は、最初の画面が遅いと読む前に離れる。外の画像の配信が止まって頁が壊れるのも同じ。目標の「モバイルファースト」「高速」を、ホームの速さと壊れにくさに当てはめる要求が無いので、FR-HOME-007・008、NFR-HOME-001 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」（購入導線をシンプルかつ高速に、モバイルファースト）、`docs/02_Requirements/requirements.md`（NFR-PERF-002・003・005） |

ホームの最初の画面が携帯の回線でも速く出て、外のサービスの具合でホームの表示が崩れないこと。

### SR-HOME-005 読み上げを使う人・色を見分けにくい人もホームを読める

| 属性 | 値 |
| --- | --- |
| 根拠 | 見出しの構造が崩れると読み上げで区画を辿れず、写真の上の白い字は背景しだいで読めなくなる。全体の NFR-A11Y-001・002 をホームに当てはめる要求が無いので、FR-HOME-009、NFR-HOME-002 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（NFR-A11Y-001・002） |

読み上げを使う人が見出しでホームの区画を辿れ、写真の上の字も十分なコントラストで読めること。

### FREQ-147 ホームの ITEM は決まった件数を取り、幅ごとの数だけ出し、続きがある時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 画面の幅で件数が変わってもサーバーは幅を知らないので、決まった件数を取って画面の側で出し分ける。続きが無いのに VIEW ALL を出すと、押しても同じ物しか無い一覧へ送ってしまう |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」の追記の行） |

要求の文: ※ ブレークポイント別の表示件数は FREQ-276 で「2xl 未満6件 / 2xl 8件」に、描画件数は8件に変更。ホームの ITEM セクションは、どのビューポートでも DB から公開 ITEM を10件取得し、lg（1024px）未満は6件・lg 帯域は8件・xl（1280px）以上は10件を表示すること。各ビューポートの表示数より公開 ITEM の総数が多い場合のみ VIEW ALL ボタンを表示すること

### FREQ-148 ホームの LOOK は8件を取り、幅ごとの数だけ出し、続きがある時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | FREQ-147 と同じ考え方を LOOK の区画にも当てる。ルックは写真が大きいので ITEM より少ない8件を上限にした（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

要求の文: ※ ブレークポイント別の表示件数は FREQ-277 で「2xl 未満6件 / 2xl 8件」に変更（描画8件は据え置き）。ホームの LOOK セクションは、どのビューポートでも DB から公開 LOOK を8件取得し、xl（1280px）未満は6件・xl 以上は8件を表示すること。各ビューポートの表示数より公開 LOOK の総数が多い場合のみ VIEW ALL ボタンを表示すること

### FREQ-278 ホームのヒーローに動きを付ける

| 属性 | 値 |
| --- | --- |
| 根拠 | 名前だけの静かなヒーロー（DRV-HOME-001）でも、文字が1つずつ現れる控えめな動きで「時を紡ぐ」印象を足し、下に続きがあることを縦線で知らせる。動きを嫌う人の設定（reduce）では止める |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

要求の文: ホームのヒーローセクション（ブランド名・SCROLL ラベル・縦線）にモーションを付けること

### FREQ-280 本番の CSP で React の style 属性を落とさず、CSS からの情報の盗み出しは塞いだままにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 本番の CSP が style 属性を落とすと、ホームの字の大きさ（style 属性で当てる値）が崩れる。一方で style 要素・link 要素まで緩めると、CSS を使った情報の盗み出しの道が開く。ホームの本番ビルドで崩れが見つかって起きた要求（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行） |

要求の文: 本番の CSP が React の inline style を落とさないようにしつつ、CSS 経由の情報窃取は塞いだままにすること

### FREQ-282 ヒーローの縦線は上から下へ伸びる動きだけを繰り返し、消える瞬間を作らない

| 属性 | 値 |
| --- | --- |
| 根拠 | 1回だけ引いて止まる線（FREQ-278 の元の形）では下へ読む誘いが続かず、繰り返すと線が消える瞬間がちらついて見える。伸びる動きだけを途切れずに繰り返して、静かに下を指す |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-282 の行） |

要求の文: ヒーローの SCROLL 下の縦線が、上から下へ伸びる動きだけを繰り返し、途中で消える瞬間が無いこと

### FREQ-283 ヒーローの SCROLL の文字と縦線を暗い写真の上でもはっきり読めるようにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 写真の暗い所に薄い白の字と線を重ねると見えにくく、下へ読む手がかりにならない |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-283 の行） |

要求の文: ヒーローの SCROLL の文字と縦線が、暗い写真の上でもはっきり読めること

## 要件

### 要求の表から写した要件

文は `requirements.md` の要件の欄のまま。元の表に優先度は無い。

### FREQ-147-REQ-01 ITEM を10件取り、11件目より後は描かない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147 |
| 根拠 | FREQ-147 の前半を、取る件数を幅によらず決める形に落とした。ただし要求の文の※は描く件数を8件に変えたと書き、今のコードは10件を取って8件だけ描く（`src/app/page.tsx` の取得の件数、描くのは範囲外の `PublicItemGrid`）。要件の文の「10件のカード」と合わない（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

ホームの ITEM 取得件数をビューポートによらず10件とし、11件目以降のカードは描画しないこと

### FREQ-147-REQ-02 描いたカードを CSS で幅ごとに出し分ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147 |
| 根拠 | サーバーは幅を知らないので、件数の出し分けは画面の側（CSS）でする。ただし数（lg 未満6・lg 8・xl 以上10）は要求の文の※で FREQ-276 の「2xl 未満6・2xl 以上8」に変わったと書かれ、要件の文には印が無い（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

描画した10件のカードを CSS で出し分け、lg 未満は先頭6件・lg 帯域は先頭8件・xl 以上は10件を表示すること

### FREQ-147-REQ-03 公開の総数を取り、その幅の表示数より多い時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147 |
| 根拠 | FREQ-147 の後半を、総数を別に数えて表示数と比べる形に落とした（取った件数だけでは続きがあるか分からないため） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

公開 ITEM の総数を取得し、総数がその帯域の表示数より多い場合のみ VIEW ALL を表示すること

### FREQ-148-REQ-01 LOOK を8件取り、9件目より後は描かない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148 |
| 根拠 | FREQ-148 の前半を、取る件数を幅によらず決める形に落とした。今のコードも8件を取る（`src/app/page.tsx`） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

ホームの LOOK 取得件数をビューポートによらず8件とし、9件目以降のカードは描画しないこと

### FREQ-148-REQ-02 描いたカードを CSS で幅ごとに出し分ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148 |
| 根拠 | FREQ-147-REQ-02 と同じ理由で出し分けは画面の側でする。ただし数（xl 未満6・xl 以上8）は要求の文の※で FREQ-277 の「2xl 未満6・2xl 以上8」に変わったと書かれ、要件の文には印が無い（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

描画した8件のカードを CSS で出し分け、xl 未満は先頭6件・xl 以上は8件を表示すること

### FREQ-148-REQ-03 公開の総数を取り、その幅の表示数より多い時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148 |
| 根拠 | FREQ-148 の後半を、総数を別に数えて表示数と比べる形に落とした |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

公開 LOOK の総数を取得し、総数がその帯域の表示数より多い場合のみ VIEW ALL を表示すること

### FREQ-278-REQ-01 ブランド名を TextReveal で1文字ずつ左から出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | FREQ-278 のブランド名の動きを、既にある見本の部品（`/loading` の TextReveal）を使う形に落とした。新しい動きを作らず見本とそろえるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

ブランド名「Le Fil des Heures」を TextReveal で1文字ずつ左から順に表示すること

### FREQ-278-REQ-02 SCROLL の下の縦線を threadDraw で上から下へ引く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | FREQ-278 の縦線の動きを、`/loading` の見本の THREAD DRAW にそろえる形に落とした。ただし今のコードは FREQ-282 の heroThreadLoop を当て、threadDraw は使わない。FREQ-278 の行に置き換えの印が無い（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

SCROLL ラベル下の縦線を loading ページの Motion Ideas「THREAD DRAW」（threadDraw）で上から下へ引くこと

### FREQ-278-REQ-03 ブランド名の字の大きさを 6xl にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | 名前だけのヒーローで名前が主役になる大きさにするため。字の大きさの決まった段（`--lk-size-*`）から選ぶ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

ブランド名のフォントサイズを --lk-size-6xl にすること

### FREQ-278-REQ-04 1文字ずつの span を読み上げに出さず、見出しの名前を元の文字列にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | 1文字ずつの span をそのまま読み上げると、ブランド名が1文字ずつ綴られて名前として聞こえないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

1文字ずつの span を支援技術に露出させず、見出しのアクセシブル名を元の文字列にすること

### FREQ-278-REQ-05 動きを減らす設定ではヒーローの動きを止める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | 動きで気分が悪くなる人が端末で「視差効果を減らす」を選んでいる時に、動きを見せないため（WCAG 2.3.3） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

prefers-reduced-motion: reduce ではヒーローのモーションを止めること

### FREQ-278-REQ-06 縦線は1回だけ再生する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278 |
| 根拠 | 見本のように繰り返すと落ち着かないので、1回引いて止める形にした。ただし FREQ-282 で無限に繰り返す形に変わり、今のコードも繰り返す。FREQ-278 の行に置き換えの印が無い（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

縦線は loading ページのデモ用 infinite ではなく、fill-mode both で1回だけ再生すること

### FREQ-280-REQ-01 style-src に 'unsafe-inline' を常に含める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-280 |
| 根拠 | style 属性は nonce で許せないので、属性を落とさないには style-src に 'unsafe-inline' を入れるしかない。中身は共有の `src/proxy.ts`（範囲外のコード） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行） |

style-src に 'unsafe-inline' を常に含めること（style 属性は nonce では許可できないため）

### FREQ-280-REQ-02 style-src-elem を分け、style 要素・link 要素は 'self' のまま締める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-280 |
| 根拠 | CSS を使った情報の盗み出しは、外から差し込んだ style 要素や link 要素から起きる。属性だけを緩め、要素は締めたままにして道を開けない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行） |

style-src-elem を分離し、style 要素・link 要素は 'self' のまま締めること

### FREQ-282-REQ-01 縦線を上端から伸ばす heroThreadLoop を無限に当てる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-282 |
| 根拠 | FREQ-282 の「伸びる動きだけ」「消えない」を、上端を起点にし、折り返しの始点を少し残した長さにする形に落とした。遅く始まり途中で速くなる動きで、機械的に見せない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-282 の行） |

縦線を上端起点で伸ばし、引ききったまま少し待機してから即座に折り返す heroThreadLoop を無限再生で当てること。折り返しの始点は scaleY(0) ではなく僅かに残した長さにし、イージングは ease-in-out（遅く始まり、途中で速く、終わりに向かってまた遅く）にすること

### FREQ-282-REQ-02 動きを減らす設定では縦線を動かさない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-282 |
| 根拠 | 無限に繰り返す動きは、動きを減らしたい人に特に負担になるため（FREQ-278-REQ-05 と同じ考え） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-282 の行） |

prefers-reduced-motion: reduce では縦線を動かさないこと

### FREQ-283-REQ-01 SCROLL の字と縦線を白 90% にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-283 |
| 根拠 | FREQ-283 の「はっきり読める」を、白の濃さの値に落とした。真っ白にせず 90% にして、写真の上で強すぎない控えめな印にする（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-283 の行） |

SCROLL ラベルと縦線の不透明度を白 90% にすること

### ホームの頁の要件

`requirements.md` の 1.1 ホームページの節から写した。文は要件の欄のまま（FR-HOME-001 は欄に文が無いので詳細設計の頁から取った）。「レビュー:」の注は古い物が多いので写さず、今のコードの形を本文の後に書いた。

### FR-HOME-001 ヒーローにブランドの世界観を伝える大きな画像を全画面で出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-001 |
| 根拠 | 最初の画面いっぱいの写真と名前だけで、ブランドの静かな世界観を言葉より先に伝えるため（SR-HOME-001）。requirements.md の欄には要件の文が無く「レビュー:」の注だけなので、文は詳細設計の頁から取った（状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | git の履歴にある `docs/04_DetailDesign/pages/01_home.md` の旧版の機能要件対応表の FR-HOME-001 の行 |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ヒーローセクションにブランドの世界観を伝える大型バナーを全画面表示する。

今のコード: `/mainphoto.png` を画面の見える高さいっぱい（svh）に敷き、上下を暗くする重ねと、ブランド名の h1 を重ねる（`src/app/page.tsx`）。

### FR-HOME-002 ITEM・LOOK・NEWS・ABOUT の4つの区画をスクロールで並べる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-002 |
| 根拠 | ホームを下へ読むだけで、新しい物とブランドの考えにひと通り触れられるようにするため（SR-HOME-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページに最新アイテム（ITEM）・最新ルック（LOOK）・最新ニュース（NEWS）・ABOUT の4セクションをスクロールで掲載する。

今のコード: ヒーロー、検索の窓（FR-SEARCH-002）、ITEM、LOOK、NEWS、ABOUT、取扱店（FR-HOME-005）の順に並べる（並びは DRV-HOME-006）。

### FR-HOME-003 ABOUT の区画から /about へ進める

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-001 |
| 根拠 | ホームの ABOUT は要約なので、考えに惹かれた人がブランドの話の全文へ進めるようにするため（SR-HOME-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページの ABOUT セクションには `/about` ページへの導線リンクを設け、ブランドストーリーページへ誘導する。

今のコード: ABOUT の区画の3本柱の下に READ OUR STORY のボタン（`/about` へのリンク）を置く。requirements.md の注「未設置」と詳細設計の「不要」は古い。

### FR-HOME-004 ITEM・LOOK・NEWS の区画の末尾に一覧へのボタンを置く

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-002 |
| 根拠 | ホームで見た続きを一覧で見たい人が、区画からそのまま一覧へ移れるようにするため（SR-HOME-002）。ただし今のコードは総数が表示数以下の時にボタンを隠し（FREQ-147-REQ-03・FREQ-148-REQ-03、NEWS の FREQ-149-REQ-02）、要件の「配置する」と合わない時がある（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページの ITEM・LOOK・NEWS 各セクションの末尾に「もっと見る」ボタンを配置し、各一覧ページへ遷移できるようにする。

今のコード: 3つとも文字は "VIEW ALL" で、共通の Button で描く（`src/features/home/components/HomeSectionViewAll.tsx`、FREQ-146）。出すかどうかは各格子の部品（範囲外）が総数で決める。

### FR-HOME-005 取扱店の区画をホームに置き、最大6件を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-002、FREQ-13（範囲外） |
| 根拠 | 実物を見て買いたい人が、ホームから近くの取扱店を知れるようにするため（SR-HOME-002、取扱店を確かめる要求 FREQ-13）。件数を絞ってホームを長くしすぎない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

STOCKIST（商品扱い店舗）セクションをホームページに追加し、`PublicStockistGrid variant="home"` で最大6件を表示する。

今のコード: 取扱店を6件まで取り（範囲外の `getHomePublicStockists`）、頁の最後に置く。モバイルで3件にする出し分けは FR-STOCKIST-004（STOCKIST）の話。

### FR-HOME-006 ホーム固有の title と description を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-003 |
| 根拠 | 検索の結果と共有の表示に、既定の文ではなくブランドの名前と説明を出すため（SR-HOME-003） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

`generateMetadata` を実装し、ホームページ固有の `title` / `description` を設定する。

今のコード: title は「Le Fil des Heures」、description はブランドの説明の文。共有の表示（Open Graph）の題・説明・画像（`/mainphoto.png`）も同じ文で付ける（全体の NFR-SEO-003 の OG タグ）。requirements.md の注「存在しない」は古い。

### FR-HOME-007 ヒーロー画像を先に読み込み、LCP を小さくする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-004 |
| 根拠 | 最初の画面で一番大きな物はヒーローの写真なので、これを先に読み込むと最初の画面が早く出る（SR-HOME-004、NFR-PERF-003 の LCP の目標） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ヒーロー画像は `priority` を設定してプリロードし、LCP（Largest Contentful Paint）を最小化する。

今のコード: 画像に priority を付け、頁を描く時にも画像の先読みを頼む（`src/app/page.tsx`）。requirements.md の注「未設定」は古い。

### FR-HOME-008 ABOUT の画像を手元の画像にし、外の住所に頼らない

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-004 |
| 根拠 | 外の画像の生成サービスが止まったり回数の制限にかかったりすると、ホームが壊れるため（SR-HOME-004） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ABOUT セクションの画像を静的ローカルアセットまたは管理された CDN 画像に置き換え、外部 URL への依存を排除する。

今のコード: 手元の `/about.png` を next/image で最適化して出す。requirements.md の注「readdy.ai」は古い。

### FR-HOME-009 h1 を1つにし、区画の見出しを h2 にする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-005 |
| 根拠 | 読み上げを使う人は見出しの段で頁を辿るので、頁の主題（ブランド名）を1つの h1、区画を h2 にそろえる（SR-HOME-005） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページには `h1` 要素を1つ配置し、各セクション見出しは `h2` として構造化する。

今のコード: h1 はヒーローのブランド名だけ。ITEMS・LOOK・NEWS・ABOUT・STOCKIST の見出しは共通の SectionTitle（h2）。ABOUT の3本柱の題は h3。

### NFR-HOME-001 ホームの初回の表示を2秒以内にする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-004 |
| 根拠 | 携帯の遅い回線で最初の画面が遅いと、読む前に離れられるため（SR-HOME-004、全体の NFR-PERF-002 の「ページ表示 2 秒未満」をホームに当てはめた） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページの初回表示速度を 2 秒以内に収める（モバイル 3G 相当の環境を想定）。

### NFR-HOME-002 ホームの色のコントラストを WCAG 2.1 AA にする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-HOME-005 |
| 根拠 | 写真の上の白い字や灰色の本文は、背景しだいで読めなくなるため（SR-HOME-005、全体の NFR-A11Y-001 の最低ライン） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.1 ホームページ（HOME）」節） |

ホームページは WCAG 2.1 AA を満たす色彩コントラストを確保する。

今のコード: ヒーローの字は白で、写真の上下を暗くする重ねを敷く。ABOUT の本文はブランドの色 Graphite Grey（#474747）。

## 受け入れ条件

### 要求の表から写した受け入れ条件

文は `requirements.md` の受け入れ条件の欄のまま（FREQ-280-AC-01 だけ、コードの書き方を言葉に直した）。

### FREQ-147-AC-01 390・768px で ITEM が最大6件出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147-REQ-02 |
| 根拠 | FREQ-147-REQ-02 の狭い幅の表示数を、2つの幅で数えて確かめる。この数は FREQ-276 の後も同じ6件 |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

mobile（390px）/ tablet（768px）で ITEM カードが最大6件表示されること

### FREQ-147-AC-02 1280px で ITEM が最大10件出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147-REQ-01、FREQ-147-REQ-02 |
| 根拠 | FREQ-147-REQ-02 の広い幅の表示数と、FREQ-147-REQ-01 の描く件数の上限（10件）を、広い幅で数えて確かめる。ただし FREQ-276 の後は 1280px（2xl 未満）で6件になり、E2E `FR-HOME-013` も6件で試す（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

desktop（1280px）で ITEM カードが最大10件表示されること

### FREQ-147-AC-03 総数が表示数以下の幅では ITEM の VIEW ALL が無く、多ければある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-147-REQ-03 |
| 根拠 | FREQ-147-REQ-03 の条件の両側（以下・より多い）で、VIEW ALL の有無を確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-147 の行） |

公開 ITEM の総数が表示数以下の帯域では VIEW ALL ボタンが表示されず、表示数より多い帯域では表示されること

### FREQ-148-AC-01 390・768px で LOOK が最大6件出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148-REQ-02 |
| 根拠 | FREQ-148-REQ-02 の狭い幅の表示数を、2つの幅で数えて確かめる。この数は FREQ-277 の後も同じ6件 |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

mobile（390px）/ tablet（768px）で LOOK カードが最大6件表示されること

### FREQ-148-AC-02 1280px で LOOK が最大8件出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148-REQ-01、FREQ-148-REQ-02 |
| 根拠 | FREQ-148-REQ-02 の広い幅の表示数と、FREQ-148-REQ-01 の描く件数の上限（8件）を、広い幅で数えて確かめる。ただし FREQ-277 の後は 1280px（2xl 未満）で6件になり、E2E `FR-HOME-013` も6件で試す（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

desktop（1280px）で LOOK カードが最大8件表示されること

### FREQ-148-AC-03 総数が表示数以下の幅では LOOK の VIEW ALL が無く、多ければある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-148-REQ-03 |
| 根拠 | FREQ-148-REQ-03 の条件の両側で、VIEW ALL の有無を確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-148 の行） |

公開 LOOK の総数が表示数以下の帯域では VIEW ALL ボタンが表示されず、表示数より多い帯域では表示されること

### FREQ-278-AC-01 3つの幅で h1 が1文字1つの span に分かれ、動きの後は全部見える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-01 |
| 根拠 | FREQ-278-REQ-01 を、span の数と動きが終わった後の見え方で確かめる。ただし今のコードの終わりの transform は translateY(0) で、算出値は none ではなく単位の行列になる。E2E も単位の行列で試す（文との食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、h1 が1文字につき1つの span に分割されており、モーション完了後はすべての span の opacity が 1 かつ transform が none であること

### FREQ-278-AC-02 3つの幅で縦線の動きの名前が threadDraw

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-02 |
| 根拠 | FREQ-278-REQ-02 を動きの名前で確かめる。ただし今の縦線は heroThreadLoop（FREQ-282）で、この条件は満たさない。E2E もこの条件を試していない（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、縦線の animation-name が threadDraw であること

### FREQ-278-AC-03 3つの幅で h1 の字の大きさが 6xl の算出値と同じ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-03 |
| 根拠 | FREQ-278-REQ-03 を、h1 の算出した字の大きさと決まった段の値を比べて確かめる。クラスの名前を見るだけでは、共有の CSS が変わっても大きさが保たれた証拠にならないので、描いた後の算出値で比べる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、h1 の font-size が --lk-size-6xl の算出値と一致すること

### FREQ-278-AC-04 名前が「Le Fil des Heures」の見出しがちょうど1つ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-04 |
| 根拠 | FREQ-278-REQ-04 を、読み上げが使う見出しの名前で確かめる。1文字ずつに分かれていれば名前で見つからない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

ホームで、名前が「Le Fil des Heures」の heading ロールがちょうど1つ取得できること

### FREQ-278-AC-05 動きを減らす設定で文字は最初から見え、縦線は止まる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-05 |
| 根拠 | FREQ-278-REQ-05 を、設定を有効にした時の文字の移り変わりの時間・濃さと、縦線の動きの名前で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

reduce を有効にしたとき、文字の transition-duration が 0s かつ opacity が 1、縦線の animation-name が none であること

### FREQ-278-AC-06 3つの幅で縦線は1回だけ再生し、終わりの形を保つ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-278-REQ-06 |
| 根拠 | FREQ-278-REQ-06 を、繰り返しの回数と終わりの扱いで確かめる。ただし今の縦線は無限に繰り返し（FREQ-282）、この条件は満たさない。E2E もこの条件を試していない（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-278 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、縦線の animation-iteration-count が 1、animation-fill-mode が both であること

### FREQ-280-AC-01 本番ビルドのホームで、style 属性で当てた価格の字の大きさが崩れない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-280-REQ-01 |
| 根拠 | FREQ-280-REQ-01 を、style 属性で字の大きさを当てた物（ITEM のカードの価格）が本番の CSP の下でも効いていることで確かめる。元の文はコードの書き方で書かれているので、言葉に直した |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行） |

本番ビルドのホームで、style 属性で --lk-size-2xs を当てて描く価格の font-size が、--lk-size-2xs の算出値と一致すること

### FREQ-280-AC-02 本番の応答の CSP に style-src-elem があり、'unsafe-inline' を含まない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-280-REQ-02 |
| 根拠 | FREQ-280-REQ-02 を、本番の応答の見出しの値で確かめる。開発のサーバーだけ `'unsafe-inline'` を足すので、本番の応答で見ないと締まりを確かめられない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行） |

本番のレスポンスヘッダに style-src-elem が含まれ、その値に 'unsafe-inline' が入っていないこと

### FREQ-282-AC-01 縦線が上端から無限に伸び、途中で消えない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-282-REQ-01 |
| 根拠 | FREQ-282-REQ-01 を、動きの名前・回数・起点と、1回りの間の高さと濃さで確かめる。要件の中心は繰り返しの途中で線が消えないことなので、1回りを通して値を見る |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-282 の行） |

ホームの .hero-thread の animation-name が heroThreadLoop、animation-iteration-count が infinite、transform-origin の Y が上端（0px）で、1 サイクルを通して描画高さが常に 0 より大きく opacity が常に 1 であること

### FREQ-282-AC-02 動きを減らす設定で縦線の動きが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-282-REQ-02 |
| 根拠 | FREQ-282-REQ-02 を、設定を有効にした時の動きの名前で確かめる。動きを減らす設定は利用者の端末の設定なので、設定を有効にした状態の動きの名前で見る |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-282 の行） |

reduce 指定時に .hero-thread の animation-name が none であること

### FREQ-283-AC-01 SCROLL の字の色と縦線の色が白の 90%

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-283-REQ-01 |
| 根拠 | FREQ-283-REQ-01 を、算出した色の値で確かめる。見た目の濃さは写真で揺れて目では決められないので、算出した色の alpha で決める |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-283 の行） |

ホームの SCROLL ラベルの color と .hero-thread の background-color が、いずれも白かつ alpha 0.9 であること

### 新しく起こした受け入れ条件

`FR-HOME-`・`NFR-HOME-` には受け入れ条件が無かったので、要件の文から起こした。

### FR-HOME-001-AC-01 3つの幅で最初の画面いっぱいにヒーローの画像が出て、ブランド名の h1 が重なる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-001 |
| 根拠 | FR-HOME-001 の「全画面」「世界観を伝える大きな画像」を、画像が最初の画面の高さを満たし、その上に名前の見出しがあることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 要件の文から起こした（FR-HOME-001） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、ホームを開いた最初の画面の高さいっぱいにヒーローの画像（代替テキストのある img）が出て、その上にブランド名「Le Fil des Heures」の h1 が見えること。

### FR-HOME-002-AC-01 3つの幅で ITEMS・LOOK・NEWS・ABOUT の区画が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-002 |
| 根拠 | FR-HOME-002 の4つの区画を、区画の見出しが全部見えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 要件の文から起こした（FR-HOME-002） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、ホームを下へ読むと ITEMS・LOOK・NEWS・ABOUT の見出し（h2）の区画がすべて表示されること。

### FR-HOME-003-AC-01 ABOUT の区画のリンクから /about が開く

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-003 |
| 根拠 | FR-HOME-003 の導線を、リンクが有ることと押して移れることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 要件の文から起こした（FR-HOME-003） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、ホームの ABOUT の区画に `/about` へのリンクがあり、押すと `/about` が開くこと。

### FR-HOME-004-AC-01 ITEM・LOOK・NEWS の区画の末尾から各一覧へ移れる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-004 |
| 根拠 | FR-HOME-004 の「末尾に置き、一覧へ移れる」を、3つの区画の末尾のリンクの行き先で確かめる。総数が表示数以下でボタンが隠れる時の扱いは決まっていない（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-004） |

ITEM・LOOK・NEWS の各区画の末尾に、それぞれ `/item`・`/look`・`/news` へのリンク（VIEW ALL）があり、押すとその一覧が開くこと。

### FR-HOME-005-AC-01 ホームの取扱店は6件以下

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-005 |
| 根拠 | FR-HOME-005 の「最大6件」を、公開の取扱店が多い時もホームの区画の店が6件を超えないことで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-005） |

ホームに取扱店の区画が表示され、公開の取扱店が7件以上あっても、区画に出る店が1件以上6件以下であること。

### FR-HOME-006-AC-01 ホームの title と description がホーム用の文

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-006、NFR-SEO-003（範囲外） |
| 根拠 | FR-HOME-006 の「ホーム固有」を、既定の文でなくブランドの名前と説明が入っていることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-006） |

ホームの title に「Le Fil des Heures」が入り、meta の description が空でなく、Next.js の既定の文（Create Next App・Generated by create next app）でないこと。

### FR-HOME-007-AC-01 ヒーロー画像の先読みがあり、遅延読み込みでない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-007 |
| 根拠 | FR-HOME-007 の「プリロード」を、HTML の先読みの指示と画像の読み込みの属性で確かめる。LCP の値そのものは環境で揺れるので条件にしない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-007） |

ホームの HTML に `/mainphoto.png` の画像の preload の link があり、ヒーローの img が遅延読み込み（loading の lazy）でないこと。

### FR-HOME-008-AC-01 ABOUT の画像が手元の画像から読まれる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-008 |
| 根拠 | FR-HOME-008 の「外部 URL への依存を排除」を、画像の読み込み先がこのサイトの手元の画像であることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-008） |

ホームの ABOUT の区画の画像が1つ表示され、その読み込み先が手元の `/about.png`（next/image の最適化を通した物を含む）で、外のドメインを指していないこと。

### FR-HOME-009-AC-01 h1 がちょうど1つで、5つの区画の見出しが h2

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-009 |
| 根拠 | FR-HOME-009 の見出しの段を、h1 の数と区画の見出しの段で確かめる。読み上げの利用者は見出しの段で区画を辿るので、h1 が2つ以上になる・段が飛ぶ崩れを数で見つける |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-HOME-009） |

ホームの h1 がちょうど1つで、ITEMS・LOOK・NEWS・ABOUT・STOCKIST の区画の見出しがすべて h2 であること。

### NFR-HOME-001-AC-01 携帯の 3G 相当の回線でホームの読み込みが2秒以内に終わる

| 属性 | 値 |
| --- | --- |
| 上位 | NFR-HOME-001 |
| 根拠 | NFR-HOME-001 の「モバイル 3G 相当で 2 秒以内」を、回線を模した条件で読み込みの終わりまでの時間を測って確かめる。今の E2E は回線を模していない（食い違い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（NFR-HOME-001） |

mobile（390px）で 3G 相当の回線を模した条件のもと、ホームを開いてから読み込み（load）が終わるまでが 2 秒以内であること。

### NFR-HOME-002-AC-01 ヒーローと ABOUT の字のコントラスト比が AA の基準を満たす

| 属性 | 値 |
| --- | --- |
| 上位 | NFR-HOME-002、NFR-A11Y-001（範囲外） |
| 根拠 | NFR-HOME-002 の「WCAG 2.1 AA」を、字の色と背景の色の比で確かめる（WCAG 1.4.3）。今の E2E は字が白いことと重ねが見えることだけを見て、比そのものは測っていない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（NFR-HOME-002） |

ホームのヒーローのブランド名と SCROLL の字、ABOUT の本文の字について、字の色と背景の色のコントラスト比が、普通の字で 4.5:1 以上、大きな字で 3:1 以上であること。

## セキュリティ要件

脅威の文書（`docs/05_Quality/security/threats/home.md`）の `THR-HOME-001`〜`020` の対策（`011`・`012`・`019` は検索の窓の話で、持ち主の SEARCH の要件に移したので廃止）。上位に書ける種類は `THR-` だけなので、全体の要件 `NFR-SEC-001`〜`012` は根拠に `（範囲外）` の印で書いた。今のコードが満たさない所は各項目の本文に（TM-HOME-NN）で指し、`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる。

### SEC-HOME-001 ホームは公開済みの商品・LOOK・NEWS・取扱店だけを出す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-001 |
| 根拠 | 発表前の物をホームで先に知られないため。DB の RLS とアプリの取り出しの絞りの2段で守り、片方が崩れても漏れないようにする（過去のレビューが「Fixed」とした形）。全体の NFR-SEC-005（範囲外）（権限管理）をホームの公開の線引きに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | MUST |

ホームが集める7つの取得は、どれも `status='published'` の行だけを返す。今のコードは満たす（`getPublishedItems`・`getPublishedItemsCount`（`src/lib/items/public.ts`）、`getPublishedLooks`・`getPublishedLooksCount`（`src/lib/look/server.ts`）、`getPublishedNews`・`getPublishedNewsCount`（`src/features/news/services/public.ts`）、`getHomePublicStockists`（`src/features/stockist/services/public.ts`）が、どれも公開済みの印で絞る）。ホームで下書きが出ないことを試すテストは無い（TM-HOME-29）。

#### SEC-HOME-001-AC-01 未ログインのホームに下書きの物が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-001 |
| 根拠 | 閲覧者の見える所で、4種類の下書きのどれもホームに出ないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に下書きの商品・LOOK・NEWS・取扱店を1件ずつ入れる。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

下書きの4件を入れた状態で未ログインでホームを開くと、4件の名前・題のどれも表示されないこと。

#### SEC-HOME-001-AC-02 下書きを読める管理者のホームにも下書きの物が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-001 |
| 根拠 | 管理者の session では RLS が下書きを許すので、アプリの絞りの段だけで守れていることを確かめるため（THR-HOME-002） |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.items.read`・`admin.stockists.read` を持つ試し用の管理者を、Google OAuth の Cookie（`sb-<ref>-auth-token`）付きで用意する。メール・パスワードのログインは `sb-access-token` だけを付け、ホームの読みが anon の権限のまま動くので、この AC を確かめられない。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

下書きの4件を入れた状態で、上の管理者でホームを開くと、4件の名前・題のどれも表示されないこと。

### SEC-HOME-002 ホームの公開の読みは、閲覧者の session を引き継がない公開の client で行う

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-002 |
| 根拠 | 公開の読みを閲覧者の権限から切り離し、絞りが1つ落ちても管理者の権限で下書きが読まれないようにするため。LOOK・NEWS は既にこの形で、ITEM・取扱店だけが外れている。全体の NFR-SEC-005（範囲外）の最小権限に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

ホームの商品・商品の総数・取扱店の読みは、Cookie の session を持たない公開の client（anon の権限）で行う。今のコードは満たさない（TM-HOME-30）。

#### SEC-HOME-002-AC-01 管理者でも未ログインでも、ホームの商品と取扱店の中身が同じ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-002 |
| 根拠 | 読みが閲覧者の権限によらないことを、結果が変わらないことで確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（下書きの商品・取扱店を入れ、未ログインと、`admin.items.read`・`admin.stockists.read` を持ち Google OAuth の Cookie（`sb-<ref>-auth-token`）付きで用意した管理者でホームを開いて比べる。パスワードのログインの管理者では読みが anon の権限のままで、差が出ない。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

未ログインと管理者で、ホームの ITEM の節のカードの名前の並び、VIEW ALL の表示の有無、STOCKIST の節の店の名前の並びが同じであること。

### SEC-HOME-003 ホームに出る商品の表で管理の権限を使う操作は、DB でも2要素認証の済みを求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-003 |
| 根拠 | パスワードだけで得た session で PostgREST を直接叩き、アプリの窓口の aal2 の確かめを飛ばされないため。ホームの見た目の改ざんの道を閉じる。全体の NFR-SEC-008（範囲外）（RBAC）と FREQ-540（範囲外）（DB の ACL・session・aal2 で管理操作を守る）をホームに出る商品の表に当てはめた。表の持ち主が範囲内にある `looks`・`look_items`・`stockists` は、持ち主の SEC を正にして、ここには書かない（二重に書くと文がずれるため） |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1 |
| 優先度 | MUST |

`items` の RLS のうち `admin.items.read`・`admin.items.manage` で許す方針は、JWT の `aal` が `aal2` の時だけ許す。今のコードは満たさない（TM-HOME-31）。`looks`・`look_items` は LOOK の SEC-LOOK-003、`stockists` は STOCKIST の SEC-STOCKIST-003 が同じ形で持つ。

#### SEC-HOME-003-AC-01 aal1 の session では下書きの商品を直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-003 |
| 根拠 | 2要素認証を済ませていない session で、下書きの商品の読み出しに届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.items.read` を持つ試し用の利用者の aal1 の JWT で、手元の Supabase の `items` を select する） |
| 出どころ | 実装から推定 |

aal1 の JWT で select した時、下書きの商品の行が結果に含まれないこと。

#### SEC-HOME-003-AC-02 aal1 の session ではホームに出る商品の行を直接書き換え・消去できない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-003 |
| 根拠 | 改ざんと消去の道も、読み出しと同じく aal2 で閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.items.manage` を持つ試し用の利用者の aal1 の JWT で `items` に update・delete を送り、その後ホームを開く） |
| 出どころ | 実装から推定 |

aal1 の JWT の update・delete が行を変えずに終わり（権限の誤りか0件）、その後のホームに元の名前のまま表示されること。

### SEC-HOME-004 anon と一般会員が直接読める商品の列は、公開の画面で出す列だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-004 |
| 根拠 | 原価と内部の注記を、ブラウザに出ている anon の鍵で読ませないため。RLS は行しか絞れないので、列は権限で絞る。注文の表で列を絞った前例（`supabase/migrations/20260927100900_hide_internal_order_columns.sql`）に合わせる。全体の NFR-SEC-005（範囲外）の最小権限に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3 |
| 優先度 | MUST |

`items` の `pattern_cost`・`mass_production_cost`・`product_note` は、anon・authenticated に SELECT を許さない（列の単位の権限で外す）。今のコードは満たさない（TM-HOME-32）。

#### SEC-HOME-004-AC-01 anon の鍵で商品の原価と注記を読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-004 |
| 根拠 | 誰でも持てる鍵で原価に届かないことを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の公開済みの商品に原価を入れ、anon の鍵と一般会員の JWT で3つの列を select する） |
| 出どころ | 実装から推定 |

anon の鍵と一般会員の JWT の select が、どちらも権限の誤りで終わり、原価の値が返らないこと。

#### SEC-HOME-004-AC-02 列を絞ってもホームの商品の節が出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-004 |
| 根拠 | 列の権限を絞ると、公開の読みが原価の列を選んでいた時に節が空になるので、画面が崩れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

未ログインでホームを開くと、ITEM の節に公開済みの商品のカードが1件以上表示されること。

### SEC-HOME-005 ホームに出る商品の表の anon・authenticated の権限は、使う物だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-005 |
| 根拠 | RLS の方針を1つ書き違えた時に、守りが無くならないようにするため。在庫の表で「剥がしてから付け直す」とした形（`supabase/migrations/20260919065336_add_variant_inventory_tables.sql`）に合わせる。全体の NFR-SEC-005（範囲外）に当てはめた。表の持ち主が範囲内にある `looks`・`look_items`・`stockists` は、持ち主の SEC を正にして、ここには書かない |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3 |
| 優先度 | SHOULD |

`items` は、anon に SELECT だけを、authenticated に SELECT と管理の権限の方針が要る INSERT・UPDATE・DELETE だけを付ける。TRUNCATE・TRIGGER・REFERENCES・MAINTAIN は付けない。今のコードは満たさない（TM-HOME-33）。`looks`・`look_items` は LOOK の SEC-LOOK-004、`stockists` は STOCKIST の SEC-STOCKIST-008 が同じ形で持つ。

#### SEC-HOME-005-AC-01 anon の鍵でホームに出る商品の行を書き換え・消去できない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-005 |
| 根拠 | anon の書きの道が、方針でも権限でも閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に anon の鍵で `items` の insert・update・delete を送り、その後ホームを開く） |
| 出どころ | 実装から推定 |

anon の鍵の insert・update・delete が、どれも権限の誤りで終わり、その後のホームの表示が変わらないこと。

### SEC-HOME-006 service role で読む・署名するのは、公開済みの商品の物だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-006 |
| 根拠 | service role の道は RLS を通らないので、公開済みの絞りと、道筋が置き場の商品の画像の下にあるかの確かめを、アプリの側で持つため。在庫の有無だけを出し、実数は出さない（FREQ-400（範囲外）の形） |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。service role の読みが RLS を通らないことから起こした |
| 優先度 | SHOULD |

在庫の読みは公開済みの商品の id だけで行い、返すのは在庫の有無だけにする。画像の署名は、置き場 `item-images` の商品の画像の道筋だけに行い、道筋にできない値と署名の失敗は画像を出さない（元の値をそのまま返さない）。今のコードは在庫の側を満たし、署名の側を満たさない（TM-HOME-34）。

#### SEC-HOME-006-AC-01 下書きの商品の在庫がホームの応答に出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-006 |
| 根拠 | service role の在庫の読みでも、公開済みの絞りが効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（下書きの商品に在庫を入れ、ホームの HTML を読む。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームの HTML に、下書きの商品の名前と在庫の表示が含まれないこと。在庫の数そのものが HTML に含まれないこと。

#### SEC-HOME-006-AC-02 置き場の道筋でない画像の住所はホームに出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-006 |
| 根拠 | 書き換えられた `image_url` で、外の住所や置き場の別の物がホームから配られないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（公開済みの商品の `image_url` を外の住所にした状態でホームを開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

その商品のカードの画像の `src` に、入れた外の住所が含まれないこと。

### SEC-HOME-007 ホームに出す商品の画像の署名は、短い期限にする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-007 |
| 根拠 | 誤って公開した商品を戻した時に、画像が見える時間を短くするため。LOOK・NEWS の1時間とそろえる案。過去のレビューは5〜60分を提案した |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

ホームに出す商品の画像の署名つき URL の期限は1時間以下にする（値は案）。LOOK のカードの関連商品の画像も、LOOK の取得（`src/lib/look/server.ts` の `hydrateLooks`）が ITEM の同じ署名（`signItemImageUrl`）を通すので、この対象に入る。今のコードは満たさない（TM-HOME-35）。

#### SEC-HOME-007-AC-01 ホームの商品の画像の署名の期限が1時間以下

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-007 |
| 根拠 | 応答の中の署名つき URL の期限を、利用者の受け取る形で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（ホームの商品の画像の元の URL の署名の token を読む。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームの商品のカードの画像と、LOOK のカードの関連商品の画像の署名つき URL の期限が、開いた時から1時間以内であること。

### SEC-HOME-008 ホームは生の HTML を描かず、CSP で差し込みを止める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-008 |
| 根拠 | 中身に仕込まれた文でスクリプトや `<style>` が動かないようにするため。React の逃がしと CSP の2段で守る。style の属性だけは、`TextReveal` の動きと、区画の字の大きさ（ITEM の価格・SCROLL・ABOUT の本文など）のために許す（FREQ-280）。全体の NFR-SEC-003（範囲外）（XSS 対策・CSP）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V14.4.3。`docs/05_Quality/reviews/code/2026-04-18-home-review.md` |
| 優先度 | MUST |

ホームの画面とその部品は生の HTML を描かない。`/` の応答の CSP は script に nonce を求め、`style-src-elem` に `'unsafe-inline'` を入れない。今のコードは満たす（`src/proxy.ts` の `buildCsp` が組み立てる `script-src` と `style-src-elem`）。ホームで中身の文が動かないことを試すテストは無い（TM-HOME-36）。

#### SEC-HOME-008-AC-01 商品名に仕込んだスクリプトがホームで動かない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-008 |
| 根拠 | 中身の文がホームで字として出て、スクリプトとして動かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（公開済みの商品名と NEWS の題に `<img src=x onerror=…>` の形の文を入れてホームを開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

入れた文がカードに字のまま表示され、`onerror` が動かず、ダイアログ・端末の記録の変化が起きないこと。

#### SEC-HOME-008-AC-02 ホームの応答の CSP が script に nonce を求める

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-008 |
| 根拠 | CSP の段が `/` に効いていることを、応答の見出しで確かめるため。`style-src-elem` の側は FREQ-280-AC-02 が試す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/` の応答の `Content-Security-Policy` の `script-src` に `'nonce-` が含まれ、`'unsafe-inline'` が含まれないこと。

### SEC-HOME-009 CSP の外の許可は、使う物だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-009 |
| 根拠 | 使わない CDN を許すと、そこが乗っ取られた時に全部の頁でスクリプトが動くため。外の物を読む時は SRI で中身を確かめる。全体の NFR-SEC-003（範囲外）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V14.2.3。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

CSP の `script-src`・`style-src`・`style-src-elem`・`font-src` に、アプリが読まない外の場所（今は `https://cdn.jsdelivr.net`）を入れない。`connect-src`・`img-src` の Supabase は自分のプロジェクトの場所だけにする。今のコードは満たさない（TM-HOME-37）。

#### SEC-HOME-009-AC-01 ホームの応答の CSP に使わない CDN が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-009 |
| 根拠 | 許可の広さを応答の見出しで確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/` の応答の `Content-Security-Policy` に `cdn.jsdelivr.net` が含まれないこと。`connect-src` に `https://*.supabase.co` の形の総当たりの許可が含まれないこと。

#### SEC-HOME-009-AC-02 CDN の許可を外してもホームの見た目と動きが崩れない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-009 |
| 根拠 | 許可を絞った時に、CSP の違反で字体・スクリプトが落ちないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームを開いた時に CSP の違反の記録が出ず、h1 のブランド名と5つの節の見出しが表示されること。

### SEC-HOME-010 ホームの応答に守りの見出しを付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-010 |
| 根拠 | ホームを枠に埋めて操作を誘う攻撃、種類の取り違え、平文への格下げ、元の住所の漏れを止めるため。過去のレビューの High の指摘を直した形を保つ。全体の NFR-SEC-001（範囲外）（TLS・HSTS）・NFR-SEC-003（範囲外）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V14.4.4、V14.4.5、V14.4.6、V14.4.7。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | MUST |

`/` の応答に `frame-ancestors 'none'` を含む CSP・`X-Frame-Options: DENY`・`X-Content-Type-Options: nosniff`・`Strict-Transport-Security`・`Referrer-Policy` を付ける。今のコードは満たす（`src/proxy.ts` の `proxy` が全部の応答に CSP の `frame-ancestors` と守りの見出しを付け、`config.matcher` が全部の道を対象にする）。`/` の応答で試すテストは無い（TM-HOME-38）。

#### SEC-HOME-010-AC-01 ホームの応答に守りの見出しがある

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-010 |
| 根拠 | 共有の部品が `/` にも見出しを付けていることを、応答で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/` の応答に、`frame-ancestors 'none'` を含む `Content-Security-Policy`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`max-age` を含む `Strict-Transport-Security`、`Referrer-Policy: no-referrer` があること。

#### SEC-HOME-010-AC-02 ほかのサイトの枠の中にホームが表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-010 |
| 根拠 | 見出しがブラウザで実際に効くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（別のオリジンの試しの頁に `/` を iframe で置く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

iframe の中にホームの h1 が表示されないこと。

### SEC-HOME-011 ホームの検索の窓の回数の制限は、偽れない送り元で数える

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-011 |
| 根拠 | 検索の窓の回数の制限は `/api/search` と共有の回数の制限の部品の話で、持ち主は SEARCH。同じ要件を2つの領域に書くと「今のコードは満たさない」が二重になり、片方を直した時にもう片方が古くなる。そこで SEARCH の SEC-SEARCH-006 を正にして、こちらは廃止にした。番号は使い回さないので項目は残す |
| 状態 | 廃止 |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/security/security_review_home.md`。移した先: `docs/02_Requirements/areas/search.md` の SEC-SEARCH-006 |

SEARCH の SEC-SEARCH-006 が持つ。満たすかどうかと確かめ方はそちらに書く。

#### SEC-HOME-011-AC-01 送り元の見出しを変えても検索の窓の回数の制限が効く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-011 |
| 根拠 | 親の SEC-HOME-011 が持ち主の SEARCH の SEC-SEARCH-006 へ移って廃止になったため、この受け入れ条件も廃止にした。確かめる中身は SEC-SEARCH-006 の受け入れ条件が持つ |
| 状態 | 廃止 |
| 出どころ | 実装から推定 |

SEC-SEARCH-006 の受け入れ条件を見る。

### SEC-HOME-012 検索の窓の応答は、中継に残さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-012 |
| 根拠 | 検索の窓の応答の指定は `/api/search` の話で、持ち主は SEARCH。HOME は `no-store` と `/api/search` だけを書いていたが、SEARCH の SEC-SEARCH-010 は `private, no-store` と `/api/suggest` も求める。文がずれるので SEC-SEARCH-010 を正にして、こちらは廃止にした。番号は使い回さないので項目は残す |
| 状態 | 廃止 |
| 出どころ | OWASP ASVS 4.0.3 V8.2.1。`docs/05_Quality/reviews/security/security_review_home.md`。移した先: `docs/02_Requirements/areas/search.md` の SEC-SEARCH-010 |

SEARCH の SEC-SEARCH-010 が持つ。満たすかどうかと確かめ方はそちらに書く。

#### SEC-HOME-012-AC-01 検索の窓の応答に no-store がある

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-012 |
| 根拠 | 親の SEC-HOME-012 が持ち主の SEARCH の SEC-SEARCH-010 へ移って廃止になったため、この受け入れ条件も廃止にした。確かめる中身は SEC-SEARCH-010 の受け入れ条件が持つ |
| 状態 | 廃止 |
| 出どころ | 実装から推定 |

SEC-SEARCH-010 の受け入れ条件を見る。

### SEC-HOME-013 ホームの1回の表示の呼び出しを抑え、大量の表示で止まらないようにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-013 |
| 根拠 | `force-dynamic` で頁の結果のキャッシュが使えない（CSP の nonce のため）ので、1回の表示の重さと、記憶の増え方に上限を持つため。描かない件数を取らない |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け |
| 優先度 | SHOULD |

ホームは、描く件数と続きの有無の判定に要る件数より多く取らない（商品は描く8件と判定の1件）。署名つき URL を残す表に件数の上限を持つ。大量の表示への守り（中継の回数の制限など）を本番の前に決める。今のコードは満たさない（TM-HOME-41）。

#### SEC-HOME-013-AC-01 ホームは描く件数だけ商品を取る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-013 |
| 根拠 | むだな取得と署名を、利用者の受け取る HTML で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（公開済みの商品を10件以上入れ、ホームの HTML を読む。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームの HTML に含まれる商品の数が、ITEM の節で描く上限（8件）以下であること。

### SEC-HOME-014 ホームは1つの取得の失敗で全体を落とさず、失敗を記録する

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-014 |
| 根拠 | 設定の誤りや1つの領域の障害で、ホームの全部が開けなくならないため。逆に全部が黙って空になった時に気づけるようにする（BUG-PUBLIC-001 の再発に備える） |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。`docs/04_DetailDesign/pages/01_home.md` |
| 優先度 | SHOULD |

7つの取得のどれかが例外を投げても、ほかの節は描く。失敗した節は空にし、サーバーの記録に失敗を残す。今のコードは満たさない（TM-HOME-42）。

#### SEC-HOME-014-AC-01 1つの領域の取得が失敗してもホームのほかの節が出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-014 |
| 根拠 | 頁ごとの失敗にならないことを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で NEWS の表の読みを止めた状態でホームを開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームの応答が 200 で、h1 のブランド名と ITEM・LOOK・ABOUT・STOCKIST の節の見出しが表示されること。

### SEC-HOME-015 失敗の記録に、DB の誤りの中身を丸ごと出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-015 |
| 根拠 | 表の名前・列・問い合わせの形を、記録や閲覧者の端末から知られないため。全体の NFR-SEC-010（範囲外）（マスキング）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

ホームが呼ぶ取得の失敗の記録は、誤りの番号と短い文だけにする。端末の側の検索の窓は、失敗の中身を端末の記録に出さない。今のコードは満たさない（TM-HOME-43）。

#### SEC-HOME-015-AC-01 検索の窓の失敗が端末の記録に中身を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-015 |
| 根拠 | 閲覧者の端末に出る記録を、利用者の受け取る形で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`/api/search` を 500 にした状態で `?q=` 付きでホームを開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

端末の記録に、応答の中身・誤りの積み重ね（stack）が出ないこと。

### SEC-HOME-016 ホームを開くだけでは、要らない個人の情報を流さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-016 |
| 根拠 | 画面が使わない id・メールの住所を、ホームを開くたびに端末へ流さないため。全体の NFR-SEC-010（範囲外）（個人情報のマスキング）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

ホームを開いた時に呼ぶ認証の状態の窓口は、画面が使う項目（ログインの有無・役割・2要素認証の済み）だけを返す。今のコードは満たさない（TM-HOME-44）。

#### SEC-HOME-016-AC-01 ホームを開いた時の認証の状態の応答に、メールの住所が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-016 |
| 根拠 | ホームで流れる応答の中身を確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（会員でログインしてホームを開き、`/api/auth/me` の応答を見る。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームを開いた時の `/api/auth/me` の応答に、その会員のメールの住所が含まれないこと。

### SEC-HOME-017 画像の最適化と CSP の画像の許可は、使う場所だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-017 |
| 根拠 | 他人の画像のためにサーバーの処理を使われない、乗っ取られた外の場所の画像をホームに出さないため。ホームは手元の画像と自分の Supabase の画像だけを使う |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V12.6.1。`docs/05_Quality/reviews/security/security_review_home.md` |
| 優先度 | SHOULD |

`next.config.ts` の `remotePatterns` と CSP の `img-src` に、使わない場所（`placehold.co`・`readdy.ai`・`public.readdy.ai`）と、自分のでない Supabase のプロジェクトを入れない。今のコードは満たさない（TM-HOME-45）。

#### SEC-HOME-017-AC-01 許していない場所の画像を最適化の中継に通せない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-017 |
| 根拠 | 許可の広さを、最適化の中継の応答で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`/_next/image` に `readdy.ai` と別の Supabase のプロジェクトの住所を渡す） |
| 出どころ | 実装から推定 |

どちらの要求も 400 で終わり、画像が返らないこと。

#### SEC-HOME-017-AC-02 許可を絞ってもホームの画像が出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-017 |
| 根拠 | 許可を絞った時に、ホームのヒーロー・ABOUT・商品・LOOK の画像が落ちないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームのヒーローの画像、ABOUT の画像、商品と LOOK のカードの画像が、どれも読み込みを終えて表示されること。

### SEC-HOME-018 ホームの OG と頁の住所は、本番のサイトの住所から作る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-018 |
| 根拠 | 共有した時のカードの画像が、別のドメインや `localhost` を指さないため。本番で設定が欠けた時は黙って `localhost` にせず、気づけるようにする |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。サイトの住所の設定の欠けから起こした |
| 優先度 | SHOULD |

ホームの `og:image` と `metadataBase` は、本番のサイトの住所の設定から作る。本番の構成で設定が無い時は、`http://localhost:3000` を使わずに起動か build を止める。今のコードは満たさない（TM-HOME-46）。

#### SEC-HOME-018-AC-01 ホームの OG の画像の住所がサイトの住所を指す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-018 |
| 根拠 | 共有のカードの住所を、頁の HTML で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

ホームの `og:image` の住所のオリジンが、設定したサイトの住所のオリジンと同じで、末尾が `/mainphoto.png` であること。

### SEC-HOME-019 ホームの検索の窓は、URL の検索語を店の案内の文の中に埋めて出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-019 |
| 根拠 | 検索の窓は SEARCH の部品で、同じ道を SEARCH が SEC-SEARCH-021（THR-SEARCH-021）で持つようになった。HOME で起こした時の「SEARCH に同じ道の項目が無い」は今は誤りで、二重に書くと文がずれるので、SEC-SEARCH-021 を正にして、こちらは廃止にした。番号は使い回さないので項目は残す |
| 状態 | 廃止 |
| 出どころ | 実装から推定（`src/features/search/components/SearchHomePreview.tsx`）。移した先: `docs/02_Requirements/areas/search.md` の SEC-SEARCH-021 |

SEARCH の SEC-SEARCH-021 が持つ。満たすかどうかと確かめ方はそちらに書く。

#### SEC-HOME-019-AC-01 URL に入れた案内の形の文が、ホームの検索の窓の案内の文に出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-019 |
| 根拠 | 親の SEC-HOME-019 が持ち主の SEARCH の SEC-SEARCH-021 へ移って廃止になったため、この受け入れ条件も廃止にした。確かめる中身は SEC-SEARCH-021 の受け入れ条件が持つ |
| 状態 | 廃止 |
| 出どころ | 実装から推定 |

SEC-SEARCH-021 の受け入れ条件を見る。

### SEC-HOME-020 原価の履歴の表 `item_cost_history` は、誰にも直接読み・書き・消させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-HOME-020 |
| 根拠 | 原価の履歴（`pattern_cost`・`mass_production_cost`・`pdf_url`）は内部の情報なのに、全員（PUBLIC）に無条件で許す方針と、anon・authenticated への全部の権限が重なっていて、RLS と権限のどちらの段も閉じていない。ホームが読む表ではないが、商品の原価（SEC-HOME-004）と同じ内部の情報の道で、表の持ち主（ITEM・ADMIN）の文書に項目が無かったので、見つけた HOME が起こした。全体の NFR-SEC-005（範囲外）の最小権限に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3。実装から推定（`supabase/migrations/20260901102912_remote_schema.sql` の読み直し） |
| 優先度 | MUST |

`item_cost_history` に「誰でも」を許す方針を置かず、anon と一般会員に権限を付けない。管理の画面が使うなら、`admin.items.*` の権限の方針で authenticated にだけ、2要素認証の済み（aal2）を求めて許す（SEC-HOME-003 と同じ形）。この表を使うコードは `src/` に無い（推定。移行の外に参照が無い）ので、使わないなら権限と方針を外すか表ごと消すかをユーザーが決める。今のコードは満たさない（TM-HOME-53）。表の持ち主が決まったら、その領域の SEC に移す。

#### SEC-HOME-020-AC-01 anon の鍵と一般会員の JWT で原価の履歴を読み・書き・消せない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-020 |
| 根拠 | 誰でも持てる鍵で原価の履歴に届かないことを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の `item_cost_history` に原価を入れ、anon の鍵と一般会員の JWT で select・insert・update・delete を送る） |
| 出どころ | 実装から推定 |

どちらの鍵でも、4つの操作が権限の誤りで終わり、原価の値が返らず、行が変わらないこと。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。

### DRV-HOME-001 ヒーローにはブランド名だけを置き、コンセプトの文や CTA のボタンを置かない

| 属性 | 値 |
| --- | --- |
| 根拠 | 静かで強い世界観を保つため、最初の画面に言葉やボタンを足さず、写真と名前だけにする。UI/UX レビュー H-1（ヒーローにコンセプトと CTA を足す案）に対し、ユーザーが「名前だけを残し、考えは下の区画へ」を選んだ（2026-06-20）。付録 D の WF-HOME-003（スライダー・CTA）・AC-WF-HOME-001（ファーストビューに CTA）とは逆（食い違い） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_home.md` |

ヒーローの中身はブランド名の h1、写真、暗くする重ね、SCROLL の印（DRV-HOME-003）だけ。ブランドの考えと `/about` への導線は ABOUT の区画（DRV-HOME-002、FR-HOME-003）に置く。

### DRV-HOME-002 ABOUT の区画にブランドの考えの文と3本柱を置く

| 属性 | 値 |
| --- | --- |
| 根拠 | 考えに共感して買う人に、天然繊維・受注生産・ユニセックスという他との違いを短く伝えるため（UI/UX レビュー H-7）。最初は CONCEPT の区画として別に作り、後に ABOUT の区画へまとめた（2026-06-22）。FR-HOME-002・003 は ABOUT の区画と導線を求めるだけで、中身は書いていない |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_home.md`、`docs/01_Planning/brand.md` の Brand Essence |

ABOUT の区画は、考えの文2つ（長く着られる服だけをつくる、タイムレスなシルエットと素材）、3本柱（タイムレス＆ユニセックス・天然繊維100%・国内受注生産）の英字の題・日本語・説明、READ OUR STORY のボタン、`/about.png` の画像で作る。英字の題の1つが「TIMELSS」と綴られている（食い違い）。

### DRV-HOME-003 ヒーローの最下部に SCROLL の印と縦線を置き、読み上げから隠す

| 属性 | 値 |
| --- | --- |
| 根拠 | ヒーローが画面いっぱいなので、下に続きがあることを控えめな印で知らせるため（UI/UX レビュー H-5）。見た目だけの印なので、読み上げには出さない。FREQ-278・282・283 は印の動きと色を求めるが、印を置くこと自体は求めていない |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_home.md` |

ヒーローの下の中央に、SCROLL の文字と細い縦線を縦に並べ、まとめて読み上げから隠す。SCROLL の文字は少し遅れて出る（共有の `globals.css` の動き）。

### DRV-HOME-004 ヒーロー画像にブランドを表す代替テキストを付け、暗くする重ねを読み上げから隠す

| 属性 | 値 |
| --- | --- |
| 根拠 | 「Hero Background」のような代替テキストは画像の中身を伝えないため、ブランドを表す文にした（UI/UX レビュー H-3、WCAG 1.1.1）。重ねは字を読みやすくするための飾りなので、読み上げには出さない。FR-HOME-001 は代替テキストの中身を書いていない |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_home.md`、`docs/02_Requirements/requirements.md`（WF-HOME-003 の「画像代替テキスト必須」） |

ヒーロー画像の代替テキストは「ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル」。上下を暗くする重ねは読み上げから隠す。E2E 2本は古い代替テキストを探す（食い違い）。

### DRV-HOME-005 VIEW ALL のボタンに行き先を区別する読み上げの名前を付ける

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームには同じ「VIEW ALL」のボタンが3つ並ぶので、読み上げでは行き先が分からない。部品は読み上げの名前を必ず受け取る形にしている（`HomeSectionViewAll.tsx` のコメント）。FR-HOME-004・FREQ-146 は名前の付け方を書いていない |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/home/components/HomeSectionViewAll.tsx`） |

VIEW ALL のボタンは、呼ぶ側が渡す行き先ごとの読み上げの名前を付けて描く。見た目の文字は3つとも "VIEW ALL"。E2E が見つけるための目印（data-testid）も付ける。

### DRV-HOME-006 区画の並びをヒーロー・検索の窓・ITEM・LOOK・NEWS・ABOUT・取扱店の順にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 新しい物（商品・ルック・知らせ）を先に見せ、ブランドの考えと取扱店を後に置く（推定）。UI/UX レビュー H-8 は「考えが下すぎる」と指摘し、検索の窓の直後に CONCEPT の抜粋を足したと書くが、今の頁には無い（食い違い）。FR-HOME-002 は4つの区画を求めるだけで、並びは書いていない |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/page.tsx`）、`docs/05_Quality/reviews/uiux/uiux_review_home.md` |

ヒーローの直後に検索の窓（SEARCH の部品）、続いて ITEM・LOOK・NEWS の格子（各領域の部品）、ABOUT の区画、最後に取扱店の格子（STOCKIST の部品）を並べる。

## 未確認事項

- ホームの ITEM・LOOK の件数: FREQ-147・148 の要件と受け入れ条件の数（lg・xl で切り替え、1280px で10件・8件）を、要求の文の※のとおり FREQ-276・277 の数（2xl で切り替え、1280px で6件）に置き換えて「廃止」にするか
- ITEM を10件取って8件だけ描く形（FREQ-147-REQ-01）をそのままにするか、取る件数を8件にそろえるか
- FREQ-278 の縦線（REQ-02・06、AC-02・06）を、FREQ-282 で置き換えた物として「廃止」にするか
- ヒーローに CTA を置かない決定（DRV-HOME-001）を認め、付録 D の WF-HOME-003・AC-WF-HOME-001 を古い物として扱うか
- FR-HOME-004 の「もっと見る」を、総数が少ない時に隠してよいか（FREQ-147〜149 の条件つきの表示との関係）
- NFR-HOME-001 の「3G 相当」を E2E でどう模すか。今の E2E は手元の本番ビルドを回線を絞らずに測る
- FR-HOME-001 の要件の文を詳細設計の頁から取ったことの確認
- 新しく起こした要求 `SR-HOME-001`〜`005` と、FR-HOME・NFR-HOME をそこへつないだことの確認
- FREQ-148 を HOME に置いたこと（部品は LOOK の `PublicLookGrid`。領域の担当の割り当ての未確認事項）
- 署名つき URL の期限（SEC-HOME-007）、ホームの回数の制限・キャッシュの値（SEC-HOME-013）は案。ユーザーに決めてもらう
- 原価の列（SEC-HOME-004）・`items` の権限（SEC-HOME-005）・原価の履歴の表（SEC-HOME-020）の持ち主 ITEM は範囲に無い。HOME で持ち続けるか、ITEM が範囲に入った時に移すかは決めていない。`looks`・`look_items`・`stockists` の分は LOOK・STOCKIST の SEC が持つ
- 検索の窓の回数の制限・応答のキャッシュ・URL の語の埋め込みは SEARCH の SEC-SEARCH-006・010・021 を正にして、SEC-HOME-011・012・019 を廃止にした。この分け方の確認
- 原価の履歴の表（SEC-HOME-020）を `src/` が使っていないこと（推定）と、本番にその表の行があるか。使わないなら表ごと消すかの判断
- `/api/auth/me` の応答を絞る（SEC-HOME-016）と、ほかの画面が id・email を使っていないかは確かめていない
- セキュリティ要件の優先度は元の文書に値が無いので案（過去のレビューの重さで付けた）
- 本番の Supabase・中継・環境変数は見ていない（脅威の文書の「未確認事項」）
