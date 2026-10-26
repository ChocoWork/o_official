# NEWS の要件

> 状態: 推定 | 確認日: 2026-10-26 | 対象: NEWS（ニュース一覧 `/news`・詳細 `/news/[id]`・ホームの NEWS の区画・管理のニュース） | 基準コミット: `a03beaff`

## 概要

NEWS の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）の NEWS にかかる行を丸ごと写し、上位の無い要件には新しい要求 `SR-NEWS-` を起こし、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-NEWS-` に書いた。セキュリティ要件は脅威の文書から別に足す。認証・CSRF・管理画面・権限にまたがる行（FREQ-316・327・515・519・540）は定義を持たず、必要な所で `ID（範囲外）` として参照する。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 17 | 既存の `FREQ-` 15（うち廃止1）、新しい `SR-NEWS-001`〜`002` |
| 要件 | 37 | 既存の `FREQ-NN-REQ-NN` 21（うち廃止1）、`FR-NEWS-ALL-001`〜`007`、`FR-NEWS-DETAIL-001`〜`008`、`FR-ADMIN-003` |
| 受け入れ条件 | 56 | 既存の `FREQ-NN-AC-NN` 28（うち廃止1）、新しい `FR-…-AC-NN` 28 |
| 派生要件 | 15 | `DRV-NEWS-001`〜`015` |
| セキュリティ要件 | 25（受け入れ条件 52） | `SEC-NEWS-001`〜`025`、`SEC-NEWS-NNN-AC-NN` |

- 状態: 写した要求の行は「現行」。ただし元の行に理由の記述が無く、根拠の「なぜ」を推定で補った行や上位のつなぎは「推定」。コードと合わない行・新しく起こした項目・実装から読み取った項目も「推定」。どちらが正しいかは決めず、食い違いは各項目の本文と「未確認事項」に書き、`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる
- 結論: 公開のニュースを読む要求は元の文書に無かった（`SR-NEWS-001`・`002` を推定で起こした）。VIEW ALL の出し方（FREQ-126 と FREQ-149）、分類が1つか複数か、BLOG の分類は、ユーザーに決めてもらう

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 写した元 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節、1.2・1.3・1.16 の NEWS の節、「要求トレーサビリティ追記」の各節の行）。元の行は消していない |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md`、`docs/01_Planning/brand.md` |
| 対象のコード | `src/app/news/`、`src/app/api/news/`、`src/app/api/admin/news/`、`src/app/admin/news/`、`src/app/actions/news.ts`、`src/components/NewsSection.tsx`、`src/features/news/`、`src/lib/news-data.ts`、`src/lib/storage/news-images.ts`、`src/types/news.ts` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |
| 範囲外の上位 | 全体の非機能要件 `NFR-SEO-003`・`NFR-A11Y-002` は定義を写さず、受け入れ条件の上位に `（範囲外）` の印で書く |

### 写した行と写さなかった行

写したのは、NEWS の範囲のコードがその一部を作っている行。ほかの領域にまたがる行も丸ごと写した（FREQ-119・126・146・185・274・275）。

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-118 | NEWS の分（AC-04 の 1680px）は FREQ-274 が撤廃した。残りは ITEM・LOOK・STOCKIST の話 |
| FREQ-51・FREQ-52 | LOOK の一覧を NEWS にそろえる要求で、NEWS は比べる元にすぎない |
| FREQ-316・327・515・519・540 | 認証の道・CSRF の検査・管理画面の選択欄・権限の画面・DB の守りにまたがる行で、定義の持ち主は範囲外の文書。NEWS の管理の窓口はこれらに従うだけなので、定義は写さず、根拠の文で `ID（範囲外）` として参照する |
| FREQ-184・190・192・193・199・200・201 | 検索のページ（範囲外）の話。NEWS は種別の名前と公開日の表記だけ |
| FREQ-202・203・205・238・253 | 管理の左のナビ（範囲外の共有部品）の話 |
| FREQ-231・FREQ-314・FREQ-402 | 会計の画面・管理の全画面の文字・管理の背景の板（`src/app/admin/layout.tsx`）の話で、NEWS の範囲のコードは作っていない |
| FR-HOME-002・004、FR-SEARCH-001・003、FR-ADMIN-001 | ホーム・検索・管理の共通の節の要件。設計の上位には `（範囲外）` の印で書ける |
| NFR-SEC-010 | 保存のデータの暗号化は Supabase の DB と置き場の基盤の設定で、NEWS の範囲のコードは作らない |
| AC-SEC-001 | 重大な脆弱性を30日以内に直す運用の決まりで、NEWS の画面や窓口の動きでは確かめられない |
| NFR-PERF-001・002・003・005、AC-PERF-001 | サイト全体の表示の速さの目標で、NEWS の頁だけを測った記録が無い。公開の NEWS は画像を出さず、005 の遅延読み込みが当たるのは範囲外の共有部品（`next/image`）だけ |
| NFR-PERF-007 | 今の NEWS の頁は要求ごとに描き（ARC-NEWS-001）、`/api/news` は `Cache-Control` を付けない（API-NEWS-001）。満たす形の構造が無いので、満たさない要件を上位にしない決まり（構造設計の文書の概要）に合わせて上位にしなかった |
| NFR-SEO-002・004・005 | サイト全体の SEO の決まり。サイトマップ（004）と CWV（005）は範囲外のコードが作る。SSR（002）は ARC-NEWS-001 の結果として成り立つが、NEWS の受け入れ条件には個別の点を求める NFR-SEO-003 だけをつないだ |
| NFR-A11Y-001・003・004・005、AC-A11Y-001 | サイト全体の WCAG の目標と、alt・フォームのラベルの決まり。NEWS の受け入れ条件は、前後のリンクと本文の構造という個別の点を求める NFR-A11Y-002 だけを上位にした。全体の自動の確かめ（AC-A11Y-001）は NEWS の範囲で流していない |
| NFR-I18N-001・002 | 多言語は今のサイトに無い。公開日の書き方は FR-NEWS-ALL-004・FR-NEWS-DETAIL-002 の「今のコード」の注に個別に書いた |
| NFR-DR-002 | 利用者が上げた物の置き場の冗長化と版の管理は Supabase の置き場の基盤の設定で、NEWS の範囲のコードは作らない |
| DES-TYPO-001・002、DES-COLOR-001〜005、DES-UX-001・002、DES-A11Y-001〜003、AC-DES-002 | 字・色・動き・コントラストの決まりで、範囲外の共有部品（`src/components/ui/`・全体の CSS）が作る。NEWS の範囲のコードは部品を使うだけ |
| WF-COMMON-005・006 | フォーカスの見え方と alt・リンクの文字の、全画面に共通の決まりで、共有部品が作る。前後のリンクの文字は FR-NEWS-DETAIL-007 が個別に求める |

### E2E と受け入れ条件の対応

`e2e/FR-NEWS-*` のファイルが試している受け入れ条件。テスト名に ID を付ける時に使う（2026-10-25 に新しい E2E を足した分まで反映）。

| E2E のファイル | 受け入れ条件 |
| --- | --- |
| FR-NEWS-ALL-001 | FR-NEWS-ALL-001-AC-01 |
| FR-NEWS-ALL-002 | FR-NEWS-ALL-002-AC-01 |
| FR-NEWS-ALL-003 | FR-NEWS-ALL-003-AC-01 |
| FR-NEWS-ALL-004 | FR-NEWS-ALL-004-AC-01 |
| FR-NEWS-ALL-005 | FR-NEWS-ALL-005-AC-01 |
| FR-NEWS-ALL-006 | FR-NEWS-ALL-006-AC-01 |
| FR-NEWS-ALL-007-category-history-restore | FR-NEWS-ALL-007-AC-01 |
| FR-NEWS-ALL-007-detail-back-filter-restore | FR-NEWS-ALL-007-AC-02 |
| FR-NEWS-ALL-008〜011 | 無し（DRV-NEWS-002・003 の動きを試す。受け入れ条件が無いので名前に付ける ID が無い） |
| FR-NEWS-ALL-012 | FREQ-31-AC-01 |
| FR-NEWS-ALL-013 | FREQ-32-AC-01 |
| FR-NEWS-ALL-014 | FREQ-47-AC-01 |
| FR-NEWS-ALL-015 | FREQ-48-AC-01（AC-02 は ALL-018） |
| FR-NEWS-ALL-016 | FREQ-49-AC-01 |
| FR-NEWS-ALL-017 | 1280px は FREQ-274-AC-02、1920px は FREQ-274-AC-01（どちらも /news・/item・/look を回る）。390・768px でデスクトップのフィルターを出さないテストは対応が無い |
| FR-NEWS-ALL-018 | FR-NEWS-ALL-001-AC-02、FR-NEWS-ALL-002-AC-02・AC-03、FR-NEWS-ALL-003-AC-02、FR-NEWS-ALL-004-AC-02、FREQ-48-AC-02、FREQ-119-AC-01・AC-02 |
| FR-NEWS-DETAIL-001〜004・006・007 | 同じ番号の `FR-NEWS-DETAIL-NNN-AC-01`（004 は AC-01 だけ。AC-02 は DETAIL-009） |
| FR-NEWS-DETAIL-009 | FR-NEWS-DETAIL-001-AC-02、FR-NEWS-DETAIL-004-AC-02、FR-NEWS-DETAIL-005-AC-01、FR-NEWS-DETAIL-008-AC-01、SEC-NEWS-012-AC-02、SEC-NEWS-013-AC-01・AC-02（005・008 の古い E2E ファイルは、AC を DETAIL-009 が持つので消した） |
| FR-NEWS-HOME-001 | FREQ-126-AC-01〜04、FREQ-146-AC-01・AC-02、FREQ-149-AC-01、FREQ-149-AC-02（6件より多い側だけ。下の注）、FREQ-275-AC-01・AC-03 |
| FR-NEWS-ADMIN-001 | FREQ-14-AC-01、FR-ADMIN-003-AC-01〜05、FREQ-252-AC-01〜03、SEC-NEWS-012-AC-03、SEC-NEWS-020-AC-01 |
| FR-NEWS-SEC-001 | SEC-NEWS-001-AC-02、003-AC-02、004-AC-01、005-AC-01・AC-02、007-AC-01・AC-02、008-AC-01、009-AC-01、012-AC-01、FREQ-185-AC-01・AC-02（004・007・008 は AC の文のとおり `/api/news` の応答を読む） |
| FR-NEWS-SEC-002 | SEC-NEWS-001-AC-01、002-AC-01〜03、010-AC-01・AC-02、022-AC-01、025-AC-01 |
| FR-NEWS-SEC-003 | SEC-NEWS-004-AC-02、006-AC-01・AC-02、009-AC-02、011-AC-01、023-AC-01、024-AC-01 |
| FR-NEWS-SEC-004 | SEC-NEWS-014-AC-01・AC-02、015-AC-01〜03 |
| FR-NEWS-SEC-005 | SEC-NEWS-016-AC-01・AC-02、017-AC-01〜03、018-AC-01・AC-02 |

- 窓口の成功の道まで進む E2E（SEC-NEWS-016〜018。`e2e/FR-NEWS-SEC-005-admin-write-aal2.spec.ts`）は、aal2 の本物の token を、共有の道具 `e2e/admin-session-test-utils.ts` と同じ作り方で用意する。GoTrue の password grant で session を作り、`auth.mfa_amr_claims` に `totp` の行を入れて refresh し、aal2 の claim を持つ token を得る（TOTP の登録は通さない）。店長は worker ごとに 1 人を使い回し、終わりに消す
- FREQ-149-AC-02 の「6件以下なら VIEW ALL が無い」側は E2E にしない。公開の NEWS を 6 件以下へ減らすには見本の記事を非公開にする必要があり、並列で動く他の E2E（FR-HOME-013 など）の件数と干渉する。E2E が試すのは「6件より多い（見本の公開 8 件）なら VIEW ALL がある」側だけで、テスト名に「【6件より多い側のみ】」と付けた。6件以下の側をどう確かめるかは「未確認事項」に書いた
- FREQ-185-AC-01 は `/api/search` の `items`・`looks`・`news` の画像の URL を求める。NEWS の E2E（SEC-001）は `news` の側だけ見る。`items`・`looks` の側は範囲外の `FR-SEARCH-007`（`e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts`）が 3 つとも読む

範囲の E2E が無い受け入れ条件（11件。`validate-trace` の `missing-child` と同じ）: `FREQ-275-AC-02`・`SEC-NEWS-003-AC-01`・`008-AC-02`・`009-AC-03`・`009-AC-04`・`018-AC-03`・`019-AC-01`・`019-AC-02`・`020-AC-02`・`020-AC-03`・`021-AC-01`。それぞれの項目の「確かめ方」に、E2E にしない理由と本当の確かめ方を書いた。範囲外の E2E だけがある物は `FR-SEARCH-007`（FREQ-185-AC-01 の `items`・`looks` の側）。

## 要求

### SR-NEWS-001 訪問者が公開済みのニュースを一覧で読み、分類で絞れる

| 属性 | 値 |
| --- | --- |
| 根拠 | ブランドの今（コレクションの発表・ポップアップなどの催し・素材と環境への考え・店の知らせ）をお客様へ届ける場が要る。brand.md の届け方（note/blog は透明性、ポップアップは戦略的に）と、stakeholder-requirements.md の目標「ブランドアイデンティティを反映した体験」から起こした。要求の表には公開のニュースを読む要求が無い（FREQ-14 は管理だけ）ので、FR-NEWS-ALL-001〜007 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」、`docs/01_Planning/brand.md` の「6. Business Principles」の SS/AW コレクションの考え方、「届け方（マーケティング）」、「感情設計（Emotion Design）」の認知の行、「ペルソナ候補」の環境意識の層 |

訪問者（エンドカスタマー）が、公開済みのニュースを新しい順に一覧で読み、分類（コレクション・催し・コラボレーション・環境・店舗・ブログ）で絞り込めること。

### SR-NEWS-002 訪問者がニュースの記事を1件ずつ読み、前後の記事と一覧へ移れる

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧で選んだ記事を全文で読めなければ知らせが届かない。読み終えた人が同じ分類の前後の記事や一覧へ続けて移れれば、ブランドの話を続けて読んでもらえる。要求の表に当たる行が無いので、FR-NEWS-DETAIL-001〜008 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」、`docs/01_Planning/brand.md` の「届け方（マーケティング）」と「感情設計（Emotion Design）」の認知の行 |

訪問者が、公開済みのニュースの記事1件の題・公開日・分類・本文を読み、前後の記事と一覧へ移れること。

### FREQ-14 管理画面でニュースを登録・編集・削除する

| 属性 | 値 |
| --- | --- |
| 根拠 | 店長が自分で記事を出し入れできれば、開発の手を借りずにブランドの発表（コレクション・イベントなど）を載せられる。stakeholder-requirements.md の要求定義表の行 |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-14 の行） |

要求の文: サイト管理者（Admin）がCMSを用いたNewsの登録と編集と削除ができること

### FREQ-31 NEWS 一覧にページ見出し「NEWS」を出さない

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧のページに大きな見出しを置かず、フィルターと記事だけで見せたいというユーザーの依頼。uiux レビュー N-1 で足した h1 を打ち消した（理由の記述は無い。静かな見た目にそろえるためと推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-31 の行） |

要求の文: NEWS 一覧ページにページ見出し「NEWS」を表示しないこと

### FREQ-32 NEWS 一覧の記事カードに画像を出さない

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧は文字だけの静かな並びにしたいというユーザーの依頼。uiux レビュー N-4 で足したサムネイルを打ち消した（理由の記述は無い。推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-32 の行） |

要求の文: NEWS 一覧ページの各記事カードに画像（アイキャッチ）を表示しないこと

### FREQ-33 管理のニュースで画像を書き込まない（廃止）

| 属性 | 値 |
| --- | --- |
| 根拠 | 画像を扱わない方針だったが、記事にアイキャッチが要り、検索の結果のサムネイル（FREQ-185）も画像を前提にするため、FREQ-252 で置き換えて廃止した |
| 状態 | 廃止 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-33 の行） |

要求の文: ~~Admin の News 管理で画像のアップロードを行わないこと~~ **FREQ-252 により廃止**（Admin の News 管理で画像アップロードを行う方針へ変更）

### FREQ-47 NEWS 一覧の FILTER ボタンを ITEM 一覧にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧どうしで FILTER ボタンの文字の大きさ・字間がずれると同じサイトに見えないため、ITEM 一覧を基準にそろえる（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-47 の行） |

要求の文: NEWS 一覧のモバイル・タブレットの FILTER ボタンを ITEM 一覧の FILTER ボタンと同じにすること

### FREQ-48 NEWS 一覧の FILTER の選択肢を ITEM 一覧にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | NEWS と ITEM で選択肢の詰まり方・文字の形がずれると、行き来した時に別の部品に見えるため、ITEM の Accordion 内の選択肢にそろえる（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-48 の行） |

要求の文: NEWS 一覧の FILTER の選択肢（要素と要素の間隔・要素自体）を ITEM 一覧の Accordion 内の子要素と同じにすること

### FREQ-49 NEWS 一覧のフィルターの縦線と本文の距離を ITEM にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 縦線と本文の間が一覧ごとに違うと、一覧を行き来した時に本文の始まりが動いて見えるため、ITEM にそろえる（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-49 の行） |

要求の文: NEWS 一覧のフィルター縦線とコンテンツの距離を ITEM 一覧と同じにすること

### FREQ-119 4つの一覧のフィルターの幅と本文までの余白をそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | NEWS・ITEM・LOOK・STOCKIST の一覧を行き来した時にフィルターと本文の位置が動かないよう、幅と余白を1つにそろえる（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-119 の行） |

要求の文: NEWS / ITEM / LOOK / STOCKIST の各一覧ページで、左サイドバーのフィルター幅と、フィルターから右側メインコンテンツまでの余白を4ページで統一すること

### FREQ-126 ホームの区画の見出しの右に VIEW ALL を常に出す

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームの各区画からすぐ一覧へ移れるよう、見出しの右に常に入口を置きたいというユーザーの依頼。ただし今のコードは FREQ-149 の形（下の中央・件数が多い時だけ）で、この行と合わない（食い違い。状態は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

要求の文: ホームページの ITEM／LOOK／NEWS セクションのカード表示は従来のグリッド（一覧）レイアウトのまま、各セクション見出しの右側に該当一覧ページ（/item・/look・/news）への VIEW ALL リンク（矢印付き）を常時表示し、従来の下部中央の条件付き VIEW ALL ボタンを廃止すること

### FREQ-146 ホームの VIEW ALL を共通の Button にし、矢印を外す

| 属性 | 値 |
| --- | --- |
| 根拠 | 区画ごとに VIEW ALL の見た目が違わないよう共通の Button にそろえ、余計な矢印を外して落ち着いた見た目にする（ブランドの控えめな動きと装飾の少なさに合わせる。推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-146 の行） |

要求の文: ホームページの ITEM / LOOK / NEWS セクションの VIEW ALL ボタンを既存の Button UI コンポーネントで実装し、ボタン内の右矢印アイコンを削除すること

### FREQ-149 ホームの NEWS はどの幅でも6件を出し、続きがある時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 画面の幅で件数が変わると、モバイルで見えない記事が出るため、どの幅でも6件を出す。全部を出し切れる時に一覧への入口を出しても行き先に新しい物が無いので、続きがある時だけ出す（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-149 の行） |

要求の文: ホームの NEWS セクションは、どのビューポートでも DB から公開 NEWS を6件取得し、全ビューポートで6件を表示すること。表示数（6件）より公開 NEWS の総数が多い場合のみ VIEW ALL ボタンを表示すること

### FREQ-185 検索の結果のサムネイルの画像を実際に出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 画像の置き場は非公開なので、DB に残る公開 URL のままでは 400 になり検索の結果の画像が出ない。ほかのページと同じ署名つき URL にそろえて出す |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-185 の行） |

要求の文: searchページの検索結果サムネイル（ITEM / LOOK / NEWS）の画像が実際に配信され表示されること（画像バケットは migrations 030 / 044 により private のため、DB 保存の public URL のままでは 400 となり表示されない）

### FREQ-252 管理のニュースで画像を書き込む

| 属性 | 値 |
| --- | --- |
| 根拠 | NEWS の記事にはアイキャッチの画像が要り、検索の結果のサムネイル（FREQ-185）も画像がある前提のため。FREQ-33 の「書き込まない」を廃止して置き換えた |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

要求の文: Admin の News 管理で画像のアップロードを行うこと。FREQ-33（画像アップロードを行わない）を廃止して置き換える。NEWS 記事にはアイキャッチ画像が必要であり、search の結果サムネイル（FREQ-185）も画像の存在を前提としている

### FREQ-274 NEWS・ITEM・LOOK の PC でフィルターを画面の左端に寄せる

| 属性 | 値 |
| --- | --- |
| 根拠 | 広い画面で 1680px の中央に寄せると、フィルターが画面の左から離れ、ITEM・LOOK と同じ使い心地にならないため、左端に寄せる（FREQ-118 の 1680px を ITEM・NEWS・LOOK で撤廃）（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-274 の行） |

要求の文: ※ FREQ-118-AC-01 / AC-04 のうち ITEM / NEWS / LOOK の「コンテナ最大幅 1680px」は本要求で撤廃（STOCKIST は据え置き）。NEWS / ITEM / LOOK のPCサイズで、左側フィルターを画面左端に寄せること

### FREQ-275 ホームの区画の見出しを共通の部品にし、下線を付ける

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームの区画の見出しが部品ごとに違うと区画の並びがそろわないため、共通の SectionTitle と下線にそろえる（hyke.jp の NEW IN・NEWS を参考）（元の行に理由の記述は無く、上の理由は推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

要求の文: ITEMS / LOOK / NEWS / ABOUT / STOCKIST のセクション見出しを共通コンポーネントにし、文字サイズは hyke.jp の NEW IN / NEWS と同じレスポンシブ挙動にすること。ITEMS / LOOK / NEWS にも下線を付けること

## 要件

### 要求の表から写した要件

文は `requirements.md` の要件の欄のまま。元の表に優先度は無い。

### FREQ-14-REQ-01 ニュースの管理の機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-14 |
| 根拠 | 店長が記事を出し入れする操作のどれかが途中で壊れると、お知らせを出せず、ブランドの今を届けられない。登録・編集・削除の細かい形は FR-ADMIN-003 が持ち、ここは管理の機能全体が動くことを求める（元の表の書き方のまま） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-14 の行） |

News管理機能が正常に動作すること

### FREQ-31-REQ-01 一覧からページの見出しの要素を外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-31 |
| 根拠 | FREQ-31 の「出さない」を、隠すのではなく見出しの要素そのものを置かない形に決めた。元の文書に理由の記述は無く、読み上げにも見出しを残さないためと推定した |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-31 の行） |

NEWS 一覧ページからページタイトルの見出し要素を削除すること

### FREQ-32-REQ-01 記事カードから画像の表示を外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-32 |
| 根拠 | FREQ-32 の「文字だけの静かな並び」は、画像を隠すのではなくカードの部品から画像の表示を外せば確実に成り立つ。元の要件の文が「削除」と書く |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-32 の行） |

NEWS 一覧ページの記事カードから画像表示を削除すること

### FREQ-33-REQ-01 フォームから画像の欄を外す（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-33 |
| 根拠 | FREQ-33 と一緒に廃止した。画像の欄は FREQ-252-REQ-01 で置いている |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-33 の行） |

~~News 作成・編集フォームから画像アップロードの入力欄と処理を削除し、画像なしで作成・更新できること~~ 廃止

### FREQ-47-REQ-01 FILTER ボタンの文字の大きさ・字間を ITEM と同じにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-47 |
| 根拠 | ボタンの見た目のずれは文字の大きさと字間に最も出るので、比べられる2つの値に絞って検証できる形にしたと推定した（元の文書に理由の記述は無い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-47 の行） |

NEWS 一覧でモバイル・タブレット表示時に出る FILTER ボタンの文字サイズ・字間を、ITEM 一覧の FILTER ボタンと同一にすること

### FREQ-48-REQ-01 選択肢の間隔と見た目を ITEM の MultiSelect と同じにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-48 |
| 根拠 | 選択肢の詰まり方のずれは間隔と、文字・チェックの見た目に出る。この2つを ITEM の MultiSelect と同じにすれば、行き来した時に別の部品に見えないと推定した（元の文書に理由の記述は無い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-48 の行） |

NEWS 一覧の FILTER の選択肢同士の間隔（option-list の gap）と選択肢自体の見た目（文字サイズ・字間・チェック表示）を、ITEM 一覧の Accordion 内 MultiSelect の選択肢と同一にすること

### FREQ-49-REQ-01 デスクトップで本文の列の左の余白を ITEM と同じにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-49 |
| 根拠 | 縦線はサイドバーの右端に付くため、縦線から本文までの距離は本文の列の左 padding で決まる。その1つの値を ITEM と同じにすれば、一覧を行き来しても本文の始まりが動かないと推定した（元の文書に理由の記述は無い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-49 の行） |

デスクトップで NEWS 一覧のフィルターサイドバー右端の縦線とコンテンツ列の間隔（コンテンツ列の左 padding）を、ITEM 一覧の同間隔と一致させること

### FREQ-119-REQ-01 サイドバーの幅・内側の余白・本文の左の余白を同じ値にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-119 |
| 根拠 | 4ページで同じクラスの値を使えば、値が1つで済み、片方だけ変えて再びずれることが起きないと推定した（元の文書に理由の記述は無い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-119 の行） |

全ページの左サイドバー幅を `w-58.25 xl:w-[288px]` に、サイドバー内側の水平パディングを `px-3.25 xl:px-5.25` に、メインコンテンツ列の左パディング（フィルターとの余白）を `lg:pl-8.5 xl:pl-13.75 2xl:pl-22.25` に揃えること

### FREQ-126-REQ-01 見出しを HomeSectionHeader に替え、下の中央の VIEW ALL と件数の条件を外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-126 |
| 根拠 | ホームの各区画から一覧へ入る入口を見出しの横に常に置くため、部品を HomeSectionHeader に替え、件数で出し分ける下の中央のボタンをやめる（FREQ-126）。今の NEWS の区画との食い違いは FREQ-126 に書いた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

各グリッド（PublicItemGrid／PublicLookGrid／PublicNewsGrid）の home variant で `SectionTitle` を `HomeSectionHeader`（h2 見出し＋右側 VIEW ALL リンク）に置き換え、従来の下部中央 `VIEW ALL ITEMS`／`VIEW LOOKBOOK`／`VIEW ALL NEWS` ボタンと、それに紐づく件数条件（hasMore 系）を削除する。カード表示（グリッド・モバイル件数制限）は従来どおりとすること

### FREQ-146-REQ-01 HomeSectionViewAll を共通の Button（secondary・square・href）で作る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-146 |
| 根拠 | 区画ごとに VIEW ALL の見た目が違わないよう、共通の Button の決まった形（variant・shape・href）で描く（FREQ-146）。元の文書に理由の記述が無いので推定 |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-146 の行） |

HomeSectionViewAll を共通 Button コンポーネント（variant="secondary"・shape="square"・href 指定によるリンク描画）で実装すること

### FREQ-149-REQ-01 6件を取り、全部の幅で全部を出す（モバイルの3件の制限をやめる）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-149 |
| 根拠 | 画面の幅で件数が変わるとモバイルだけ見えない記事が出る。取る件数と出す件数を同じ6件にすれば、どの幅でも同じ記事が見える（FREQ-149）。元の文書に理由の記述は無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-149 の行） |

ホームの NEWS 取得件数をビューポートによらず6件とし、全ビューポートで取得した記事をすべて表示すること（モバイルの3件制限を廃止）

### FREQ-149-REQ-02 公開の総数を取り、6件より多い時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-149 |
| 根拠 | 続きがあるかは、取った6件だけでは分からない。公開の総数を別に数えて6と比べれば、行き先に新しい物がある時だけ入口を出せる（FREQ-149）。元の文書に理由の記述は無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-149 の行） |

公開 NEWS の総数を取得し、総数が6件より多い場合のみ VIEW ALL を表示すること

### FREQ-185-REQ-01 検索の結果の imageUrl を署名つき URL にそろえる（置き場は公開にしない）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-185 |
| 根拠 | 画像の置き場は非公開なので、公開 URL のままでは 400 になる（FREQ-185）。ほかのページと同じ署名つき URL にそろえ、置き場を公開にはしない（元の要件の文が「バケットの public 化は行わない」と書く） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-185 の行） |

検索サービスが返す各結果の imageUrl を、他ページ（ITEM一覧・LOOK詳細・カート・注文）と同じ署名付き URL 方式に統一すること。種別ごとに signItemImageUrl / signLookImageUrl / signNewsImageUrl を使い、署名クライアントは storage の RLS を bypass できる createServiceRoleClient を用いること。検索結果（items / looks / news）と popularItems の全件に適用し、バケットの public 化は行わないこと

### FREQ-252-REQ-01 作成・編集のフォームに画像の欄を置き、キーボードでも選べ、選んだら見本を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252 |
| 根拠 | 記事のアイキャッチ（FREQ-252）を店長が付けるには、画像の欄と、選んだ画像を確かめる見本が要る。キーボードでも選べるのは操作の決まり（NFR-A11Y-002（範囲外））に合わせたためと推定した |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

News 作成・編集フォームに画像アップロード欄を設けること。ファイル選択（クリックおよびキーボード操作）で画像を選べ、選択後はプレビューを表示すること

### FREQ-252-REQ-02 作る時は画像が必須、直す時は付け直さなければ元の画像のまま

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252 |
| 根拠 | 記事のアイキャッチは検索の結果にも使う（FREQ-185）ので、作る時は必須にする。直す時に毎回付け直させないよう、付け直さなければ元の画像を残すと推定した（元の要件の文は両方を書くが理由は無い） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

新規作成時は画像を必須とし、未添付のまま送信した場合は「画像を添付してください」と表示して送信を中止すること。編集時は再添付しなければ既存画像を維持すること

### FREQ-252-REQ-03 JPEG・PNG・WebP・GIF で 5MB 以下だけを受ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252 |
| 根拠 | 画面で出せる種類に絞り、大きすぎる画像で置き場と表示が重くならないよう 5MB で止めると推定した（元の要件の文は条件だけを書き、理由は無い） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

受け付ける画像は JPEG / PNG / WebP / GIF に限り、サイズは 5MB 以下とすること。条件を外れる場合はその旨を表示して受け付けないこと

### FREQ-274-REQ-01 幅の上限による中央寄せをやめ、1680px を超える画面でも左端に寄せる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-274 |
| 根拠 | 広い画面で幅の上限により中央に寄ると、フィルターが画面の左から離れる（FREQ-274）。上限の幅の指定を外せば、1680px を超える画面でも左端に寄る。元の文書に理由の記述は無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-274 の行） |

各ページのコンテンツ幅上限（max-w-[1680px]）による中央寄せを廃止し、幅1680pxを超える画面でも左フィルターが画面左端付近に固定されること

### FREQ-274-REQ-02 1680px 以下の画面では今までの位置を変えない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-274 |
| 根拠 | 狭い画面では前から左端にあるので、FREQ-274 の変更で動かさないことを決めたと推定した（元の要件の文は「変えない」とだけ書く） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-274 の行） |

1680px以下の画面ではこれまでの左フィルター位置を変えないこと

### FREQ-275-REQ-01 5つの区画の見出しを SectionTitle 1つにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275 |
| 根拠 | 区画の見出しが部品ごとに違うと区画の並びがそろわない（FREQ-275）。1つの部品だけを使えば、見出しが部品ごとにずれることが無い。元の文書に理由の記述は無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

5つのセクション見出しを SectionTitle 1つに統一すること

### FREQ-275-REQ-02 見出しの文字を 1024px 未満で 20px、以上で 28px にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275 |
| 根拠 | hyke.jp と同じ大きさの変わり方にするため。ただし E2E の注は「FREQ-314-REQ-02（範囲外） で撤回」と書き、requirements.md の行には印が無い（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

見出しの文字サイズを 1024px 未満で 20px、1024px 以上で 28px にすること

### FREQ-275-REQ-03 ITEMS・LOOK・NEWS の見出しにも下線を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275 |
| 根拠 | ABOUT・STOCKIST にだけ下線があると区画がそろわないため、残りの3つにも付けると推定した（元の要件の文は「付けること」とだけ書く） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

ITEMS / LOOK / NEWS の見出しにも下線を表示すること

### ニュース一覧・詳細・管理の要件

文は `requirements.md` の 1.2・1.3・1.16 のまま。「今のコード」は 2026-10-24 にコードを読んで分かったこと。

### FR-NEWS-ALL-001 公開済みの記事を公開日の新しい順に並べる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 新しい知らせを先に見せるため。古い記事が上に来ると今のブランドの動きが伝わらない（SR-NEWS-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-001 の行） |

公開済みニュース記事を最新公開日順で一覧表示する。

### FR-NEWS-ALL-002 ALL と6つの分類で絞り込む

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 発表の種類ごとに読みたい人が絞れるようにするため（SR-NEWS-001）。ただし BLOG は DB の CHECK・管理の入力欄・型に無く、選んでも常に0件になる（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-002 の行） |

`ALL` / `COLLECTION` / `EVENT` / `COLLABORATION` / `SUSTAINABILITY` / `STORE` / `BLOG` のカテゴリ絞り込みを提供し、`ALL` は全記事表示とする。

今のコード（推定）: 画面の分類の一覧（`src/lib/news-data.ts` の `categories`）は BLOG を含み、選択肢に出る。記事の表の分類の CHECK（`supabase/migrations/20260901102912_remote_schema.sql` の `news_articles` の定義）と管理のフォームの選択肢（`src/app/admin/news/NewsForm.tsx` の分類の選択肢）は BLOG を含まないので、BLOG の記事は作れない。絞り込みは複数を選べる形（DRV-NEWS-001）。

### FR-NEWS-ALL-003 選んだ分類を URL の category に出し、共有できるようにする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 絞った状態の URL を人に送ったり保存したりできるようにするため（SR-NEWS-001） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-003 の行） |

カテゴリ選択は URL の `category` クエリパラメータに反映し、共有可能な状態にする。

今のコード（推定）: 複数を選ぶとカンマ区切り（`category=EVENT,COLLECTION`）で出す。ALL だけの時は category を消す。requirements.md の「レビュー:」の注は「未実装」と書くが、今は実装されている。

### FR-NEWS-ALL-004 記事カードに公開日・分類・題・概要を出し、押すと詳細へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 一覧で中身の見当をつけてから詳細へ進めるようにするため（SR-NEWS-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-004 の行） |

記事カードは公開日・カテゴリ・タイトル・概要を表示し、クリックで該当ニュース詳細ページへ遷移できる。

今のコード（推定）: 公開日は `YYYY.MM.DD`、概要は本文の要約（`content`）から Markdown の印を外した文字（DRV-NEWS-004）。画像は出さない（FREQ-32）。

### FR-NEWS-ALL-005 category を DB の取り出しに渡し、DB で絞る

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 絞った時に要る記事だけを DB から取り、余計な行を画面へ送らないため（SR-NEWS-001）。ただし今のコードは分類が1つの時だけ DB で絞り、複数の時は全部を取って画面で絞る（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-005 の行） |

サーバ側カテゴリ絞り込みを実装する。`searchParams.category` を `getPublishedNews()` に渡し、DB レベルでフィルタリングする。

今のコード（推定）: `src/app/news/page.tsx` は category が1つの正しい分類なら `getPublishedNews({ category })` で DB で絞る。複数（カンマ区切り）や正しくない値は ALL として全部を取り、`PublicNewsGrid` が画面で絞る。

### FR-NEWS-ALL-006 一覧のページの title と description を決めて出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 検索エンジンの結果と共有の時に、一覧のページの題と説明を正しく出すため（NFR-SEO-003 の決まりを一覧に当てる） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-006 の行） |

ニュース一覧ページに `generateMetadata` を実装し、`title` / `description` を明示的に設定する。

今のコード（推定）: title は「NEWS | Le Fil des Heures」、description は固定の文。requirements.md の「レビュー:」の注は「無い」と書くが、今は実装されている。

### FR-NEWS-ALL-007 分類の変化を URL に残し、ブラウザの戻るで元に戻す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-001 |
| 根拠 | 詳細を見て戻った時や選び直した時に、絞り込みをやり直させないため（SR-NEWS-001） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.2 ニュース一覧ページ（NEWS）」節の「表示・絞り込み」の FR-NEWS-ALL-007 の行） |

カテゴリ変化をクエリパラメータで保持し、ブラウザ戻るで絞り込み状態を復元できるようにする。

今のコード（推定）: 選ぶたびに履歴を足して URL を変え、URL が変わると選択を URL に合わせ直す。詳細へのリンクにも category を引き継ぐ。

### FR-NEWS-DETAIL-001 公開済みの記事の詳細のページを出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 一覧から選んだ記事を全文で読めるようにするため（SR-NEWS-002）。公開済みに限るのは、下書き（非公開）を外へ出さないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-001 の行） |

公開済みニュース記事の詳細ページを表示する。

今のコード（推定）: 公開済みの記事が無い・非公開・形の合わない id のどれも、Next.js の 404 になる。

### FR-NEWS-DETAIL-002 題・公開日・分類・本文を載せる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 記事が何の話で、いつの物かを一目で分かるようにするため（SR-NEWS-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-002 の行） |

記事詳細にはタイトル、公開日、カテゴリタグ、本文を掲載する。

今のコード（推定）: 題は h1、公開日は `YYYY.MM.DD`、分類は TagLabel、本文は文字として出す（HTML も Markdown も解釈しない）。画像は出さない。

### FR-NEWS-DETAIL-003 前後の記事と一覧への入口を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 読み終えた後に続けて別の記事や一覧へ移れるようにするため（SR-NEWS-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-003 の行） |

前後の記事へのナビゲーションとニュース一覧ページへの遷移を提供する。

### FR-NEWS-DETAIL-004 category があれば同じ分類の中で前後を辿り、正しくない値は ALL にする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 分類で絞って読んでいる人が、詳細でも同じ分類のまま前後を辿れるようにするため。正しくない値で画面を壊さないため ALL に倒す（SR-NEWS-002）。ただし今のコードは、記事と違う正しい分類を付けると 404 にし、複数の時は全部の分類で前後を出す（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-004 の行） |

`category` クエリパラメータが指定されている場合は同カテゴリ内の前後記事を継続して辿れるようにし、無効なカテゴリは `ALL` として扱う。

今のコード（推定）: 1つの正しい分類なら、記事そのものの取り出しにも分類を渡すので、記事と違う分類を URL に付けると 404 になる（一覧からのリンクではそうならない）。複数を指定すると前後は ALL で出し、リンクには複数のまま引き継ぐ。

### FR-NEWS-DETAIL-005 詳細の title と description を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 記事ごとの題と説明を検索エンジンと共有に出すため（NFR-SEO-003 の決まりを詳細に当てる） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-005 の行） |

`generateMetadata` で `title` / `description` のメタ情報を設定する。

今のコード（推定）: title は「<題> | NEWS | Le Fil des Heures」、description は本文の先頭 120 字。requirements.md の「レビュー:」の注は「無い」と書くが、今は実装されている。

### FR-NEWS-DETAIL-006 パンくずか分類へのリンクを出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 今どの分類のどの記事にいるかを示し、同じ分類の一覧へ戻りやすくするため（SR-NEWS-002） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | COULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-006 の行） |

パンくずまたはカテゴリリンクを提供し、現在位置の把握とカテゴリ内移動を容易にする。

今のコード（推定）: NEWS → 記事の分類 → 題のパンくずを出す。requirements.md の「レビュー:」の注は「未実装」と書くが、今は実装されている。

### FR-NEWS-DETAIL-007 前後のリンクに aria-label を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | スクリーンリーダーでも前後のリンクの行き先が分かるようにするため（NFR-A11Y-002 の決まりを前後のリンクに当てる） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | COULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-007 の行） |

前後リンクに `aria-label` などのアクセシビリティ属性を付与して、リンク先が明示的にわかるようにする。

今のコード（推定）: 「前の記事: <題>」「次の記事: <題>」。requirements.md の「レビュー:」の注は「未設定」と書くが、今は付いている。

### FR-NEWS-DETAIL-008 本文を段落と改行で読みやすく出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-NEWS-002 |
| 根拠 | 本文の段落を正しく区切り、読み上げでも文の構造が伝わるようにするため（NFR-A11Y-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.3 ニュース詳細ページ（NEWS DETAIL）」節の「表示・ナビゲーション」の FR-NEWS-DETAIL-008 の行） |

本文はアクセシビリティ対応を考慮して段落・改行を適切にレンダリングし、スクリーンリーダーで読みやすい構造とする。

今のコード（推定）: 空行（`\n\n`）で段落（p）に分け、段落の中の1つの改行も見える形で出す。

### FR-ADMIN-003 NEWS タブで記事の一覧・作成・編集・削除・公開の切り替えをする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-14 |
| 根拠 | 店長が管理画面の NEWS タブで記事の出し入れと公開の切り替えをできるようにするため（FREQ-14 を管理画面の形に落とした）。元の文書に上位の記載は無く、FREQ-14 につないだのは中身が同じだから（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md`（「1.16 管理画面（ADMIN）」節の「コンテンツ管理」の FR-ADMIN-003 の行） |

