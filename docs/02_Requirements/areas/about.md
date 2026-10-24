# ABOUT の要件

> 状態: 推定 | 確認日: 2026-10-24 | 対象: ABOUT（アバウトページ `/about`） | 基準コミット: `a03beaff`

## 概要

ABOUT の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
`requirements.md` の「1.8 アバウトページ」節の `FR-ABOUT-001`〜`008` を写し、上位の無いこの8件に新しい要求 `SR-ABOUT-` を起こし、受け入れ条件の無い8件に `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-ABOUT-` に書いた。セキュリティ要件 `SEC-ABOUT-` は脅威の文書の `THR-ABOUT-` から起こした。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 2 | 新しい `SR-ABOUT-001`〜`002`（ABOUT ページを対象にした `FREQ-` は無い） |
| 要件 | 8 | `FR-ABOUT-001`〜`008` |
| 受け入れ条件 | 11 | 新しい `FR-ABOUT-NNN-AC-NN` |
| 派生要件 | 5 | `DRV-ABOUT-001`〜`005` |
| セキュリティ要件 | 7 | 新しい `SEC-ABOUT-001`〜`007`（上位は `docs/05_Quality/security/threats/about.md` の `THR-ABOUT-001`〜`006`）と、その受け入れ条件10件 `SEC-ABOUT-NNN-AC-NN` |

- 状態: 全部「推定」。FR-ABOUT-001〜004 は 2026-08-13 の決定（今の画面を仕様とする）で今の画面に合わせた文だが、決定の理由は出どころに書かれておらず、ユーザーの承認の記録も見つからないので「推定」にした。コードと合わない要件（005〜007）、コードは満たすが E2E の前提（画像が1枚以上ある）と画像を置くかどうかが決まっていない要件（008）、新しく起こした項目、実装から読み取った項目も「推定」。どちらが正しいかは決めず、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節（`TM-ABOUT-`）に載せた
- 結論: 今の画面は文章と余白だけで、h1・画像・アイコン・CONTACT への導線が無い。h1（FR-ABOUT-005）、CONTACT の CTA（FR-ABOUT-006）、アイコンと画像（FR-ABOUT-007・008）を残すか廃止するかは、ユーザーに決めてもらう

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ABOUT |
| 写した元 | `docs/02_Requirements/requirements.md`（「1.8 アバウトページ（ABOUT）」節）。元の行は消していない |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」、`docs/01_Planning/brand.md`、`docs/05_Quality/reviews/uiux/uiux_review_about.md` |
| 対象のコード | `src/app/about/page.tsx`（1ファイル。データの取得・入力・API を持たない Server Component。描画は共有の `src/app/layout.tsx` の設定で毎回サーバーで行う） |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |
| 範囲外の上位 | 全体の非機能要件 `NFR-SEO-003`（title・description・OG・canonical）・`NFR-A11Y-001`・`NFR-A11Y-005` は、どの領域の文書も定義しない（`requirements.md` の 5 章にだけある）。ここでは写さず、根拠に添えるだけにした。`NFR-SEO-004（範囲外）`（URL 設計・robots・サイトマップ、`requirements.md` の 5 章）も ABOUT に触れる。今はサイト全体に sitemap・robots が無く、`/about` もどこにも載らない（`src/app/`・`public/` に無い） |
| 過去の決定 | 2026-08-13 に「ABOUT は今の画面を正規の仕様とする」と決め、FR-ABOUT-002〜004 の文を置き換えた（`docs/superpowers/specs/2026-08-13-e2e-classification-5.md`）。FR-ABOUT-005 の h1 は「別途判断」のまま |

### 写さなかった行

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-275 | ホームの ABOUT の区画の見出しの話で、`/about` ではない。持ち主は NEWS |
| FR-HOME-002・003・008 | ホームの ABOUT の区画・`/about` への導線・区画の画像の話。持ち主は HOME。設計の上位には `（範囲外）` の印で書ける |
| FR-HOME-009 | ホームの h1 と h2 の構造の話で、`/about` ではない。持ち主は HOME |

### E2E と受け入れ条件の対応

`e2e/FR-ABOUT-*` のファイルが試している受け入れ条件。テスト名に ID を付ける時に使う。2026-10-24 の E2E 全件では 005〜008 が赤（アサーションの不一致で、実装と合わない）。