NEWS タブでニュース記事の一覧・作成・編集・削除・ステータス変更（公開/下書き）を管理する。

今のコード（推定）: 状態の値は「非公開（private）」と「公開（published）」の2つで、文の「下書き」は非公開に当たる。NEWS タブと「新規作成」は店長の役のときだけ出し、窓口は権限（admin.news.read・admin.news.manage）と 2要素認証で許す。

## 受け入れ条件

### 要求の表から写した受け入れ条件

### FREQ-14-AC-01 ニュースの管理でエラーが出ず登録・編集・削除が終わる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-14-REQ-01 |
| 根拠 | 登録・編集・削除のどれかが途中で止まると記事を出し入れできない。「エラーが出ない」を完了の目印にした元の書き方のまま写す。何を見て終わったとするかは書かれていない（未確認事項） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-14 の行） |

News管理でエラーが発生せず、登録・編集・削除が完了すること

### FREQ-31-AC-01 一覧に h1「NEWS」が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-31-REQ-01 |
| 根拠 | 見出しの要素を置かない形（FREQ-31-REQ-01）は、利用者に見えるテキスト「NEWS」の h1 が無いことで外から判定できる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-31 の行） |

NEWS 一覧ページにテキスト「NEWS」の見出し（h1）が表示されないこと

### FREQ-32-AC-01 記事カードに img が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-32-REQ-01 |
| 根拠 | カードに画像が戻ると文字だけの静かな並び（FREQ-32）が崩れる。外から判定できるよう、カードの中の img 要素の有無で見る |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-32 の行） |

NEWS 一覧ページの記事カード内に img 要素が表示されないこと

### FREQ-33-AC-01 画像なしで保存できる（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-33-REQ-01 |
| 根拠 | FREQ-33 と一緒に廃止した。今の確かめは FREQ-252-AC-01〜03 |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）」節の FREQ-33 の行） |

~~News 作成・編集フォームに画像アップロード欄が存在せず、画像を添付せずに保存・更新が完了すること~~ 廃止。FREQ-252 を参照

### FREQ-47-AC-01 モバイル・タブレットで FILTER ボタンの文字が ITEM と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-47-REQ-01 |
| 根拠 | ボタンが出るのはモバイル・タブレットだけなので、その幅で ITEM のボタンと比べないと、ずれても見つからない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-47 の行） |

モバイル・タブレットで NEWS 一覧の FILTER ボタンの文字サイズと letter-spacing が、ITEM 一覧の FILTER ボタンと一致すること

### FREQ-48-AC-01 選択肢の gap が ITEM と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-48-REQ-01 |
| 根拠 | 選択肢の詰まり方のずれは並びの gap の値に出るため、ITEM の値と比べる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-48 の行） |