| E2E のファイル | 受け入れ条件 | 2026-10-24 の結果 |
| --- | --- | --- |
| FR-ABOUT-001-brand-philosophy-section | FR-ABOUT-001-AC-01 | 通過 |
| FR-ABOUT-002-quality-craftsmanship-section | FR-ABOUT-002-AC-01 | 通過 |
| FR-ABOUT-003-our-values-icons | FR-ABOUT-003-AC-01 | 通過 |
| FR-ABOUT-004-responsive-story-layout | FR-ABOUT-004-AC-01・AC-02（1つのテストで両方。3つの幅） | 通過 |
| FR-ABOUT-005-heading-and-metadata | FR-ABOUT-005-AC-01・AC-02（1つのテストで両方） | 赤（h1 が無い） |
| FR-ABOUT-006-cta-links | FR-ABOUT-006-AC-01 | 赤（その文言のリンクが無い） |
| FR-ABOUT-007-icon-aria-and-image-alt | FR-ABOUT-007-AC-01・AC-02（1つのテストで両方） | 赤（アイコンが無い） |
| FR-ABOUT-008-static-image-source | FR-ABOUT-008-AC-01 | 赤（画像が1枚も無い） |

- 3つの幅（390・768・1280）で試すのは 004 だけ。ほかは desktop だけ
- テスト名から読める ID は先頭の1つだけ（`scripts/trace/parse-tests.ts`）。004・005・007 の「1つのテストで両方」は、名前に ID を付けても AC-02 にはつながらない。AC-02 を確かめるには、テストを AC ごとに分ける必要がある
- 派生要件 `DRV-ABOUT-` の動きを試す E2E は無い

## 要求

### SR-ABOUT-001 訪問者がブランドの思想とものづくりを1つのページで読み、商品と LOOK へ進める

| 属性 | 値 |
| --- | --- |
| 根拠 | コアペルソナは「なぜこの服をつくるか」「つくり方の透明さ」「受注生産の安心」に価値を感じるので、ABOUT はその信頼を作る場になる（uiux レビューのペルソナ適合）。読み終えた人がそのまま商品や LOOK へ移れれば、共感が購入の行動につながる。要求の表に ABOUT ページの行が無いので、FR-ABOUT-001〜004・006 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」（ブランドアイデンティティを反映した体験）、`docs/01_Planning/brand.md` の「5. Product Architecture」「6. Business Principles」の節、`docs/05_Quality/reviews/uiux/uiux_review_about.md` |

訪問者（エンドカスタマー）が、ブランドの思想・服をつくる理由・取り組み（事業の原則）・商品設計の考え方を1つのページで読み、商品の一覧と LOOK へ進めること。

### SR-ABOUT-002 ABOUT ページが検索エンジンと支援技術で正しく読め、外のサービスが止まっても壊れない

| 属性 | 値 |
| --- | --- |
| 根拠 | ブランドの説明のページは検索や共有から最初に見られることが多く、見出しと説明が正しく読めないと人に届かない。画面を読み上げる人にも同じ内容が届く必要がある。外のサービスから画像を読むと、相手が止まった時にページが壊れる（FR-ABOUT-008 のレビューの指摘）。要求の表に当たる行が無いので、FR-ABOUT-005・007・008 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md` の趣旨、全体の非機能要件 NFR-SEO-003・NFR-A11Y-001・NFR-A11Y-005（`requirements.md` の 5 章） |

ABOUT ページの見出しの階層・題・説明が検索エンジンと支援技術に正しく伝わり、ページの表示が外の画像の配信元に頼らないこと。

## 要件

文は `requirements.md` の 1.8 のまま。「今のコード」は 2026-10-24 にコードを読んで分かったこと。`requirements.md` の各行の「レビュー:」の注は 2026-06-28 の作り直しより前の画面を書いていて、今の画面と合わない（食い違い）。

### FR-ABOUT-001 ブランド哲学の節を表示する

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-001 |
| 根拠 | ブランドが何を目指すか（時間を超えて選ばれ続ける服）を最初に伝えないと、ほかの節の取り組みや商品の考え方が何のためか分からない（SR-ABOUT-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md`、`docs/01_Planning/brand.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-001 |

ブランド哲学（Brand Philosophy）を紹介するセクションを表示する。

今のコード: 最初の節の見出しは `Brand Philosophy / ブランドの思想`（h2）。本文は3段落で、ブランド名の意味（時の糸）と「時を超えて価値の続く服」を書く。画像は無い（レビューの注の「テキストと画像の2カラム」は古い）。

### FR-ABOUT-002 服をつくる理由と Founder の言葉の節を表示する

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-001 |
| 根拠 | 安さと大量生産が優先される市場に対して、なぜ形と生地の両方に妥協しない服をつくるのかを示すと、価格の理由と信頼が伝わる。創業者の一人称の言葉を載せるのはユーザーが選んだ（uiux レビューで「両方」を選択） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md`、`docs/05_Quality/reviews/uiux/uiux_review_about.md`（ユーザーの選択） |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-002 |

ブランドが服づくりを行う理由を伝える `WHY WE MAKE / なぜ、つくるのか` セクションを表示し、ブランドの考え方と Founder の言葉を掲載する。