NEWS 一覧の FILTER 選択肢リストの gap が、ITEM 一覧の FILTER 選択肢リストの gap と一致すること

### FREQ-48-AC-02 選択肢の字間が ITEM と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-48-REQ-01 |
| 根拠 | 選択肢の文字の見た目のずれはラベルの letter-spacing に出るため、ITEM の値と比べる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-48 の行） |

NEWS 一覧の FILTER 選択肢ラベルの letter-spacing が、ITEM 一覧の FILTER 選択肢ラベルと一致すること

### FREQ-49-AC-01 lg・xl・2xl で本文の列の左 padding が ITEM と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-49-REQ-01 |
| 根拠 | 本文の列の左 padding は幅の段階（lg・xl・2xl）ごとに値が変わるので、1つの幅だけ合っていても他の幅でずれる。3つの幅で ITEM と比べる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-49 の行） |

デスクトップ（lg/xl/2xl の各幅）で NEWS 一覧のコンテンツ列の左 padding が、ITEM 一覧のコンテンツ列の左 padding と一致すること

### FREQ-119-AC-01 デスクトップで4ページのサイドバーの幅が一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-119-REQ-01 |
| 根拠 | サイドバーの幅は4ページで別々の部品が決めるので、1ページだけ直してもずれる。実際の幅を4ページで比べる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-119 の行） |

デスクトップで4ページの左サイドバー幅が一致すること

### FREQ-119-AC-02 デスクトップで4ページの本文の左の余白が一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-119-REQ-01 |
| 根拠 | 本文の左の余白も4ページで別々に決まるので、実際の値を4ページで比べないとずれが残る |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-119 の行） |

デスクトップで4ページのメインコンテンツ列の左余白（フィルターとの間隔）が一致すること

### FREQ-126-AC-01 ITEMS の見出しの右に /item への VIEW ALL がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-126-REQ-01 |
| 根拠 | 見出しの右の入口が無いと FREQ-126 が満たされない。リンクの有無で外から判定できる（ITEM は範囲外の領域） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

ITEMS セクション見出し右側に /item への VIEW ALL リンクが表示されること

### FREQ-126-AC-02 LOOK の見出しの右に /look への VIEW ALL がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-126-REQ-01 |
| 根拠 | 見出しの右の入口が無いと FREQ-126 が満たされない。リンクの有無で外から判定できる（LOOK は範囲外の領域） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

LOOK セクション見出し右側に /look への VIEW ALL リンクが表示されること

### FREQ-126-AC-03 NEWS の見出しの右に /news への VIEW ALL がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-126-REQ-01 |
| 根拠 | NEWS の区画にも同じ入口が要る（FREQ-126）。リンクの有無で外から判定できる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

NEWS セクション見出し右側に /news への VIEW ALL リンクが表示されること

### FREQ-126-AC-04 下の中央の VIEW ALL ボタンが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-126-REQ-01 |
| 根拠 | 下の中央のボタンが残ると入口が二重になる。ボタンが無いことで、廃止を外から判定できる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126 の行） |

従来の下部中央 VIEW ALL ボタン（VIEW ALL ITEMS／VIEW LOOKBOOK／VIEW ALL NEWS）が表示されないこと

### FREQ-146-AC-01 VIEW ALL に data-ui-button と secondary が付く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-146-REQ-01 |
| 根拠 | 共通の Button で描いたかは見た目だけでは分からないので、部品が付ける印（data-ui-button と secondary）で判定する |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-146 の行） |

ホームの ITEM / LOOK / NEWS 各セクションの VIEW ALL ボタンに data-ui-button="true"（variant=secondary）が付与されていること

### FREQ-146-AC-02 VIEW ALL に右矢印のアイコンが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-146-REQ-01 |
| 根拠 | 矢印を外す（FREQ-146）ことは、アイコンの要素が無いことで外から判定できる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-146 の行） |

VIEW ALL ボタン内に右矢印アイコン（ri-arrow-right-line）が表示されないこと

### FREQ-149-AC-01 390・768・1280px で NEWS が最大6件出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-149-REQ-01 |
| 根拠 | 幅によって件数が変わる不具合（モバイルだけ少ないなど）を見つけるため、3つの幅それぞれで件数を数える |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-149 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）のいずれでも NEWS 記事が最大6件（取得件数どおり）表示されること

### FREQ-149-AC-02 総数が6件以下なら VIEW ALL が無く、多ければある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-149-REQ-02 |
| 根拠 | 入口の出し分けは6件以下と6件より多いで動きが違うので、片側だけでは条件の誤りを見逃す。両側で有無を見る |
| 状態 | 現行 |
| 確かめ方 | E2E（6件より多い側だけ。6件以下の側は並列の E2E の件数と干渉するので E2E にしない。確かめ方は未確認事項） |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-149 の行） |

公開 NEWS の総数が6件以下の場合は VIEW ALL ボタンが表示されず、6件より多い場合は表示されること

### FREQ-185-AC-01 /api/search の画像の URL が署名つきの形になっている

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-185-REQ-01 |
| 根拠 | 画像が出る前提は、URL が署名つきの形で、公開の形（/object/public/）でないこと。応答を直接見れば画面に頼らず判定できる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-185 の行） |

/api/search のレスポンスで items / looks / news の imageUrl がいずれも `/storage/v1/object/sign/` を含む署名付き URL であること（`/object/public/` でないこと）

### FREQ-185-AC-02 3つの幅で検索の結果の画像が読み込まれる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-185-REQ-01 |
| 根拠 | URL の形だけでは画像が出ることまでは分からないので、画面で画像が読み込まれ 400 が返らないことを確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-185 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）の検索結果画面で、各結果行のサムネイル画像が実際に読み込まれていること（naturalWidth > 0）かつ画像リクエストが 400 を返さないこと

### FREQ-252-AC-01 作成と編集のフォームに画像の欄と file の入力がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252-REQ-01 |
| 根拠 | 欄が作成か編集のどちらかにしか無いと、片方で画像を付けられない。両方のフォームで確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

News 作成フォームと編集フォームの両方に「画像」欄と file 入力が存在すること

### FREQ-252-AC-02 作る時に画像が無いと送らず、直す時は画像なしで更新できる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252-REQ-02 |
| 根拠 | 作る時の必須と直す時の任意は逆の動きなので、両方を送信の有無と文言で確かめないと片方の誤りを見逃す |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

作成モードで画像を添付せず送信すると「画像を添付してください」が表示され、送信APIが呼ばれないこと。編集モードでは画像未選択のまま更新できること

### FREQ-252-AC-03 種類の外・5MB 超はそれぞれの文言で断る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252-REQ-03 |
| 根拠 | 種類と大きさは別の条件で、文言も違う。どちらも外れた時にそれぞれ断ることを文言で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-252 の行） |

対象外の MIME を選ぶと「画像は JPEG / PNG / WebP / GIF を選択してください」、5MB 超を選ぶと「画像サイズは5MB以下にしてください」が表示されること

### FREQ-274-AC-01 1920px で左のフィルターの左端が 40px 以内にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-274-REQ-01 |
| 根拠 | 1680px の上限を外した効果は、上限を超える広い画面でしか見えない。1920px で左端からの距離を測る |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-274 の行） |

desktop（1920px）で、NEWS / ITEM / LOOK の左フィルター（aside）の左端が画面左から40px以内にあること

### FREQ-274-AC-02 1280px で左のフィルターの左端が 40px 以内にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-274-REQ-02 |
| 根拠 | 上限を外しても狭い画面の位置が動いていないことを、1680px 以下の 1280px で確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-274 の行） |

desktop（1280px）で、NEWS / ITEM / LOOK の左フィルター（aside）の左端が画面左から40px以内にあること

### FREQ-275-AC-01 3つの幅で5つの見出しの文字の大きさが同じ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275-REQ-01 |
| 根拠 | 区画の見出しが部品ごとにずれると並びがそろわない。5つの見出しの font-size が同じことで外から判定する |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、ホーム上の ITEMS / LOOK / NEWS / ABOUT / STOCKIST の見出しがすべて同一の font-size を持つこと

### FREQ-275-AC-02 390・768px で 20px、1280px で 28px

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275-REQ-02 |
| 根拠 | 値は幅の段階ごとに変わるので、幅ごとに確かめる。今のコードの値との食い違いは FREQ-275-REQ-02 に書いた |
| 状態 | 推定 |
| 確かめ方 | 未定（E2E にしない。AC の文の 20px／28px と、撤回した FREQ-314-REQ-02（範囲外）・実装の流体の文字の大きさが食い違う。文面をユーザーが決めてから確かめ方を決める。未確認事項） |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

mobile（390px）/ tablet（768px）で 20px、desktop（1280px）で 28px であること

### FREQ-275-AC-03 3つの幅で5つの見出しに下線がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-275-REQ-03 |
| 根拠 | ABOUT・STOCKIST と同じ下線が3つの区画にもあることを、text-decoration-line の値で外から判定する |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-275 の行） |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、5つの見出しすべての text-decoration-line が underline であること

### 新しく起こした受け入れ条件

要件の文から、画面の外から確かめられる形に起こした。ユーザーの確認を受けていないので「推定」。

### FR-NEWS-ALL-001-AC-01 一覧の記事が公開日の新しい順に並ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-001 |
| 根拠 | 新しい知らせが先頭に来ないと今のブランドの動きが伝わらない（SR-NEWS-001）。並びは、見える公開日が上から新しい順かで判定できる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-001） |

`/news` を開くと、記事カードの公開日が上から新しい順（同じ日は順不同）に並んで表示されること。

### FR-NEWS-ALL-001-AC-02 非公開の記事が一覧に出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-001 |
| 根拠 | 下書きが一覧に混ざると発表前の記事を先に知られる（SEC-NEWS-001）。非公開の記事の題が出ないことで判定する。`e2e/FR-NEWS-ALL-018-list-behaviour-and-layout.spec.ts` が 3 つの幅で試す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-001） |

非公開（private）の記事があるとき、`/news` の一覧にその記事の題が表示されないこと。

### FR-NEWS-ALL-002-AC-01 7つの分類の選択肢が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-002 |
| 根拠 | 選択肢が欠けると読みたい分類で絞れない。7つが画面に出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-002） |

`/news` に ALL・COLLECTION・EVENT・COLLABORATION・SUSTAINABILITY・STORE・BLOG の選択肢が表示されること。

### FR-NEWS-ALL-002-AC-02 分類を選ぶとその分類の記事だけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-002 |
| 根拠 | 絞り込みが効かなければ選択肢が飾りになる。出た記事の分類が選んだ分類だけかで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-002） |

1つの分類を選ぶと、表示される記事カードの分類がすべて選んだ分類であること。

### FR-NEWS-ALL-002-AC-03 ALL を選ぶと全部の記事が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-002 |
| 根拠 | ALL が絞ったままだと読めない記事が出る。件数が絞る前と同じかで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-002） |

ALL を選ぶと、公開済みの記事がすべて表示されること。

### FR-NEWS-ALL-003-AC-01 分類を選ぶと URL の category に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-003 |
| 根拠 | 選んだ分類が URL に出ないと、絞った状態を人に送れない。選んだ後の URL で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-003） |

分類を選ぶと、URL の `category` に選んだ分類が表示されること（ALL だけの時は `category` が無いこと）。

### FR-NEWS-ALL-003-AC-02 category 付きの URL を開くとその分類が選ばれている

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-003 |
| 根拠 | 送られた URL を開いた人が同じ状態を見られなければ共有にならない。開いた側の選択の表示で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-003） |

`/news?category=EVENT` を開くと、EVENT が選ばれた状態で表示されること。

### FR-NEWS-ALL-004-AC-01 カードに公開日・分類・題・概要が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-004 |
| 根拠 | 一覧で中身の見当がつかないと詳細へ進む理由が無い。4つの項目がカードごとに出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-004） |

記事カードに公開日（`YYYY.MM.DD`）・分類・題・概要が表示されること。

### FR-NEWS-ALL-004-AC-02 カードを押すとその記事の詳細が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-004 |
| 根拠 | カードから詳細へ移れなければ記事を読めない。押した後のページで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-004） |

記事カードを押すと、その記事の詳細ページ（`/news/<id>`）が表示されること。

### FR-NEWS-ALL-005-AC-01 category 付きで開くとその分類の記事だけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-005 |
| 根拠 | 絞った時に別の分類の記事が混ざらないことが、利用者に見える結果。DB で絞ったかは画面からは見えないので、出た記事の分類で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-005） |

`/news?category=EVENT` を開くと、表示される記事カードの分類がすべて EVENT であること。

### FR-NEWS-ALL-006-AC-01 一覧の title と description が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-006、NFR-SEO-003（範囲外） |
| 根拠 | title と description が無い一覧は、検索の結果と共有で区別がつかない（NFR-SEO-003（範囲外））。ページの title と meta の description で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-006） |

`/news` の title が「NEWS | Le Fil des Heures」で、meta の description が空でないこと。

### FR-NEWS-ALL-007-AC-01 分類を変えた後に戻ると前の選択に戻る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-007 |
| 根拠 | 選び直しを戻れないと、絞り込みをやり直すことになる。戻った後の URL と選択の表示で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-007） |

分類を続けて選んだ後にブラウザの戻るを押すと、1つ前の選択の URL と選択の表示に戻ること。

### FR-NEWS-ALL-007-AC-02 詳細から戻ると一覧の選択が残っている

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-007 |
| 根拠 | 詳細を見て戻った時に選択が消えると、読み進めるたびに絞り直す。詳細を挟んだ後の選択で、分類が1つの時と複数の時の両方を判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-ALL-007） |

分類を選んで詳細へ移り、ブラウザの戻るを押すと、一覧が同じ分類の選択で表示されること（分類が1つの時と複数の時の両方）。

### FR-NEWS-DETAIL-001-AC-01 公開済みの記事の詳細に題が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-001 |
| 根拠 | 詳細が開かなければ記事を全文で読めない（SR-NEWS-002）。記事の題（h1）が出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-001） |

一覧から公開済みの記事の詳細を開くと、記事の題が h1 で表示されること。

### FR-NEWS-DETAIL-001-AC-02 無い記事・非公開の記事の詳細は 404

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-001 |
| 根拠 | 下書きの詳細が開くと発表前の記事が見える（SEC-NEWS-001）。公開済み以外で中身が出ないことで判定する。`e2e/FR-NEWS-DETAIL-009-detail-edge-cases-and-body-safety.spec.ts` が 3 つの幅で試す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-001） |

存在しない id、または非公開（private）の記事の `/news/<id>` を開くと、404 のページが表示され、記事の題と本文が表示されないこと。

### FR-NEWS-DETAIL-002-AC-01 題・公開日・分類・本文が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-002 |
| 根拠 | 記事が何の話でいつの物か分からないと読み始められない。4つの項目が詳細に出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-002） |