今のコード: 見出し（h2）の下に、市場への問題の提起の1段落、創業者の言葉2つ（かぎ括弧）、`— Founder, Le Fil des Heures` を出す。

### FR-ABOUT-003 取り組みの節に3つの原則を番号・日本語見出し・説明付きで載せる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-001 |
| 根拠 | 他のブランドとの違い（タイムレス・ユニセックス、天然繊維、国内の受注生産）を書かないと購入の理由が完成しない（uiux レビュー A-1）。ブランド文書の事業原則を、最高の服をつくるための手段として示す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md`、`docs/01_Planning/brand.md`、`docs/05_Quality/reviews/uiux/uiux_review_about.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-003 |

`OUR COMMITMENTS / 取り組み` セクションに、`TIMELESS / UNISEX`、`NATURAL FIBERS`、`DOMESTIC, MADE TO ORDER` の3原則を番号・日本語見出し・説明文付きで掲載する。

今のコード: 見出し（h2）の下に `01`〜`03` の番号、英語のラベル、日本語の見出し（h3: タイムレス・ユニセックス／天然繊維／国内受注生産）、説明文を並べる。アイコンは無い（レビューの注の Remixicon・3カラムは古い）。

### FR-ABOUT-004 商品設計の考え方の節と、商品・LOOK への CTA を幅に合わせて並べる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-001 |
| 根拠 | ページを読み終えた人が、共感したまま商品と LOOK へ進めるようにする（uiux レビュー A-2、Peak-End）。スマートフォンではボタンを縦に並べて押しやすくし、どの幅でも横にずれないようにする |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | `docs/02_Requirements/requirements.md`、`docs/01_Planning/brand.md`、`docs/05_Quality/reviews/uiux/uiux_review_about.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-004 |

`COLLECTION / 商品設計思想` セクションと、`VIEW COLLECTION`・`VIEW LOOKBOOK` のCTAを表示する。mobile（390px）ではCTAを縦並び、tablet（768px）以上では横並びとし、横方向のページスクロールを発生させない。

今のコード: `COLLECTION / 商品設計思想`（h2）の節の後に締めの一文（DRV-ABOUT-001）と2つのボタンを置く。`VIEW COLLECTION` は `/item`、`VIEW LOOKBOOK` は `/look` へ移る。640px 未満は縦、640px 以上は横に並ぶ。画像は無い（レビューの注の画像の並びは古い）。

### FR-ABOUT-005 h1 を含む見出しの階層と、ページの題・説明を持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-002 |
| 根拠 | 見出しの起点が無いと、検索エンジンと画面の読み上げがページの主題を取り違える。題と説明は検索の結果と共有の時に出る（NFR-SEO-003・NFR-A11Y-001 の ABOUT 版） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-005 |

ページに `h1` を含む見出し階層を明示し、`generateMetadata` で `title` / `description` を設定する。

今のコード: h1 は満たさない。題 `ABOUT | Le Fil des Heures` と説明は返す（レビューの注の「generateMetadata も無し」は古い）。h1 は無く、最初の見出しは h2（2026-06-28 の作り直しで消えた）。canonical は無い（NFR-SEO-003 は求める）。

### FR-ABOUT-006 ブランドの話の後に COLLECTION・LOOKBOOK・CONTACT への CTA を置く

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-001 |
| 根拠 | 読み終えた人の次の行動（商品を見る・LOOK を見る・問い合わせる）を用意するため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | COULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-006 |

ブランドストーリー後に `COLLECTIONを見る` / `LOOKBOOKを見る` / `CONTACTする` などの CTA を設置する。

今のコード: CTA は `VIEW COLLECTION`（`/item`）と `VIEW LOOKBOOK`（`/look`）の2つだけ。`/contact` への CTA は無く、文言も違うので満たさない（FR-ABOUT-004 の CTA と中身が重なる）。

### FR-ABOUT-007 装飾のアイコンを読み上げから外し、画像の代わりの文を具体にする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-002 |
| 根拠 | 飾りのアイコンが読み上げられると内容の邪魔になり、画像の代わりの文が汎用だと見えない人に何も伝わらない（NFR-A11Y-005 の ABOUT 版） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-007 |

装飾アイコンに `aria-hidden="true"` を設定し、画像 `alt` 属性をより具体的な説明にする。

今のコード: アイコンも画像も置かないので、対象が無い（DRV-ABOUT-003）。

### FR-ABOUT-008 画像を外の動的な生成の URL から自分の置き場へ移す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-ABOUT-002 |
| 根拠 | 外のサービス（readdy.ai）が止まる・回数の制限に当たると、ページの画像が壊れる。自分の置き場か管理された配信元から出せば、表示が外に頼らない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.8 アバウトページ（ABOUT）」節の FR-ABOUT-008 |

画像を外部の動的生成 URL（readdy.ai）から静的ローカルアセットまたは管理された CDN 画像に移行する。

今のコード: 満たす。本文に画像は無く、共有の時の画像（OG）は同じサイトの `/about.png`（DRV-ABOUT-002）。ただし E2E は画像が1枚以上あることを前提にし、画像を置くかどうか（DRV-ABOUT-003）も決まっていない。

## 受け入れ条件

要件の文から、画面の外から確かめられる形に起こした。ユーザーの確認を受けていないので「推定」。

### FR-ABOUT-001-AC-01 ブランド哲学の見出しと文が見える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-001 |
| 根拠 | FR-ABOUT-001 の節があることを、見出しとブランドの目指すものの文が見えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-001）。`e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts` |

`/about` を開くと、見出し `Brand Philosophy / ブランドの思想` と、「時間を超えて選ばれ続ける服をつくるブランド」を含む文が表示されること。

### FR-ABOUT-002-AC-01 服をつくる理由の見出しと Founder の名乗りが見える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-002 |
| 根拠 | FR-ABOUT-002 の節と創業者の言葉があることを、見出しと言葉の結びの名乗りが見えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-002）。`e2e/FR-ABOUT-002-quality-craftsmanship-section.spec.ts` |

`/about` を開くと、見出し `WHY WE MAKE / なぜ、つくるのか` と、`Founder, Le Fil des Heures` を含む文が表示されること。

### FR-ABOUT-003-AC-01 3つの原則が番号・英語のラベル・日本語の見出し付きで見える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-003 |
| 根拠 | FR-ABOUT-003 の3原則の並びを、番号・英語のラベル・日本語の見出しが全部見えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-003）。`e2e/FR-ABOUT-003-our-values-icons.spec.ts` |

`/about` を開くと、見出し `OUR COMMITMENTS / 取り組み`、英語のラベル `TIMELESS / UNISEX`・`NATURAL FIBERS`・`DOMESTIC, MADE TO ORDER`、見出し（h3）`タイムレス・ユニセックス`・`天然繊維`・`国内受注生産`、番号 `01`・`02`・`03` が表示されること。

### FR-ABOUT-004-AC-01 商品設計の考え方の見出しと、商品・LOOK への CTA がある

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-004 |
| 根拠 | FR-ABOUT-004 の節と CTA の行き先を、見出しとリンクの行き先で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 要件の文から起こした（FR-ABOUT-004）。`e2e/FR-ABOUT-004-responsive-story-layout.spec.ts` |

`/about` を開くと、見出し `COLLECTION / 商品設計思想` が表示され、リンク `VIEW COLLECTION` が `/item` を、リンク `VIEW LOOKBOOK` が `/look` を指すこと。

### FR-ABOUT-004-AC-02 CTA が 390px で縦、768px 以上で横に並び、横にずれない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-004 |
| 根拠 | FR-ABOUT-004 の幅ごとの並びと横のスクロールが無いことを、3つの幅で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 要件の文から起こした（FR-ABOUT-004）。`e2e/FR-ABOUT-004-responsive-story-layout.spec.ts` |

幅 390px では 2つの CTA が縦に並び、768px と 1280px では横に並ぶこと。どの幅でもページの横幅が画面の幅を超えず、横のスクロールが出ないこと。

### FR-ABOUT-005-AC-01 h1 の見出しが1つ見える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-005 |
| 根拠 | FR-ABOUT-005 の「h1 を含む見出し階層」を、h1 が見えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-005）。`e2e/FR-ABOUT-005-heading-and-metadata.spec.ts` |

`/about` を開くと、h1 の見出しが1つ表示されること。

### FR-ABOUT-005-AC-02 ページの題と説明がある

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-005 |
| 根拠 | FR-ABOUT-005 の題と説明を、ブラウザの題と説明のメタ情報で確かめる。OG と canonical（NFR-SEO-003）を含めるかは未定 |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-005）。`e2e/FR-ABOUT-005-heading-and-metadata.spec.ts` |

`/about` のページの題に `ABOUT` か `Le Fil des Heures` が含まれ、説明のメタ情報（description）が空でないこと。

### FR-ABOUT-006-AC-01 COLLECTION・LOOKBOOK・CONTACT への CTA がある

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-006 |
| 根拠 | FR-ABOUT-006 の3つの CTA を、文言と行き先で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-006）。`e2e/FR-ABOUT-006-cta-links.spec.ts` |

`/about` を開くと、リンク `COLLECTIONを見る` が `/item` を、`LOOKBOOKを見る` が `/look` を、`CONTACTする` が `/contact` を指して表示されること。

### FR-ABOUT-007-AC-01 装飾のアイコンが読み上げから外れている

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-007 |
| 根拠 | FR-ABOUT-007 のアイコンの扱いを、アイコンの属性で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-007）。`e2e/FR-ABOUT-007-icon-aria-and-image-alt.spec.ts` |

`/about` の装飾のアイコンの全部に `aria-hidden="true"` が付いていること。

### FR-ABOUT-007-AC-02 画像の代わりの文が具体的である

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-007 |
| 根拠 | FR-ABOUT-007 の「より具体的な説明」のうち、機械で確かめられる長さを確かめる（E2E は16字以上を見る）。中身が画像を表すかはレビューで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-007）。`e2e/FR-ABOUT-007-icon-aria-and-image-alt.spec.ts` |

`/about` の画像の代わりの文（alt）が、16字以上であること。画像の中身を表す説明になっているかは、機械では確かめず、レビューで確かめる。

### FR-ABOUT-008-AC-01 画像が readdy.ai から読まれない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-008 |
| 根拠 | FR-ABOUT-008 の移し替えを、画像の読み元に readdy.ai が無いことで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ABOUT-008）。`e2e/FR-ABOUT-008-static-image-source.spec.ts` |

`/about` の画像のどれも、読み元（src）に `readdy.ai` を含まないこと。

## セキュリティ要件

### SEC-ABOUT-001 ABOUT の画像と OG の画像は同じオリジンからだけ出す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-001 |
| 根拠 | 外の配信元の停止や差し替えで、ブランドの紹介の頁と共有のカードが壊れないようにするため。過去の要件 FR-ABOUT-008（readdy.ai からの移し）の趣旨を、画像の有る無しに関わらず確かめられる形に書き直した |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け（V14.2.3 の SRI が近いが、外に置かない対策とは同じでない）。`docs/02_Requirements/requirements.md`、`docs/05_Quality/reviews/code/2026-04-18-about-page-security-review.md` |
| 優先度 | MUST |

`/about` の本文の画像と、`og:image` の URL は、サイトと同じオリジン（`public/` の物）だけを指す。今のコードは満たす（本文に画像が無く、OG は `/about.png`。`src/app/about/page.tsx` の metadata の関数）。外のオリジンを CSP や画像の最適化の許可で止めるかは SEC-ABOUT-003 が求める。

#### SEC-ABOUT-001-AC-01 本文の画像と OG の画像が外のオリジンを指さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-001 |
| 根拠 | 画像が0枚でも落ちない形で、外の配信元に頼っていないことを確かめるため（今の E2E は画像が1枚以上ある前提で落ちる） |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/about` を開いた時、頁の中の全部の画像の `src` と `og:image` の URL のオリジンが、頁のオリジンと同じであること。`src` が `/_next/image` の時は、その `url` の値も外のオリジンを指さないこと。readdy.ai・placehold.co を含む URL が表示されないこと。

#### SEC-ABOUT-001-AC-02 OG の画像が取得できる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-001 |
| 根拠 | 同じオリジンに移した画像が、実際に置かれていて共有のカードに出せることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/about` の `og:image` の URL の道筋（`/about.png`）を頁と同じオリジンで要求すると、200 で画像の種類の応答が返ること。

### SEC-ABOUT-002 ABOUT の応答に守りの見出しを付ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-002 |
| 根拠 | 枠への埋め込み・種類の取り違え・平文への格下げを、ABOUT でも防ぐため。守りは共有の `src/proxy.ts` にあり、ABOUT の応答で付いていることを ABOUT の側でも確かめる。全体の NFR-SEC-001（範囲外。TLS・HSTS）と NFR-SEC-003（範囲外。CSP 導入）を ABOUT に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V14.4.3、V14.4.4、V14.4.5、V14.4.6、V14.4.7 |
| 優先度 | MUST |

`/about` の応答は、nonce 付きの CSP（`default-src 'none'`・`frame-ancestors 'none'`・`object-src 'none'`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Strict-Transport-Security`、`Referrer-Policy: no-referrer` を持ち、`X-Powered-By` を持たない。今のコードは満たす（`src/proxy.ts` の応答の見出しを付ける処理、`next.config.ts` の `X-Powered-By` を出さない設定）。`/about` の応答でこれを試すテストは無い（同じ見出しを試す E2E は `/terms` だけを開く）。