詳細に題（h1）・公開日（`YYYY.MM.DD`）・分類のタグ・本文が表示されること。

### FR-NEWS-DETAIL-003-AC-01 前後のリンクと VIEW ALL が出て、VIEW ALL で一覧へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-003 |
| 根拠 | 読み終えた人が続けて移れる入口が無いと、記事で終わってしまう。2つの入口が出ることと、押した後のページで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-003） |

記事が2件以上あるとき、前か次の記事へのリンクが表示されること。VIEW ALL が表示され、押すとニュース一覧が表示されること。

### FR-NEWS-DETAIL-004-AC-01 category 付きの詳細では VIEW ALL と前後に同じ category が付く

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-004 |
| 根拠 | 分類で絞って読んでいる人が、詳細で分類が切れると読み進めを中断される。リンク先の category が引き継がれることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-004） |

記事の分類を `category` に付けて詳細を開くと、VIEW ALL のリンク先が `/news?category=<その分類>` であること。

### FR-NEWS-DETAIL-004-AC-02 正しくない category は ALL として扱う

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-004 |
| 根拠 | 正しくない値で画面が壊れると、共有された URL が開けなくなる。ALL へ倒れて category の無いリンク先になることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-004） |

`category=INVALID_CATEGORY` を付けて詳細を開くと、記事が表示され、VIEW ALL のリンク先が `/news`（category 無し）であること。

### FR-NEWS-DETAIL-005-AC-01 詳細の title に NEWS を含み、description が空でない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-005、NFR-SEO-003（範囲外） |
| 根拠 | 記事ごとの題と説明が無いと、検索の結果と共有で記事を区別できない（NFR-SEO-003（範囲外））。ページの title と meta の description で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-005） |

詳細の title に記事の題と「NEWS」が含まれ、meta の description が空でないこと。

### FR-NEWS-DETAIL-006-AC-01 一覧へのリンクと分類の一覧へのリンクが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-006 |
| 根拠 | 今の位置が分からないと迷い、同じ分類の一覧へ戻れない。一覧と分類の一覧への2つのリンクで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-006） |

詳細に NEWS 一覧へのリンクと、記事の分類で絞った一覧（`/news?category=<分類>`）へのリンクが表示されること。

### FR-NEWS-DETAIL-007-AC-01 前後のリンクに行き先の題を含む aria-label が付く

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-007、NFR-A11Y-002（範囲外） |
| 根拠 | スクリーンリーダーでは、行き先が名前に無いとリンクの意味が分からない（NFR-A11Y-002（範囲外））。aria-label の文で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-007） |

前後のリンクに「前の記事: <題>」「次の記事: <題>」の aria-label が付いていること。

### FR-NEWS-DETAIL-008-AC-01 本文が段落ごとの p で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-DETAIL-008、NFR-A11Y-002（範囲外） |
| 根拠 | 本文が1つの塊だと読み上げで文の構造が伝わらない（NFR-A11Y-002（範囲外））。p 要素の数で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-NEWS-DETAIL-008） |

空行で区切った本文が、区切りごとに別の段落（p 要素）として表示されること。

### FR-ADMIN-003-AC-01 NEWS タブに記事の一覧が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003 |
| 根拠 | 店長が記事の状態を見られないと、出し入れの判断ができない。公開・非公開の両方が状態つきで出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-003） |

店長が管理画面の NEWS タブを開くと、公開・非公開の両方の記事が題・公開日・分類・状態つきで表示されること。

### FR-ADMIN-003-AC-02 作った記事が一覧に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003 |
| 根拠 | 保存したつもりで記事が一覧に無いと、出せたか分からない。保存の後に一覧に出ることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-003） |

新規作成で題・分類・公開日・概要・本文・状態・画像を入れて保存すると、「保存しました」が表示され、NEWS タブの一覧にその記事が表示されること。

### FR-ADMIN-003-AC-03 直した内容が一覧に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003 |
| 根拠 | 直した内容が反映されていないと、誤った記事が残る。更新の後の一覧の題で判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-003） |

記事の編集で題を変えて更新すると、「更新しました」が表示され、NEWS タブの一覧に新しい題が表示されること。

### FR-ADMIN-003-AC-04 消した記事が一覧から消える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003 |
| 根拠 | 確かめ無しで消えると押し間違いを戻せない（DRV-NEWS-013）。同意の後に一覧から消えることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-003） |

記事の削除を押して確かめに同意すると、NEWS タブの一覧からその記事が表示されなくなること。

### FR-ADMIN-003-AC-05 公開・非公開を切り替えると状態の表示が変わる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003 |
| 根拠 | 公開の切り替えを誤ると下書きが外に出る。状態の表示が変わることで判定する |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-003） |

非公開の記事で「公開」を押すと状態が「公開中」に、公開中の記事で「非公開」を押すと「非公開」に変わって表示されること。

## セキュリティ要件

### SEC-NEWS-001 公開の道は公開済みの記事だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-001 |
| 根拠 | 発表前の記事を先に知られないため。DB の RLS とアプリの取り出しの絞りの2段で守り、片方が崩れても漏れないようにする（過去のレビューが「維持」とした形）。全体の NFR-SEC-005（権限管理）を NEWS の公開の線引きに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_news.md:52` |
| 優先度 | MUST |

`/news`・`/news/<id>`・`/api/news`・検索・anon と一般会員の JWT での PostgREST の読み出しは、`status='published'` の行だけを返す。今のコードは満たす（`src/features/news/services/public.ts` の公開の取り出しの各関数が `status='published'` で絞り、`supabase/migrations/20260901102912_remote_schema.sql` の `news_articles` の RLS が公開の行だけを anon と一般会員に許す）。この性質を試すテストは無い。

### SEC-NEWS-001-AC-01 anon と一般会員の直接の読み出しに非公開の記事が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-001 |
| 根拠 | RLS の段だけで守れているかを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に非公開の記事を1件入れ、anon の鍵と一般会員の JWT で `news_articles` を select する） |
| 出どころ | 実装から推定 |

非公開の記事を1件入れた状態で、anon と一般会員の JWT の select の結果にその記事が含まれないこと。

### SEC-NEWS-001-AC-02 公開の画面・API・検索に非公開の記事が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-001 |
| 根拠 | アプリの取り出しの段で守れているかを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

非公開の記事の id で `/news/<id>` を開くと 404 の画面が表示されること。`/news` の一覧・`/api/news` の応答・検索の NEWS の結果に、非公開の記事の題が表示されないこと。

### SEC-NEWS-002 DB でも管理の権限を使う操作に、生きている session と2要素認証の済みを求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-002 |
| 根拠 | パスワードだけで得た session や、ログアウト・失効の後も期限の残る access token で PostgREST を直接叩き、アプリの窓口の aal2 と session の生存の確かめを飛ばされないため。全体の NFR-SEC-008（RBAC）と FREQ-540（範囲外。DB の ACL・session・aal2 で管理操作を守る）を NEWS の表に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1 |
| 優先度 | MUST |

`news_articles` の RLS のうち `admin.news.read`・`admin.news.manage` で許す方針は、JWT の `aal` が `aal2` で、JWT の `session_id` の session が生きている（ログアウト・失効していない）時だけ許す。今のコードはどちらも満たさない（`supabase/migrations/20261023175712_group_g0_permissions.sql` の `has_permission` は `auth.uid()` と ACL の表だけを見る）。

### SEC-NEWS-002-AC-01 aal1 の session では非公開の記事を直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-002 |
| 根拠 | 2要素認証を済ませていない session で、下書きの読み出しに届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.news.read` を持つ試し用の利用者の aal1 の JWT で、手元の Supabase の `news_articles` を select する） |
| 出どころ | 実装から推定 |

`admin.news.read` を持つ利用者の aal1 の JWT で select した時、非公開の記事が結果に含まれないこと。

### SEC-NEWS-002-AC-02 aal1 の session では記事を直接書き換え・消去できない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-002 |
| 根拠 | 改ざんと消去の道も、読み出しと同じく aal2 で閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.news.manage` を持つ試し用の利用者の aal1 の JWT で insert・update・delete を送る） |
| 出どころ | 実装から推定 |

aal1 の JWT の insert・update・delete が、どれも行を変えずに終わること（権限の誤りか0件）。

### SEC-NEWS-002-AC-03 ログアウトした session の token では news_articles を直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-002 |
| 根拠 | 失効した session の道も、aal1 の道と同じく DB で閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.news.read` を持つ試し用の利用者でログアウトの前に access token を控え、ログアウトの後にその token で手元の Supabase の `news_articles` を select する） |
| 出どころ | 実装から推定 |

ログアウトの後（token の期限の前）に、控えた token で select した結果に非公開の記事が含まれないこと。

### SEC-NEWS-003 画像の置き場は非公開で、その設定を移行で持つ

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-003 |
| 根拠 | 非公開の記事の画像を、公開の URL から開かせないため。設定が手元の見本だけにあると、本番と手元で食い違っても気づけない |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md:45-48` |
| 優先度 | MUST |

置き場 `news-images` は `public=false` とし、大きさの上限（5MB）と種類の上限（JPEG・PNG・WebP・GIF）を付け、`storage.objects` に読み書きの方針を作らない（service role と署名つき URL だけで扱う）。この定義を `supabase/migrations/` の移行に置く。今のコードは満たさない。

### SEC-NEWS-003-AC-01 移行だけを当てた DB で置き場が非公開になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-003 |
| 根拠 | 見本のデータに頼らず、移行の中に置き場の設定があることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | CI の結合テスト（`supabase db reset --no-seed` で移行だけを当てた DB の `storage.buckets` を読む）。共有の手元 DB・並列の E2E からは見本なしの DB を用意できないので E2E にしない |
| 出どころ | 実装から推定 |

`storage.buckets` の `news-images` の行があり、`public` が false、`file_size_limit` が 5MB、`allowed_mime_types` が4つの画像の種類であること。

### SEC-NEWS-003-AC-02 公開の URL では記事の画像を開けない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-003 |
| 根拠 | 利用者の見える所で、公開の道が閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

記事の画像の道筋を `/storage/v1/object/public/news-images/<道筋>` で開くと、画像が返らない（4xx）こと。

### SEC-NEWS-004 署名つき URL と最適化の画像を、短い期限で失わせる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-004 |
| 根拠 | 署名つき URL は取り消せないので、非公開にした後に画像が見える時間を期限で区切るしかない。最適化のキャッシュが期限より長いと、期限の守りが崩れる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・レビュー |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_news_id.md:51` |
| 優先度 | SHOULD |

画像の署名つき URL の期限は1時間以下とする。最適化した画像のキャッシュの長さも、署名の期限を超えないように設定する。期限は今のコードが満たす（`src/lib/storage/news-images.ts` の署名の期限の定数）。キャッシュの長さは設定が無い。

### SEC-NEWS-004-AC-01 署名つき URL の期限が1時間以下

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-004 |
| 根拠 | 非公開にした後に見える時間の上限を、署名の期限で決めるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`/api/news` の応答の `image_url` の期限を読む） |
| 出どころ | 実装から推定 |

公開の応答の署名つき URL の期限が、発行から3600秒以下であること。

### SEC-NEWS-004-AC-02 最適化の画像のキャッシュが署名の期限を超えない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-004 |
| 根拠 | 最適化の中継に残った画像で、署名の期限の守りを崩さないため |
| 状態 | 推定 |
| 確かめ方 | E2E（管理の一覧の画像の `/_next/image` の応答の見出しを読む） |
| 出どころ | 実装から推定 |

管理の一覧の画像の `/_next/image` の応答の `Cache-Control` の `max-age` が3600以下であること。

### SEC-NEWS-005 公開の応答に、画面で使わない画像の道筋を載せない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-004 |
| 根拠 | 公開の一覧・詳細は画像を出さない（FREQ-32）ので、署名つき URL を配る先を減らせば、非公開にした後に残る URL も減る。毎回の署名の呼び出しも減る |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_news.md:48,73` |
| 優先度 | SHOULD |

公開の一覧・詳細の取り出しと `/api/news` は `image_url` を返さない。画像の要る検索の結果は対象外。2026-10-26 に満たした（以前は一覧・詳細の取り出しが `image_url` を選び、service role の client で署名して返した）。

- `getPublishedNews` は `select('id, title, published_date, category, content')`、`getPublishedNewsDetailById` は `select('id, title, published_date, category, content, detailed_content')` で読み、`image_url` を選ばない。`createServiceRoleClient`・`signNewsImageFields` を呼ばない。型 `PublicNewsArticle` から `image_url` を外した（IMPL-NEWS-121・123、DD-NEWS-003・031）
- 公開の道（`/news`・`/news/[id]`・`/api/news`・ホームの NEWS の節）は service role を持たない。画像の署名が残るのは検索（`signResultImages`）と管理（`/api/admin/news`）だけ
- 公開の画面は記事の画像を出さない（FREQ-32）ので、見た目は変わらない

### SEC-NEWS-005-AC-01 /api/news の応答に image_url が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-005 |
| 根拠 | 外へ出る JSON に署名つき URL が載らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/news` の応答の各記事に `image_url` の値が含まれないこと。

### SEC-NEWS-005-AC-02 公開の一覧と詳細の頁に署名つき URL が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-005 |
| 根拠 | 画面の HTML と、頁に埋めたデータにも署名つき URL が載らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/news` と `/news/<id>` の頁の HTML に、`/storage/v1/object/sign/news-images/` を含む文字が表示・埋め込みされないこと。

### SEC-NEWS-006 署名つき URL を含む応答と失敗の応答を共有のキャッシュに残させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-005 |
| 根拠 | 中継のキャッシュが古い応答や 429 を別の利用者に渡さないため。署名つき URL を含む応答は利用者ごとの物として扱う |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.2.1。`docs/05_Quality/reviews/security/security_review_news.md:47,49` |
| 優先度 | MUST |

`/api/news` の成功・失敗の応答と、回数の制限の 429・503 に `Cache-Control: no-store`（または `private`）を付ける。今のコードは満たさない。

### SEC-NEWS-006-AC-01 /api/news の成功の応答に no-store が付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-006 |
| 根拠 | 署名つき URL を含む応答が共有のキャッシュに残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/news` の 200 の応答の `Cache-Control` に `no-store` か `private` が含まれること。

### SEC-NEWS-006-AC-02 /api/news の失敗と回数の制限の応答に no-store が付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-006 |
| 根拠 | 429 や 500 が残り、別の利用者まで断られないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（回数の上限を超えるまで送る） |
| 出どころ | 実装から推定 |

`/api/news` の 429 の応答の `Cache-Control` に `no-store` が含まれること。