#### SEC-ABOUT-002-AC-01 /about の応答に守りの見出しが付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-002 |
| 根拠 | 共有の守りが `/about` の応答にも効いていることを、利用者の受け取る応答で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドの `/about` を要求し、応答の見出しを読む） |
| 出どころ | 実装から推定。見本は `e2e/FR-TERMS-003-security-headers.spec.ts`（`/terms` で同じ見出しを試す） |

`/about` の応答が 200 で、CSP に `default-src 'none'`・`frame-ancestors 'none'`・`object-src 'none'`・nonce 付きの `script-src` が含まれ、`X-Content-Type-Options` が `nosniff`、`X-Frame-Options` が `DENY`、`Strict-Transport-Security` に `max-age=63072000` が含まれ、`Referrer-Policy` が `no-referrer` であること。`X-Powered-By` が無いこと。

### SEC-ABOUT-003 ABOUT の応答の CSP と画像の最適化の許可は ABOUT が使わない外のオリジンを許さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-003 |
| 根拠 | 差し込みの穴が別にできた時の持ち出しの道を減らすため。過去のレビューが Low・Open とした指摘を要件にした。外の画像の許可が広いと、コードに外の URL が戻っても CSP と next/image のどちらも止めず、SEC-ABOUT-001（画像は同じオリジンだけ）を機械で守れない。全体の NFR-SEC-003（範囲外。CSP 導入）の最小の許可を ABOUT に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V14.4.3。`docs/05_Quality/reviews/security/security_review_about.md`、`docs/05_Quality/reviews/code/2026-04-18-about-page-security-review.md` |
| 優先度 | SHOULD |

`/about` の応答の CSP は、ABOUT が読まない `https://cdn.jsdelivr.net`・`https://readdy.ai`・`https://*.readdy.ai`・`https://placehold.co` を許さない。next/image の外の画像の許可（`next.config.ts` の `images.remotePatterns`）も、これらを許さない。頁ごとに CSP を分けるか全体を絞るかは決めていない。

今のコードは満たさない。CSP（`src/proxy.ts`）は全部の頁に同じ1つの方針で、`cdn.jsdelivr.net`（style・style の要素・script・font）と readdy.ai・placehold.co（img）を許す。jsdelivr は `src/` の `.ts`・`.tsx`・`.css` のどこからも読まない（アイコンの字形は `src/styles/globals.css` で自前で読み込む）。`remotePatterns` も placehold.co・readdy.ai・public.readdy.ai を許すので、next/image を通すと `src` が同じオリジンの `/_next/image?url=…` になり、CSP を絞っても止まらない。なお `style-src` の `'unsafe-inline'` の理由の1つに、ABOUT が文字の大きさを `style` の属性で付けていることがある。

#### SEC-ABOUT-003-AC-01 /about の CSP に使わない外のオリジンが無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-003 |
| 根拠 | 許可の広さを、応答の見出しの字で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドの `/about` の CSP を読む） |
| 出どころ | 実装から推定 |

`/about` の応答の CSP に、`cdn.jsdelivr.net`・`readdy.ai`・`placehold.co` の字が含まれないこと。

#### SEC-ABOUT-003-AC-02 画像の最適化の入口が使わない外のオリジンの画像を取りに行かない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-003 |
| 根拠 | CSP を絞っても next/image を通すと同じオリジンの URL になって素通りするので、最適化の入口の許可も確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドの `/_next/image` を要求する） |
| 出どころ | 実装から推定 |

`/_next/image` に、許された幅 `w`（`images.deviceSizes` の値。例 640）と許された品質 `q`（既定の 75）を付けて `placehold.co` と `readdy.ai` の画像の URL を渡して要求した時、画像が返らず、拒否の応答（4xx）になること。`w` と `q` が許されない値だけで 400 になる場合を除くため、同じ条件で同じオリジンの `/about.png` を渡した対照が 200 になることも確かめる。

### SEC-ABOUT-004 ABOUT の応答を共有のキャッシュに残させない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-004 |
| 根拠 | 中身が誰にでも同じ ABOUT でも、初めての閲覧者への応答には閲覧者ごとのセッションの id が載り、どの応答にも要求ごとに変わる CSP の nonce が載るので、共有のキャッシュから別の閲覧者に配られないようにするため。Cookie を持って戻った閲覧者への応答には `Set-Cookie` が付かないので、`Set-Cookie` の有無で分けると nonce が焼き付く。今は Next の既定の動きに頼り、明示も試験も無い。全体の要件に当てはまる行は無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.1.1（当てはめは推定） |
| 優先度 | MUST |

`/about` の全部の応答（`Set-Cookie` の有無に関わらない）は、`Cache-Control` に `private` か `no-store` を持つ。今のコードは Next の既定の動きで満たす見込みだが、本番ビルドの応答を測っておらず、試すテストも無い。

#### SEC-ABOUT-004-AC-01 Cookie を付けた /about の応答が共有のキャッシュに残らない指定を持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-004 |
| 根拠 | Next の既定の動きに頼っている守りが、本番ビルドで実際に効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（Cookie を持たない要求で本番ビルドの `/about` を要求する） |
| 出どころ | 実装から推定 |

Cookie を持たない要求で `/about` を要求した時、応答に `Set-Cookie` があり、`Cache-Control` に `private` か `no-store` が含まれ、`public` と `s-maxage` が含まれないこと。