### SEC-NEWS-007 署名する前に、道筋が記事の画像の場所にあることを確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-006 |
| 根拠 | service role の署名は RLS が効かないので、DB の値が書き換えられても置き場の別の物を配らないよう、署名の手前で場所を絞る |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_news.md:90` |
| 優先度 | MUST |

署名するのは、道筋が `news/` の下にあり（`..` を含まない）、URL の時はホストが自分の Supabase のプロジェクトである物だけ。外れた物は署名しない。公開・管理・検索の全部の署名に当てる。公開の道は署名しなくなった（SEC-NEWS-005）ので、残る署名の経路（検索と管理）の道筋の絞りは今のコードは満たさない（波 1-C）。

### SEC-NEWS-007-AC-01 news/ の外の道筋には署名しない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-007 |
| 根拠 | 置き場の別の場所の物が、公開の応答から配られないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で記事の `image_url` を `other/x.png` に書き換え、`/api/news` を読む） |
| 出どころ | 実装から推定 |

`image_url` が `news/` の外の記事について、`/api/news` の応答に署名つき URL が含まれないこと。公開の道は署名しない（SEC-NEWS-005）ので、この確かめは `/api/news` から `image_url` を外した後は署名の無いことを読むだけになる。署名の関数が道筋を絞る確かめは、検索と管理の署名を直す波 1-C で単体テストに移す。

### SEC-NEWS-007-AC-02 別のホストの URL には署名しない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-007 |
| 根拠 | 別のプロジェクトの URL の形をした値を、自分の置き場の署名に変えないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（記事の `image_url` を別のホストの `/storage/v1/object/public/news-images/news/x.png` に書き換え、`/api/news` を読む） |
| 出どころ | 実装から推定 |

別のホストの URL の記事について、`/api/news` の応答に自分の置き場の署名つき URL が含まれないこと。公開の道は署名しない（SEC-NEWS-005）ので、`/api/news` では署名の無いことを読むだけになる。署名の関数が別のホストを断る確かめは、検索と管理の署名を直す波 1-C で単体テストに移す。

### SEC-NEWS-008 署名に失敗した時は閉じる側へ倒れ、失敗を記録に残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-007 |
| 根拠 | 失敗の時に素の道筋や外の URL を閲覧者へ渡さないため。失敗が続くのは改ざんか障害の兆しなので、気づけるよう記録に残す |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.5。`docs/05_Quality/reviews/security/security_review_news_id.md:44,96-97` |
| 優先度 | MUST |

道筋にできない値と署名の失敗は、元の値ではなく `null` を返す。失敗を、道筋の全部や鍵を含まない形で記録に残す。公開の道は署名しなくなった（SEC-NEWS-005）ので、残る署名の経路（検索と管理）の閉じる側への倒れは今のコードは満たさない（波 1-C）。

### SEC-NEWS-008-AC-01 署名の失敗で元の値を返さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-008 |
| 根拠 | 開く側へ倒れないことを、外から見える応答で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の置き場に無い道筋を持つ記事を入れ、`/api/news` を読む） |
| 出どころ | 実装から推定 |

署名できない記事について、`/api/news` の応答の `image_url` が null であり、DB の値と同じ文字が含まれないこと。公開の道は `image_url` を返さなくなった（SEC-NEWS-005）ので、`/api/news` では DB の値と同じ文字が含まれないことを読む。署名の失敗で null を返す確かめは、検索と管理の署名を直す波 1-C で行う。

### SEC-NEWS-008-AC-02 署名の失敗が記録に1件残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-008 |
| 根拠 | 失敗に気づけることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（署名の関数の失敗の道で、記録の出口に渡る引数を捕まえる）。E2E のサーバーは別プロセスで記録を読めないので E2E にしない |
| 出どころ | 実装から推定 |

署名できない記事を1回読んだ時、署名の失敗の記録が1件出ており、その記録に service role の鍵が含まれないこと。

### SEC-NEWS-009 公開の読み出しに件数の上限と回数の制限を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-008 |
| 根拠 | 認証の無い窓口と頁（`/api/news`・`/news`・`/news/[id]`）を続けて叩かれても、DB と署名の負荷が記事の数や回数に比例して増えないため（2026-04-18 の Critical の指摘で足した守りを、画面の取り出しにも広げる） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/code/2026-04-18-news-review.md:30`、`docs/05_Quality/reviews/security/security_review_actions.md:35,37` |
| 優先度 | MUST |

`/api/news` は10分に60回・1回20件までとする（今のコードは満たす。`src/app/api/news/route.ts` の件数の定数と回数の制限の呼び出し）。公開の取り出しの関数は、呼び手が上限を渡さなくても件数の上限を持つ。詳細の頁の前後の記事の取り出しは、公開済みの全部を読まず、今の記事の前と次だけを読む。外から呼べる使われない Server Action を残さない。後ろの3つは今のコードが満たさない（前後の記事の取り出し `src/features/news/services/public.ts` の `getPublishedNewsNavigation` が、上限なしに公開済みの全部を読む）。

### SEC-NEWS-009-AC-01 /api/news は20件を超えて返さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-009 |
| 根拠 | 1回の要求で全部を吸い出せないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/news?limit=1000` の応答の記事の数が20以下であること。

### SEC-NEWS-009-AC-02 /api/news は10分に61回目を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-009 |
| 根拠 | 続けて叩いた時に止まることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

同じ送り元から10分の間に61回送った時、61回目が 429 で、`Retry-After` の見出しが付くこと。

### SEC-NEWS-009-AC-03 公開の一覧の取り出しは上限を渡さなくても上限で止まる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-009 |
| 根拠 | 回数の制限を通らない画面の取り出しでも、1回の負荷に上限があることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 未定（上限の値が決まるまで E2E にしない。決まったら、手元の Supabase に上限より多い公開の記事を入れて `/news` を開く E2E を書く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

公開の記事が上限より多い時、`/news` に表示される記事の数が上限以下であること。上限の値は未定。

### SEC-NEWS-009-AC-04 詳細の前後の取り出しは公開済みの全部を読まない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-009 |
| 根拠 | 回数の制限を通らない詳細の頁でも、1回の要求の負荷が記事の数に比例しないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 結合テスト（公開の記事を100件入れ、前後の取り出しが返す行を数える）。PostgREST の記録は E2E から読めないので E2E にしない |
| 出どころ | 実装から推定 |

公開の記事が100件ある時に `/news/<id>` を1回開いて、前後の記事のための読み出しが返す行が合わせて3件以下であること。

### SEC-NEWS-010 anon が PostgREST・RPC を直接叩いた時も件数に上限がある

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-009 |
| 根拠 | アプリの回数の制限は PostgREST・RPC の直接の道を通らないので、DB の側でも1回の負荷に上限を置く。ゲストのカートの RPC の直接の道を塞いだ FREQ-322 と同じ考え |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4 |
| 優先度 | SHOULD |

`search_news` の `limit_count` は上限に丸める（または anon の EXECUTE を外し、サーバーからだけ呼ぶ）。使われていない `search_public_news` の PUBLIC への付与を外す。PostgREST の `max_rows` を本番でも決めた値にする。今のコードは満たさない。

### SEC-NEWS-010-AC-01 anon の search_news は大きな件数を求めても上限で止まる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-010 |
| 根拠 | 検索の関数を直接呼んでも、件数の上限を外せないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に anon の鍵で RPC を呼ぶ） |
| 出どころ | 実装から推定 |

anon で `search_news` を `limit_count=10000` で呼んだ時、返る行が20以下であるか、呼び出しが断られること。

### SEC-NEWS-010-AC-02 anon は search_public_news を呼べない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-010 |
| 根拠 | 使われていない関数を、外からの入口として残さないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に anon の鍵で RPC を呼ぶ） |
| 出どころ | 実装から推定 |

anon で `search_public_news` を呼ぶと、権限の誤りで断られること。

### SEC-NEWS-011 回数の制限の送り元は、利用者が偽れない値から取る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-010 |
| 根拠 | 利用者が付けた `x-forwarded-for` をそのまま使うと、見出しを変えるだけで制限を逃れられ、数えの行も増え続けるため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/security/security_review_news.md:42` |
| 優先度 | MUST |

回数の制限の送り元は、信頼できる中継が付けた値（または接続の送り元）だけから取る。利用者が付けた `x-forwarded-for`・`x-real-ip` で数えを分けない。今のコードは満たさない。

### SEC-NEWS-011-AC-01 x-forwarded-for を変えても61回目を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-011 |
| 根拠 | 見出しを偽っても制限を逃れられないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

同じ接続から、毎回違う `x-forwarded-for` を付けて `/api/news` を10分に61回送った時、61回目が 429 であること。

### SEC-NEWS-012 入口の値を許可の一覧と型で確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-011、THR-NEWS-024 |
| 根拠 | 想定外の値を DB まで届かせず、失敗の形をそろえるため。公開の画面の分類は既に許可の一覧で確かめており、API と id にも同じ守りを広げる。管理の編集のページでは、URL の id を窓口の道に入れる前に確かめ、管理者の要求を別の窓口へ送らせない（THR-NEWS-024）。全体の NFR-SEC-003（入力検証）・NFR-SEC-007（パラメータ化クエリ）を NEWS に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.1.3、V5.1.4。`docs/05_Quality/reviews/security/security_review_news.md:43`、`docs/05_Quality/reviews/security/security_review_news_id.md:45-47` |
| 優先度 | SHOULD |

`/api/news` の `category` は分類の許可の一覧で確かめ、外れた値は取り出しに渡さない（ALL として扱うか 400 にするかは未定）。公開と管理の `[id]` は正の整数として確かめ、外れたら DB に問い合わせずに 404（公開）・400 か 404（管理）にする。管理の編集のページ（`src/app/admin/news/edit/[id]/page.tsx`）も、URL の `id` を窓口の道に入れる前に正の整数か確かめ、外れたら要求を送らない。公開の画面の分類は今のコードが満たす（`src/app/news/page.tsx` の分類の確かめ）。API・id・編集のページは満たさない（編集のページは URL の id を確かめずに窓口の道に入れる）。

### SEC-NEWS-012-AC-01 /api/news は許可の一覧に無い分類を取り出しに渡さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-012 |
| 根拠 | API でも画面と同じく分類の値を確かめていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/news?category=<許可の一覧に無い長い文字>` の応答が、ALL と同じ記事の一覧か 400 であり、0件の一覧ではないこと。

### SEC-NEWS-012-AC-02 数でない記事の id は 404 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-012 |
| 根拠 | 壊れた id が詳細の頁で同じ形に断られることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/news/abc` と `/news/1.5` を開くと、404 の画面が表示されること。

### SEC-NEWS-012-AC-03 編集のページは数でない id で窓口へ要求を送らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-012 |
| 根拠 | 細工した編集のページのリンクから、管理者の要求が記事の窓口の外へ出ないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の店長で開き、送られた要求を記録する。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/admin/news/edit/..%2F..%2Fnews` と `/admin/news/edit/abc` を開いた時、`/api/admin/news/` の下でない `/api` への要求が送られず、記事の読み込みの失敗の文が表示されること。

### SEC-NEWS-013 記事の文字は HTML として解釈させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-012 |
| 根拠 | 管理の権限を乗っ取られても、閲覧者の端末でスクリプトを動かされないため。Markdown を出す部品をつなぐ時に、リンクと画像の URL から道ができないようにする。全体の NFR-SEC-003（XSS 対策）を NEWS の本文に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.3.3。`docs/05_Quality/reviews/security/security_review_news_id.md:52,125` |
| 優先度 | MUST |

題・概要・本文は React の文字として出し、`dangerouslySetInnerHTML` を使わない。Markdown のリンク・画像を出す時は `http:`・`https:`・サイトの中の道だけを許す。前者は今のコードが満たす（`src/app/news/[id]/page.tsx` の本文の描画）。後者は使われていない部品 `ArticleBody` が満たさない（DRV-NEWS-015）。

### SEC-NEWS-013-AC-01 本文の HTML の印は文字として出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-013 |
| 根拠 | 保存された XSS が画面で動かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に本文が `<img src=x onerror=alert(1)>` の公開の記事を入れて開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

その記事の詳細の頁で、本文の印がそのままの文字として表示され、`img` の要素が作られず、ダイアログが出ないこと。

### SEC-NEWS-013-AC-02 Markdown の javascript: のリンクは href にならない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-013 |
| 根拠 | Markdown の部品をつないだ時に、リンクから道ができないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本文に、リンクの先を `javascript:alert(1)` にした Markdown のリンクを含む公開の記事を開く） |
| 出どころ | 実装から推定 |

その記事の詳細の頁に、`href` が `javascript:` で始まる `a` の要素が無いこと。

React 19.2.4 は `javascript:` の href を `javascript:throw new Error('React has blocked a javascript: URL…')` に置き換えて実行を止める（`node_modules/react-dom` の `react-dom-client.development.js`）。置き換えた後も href は `javascript:` で始まるので、この書き方は、許可の一覧を持たない部品をつないだ時に正しく赤になる。

### SEC-NEWS-014 管理の書き換えを他のサイトから送らせない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-013 |
| 根拠 | ログイン中の管理者のブラウザを使った記事の改ざん・誤った公開・消去を防ぐため。FREQ-327-REQ-03（範囲外）に合わせ、Origin・Referer の確かめを proxy の1か所で行う。token を重ねるかは決めていない。全体の NFR-SEC-003（CSRF 対策）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.2.2 |
| 優先度 | MUST |

管理のニュースの POST・PUT・PATCH・DELETE は、Origin（無ければ Referer）が許可のオリジンと合わない時と、どちらも無い時に 403 で断る。今のコードは満たす（`src/proxy.ts` の Origin・Referer の検査）。管理の窓口は Cookie の access token で認証する（`src/lib/auth/request-token.ts`）ので、他のサイトからの送信を断る守りは、この Origin・Referer の確かめと access の Cookie の SameSite=Lax（`src/lib/cookie.ts`）の2つだけになる。`clientFetch` が付ける `x-csrf-token` を窓口が確かめない点は残りの穴で、許可のオリジンが設定されていない時に要求の見出しから比べる元を作る点と合わせて、食い違いとして残す（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節）。

### SEC-NEWS-014-AC-01 別のサイトの Origin の書き換えを断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-014 |
| 根拠 | 他のサイトから送らせた書き換えが届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`Origin: https://evil.example` を付けた `PUT /api/admin/news/<id>` が 403 で、応答の `error` が `Forbidden origin` であり、記事が変わらないこと。

### SEC-NEWS-014-AC-02 Origin も Referer も無い削除を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-014 |
| 根拠 | 送り元が分からない書き換えを通さないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

Origin と Referer の無い `DELETE /api/admin/news/<id>` が 403 で、記事が残ること。

### SEC-NEWS-015 管理の窓口は有効な session・権限・2要素認証の全部を求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-014 |
| 根拠 | 画面を隠すだけでは窓口を直接叩かれるので、窓口ごとに DB の ACL の権限と aal2 を確かめ、DB の操作も利用者の JWT で RLS に通す（service role で素通りしない）。全体の NFR-SEC-005・NFR-SEC-008 と FREQ-316-REQ-02（範囲外）・FREQ-540（範囲外）を NEWS に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3、V4.3.1。`docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md:32-35` |
| 優先度 | MUST |