#### SEC-ABOUT-004-AC-02 Cookie を持つ要求への /about の応答も共有のキャッシュに残らない指定を持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-004 |
| 根拠 | `Set-Cookie` が付かない応答でも CSP の nonce が載るので、戻ってきた閲覧者への応答が共有のキャッシュに残って nonce が使い回されないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（セッションの Cookie を付けた要求で本番ビルドの `/about` を要求する） |
| 出どころ | 実装から推定（`src/proxy.ts`） |

セッションの Cookie を付けて `/about` を要求した時、応答に `Set-Cookie` が無くても、`Cache-Control` に `private` か `no-store` が含まれ、`public` と `s-maxage` が含まれないこと。

### SEC-ABOUT-005 OG の絶対の URL は要求の見出しから作らず、設定のサイトの URL だけから作る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-005 |
| 根拠 | 要求の見出しを偽って共有のカードの画像を別のサイトに向けさせないため |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。実装から推定 |
| 優先度 | SHOULD |

`og:image` の絶対の URL の基点は、サイトの URL の環境変数だけから作り、`Host`・`X-Forwarded-Host` を読まない。今のコードは満たす（`src/lib/redirect.ts` の `getSiteUrl`、`src/app/layout.tsx` の `metadataBase`）。設定が無い時の振る舞いは SEC-ABOUT-007。

#### SEC-ABOUT-005-AC-01 要求の見出しを偽っても OG の URL が変わらない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-005 |
| 根拠 | 見出しから基点を作らない守りを、応答の字で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`X-Forwarded-Host` に別の値を付けて `/about` を要求する） |
| 出どころ | 実装から推定 |

`X-Forwarded-Host` に別のホストを付けて `/about` を要求した時、`og:image` の URL のホストが、付けないで要求した時と同じであること。

### SEC-ABOUT-006 ABOUT の描画はサーバーで DB と外のサービスを読まない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-006 |
| 根拠 | 頁の要求には回数の制限が無く、毎回サーバーで描かれるので、1回の要求の重さを描画だけに抑えて大量の要求の害を小さくするため。DB や外のサービスが止まっても ABOUT が出せる |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4（自動化への守り。当てはめは推定）。実装から推定 |
| 優先度 | SHOULD |

`/about` のサーバーの描画は、Supabase・外の API を呼ばない。頁の要求の回数は本番のホスティングの守りに任せる（本番は未確認）。今のコードは満たす（`src/app/about/page.tsx` に読み出しが無い）。試すテストは無い。

#### SEC-ABOUT-006-AC-01 Supabase に届かない状態でも /about が表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-006 |
| 根拠 | 描画が DB に頼っていないことを、DB を外した状態で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に届かない状態で本番ビルドの `/about` を開く） |
| 出どころ | 実装から推定 |

手元の Supabase に届かない状態で `/about` を開いた時、応答が 200 で、`Brand Philosophy / ブランドの思想` の見出しが表示されること。

### SEC-ABOUT-007 サイトの URL の設定が無い時に OG の URL が手元の URL に落ちない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-ABOUT-005 |
| 根拠 | 本番で環境変数の設定が漏れても、共有のカードの画像が手元の URL や意図しないデプロイごとの URL を指して壊れたまま公開されないようにするため。SEC-ABOUT-005 は見出しの偽りを防ぐ要件で、設定が無い時の振る舞いは別に決める必要がある（このため分けた） |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。実装から推定 |
| 優先度 | SHOULD |

サイトの URL の環境変数が1つも無い時に、`og:image` の絶対の URL の基点が黙って `http://localhost:3000` にならない（警告を出す、または本番では起動を止める）。`NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_BASE_URL`・`BASE_URL` が無く `NEXT_PUBLIC_VERCEL_URL` だけがある時も、基点がデプロイごとの `*.vercel.app` にならない。

今のコードは満たさない。`getSiteUrl`（`src/lib/redirect.ts`）は環境変数が1つも無いと、警告なく既定の手元の URL を返す。上の3つが無く `NEXT_PUBLIC_VERCEL_URL` だけがあると（Vercel が自動で入れる場合）、そのデプロイごとの URL を返す。どちらも、`src/app/layout.tsx` の `metadataBase` がそれを基点にする。本番の環境変数は未確認（本番のアプリは未デプロイ）。

#### SEC-ABOUT-007-AC-01 設定が無い時に OG の URL が手元の URL にならない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-007 |
| 根拠 | 設定が漏れた状態を再現して、手元の URL が公開の応答に出ないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（サイトの URL の環境変数を外して本番ビルドを起動し、`/about` を要求する） |
| 出どころ | 実装から推定 |

サイトの URL の環境変数を1つも設定せずに起動して `/about` を要求した時、`og:image` の URL のホストが `localhost` でないこと。または起動の時点で警告かエラーが出ること。本番で設定した本番のドメインを与えて起動した時は、`og:image` の URL のホストがそのドメインと同じであること。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。

### DRV-ABOUT-001 CTA の前に締めの一文「時を超えて価値の続く服を。」を置く

| 属性 | 値 |
| --- | --- |
| 根拠 | ページを結びの言葉も無く終わらせず、ブランドの言葉で読み終わりを作ってから次の行動へ渡すため（uiux レビュー A-2 の「締めのブランドステートメント + CTA」）。文は Philosophy の節の「時を超えて価値の続く服」と同じ言葉（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_about.md`、実装から推定 |

COLLECTION の節の後、罫線の下の中央に一文 `時を超えて価値の続く服を。` を出し、その下に2つの CTA を置く。

### DRV-ABOUT-002 共有の時の題・説明・画像（OG）を同じサイトの画像で返す

| 属性 | 値 |
| --- | --- |
| 根拠 | SNS などで共有された時にブランドの題と写真が出るようにするため。FR-ABOUT-005 は題と説明だけを求め、OG は全体の NFR-SEO-003 にしか無い。画像は外に頼らないよう `public/` の `/about.png` を使う（FR-ABOUT-008 の趣旨と合う。ホームと商品の E2E も同じ画像を使う） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/about/page.tsx` の metadata） |

OG の題は `ABOUT | Le Fil des Heures`、説明は検索用の説明より短いブランドの一文、画像は `/about.png`。絶対の URL にするのは共有の `src/app/layout.tsx` のサイトの起点の設定。og:url・og:type・canonical は返さない（推定）。

### DRV-ABOUT-003 画像とアイコンを置かず、文章と余白でブランドを語る

| 属性 | 値 |
| --- | --- |
| 根拠 | ABOUT は「静かで強い世界観」を文章と余白で語るのがブランドの作法で、図やアイコンの飾りを足さないとあえて決めた（uiux レビューの「あえて従わない判断」）。2026-06-28 の作り直し（cf822a96）で画像2枚と h1 を消した。この動きは FR-ABOUT-007・008 の前提（アイコン・画像がある）と合わない（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_about.md`、git cf822a96、実装から推定 |

本文に画像・アイコンを置かない。節の区切りは上の細い罫線と余白だけで作る。

### DRV-ABOUT-004 節の見出しと本文を広い幅では左右に、狭い幅では縦に並べる

| 属性 | 値 |
| --- | --- |
| 根拠 | 広い画面で見出しを左の細い列、本文を右の広い列に置くと、節の入口が揃って読み進めやすい。狭い画面では縦に積んで文字の幅を保つ（uiux レビュー A-7 の「罫線や余白のリズムで区切る」）。要件は CTA の並びしか幅ごとの形を決めていない（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_about.md`、実装から推定 |

ブランド哲学・WHY WE MAKE・COLLECTION の節は、1024px 以上で見出しと本文を 1:2 の2列に並べ、1024px 未満は見出しの下に本文を積む。OUR COMMITMENTS の節は見出しを上に置き、原則の行を字下げして並べる。

### DRV-ABOUT-005 取り組みの3原則を罫線で区切り、最後の原則の下にも罫線を引く

| 属性 | 値 |
| --- | --- |
| 根拠 | 原則どうしの境目を罫線で示し、最後の原則の下にも線を引いて、次の節との間で並びが閉じて見えるようにするため（推定。記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/about/page.tsx` の原則の並び） |

3つの原則のそれぞれの上に罫線を引き、最後の原則だけ下にも罫線を引く。番号は 640px 以上で本文の左の列に右寄せで置き、640px 未満は本文の上に置く。

## 未確認事項

- h1 を足すか、FR-ABOUT-005 から h1 の部分を外すか（2026-08-13 から「別途判断」のまま）
- FR-ABOUT-005 の題と説明に、OG と canonical（NFR-SEO-003）の確かめまで含めるか
- FR-ABOUT-006（CONTACT への CTA）を残すか、廃止して FR-ABOUT-004 にまとめるか
- FR-ABOUT-007・008 を廃止にするか（今は画像とアイコンを置かない方針。DRV-ABOUT-003）。置かない方針なら ADR に残す
- 説明の「天然繊維100%」（metadata・brand.md）と本文の「天然繊維を中心に」のどちらが正か
- CSP と画像の最適化の許可を、頁ごとに分けるか全体を絞るか（SEC-ABOUT-003。共有の `src/proxy.ts`・`next.config.ts` の話）
- 本番のサイトの URL の環境変数が設定されるか、本番ビルドの `/about` の応答の `Cache-Control` の実際の値（SEC-ABOUT-004・007。本番のアプリは未デプロイ）
- 要求 `SR-ABOUT-001`・`002` を起こしたこと、FR-ABOUT-001〜008 をこの2つにつないだことの確認