読む窓口（GET）は `admin.news.read`、変える窓口（POST・PUT・PATCH・DELETE）は `admin.news.manage` を求め、どれも有効な session と `aal2` を求める。DB の操作は利用者の JWT の client で行う。今のコードは満たす（`src/lib/auth/admin-rbac.ts` の `authorizeAdminPermission`、`src/app/api/admin/news/route.ts` の各ハンドラ）。この性質を試すテストは無い。

### SEC-NEWS-015-AC-01 権限の無い利用者は管理の一覧を読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-015 |
| 根拠 | `admin.news.read` を持たない人に下書きが渡らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（お知らせの権限の無いサポーターで `GET /api/admin/news` を送る） |
| 出どころ | 実装から推定 |

`admin.news.read` を持たない aal2 の利用者の `GET /api/admin/news` が 403 であること。

### SEC-NEWS-015-AC-02 aal1 の session は管理の窓口で断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-015 |
| 根拠 | 2要素認証を済ませていない session で管理の操作に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`admin.news.manage` を持つ利用者の aal1 の session の `PATCH /api/admin/news/<id>` が 403 で、`reason` が `MFA required` であり、記事の状態が変わらないこと。

### SEC-NEWS-015-AC-03 読むだけの権限では記事を変えられない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-015 |
| 根拠 | 読む権限と変える権限が分かれていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（サポーターに `admin.news.read` だけを付けて送る） |
| 出どころ | 実装から推定 |

`admin.news.read` だけを持つ aal2 の利用者の `DELETE /api/admin/news/<id>` が 403 で、記事が残ること。

### SEC-NEWS-016 管理の書き換えを正しく監査の記録に残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-015 |
| 根拠 | 不正や誤操作を後から追えるようにするため。存在しない記事への操作を成功と記録すると、記録を信じられなくなる。IP は見出しを偽れるので残さない。全体の NFR-SEC-005（監査ログ）・NFR-SEC-011（監査ログの保持）を NEWS に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md:37-40` |
| 優先度 | MUST |

作成・書き換え・公開の切り替え・削除・画像の書き込みの失敗を、成功と失敗の両方で監査に残す（今のコードは満たす）。対象の記事が無い PUT・PATCH・DELETE は 404 を返し、成功として記録しない。2026-10-26 に満たした（以前は 0 件でも 200 と成功の監査だった）。

- PUT・PATCH は `.update(...).eq('id', id).select('id')`、DELETE は `.delete().eq('id', id).select('id')` で変えた行を受け取る。0 行（無い、または RLS が隠した）は 404 `{ error: 'Article not found' }` と、結果 `failure`・`detail='News article not found'` の監査 1 行（`admin.news.update.not_found`・`admin.news.status_update.not_found`・`admin.news.delete.not_found`）にする。成功の監査は書かない
- 管理の窓口は利用者の session の client で書くので、RLS が隠した行も 0 行になり、403 でなく 404 になる
- 道の `id` は 18 桁以下の数字（`/^\d{1,18}$/`）だけを DB に渡す。外れた id は DB に触らず（PUT では画像の置き場にも触らず）404 にし、失敗の監査には生の id でなく長さ（`articleIdLength`）だけを残す。DB の bigint の桁あふれ（22P02）を 500 にしない
- PUT は画像を上げてから更新するので、無い id への PUT でも上げた画像は置き場に残る（更新が失敗した時の枝と同じ。SEC-NEWS-018 の範囲で、このタスクでは直さない）

### SEC-NEWS-016-AC-01 記事を作ると監査の記録が1件残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-016 |
| 根拠 | 成功の操作が記録に残ることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の `audit_logs` を読む） |
| 出どころ | 実装から推定 |

記事を作った後、`audit_logs` に action が `admin.news.create`、resource_id が新しい記事の id の行が1件あり、IP の値が入っていないこと。

### SEC-NEWS-016-AC-02 存在しない記事への書き換えは 404 で成功と記録しない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-016 |
| 根拠 | 0件の操作が成功に見えないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

存在しない id への `PUT`・`PATCH`・`DELETE /api/admin/news/<id>` がどれも 404 であり、`audit_logs` に `admin.news.update`・`admin.news.status_update`・`admin.news.delete` の成功の行が増えないこと（代わりに `.not_found` の失敗の行が 1 件残る）。

### SEC-NEWS-017 書き込む画像は中身で種類を確かめ、保存の名前を送られた名前から作らない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-016 |
| 根拠 | 送る側の申告やファイル名は偽れるので、画像でない物や想定外の拡張子の物を置き場に入れないため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V12.1.1、V12.2.1、V12.3.1 |
| 優先度 | SHOULD |

画像の種類は中身のしるしで確かめ、JPEG・PNG・WebP・GIF の4つだけを受ける。保存の名前の拡張子は確かめた種類から決め、作る時（POST）も直す時（PUT）も同じにする。大きさは5MBまで（今のコードは満たす）。中身の確かめと PUT の拡張子は満たさない。

### SEC-NEWS-017-AC-01 画像と偽った HTML を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-017 |
| 根拠 | 申告の種類だけで通さないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

中身が HTML で `type` を `image/png` と付けたファイルの `POST /api/admin/news` が 400 で、置き場にファイルが増えないこと。

### SEC-NEWS-017-AC-02 直す時の保存の名前は確かめた種類の拡張子になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-017 |
| 根拠 | 送ったファイル名の拡張子が置き場に入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

名前が `x.html` の PNG の画像で `PUT /api/admin/news/<id>` を送った後、記事の `image_url` の道筋が `.png` で終わること。

### SEC-NEWS-017-AC-03 5MB を超える画像を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-017 |
| 根拠 | 大きさの上限が窓口で効くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

5MB を超える PNG の `POST /api/admin/news` が 400 で、応答の `error` が `Image size must be 5MB or less` であること。

### SEC-NEWS-018 使わなくなった記事の画像を置き場から消す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-017 |
| 根拠 | 消したつもりの画像が置き場に残り、置き場の設定が崩れた時に開ける物を増やさないため。`docs/03_BasicDesign/api/api-spec.md` の DELETE の記述も画像を消すと書く |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け |
| 優先度 | SHOULD |

記事を消した時・画像を差し替えた時・作成で DB への保存に失敗した時に、使わなくなった画像を置き場から消す。今のコードは満たさない。

### SEC-NEWS-018-AC-01 記事を消すと画像も置き場から消える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-018 |
| 根拠 | 削除の後に画像が残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の置き場を service role で一覧する） |
| 出どころ | 実装から推定 |

`DELETE /api/admin/news/<id>` が 200 になった後、その記事の画像の道筋が置き場の一覧に無いこと。

### SEC-NEWS-018-AC-02 画像を差し替えると前の画像が置き場から消える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-018 |
| 根拠 | 差し替えの後に古い画像が残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

新しい画像を付けた `PUT /api/admin/news/<id>` が 200 になった後、前の画像の道筋が置き場の一覧に無いこと。

### SEC-NEWS-018-AC-03 作成の失敗で上げた画像が残らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-018 |
| 根拠 | 失敗の道でも画像が残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 結合テスト（DB への保存を失敗させ、置き場のファイルの数を送る前後で比べる）。窓口を通る入力は DB の CHECK（SEC-NEWS-025）も通るので、E2E では保存の失敗を作れず E2E にしない |
| 出どころ | 実装から推定 |

`POST /api/admin/news` が DB への保存の失敗で 500 になった時、置き場のファイルの数が送る前と同じであること。

### SEC-NEWS-019 記録と応答に内部の情報を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-018 |
| 根拠 | 記録を読める人や応答を受けた人に、DB の構造・接続の情報・Cookie や token を渡さないため |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V7.1.1。`docs/05_Quality/reviews/security/security_review_news.md:93` |
| 優先度 | SHOULD |

失敗の応答の本文は固定の文にする（今のコードは満たす）。記録には例外を丸ごと渡さず、失敗の種類と短い説明だけを残す。Cookie・token の値は記録しない（今のコードは満たす）。例外を丸ごと記録する点は満たさない。

### SEC-NEWS-019-AC-01 /api/news の失敗の応答は固定の文だけ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-019 |
| 根拠 | 応答から内部の情報が漏れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 結合テスト（取り出しを失敗させて `/api/news` の 500 の本文を読む）。共有の手元 DB を止めると並列の E2E を巻き込むので E2E にしない |
| 出どころ | 実装から推定 |

`/api/news` の 500 の応答の本文が `{"error":"Failed to fetch news"}` だけで、表の名前や SQL の文が含まれないこと。

### SEC-NEWS-019-AC-02 失敗の記録に鍵と token が含まれない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-019 |
| 根拠 | 記録から認証の情報が漏れないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・結合テスト（AC-01 と同じ失敗で、記録の出口に渡る引数を捕まえる）。E2E のサーバーの記録は読めないので E2E にしない |
| 出どころ | 実装から推定 |

AC-01 の失敗の時のサーバーの記録に、Supabase の鍵・利用者の JWT・Cookie の値が含まれないこと。

### SEC-NEWS-020 取り出しの失敗を「0件」「無い」と区別する

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-019 |
| 根拠 | DB・RLS・署名の障害を「記事が無い」に紛れさせず、運営が気づけるようにするため。署名の障害で一覧の文字まで止めないため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_news.md:44,91` |
| 優先度 | SHOULD |

公開の取り出しは Supabase の `error` を見て、失敗を記録に残す。管理の一覧は取得の失敗を0件と別の表示にする。管理の1件の取得は、無い時だけ 404、DB の失敗は 500 にする。画像の署名の client を作れない時も、公開の一覧の文字は出す。今のコードは満たさない。

### SEC-NEWS-020-AC-01 管理の一覧の取得の失敗を0件と別に表示する

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-020 |
| 根拠 | 管理者が障害を「記事が無い」と取り違えないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`/api/admin/news` を 500 にして管理の NEWS のタブを開く。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

取得が失敗した時、「ニュース記事がありません」が表示されず、取得に失敗したことを伝える文が表示されること。

### SEC-NEWS-020-AC-02 管理の1件の取得は DB の失敗を 404 にしない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-020 |
| 根拠 | 「無い」と「失敗」を応答で区別できることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 結合テスト（DB の失敗を作って 500 を読む）。404 の側は E2E でできるが、AC は DB を止めた時の 500 も求め、共有の手元 DB は止められないので E2E にしない |
| 出どころ | 実装から推定 |

存在しない id の `GET /api/admin/news/<id>` が 404 であり、手元の Supabase の DB を止めた時の同じ要求が 500 であること。

### SEC-NEWS-020-AC-03 公開の一覧の取り出しの失敗が記録に残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-020 |
| 根拠 | 公開の画面の障害に運営が気づけることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・結合テスト（取り出しの失敗で、記録の出口に失敗が渡る）。DB を止められず、サーバーの記録も読めないので E2E にしない |
| 出どころ | 実装から推定 |

`/news` の取り出しが失敗した時、サーバーの記録に取り出しの失敗が1件以上出ていること。

### SEC-NEWS-021 管理の窓口に回数の制限を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-020 |
| 根拠 | 乗っ取った session や誤った道具の連打で、DB と置き場を埋めさせないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4 |
| 優先度 | SHOULD |

管理のニュースの POST・PUT・PATCH・DELETE に、利用者ごとの回数の制限を付ける。回数は未定。今のコードは満たさない。

### SEC-NEWS-021-AC-01 決めた回数を超えた作成を断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-021 |
| 根拠 | 連打で置き場が埋まらないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | 未定（決めた回数が未定なので、決まるまで E2E にしない。決まったら、SEC-NEWS-016〜018 と同じ aal2 の token で `POST /api/admin/news` を送る E2E を書く） |
| 出どころ | 実装から推定 |

同じ利用者が決めた時間の中で決めた回数を超えて `POST /api/admin/news` を送った時、超えた要求が 429 で、記事と置き場のファイルが増えないこと。

### SEC-NEWS-022 anon・authenticated には使う表の権限だけを付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-021 |
| 根拠 | 守りを RLS の1段だけにせず、RLS の書き損じや RLS の効かない操作（TRUNCATE）でも表を変えさせないため |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3 |
| 優先度 | SHOULD |

`news_articles` の anon の権限は SELECT だけ、authenticated は SELECT・INSERT・UPDATE・DELETE だけにし、TRUNCATE・TRIGGER・REFERENCES・MAINTAIN を外す。今のコードは満たさない。

### SEC-NEWS-022-AC-01 anon は news_articles を空にも書き換えもできない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-022 |
| 根拠 | 権限の段で閉じていることを、RLS と別に確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で `has_table_privilege` を読む） |
| 出どころ | 実装から推定 |

`has_table_privilege('anon','public.news_articles', p)` が、p が TRUNCATE・INSERT・UPDATE・DELETE・TRIGGER のどれでも false であること。

### SEC-NEWS-023 画像の最適化の中継は自分のプロジェクトの画像だけを通す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-022 |
| 根拠 | 他人の Supabase のプロジェクトの画像のために、サーバーの処理とキャッシュを使わせないため |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V12.6.1 |
| 優先度 | SHOULD |

`next.config.ts` の `remotePatterns` の Supabase の行は、自分のプロジェクトのホストと、使う置き場の道だけを許す。今のコードは満たさない。`next.config.ts` は範囲外の共有の設定なので、NEWS 以外の画像も同じ設定を通る。

### SEC-NEWS-023-AC-01 別のプロジェクトの画像を最適化に通さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-023 |
| 根拠 | 中継が許す先の外に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドで `/_next/image?url=https://other.supabase.co/storage/v1/object/public/x/y.png&w=64&q=75` を送る） |
| 出どころ | 実装から推定 |

別のプロジェクトのホストの URL を渡した `/_next/image` が 400 であること。

### SEC-NEWS-024 全部の応答に守りの見出しを付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-023 |
| 根拠 | 枠への埋め込み・種類の取り違え・平文への格下げ・スクリプトの差し込みを、ブラウザの側でも止めるため。全体の NFR-SEC-001（TLS・HSTS）・NFR-SEC-003（CSP）を NEWS の画面と API に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V14.4.3、V14.4.4、V14.4.5、V14.4.7 |
| 優先度 | MUST |

`/news`・`/news/<id>`・`/api/news`・管理のニュースの応答に、CSP（nonce 付き）・`X-Content-Type-Options: nosniff`・`X-Frame-Options: DENY`・`Strict-Transport-Security` を付ける。今のコードは満たす（`src/proxy.ts` の守りの見出しを付ける処理）。

### SEC-NEWS-024-AC-01 NEWS の頁と API に守りの見出しが付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-024 |
| 根拠 | 共有の proxy の守りが NEWS の応答にも届いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/news`・`/news/<id>`・`/api/news` の応答に `Content-Security-Policy`・`X-Content-Type-Options: nosniff`・`X-Frame-Options: DENY`・`Strict-Transport-Security` の4つの見出しがあること。

### SEC-NEWS-025 表の段で記事の長さと画像の道の形を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-NEWS-025 |
| 根拠 | 窓口を通らない PostgREST の直接の書き込みでも、上限の無い長さの文字や置き場の外を指す画像の道を表に入れさせないため。窓口の確かめ（DRV-NEWS-009）と同じ線を DB にも引く |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.1.4（当てはめは推定） |
| 優先度 | SHOULD |

`news_articles` に、`title` は200字・`content` は2000字・`detailed_content` は10000字までの CHECK と、`image_url` が置き場の中の `news/` の下の道である CHECK を持たせる。上限の値は窓口の入力の形（`src/app/api/admin/news/route.ts` の入力の形）とそろえる。今のコードは満たさない（表には NOT NULL だけ、`supabase/migrations/20260901102912_remote_schema.sql` の `news_articles` の定義）。

### SEC-NEWS-025-AC-01 長すぎる題と置き場の外の道を表が断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-025 |
| 根拠 | 窓口を通らない書き込みでも、表の段で値が止まることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に service role で insert を送る） |
| 出どころ | 実装から推定 |

201字の題の insert と、`image_url` が `other/x.png` の insert が、どちらも CHECK の違反で断られ、行が増えないこと。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。

### DRV-NEWS-001 分類は複数を選べ、ALL とは一緒に選べない

| 属性 | 値 |
| --- | --- |
| 根拠 | ITEM・LOOK の一覧と同じ左のサイドバー（モバイルは FILTER の引き出し）の複数選択にそろえ、NEWS だけ違う部品にしないため（uiux レビュー N-5 で横のタブの案を退けた。FREQ-48 は ITEM の MultiSelect と同じ見た目を求める）。FR-NEWS-ALL-002 は1つか複数かを書いていない（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_news.md:39,66`、実装から推定 |

全部を外すと ALL に戻る。ALL を足すと ALL だけになる。ALL が選ばれた状態で別の分類を足すと ALL を外す。選んだ分類は URL の `category` にカンマ区切りで残す（`src/features/news/components/PublicNewsGrid.tsx` の `applyCategorySelection`・`syncCategoryQuery`）。

### DRV-NEWS-002 モバイル・タブレットの FILTER のバーをヘッダーの真下に付けて一緒に動かす

| 属性 | 値 |
| --- | --- |
| 根拠 | スクロールしても FILTER のボタンにすぐ届くようにし、ヘッダーが隠れる時にバーが離れて隙間や重なりが出ないようにするため（推定。要件の文は無く、E2E FR-NEWS-ALL-008〜010 がこの動きを試す） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`e2e/FR-NEWS-ALL-008-mobile-filter-initial-offset.spec.ts`・`009`・`010`） |

バーの位置はヘッダーの高さとずれの変数（`--site-header-offset`・`--site-header-height`）で決め、ヘッダーの隠れる動きに合わせる。初めの表示では先頭の記事と重ならない。

### DRV-NEWS-003 デスクトップの左のフィルターをヘッダーの真下に留める

| 属性 | 値 |
| --- | --- |
| 根拠 | 長い一覧を下へ読んでも分類を選び直せるよう、左のフィルターを画面に留めるため。ヘッダーから離れて始まると一覧の頭が空いて見えるので、ヘッダーの真下から始める（推定。要件の文は無く、E2E FR-NEWS-ALL-011 がこの位置を試す） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`e2e/FR-NEWS-ALL-011-desktop-filter-initial-position.spec.ts`） |

lg 以上で左のサイドバーを sticky にし、上の位置をヘッダーのずれの変数に合わせる。

### DRV-NEWS-004 一覧の概要から Markdown の印を外す

| 属性 | 値 |
| --- | --- |
| 根拠 | 概要の欄に Markdown の記号（画像・リンク・見出し・箇条書き・太字など）が混ざると、一覧で記号のまま見えて読みにくいため（uiux レビュー N-6） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_news.md:40,67` |

記事カードの概要は、本文の要約（`content`）から Markdown の印を外した文字で出す（`toPlainPreview`）。詳細の本文は、今のコードでは Markdown を解釈せず文字のまま段落に分けて出す（推定。DD-NEWS-030、`src/app/news/[id]/page.tsx` の本文の描画）。FR-NEWS-DETAIL-008 が求めるのは段落と改行だけで、Markdown を解釈しないことは求めていない。

### DRV-NEWS-005 記事の題の見出しの段と、カードの上下の線の動き

| 属性 | 値 |
| --- | --- |
| 根拠 | 見出しの段がページの構造に合わないと読み上げで記事の区切りが分からないため、一覧は h2、ホームの区画の中は h3 にする（uiux レビュー N-2）。カードの4辺が約1秒動く形は落ち着かないので、上下の線だけを短く（300ms）動かす（uiux レビュー N-7、brand の控えめな動き） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_news.md:36,41,63,68` |

一覧（catalog）の記事の題は h2、ホーム（home）の記事の題は h3。カードに触れると上と下の線が左から伸びる。

### DRV-NEWS-006 記事が無い時と取り出しに失敗した時の文

| 属性 | 値 |
| --- | --- |
| 根拠 | 何も出ない画面だと、記事が無いのか壊れているのか利用者に分からないため、場合ごとに文を出す（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

公開の記事が1件も無い時は「現在、公開されている記事はありません」、絞った結果が0件の時は「該当カテゴリの記事はありません」、部品が自分で取り出して失敗した時は「ニュースデータの取得に失敗しました」を出す（`src/features/news/components/PublicNewsGrid.tsx`）。

### DRV-NEWS-007 公開済みのニュースを JSON で返す窓口 `GET /api/news`

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧の部品が記事を渡されなかった時の取り出し先として作った（推定）。今の画面は記事を渡すので通らず、検索の E2E の補助（`e2e/search-test-utils.ts`）が記事の有無を確かめるために呼ぶ。回数の制限と件数の上限はセキュリティの指摘から付けた（SEC の項目で扱う） |
| 状態 | 推定 |
| 出どころ | `docs/03_BasicDesign/api/api-spec.md:87`、実装から推定 |

クエリの `category` と `limit` を受け、公開済みの記事の id・題・公開日・分類・画像の URL（署名つき）・要約を、公開日の新しい順で返す。本文（`detailed_content`）は返さない。例外は固定の文の 500。

### DRV-NEWS-008 画像の URL を期限1時間の署名つき URL にして返す（公開側を含む）

| 属性 | 値 |
| --- | --- |
| 根拠 | 画像の置き場（`news-images`）は非公開なので、そのままの道では画像を出せないため、取り出すたびに期限つきの署名つき URL に置き換える。公開の一覧・詳細は画像を出さない（FREQ-32）が、管理・検索と同じ関数で行ごとに署名している（推定）。古い公開 URL の行も読めるよう、URL から置き場の中の道を取り出す |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md:45-48`、実装から推定 |

署名の期限は 3600 秒。保存の道・旧 public・sign・authenticated の URL から道を取り出す。道にできない時と署名に失敗した時の扱いは SEC-NEWS-008 に書く（`src/lib/storage/news-images.ts` の署名の関数）。

### DRV-NEWS-009 管理の入力の長さの上限と日付の形

| 属性 | 値 |
| --- | --- |
| 根拠 | 記事の表には長さの制約が無いので、アプリの入口で上限を決め、画面の崩れと過大な保存を防ぐため（推定）。日付は DB の date 型に入る形だけを受ける |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

題 1〜200 字、概要 1〜2000 字、本文 1〜10000 字（前後の空白を除く）、公開日 `YYYY-MM-DD`、分類は5つ、状態は private・published（`src/app/api/admin/news/route.ts` と `[id]/route.ts` の入力の形）。フォームには上限の表示が無い。

### DRV-NEWS-010 画像の保存の道の決まり

| 属性 | 値 |
| --- | --- |
| 根拠 | 日付と乱数の名前にすれば、同じ名前の上書きが起きず、道から中身を推し量られにくいため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

作る時は `news/<YYYY-MM-DD>/<uuid>.<MIME から決めた拡張子>`、上書きしない（`upsert:false`）、キャッシュ 3600 秒。直す時の拡張子の扱いは SEC-NEWS-017 に書く。

### DRV-NEWS-011 新しい記事の初めの値は非公開・COLLECTION・今日

| 属性 | 値 |
| --- | --- |
| 根拠 | 書きかけの記事をうっかり公開しないよう、初めは非公開にするため（推定）。分類と日付は選び直す手間を減らす値にした |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

作成のフォームの初めの値は、状態が非公開、分類が COLLECTION、公開日が端末の今日（`src/app/admin/news/NewsForm.tsx`）。

### DRV-NEWS-012 保存した後に少し待って NEWS タブへ戻る

| 属性 | 値 |
| --- | --- |
| 根拠 | 保存できたことを文で見せてから一覧へ戻し、次の操作へ移りやすくするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

保存・更新が成功すると「保存しました」「更新しました」を出し、500ms 後に `/admin?tab=NEWS` へ移る。

### DRV-NEWS-013 削除の前に確かめ、記事の行を消す

| 属性 | 値 |
| --- | --- |
| 根拠 | 消した記事は戻せないので、押し間違いで消さないよう確かめを挟むため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

「この記事を削除してもよろしいですか？」に同意した時だけ削除を送る。削除は行を消す形で、戻す手段は無い。置き場の画像の扱いは SEC-NEWS-018 に書く。

### DRV-NEWS-014 管理の一覧の並びと見せ方

| 属性 | 値 |
| --- | --- |
| 根拠 | 管理の一覧も公開側と同じ公開日の新しい順にして、並びを1つの決まりにそろえるため（推定）。分類は枠線だけのタグ（outline）にし、塗りの状態のバッジと見分けやすくする（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`tests/unit/components/NewsSection.test.tsx`） |

NEWS タブの一覧は公開日の新しい順。行ごとに画像・状態のバッジ（公開中・非公開）・分類の TagLabel（outline）・題・公開日と、公開・非公開の切り替え・編集・削除のボタンを出す。取り出しに失敗した時も0件と同じ「ニュース記事がありません」を出す。

### DRV-NEWS-015 未使用（削除の判断待ち）の3つのコードを消さずに残す

| 属性 | 値 |
| --- | --- |
| 根拠 | 未使用（削除の判断待ち）。呼ぶ所が無い3つの単位は、消すかをユーザーが決めるまで残る。残る間に、外から呼べる入口（`getLatestNews` の Server Action）として使われる恐れと、つないだ時に要る守り（SEC-NEWS-009・SEC-NEWS-013）を見落とさないよう、動きを書いておく |
| 状態 | 推定 |
| 出どころ | 実装から推定（`docs/05_Quality/reports/unused-code.md` に載せる） |

どこからも呼ばれない `src/app/news/NewsCategoryTabs.tsx`（1つだけ選ぶ分類のタブ）・`src/features/news/components/ArticleBody.tsx`（本文の軽い Markdown の部品）・`src/app/actions/news.ts` の `getLatestNews`（最新の3件の Server Action）を、消さずに残す。どれも `src`・`tests`・`e2e` に呼ぶ所が無い。

## 未確認事項

- VIEW ALL の出し方: FREQ-126（見出しの右に常に出す）と FREQ-149（下の中央に総数が6件より多い時だけ）のどちらが今の決まりか。コードは FREQ-149 の形
- 分類の絞り込みが1つか複数か: 要件の文（FR-NEWS-ALL-002・003・005、FR-NEWS-DETAIL-004）は1つを前提に読め、コードと E2E は複数
- BLOG の分類を残すか: 画面と FR-NEWS-ALL-002 にあり、DB・管理のフォーム・型に無い
- FREQ-14-AC-01 の「エラーが発生せず」を何で確かめるか
- FREQ-149-AC-02 の「6件以下なら VIEW ALL が無い」側を何で確かめるか。E2E は並列の他のテストの件数と干渉するので「6件より多い」側だけにした。6件以下の側を、直列で流す E2E か結合テスト（`NewsSection` が総数で出し分ける所）のどちらにするか
- SEC-NEWS-004-AC-01・007-AC-01・007-AC-02・008-AC-01 は AC の文のとおり `/api/news` の `image_url` を読む。SEC-NEWS-005 の対策（公開の `/api/news` から `image_url` を外す）を 2026-10-26 に入れたので、この 4 つの E2E は読む物が無くなり、署名つき URL が無いことで自明に通る（007-AC-01・AC-02・008-AC-01 は `test.fail` の印を外した）。確かめ先を、署名を使う `/api/search` と管理の署名に AC の文ごと移すか（波 1-C で決める）
- SEC-NEWS-012-AC-03: 見出しは「数でない id で窓口へ要求を送らない」だが、本文の条件は「`/api/admin/news/` の下でない `/api` への要求が送られず、記事の読み込みの失敗の文が表示される」。`abc` の場合、要求が `/api/admin/news/abc` のように窓口の下に留まっても本文は満たされる。見出しの「窓口へ要求を送らない」に合わせて本文を直すか、本文に合わせて見出しを直すか
- 管理のニュースの PUT は画像を上げてから更新するので、無い id（0 行 → 404）でも上げた画像が置き場に残る。更新の失敗の枝と同じ振る舞いで、SEC-NEWS-018（使わなくなった画像を消す）の範囲
- 公開のニュースを読む要求 `SR-NEWS-001`・`002` と、FR-ADMIN-003 を FREQ-14 につないだことの確認
- E2E FR-NEWS-ALL-008〜011 の動き（DRV-NEWS-002・003）を要件として認めるか。認めれば受け入れ条件を起こしてテスト名に付けられる
- FREQ-275-REQ-02 の文字の大きさ（20px／28px）が FREQ-314（範囲外） で撤回されたか
- 本番の画像の置き場（`news-images`）の公開の設定とポリシーは移行に無く、確かめていない
- FREQ-14・31・32・47・48・49・119・146・149・274・275 と、その下の FREQ-14-REQ-01・31-REQ-01・47-REQ-01・48-REQ-01・49-REQ-01・119-REQ-01・146-REQ-01・149-REQ-01〜02・252-REQ-01〜03・274-REQ-01〜02・275-REQ-01〜03、FR-NEWS-ALL-001・004、FR-NEWS-DETAIL-001・002・003・008 は、元の文書に理由の記述が無く、根拠の「なぜ」を推定で書いたので「推定」にした。理由をユーザーに確かめたら「現行」に戻す
- 「写さなかった行」の表の全体の要件（NFR-PERF・NFR-SEO・NFR-A11Y・DES・WF-COMMON など）を、NEWS の上位に入れるか
