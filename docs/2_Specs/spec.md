# 要件定義書

> **優先度凡例**
> - `MUST` — リリース必須。これが欠けると事業・UX・セキュリティ上の重大な問題が生じる。
> - `SHOULD` — 強く推奨。競合優位性・品質向上に直結し、早期対応が望ましい。
> - `COULD` — 対応すると良い。余力があれば対応する改善・拡張機能。
> - `WONT` — 現フェーズでは対応しない。将来のマイルストーンで再評価する。

## 概要

この要件定義書はサイト全体の要求と受け付け基準を管理する。LOOK 一覧ではシーズンフィルタ（ALL / SS / AW）を追加し、desktop では左サイドバー、tablet/mobile では FILTER ボタンと Drawer を採用する。


## 凡例

### 要求ID凡例

| 要求ID | 意味 |
|---|---|
| **FREQ-RR** | 機能要求 |
| **NFREQ-RR** | 非機能要求 |

### 要件ID凡例

| 要件ID | 意味 |
|---|---|
| **REQ-RR-SS** | 要件 |
| **SEC-RR-SS** | セキュリティ要件 |
| **CON-RR-SS** | 制約 |
| **GUD-RR-SS** | ガイドライン |
| **PAT-RR-SS** | 準拠すべきパターン |
| **OTH-RR-SS** | その他の要件 |

## 要求と要件のトレーサビリティ

| 要求ID  | 要求の内容 | 要件ID      | 要件の内容    | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|------------|---------------|----------------|------------------|
| FREQ-01 | ユーザーが基本機能を利用できること | FREQ-01-REQ-01 | 基本機能の操作が正常に完了すること | FREQ-AC-01-01-01 | 基本機能でエラーが発生せず操作が完了すること |

| 要求ID  | 要求の内容 | 要件ID      | 要件の内容    | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|------------|---------------|----------------|------------------|
| FREQ-01 | エンドカスタマー（User）がスマホ、PC、タブレットで商品を検索できること | FREQ-01-REQ-01 | Userがヘッダーの虫眼鏡アイコンをクリックし、単語で商品を検索できること | FREQ-01-AC-01 | 商品検索でエラーが発生せず、関連商品が表示されること |
| FREQ-01 | エンドカスタマー（User）がスマホ、PC、タブレットで商品を検索できること | FREQ-01-REQ-02 | Userがヘッダーの虫眼鏡アイコンをクリックし、単語で商品を検索できること | FREQ-01-AC-01 | 商品検索でエラーが発生せず、関連商品が表示されること |
| FREQ-02 | エンドカスタマー（User）がスマホ、PC、タブレットで商品を閲覧できること | FREQ-02-REQ-01 | 商品閲覧機能が正常に動作すること | FREQ-02-AC-01 | 商品閲覧でエラーが発生せず、商品詳細が表示されること |
| FREQ-03 | エンドカスタマー（User）がスマホ、PC、タブレットで商品を購入できること | FREQ-03-REQ-01 | 商品購入機能が正常に動作すること | FREQ-03-AC-01 | 商品購入でエラーが発生せず、購入完了の確認が表示されること |
| FREQ-04 | エンドカスタマー（User）が購入前や購入後の問い合わせをできること | FREQ-04-REQ-01 | 問い合わせ機能が正常に動作すること | FREQ-04-AC-01 | 問い合わせでエラーが発生せず、問い合わせ内容が送信されること |
| FREQ-05 | エンドカスタマー（User）が返品をできること | FREQ-05-REQ-01 | 返品機能が正常に動作すること | FREQ-05-AC-01 | 返品でエラーが発生せず、返品手続きが完了すること |
| FREQ-06 | エンドカスタマー（User）が商品のサイズを確認できること | FREQ-06-REQ-01 | サイズ確認機能が正常に動作すること | FREQ-06-AC-01 | サイズ確認でエラーが発生せず、正しいサイズ情報が表示されること |
| FREQ-07 | エンドカスタマー（User）が商品の試着をできること | FREQ-07-REQ-01 | 試着機能が正常に動作すること | FREQ-07-AC-01 | 試着でエラーが発生せず、試着手続きが完了すること |
| FREQ-08 | エンドカスタマー（User）が商品の注文をキャンセルできること | FREQ-08-REQ-01 | 注文キャンセル機能が正常に動作すること | FREQ-08-AC-01 | 注文キャンセルでエラーが発生せず、キャンセル手続きが完了すること |
| FREQ-09 | エンドカスタマー（User）が商品を予約注文できること | FREQ-09-REQ-01 | 予約注文機能が正常に動作すること | FREQ-09-AC-01 | 予約注文でエラーが発生せず、予約手続きが完了すること |
| FREQ-10 | エンドカスタマー（User）が商品をお気に入り登録できること | FREQ-10-REQ-01 | お気に入り登録機能が正常に動作すること | FREQ-10-AC-01 | お気に入り登録でエラーが発生せず、登録が完了すること |
| FREQ-11 | エンドカスタマー（User）が商品を用いたコーディネートを確認できること | FREQ-11-REQ-01 | コーディネート確認機能が正常に動作すること | FREQ-11-AC-01 | コーディネート確認でエラーが発生せず、関連コーディネートが表示されること |
| FREQ-12 | エンドカスタマー（User）が他のユーザーのコーディネートを確認できること | FREQ-12-REQ-01 | 他ユーザーのコーディネート確認機能が正常に動作すること | FREQ-12-AC-01 | 他ユーザーのコーディネート確認でエラーが発生せず、関連コーディネートが表示されること |
| FREQ-13 | エンドカスタマー（User）が取り扱い店舗（Stockist）を確認できること | FREQ-13-REQ-01 | 取り扱い店舗確認機能が正常に動作すること | FREQ-13-AC-01 | 取り扱い店舗確認でエラーが発生せず、正しい店舗情報が表示されること |
| FREQ-14 | サイト管理者（Admin）がCMSを用いたNewsの登録と編集と削除ができること | FREQ-14-REQ-01 | News管理機能が正常に動作すること | FREQ-14-AC-01 | News管理でエラーが発生せず、登録・編集・削除が完了すること |
| FREQ-15 | サイト管理者（Admin）がCMSを用いたItemの登録と編集と削除ができること | FREQ-15-REQ-01 | Item管理機能が正常に動作すること | FREQ-15-AC-01 | Item管理でエラーが発生せず、登録・編集・削除が完了すること |
| FREQ-16 | サイト管理者（Admin）がItemの在庫管理ができること | FREQ-16-REQ-01 | 在庫管理機能が正常に動作すること | FREQ-16-AC-01 | 在庫管理でエラーが発生せず、在庫情報が正しく更新されること |
| FREQ-17 | サイト管理者（Admin）がCMSを用いたLookの登録と編集と削除ができること | FREQ-17-REQ-01 | Look管理機能が正常に動作すること | FREQ-17-AC-01 | Look管理でエラーが発生せず、登録・編集・削除が完了すること |
| FREQ-18 | サイト管理者（Admin）が商品扱い店舗（Stockist）の登録と編集と削除ができること | FREQ-18-REQ-01 | 商品扱い店舗管理機能が正常に動作すること | FREQ-18-AC-01 | 商品扱い店舗管理でエラーが発生せず、登録・編集・削除が完了すること |
| FREQ-19 | サイト管理者（Admin）がKPIの閲覧と管理ができること | FREQ-19-REQ-01 | KPI管理機能が正常に動作すること | FREQ-19-AC-01 | KPI管理でエラーが発生せず、KPI情報が正しく表示されること |
| FREQ-20 | サイト管理者（Admin）がユーザー権限の管理ができること | FREQ-20-REQ-01 | ユーザー権限管理機能が正常に動作すること | FREQ-20-AC-01 | ユーザー権限管理でエラーが発生せず、権限変更が正しく反映されること |
| FREQ-21 | サイト管理者（Admin）が注文履歴（発送状態含む）の閲覧・管理ができること | FREQ-21-REQ-01 | 注文履歴管理機能が正常に動作すること | FREQ-21-AC-01 | 注文履歴管理でエラーが発生せず、正しい注文情報が表示されること |
| FREQ-22 | 発送管理者（Supporter）が提携先の発送担当者として注文履歴を確認し発送を行えること | FREQ-22-REQ-01 | 発送管理機能が正常に動作すること | FREQ-22-AC-01 | 発送管理でエラーが発生せず、発送手続きが完了すること |
| FREQ-23 | 発送管理者（Supporter）が発送状態の更新を行えること | FREQ-23-REQ-01 | 発送状態更新機能が正常に動作すること | FREQ-23-AC-01 | 発送状態更新でエラーが発生せず、状態が正しく反映されること |
| FREQ-24 | エンドカスタマー（User）が問い合わせ時に完了（確認）メールを受け取れること | FREQ-24-REQ-01 | 問い合わせ送信時に本人宛の確認メールを送信し、Reply-To でメール返信を取り込めること | FREQ-24-AC-01 | 送信完了後にサンクス表示がされ、問い合わせがスレッドとしてDBに保存されること |
| FREQ-25 | サイト管理者（Admin）がMANAGEで問い合わせを確認・返信でき、テンプレートを選んで返信できること | FREQ-25-REQ-01 | CONTACTタブで一覧・詳細・返信・ステータス変更・テンプレートCRUDが動作すること | FREQ-25-AC-01 | 返信でエラーが発生せず、顧客へメール送信されスレッドに反映されること |
| FREQ-26 | 会員（User）がAccountページで問い合わせのやり取りをチャット表示・返信できること | FREQ-26-REQ-01 | お問い合わせタブでスレッド一覧・チャット表示・返信が動作すること | FREQ-26-AC-01 | 本人のスレッドと管理者返信が表示され、返信が反映されること |
| FREQ-27 | ゲスト（非会員）が受信メールへの返信で会話を継続でき、注文番号で問い合わせできること | FREQ-27-REQ-01 | 注文確認メールに注文番号を記載し、メール返信をinbound Webhookでスレッドに取り込むこと | FREQ-27-AC-01 | ゲストのメール返信がMANAGEのスレッドに反映され、注文番号での紐づけができること |

---

## 1. ページ別機能要件

---

### 1.1 ホームページ（HOME）— `GET /`

**概要**: ブランドのランディングページ兼各セクションへの入口。

#### 表示・レイアウト

- **FR-HOME-001** `MUST`: 
  - レビュー: `/mainphoto.png` をフルスクリーン表示しグラデーションオーバーレイと `h1` ブランド名を重ねている。ただし `<Image>` に `priority` 属性が未設定のため LCP が悪化するリスクあり（FR-HOME-007 と合わせて対応必須）。
- **FR-HOME-002** `MUST`: ホームページに最新アイテム（ITEM）・最新ルック（LOOK）・最新ニュース（NEWS）・ABOUT の4セクションをスクロールで掲載する。
  - レビュー: `PublicItemGrid variant="home"` / `PublicLookGrid variant="home"` / `PublicNewsGrid variant="home"` / インライン ABOUT セクションで構成済み。STOCKIST セクションも末尾に追加されている（FR-HOME-005 解消）。
- **FR-HOME-003** `SHOULD`: ホームページの ABOUT セクションには `/about` ページへの導線リンクを設け、ブランドストーリーページへ誘導する。
  - レビュー: ABOUT セクションは存在するが `/about` への `<Link>` が未設置。`SectionTitle` 直後に CTA ボタンを追加することで解消できる。
- **FR-HOME-004** `MUST`: ホームページの ITEM・LOOK・NEWS 各セクションの末尾に「もっと見る」ボタンを配置し、各一覧ページへ遷移できるようにする。
  - レビュー: `PublicItemGrid` に "VIEW ALL ITEMS"、`PublicLookGrid` に "VIEW LOOKBOOK"、`PublicNewsGrid` に "VIEW ALL NEWS" がそれぞれ実装済み。要件は満たされている。
- **FR-HOME-005** `SHOULD`: STOCKIST（商品扱い店舗）セクションをホームページに追加し、`PublicStockistGrid variant="home"` で最大6件を表示する。
  - レビュー: `<PublicStockistGrid variant="home" />` がページ末尾に追加済みで要件は満たされている。

#### SEO・パフォーマンス

- **FR-HOME-006** `MUST`: `generateMetadata` を実装し、ホームページ固有の `title` / `description` を設定する。
  - レビュー: `layout.tsx` の `description` が `"Generated by create next app"` のまま。`app/page.tsx` にページ固有の `generateMetadata` エクスポートが存在しない。早急に対応が必要。
- **FR-HOME-007** `MUST`: ヒーロー画像は `priority` を設定してプリロードし、LCP（Largest Contentful Paint）を最小化する。
  - レビュー: `<Image src="/mainphoto.png" ...>` に `priority` 属性が未設定。LCP スコアに直接影響するため `priority` の追加が必須。
- **FR-HOME-008** `MUST`: ABOUT セクションの画像を静的ローカルアセットまたは管理された CDN 画像に置き換え、外部 URL への依存を排除する。
  - レビュー: ABOUT セクション画像が `readdy.ai` の外部動的生成 URL を使用。サービス停止・レートリミット時にページが壊れるリスクがあり、本番リリース前に対応が必須。

#### アクセシビリティ

- **FR-HOME-009** `SHOULD`: ホームページには `h1` 要素を1つ配置し、各セクション見出しは `h2` として構造化する。
  - レビュー: ヒーローに `h1`（ブランド名）、各セクションに `SectionTitle`（`h2` 相当）を使用しており見出し階層は適切。STOCKIST セクションの見出し設定は個別確認が必要。
- **NFR-HOME-001** `MUST`: ホームページの初回表示速度を 2 秒以内に収める（モバイル 3G 相当の環境を想定）。
- **NFR-HOME-002** `MUST`: ホームページは WCAG 2.1 AA を満たす色彩コントラストを確保する。

---

### 1.2 ニュース一覧ページ（NEWS）— `GET /news`

**概要**: 公開済みニュース記事のカタログ表示とカテゴリ絞り込み。

#### 表示・絞り込み

- **FR-NEWS-ALL-001** `MUST`: 公開済みニュース記事を最新公開日順で一覧表示する。
  - レビュー: `getPublishedNews()` で `published_date` 降順取得、`PublicNewsGrid variant="catalog"` で表示済み。要件を満たしている。
- **FR-NEWS-ALL-002** `MUST`: `ALL` / `COLLECTION` / `EVENT` / `COLLABORATION` / `SUSTAINABILITY` / `STORE` / `BLOG` のカテゴリ絞り込みを提供し、`ALL` は全記事表示とする。
  - レビュー: `PublicNewsGrid` にカテゴリタブ UI が実装されており、クライアント側でのフィルタリングは動作している。ただしサーバ側フィルタ未接続（FR-NEWS-ALL-005 参照）。
- **FR-NEWS-ALL-003** `SHOULD`: カテゴリ選択は URL の `category` クエリパラメータに反映し、共有可能な状態にする。
  - レビュー: `news/page.tsx` で `searchParams` を `await` しているが抽出した `category` 値を `getPublishedNews()` に渡していない。`PublicNewsGrid` は `useSearchParams` / `useRouter` を使用せず、URL への同期が未実装。`useRouter().push` で URL を更新するコードの追加が必要。
- **FR-NEWS-ALL-004** `MUST`: 記事カードは公開日・カテゴリ・タイトル・概要を表示し、クリックで該当ニュース詳細ページへ遷移できる。
  - レビュー: 一覧行に公開日・カテゴリタグ・タイトルを表示しリンクで詳細へ遷移するため要件を満たしている。
- **FR-NEWS-ALL-005** `SHOULD`: サーバ側カテゴリ絞り込みを実装する。`searchParams.category` を `getPublishedNews()` に渡し、DB レベルでフィルタリングする。
  - レビュー: `getPublishedNews()` はオプショナルな `category` パラメータをサポートしているにもかかわらず、`news/page.tsx` がそれを渡していない。`const { category } = await searchParams; getPublishedNews({ category })` の1行修正で解消できる。
- **FR-NEWS-ALL-006** `SHOULD`: ニュース一覧ページに `generateMetadata` を実装し、`title` / `description` を明示的に設定する。
  - レビュー: `news/page.tsx` に `generateMetadata` エクスポートが存在しない。SEO に影響するため追加が必要。
- **FR-NEWS-ALL-007** `SHOULD`: カテゴリ変化をクエリパラメータで保持し、ブラウザ戻るで絞り込み状態を復元できるようにする。
  - レビュー: URL 同期 が未実装のため（FR-NEWS-ALL-003 参照）、ブラウザバック時に絞り込み状態が失われる。FR-NEWS-ALL-003 と FR-NEWS-ALL-005 の実装時に合わせて解消する。

---

### 1.3 ニュース詳細ページ（NEWS DETAIL）— `GET /news/[id]`

**概要**: 公開済み記事の詳細表示と前後ナビゲーション。

#### 表示・ナビゲーション

- **FR-NEWS-DETAIL-001** `MUST`: 公開済みニュース記事の詳細ページを表示する。
  - レビュー: RSC で `getPublishedNewsDetailById` を呼び出して表示。存在しない場合は `notFound()`。要件を満たしている。
- **FR-NEWS-DETAIL-002** `MUST`: 記事詳細にはタイトル、公開日、カテゴリタグ、本文を掲載する。
  - レビュー: `h1` にタイトル、`TagLabel` にカテゴリ、`published_date` の表示あり。本文は `detailed_content` を段落分割して `<p>` タグで描画。要件を満たしている。
- **FR-NEWS-DETAIL-003** `MUST`: 前後の記事へのナビゲーションとニュース一覧ページへの遷移を提供する。
  - レビュー: `getPublishedNewsNavigation` で前後記事リンクを表示し、"VIEW ALL" ボタンで一覧へ戻れる。要件を満たしている。
- **FR-NEWS-DETAIL-004** `SHOULD`: `category` クエリパラメータが指定されている場合は同カテゴリ内の前後記事を継続して辿れるようにし、無効なカテゴリは `ALL` として扱う。
  - レビュー: `searchParams.category` を取得し検証後に `activeCategory` として `getPublishedNewsNavigation` へ渡す実装済み。無効値は `ALL` にフォールバック。要件を満たしている。
- **FR-NEWS-DETAIL-005** `SHOULD`: `generateMetadata` で `title` / `description` のメタ情報を設定する。
  - レビュー: `generateMetadata` のエクスポートがない。SEO 対応が未実施。対応が必要。
- **FR-NEWS-DETAIL-006** `COULD`: パンくずまたはカテゴリリンクを提供し、現在位置の把握とカテゴリ内移動を容易にする。
  - レビュー: パンくずリストもカテゴリリンクも実装されていない。
- **FR-NEWS-DETAIL-007** `COULD`: 前後リンクに `aria-label` などのアクセシビリティ属性を付与して、リンク先が明示的にわかるようにする。
  - レビュー: PREV/NEXT リンクに `aria-label` が未設定。リンクテキストとして記事タイトルが表示されるため最低限の識別は可能だが、`aria-label` による明示は未対応。
- **FR-NEWS-DETAIL-008** `SHOULD`: 本文はアクセシビリティ対応を考慮して段落・改行を適切にレンダリングし、スクリーンリーダーで読みやすい構造とする。
  - レビュー: `detailed_content.split("\n\n").map(paragraph => <p>)` で段落分割済み。`whitespace-pre-line` クラスで改行も保持。基本的な段落構造は満たしている。

---

### 1.4 商品一覧ページ（ITEM）— `GET /item`

**概要**: 公開済み商品のカタログ表示とフィルタリング。

#### 表示・絞り込み

- **FR-ITEM-ALL-001** `MUST`: 公開済み商品をカテゴリ・コレクション別に一覧表示する。
  - レビュー: `getPublishedItems()` で全公開商品を取得し `PublicItemGrid variant="catalog"` で表示。カテゴリ絞り込みはクライアント側の `selectedCategories` ステートで実施。DB 側フィルタなし。
- **FR-ITEM-ALL-002** `SHOULD`: 商品カードはカテゴリ・商品名・価格・サムネイルを表示し、バッジ（NEW、SALE、SOLD OUT）で判別性を高める。
  - レビュー: カード内に `item.name`（h3）と `item.price` のみ表示。カテゴリ表示なし。バッジ（NEW / SALE / SOLD OUT）は未実装。Item 型にバッジ用フラグもない。
- **FR-ITEM-ALL-003** `SHOULD`: URLベースのカテゴリフィルタリングを実装し、`category` クエリで共有・リンク可能な状態とする。ブラウザの戻る/進むで絞り込み状態を復元できるようにする。
  - レビュー: `PublicItemGrid` は `useSearchParams` / `useRouter` を使用していない。URL との同期が未実装。
- **FR-ITEM-ALL-004** `SHOULD`: サーバ側カテゴリ絞り込みを実装し、`category` に基づく DB フィルタを行うことで、全件取得後クライアントで絞り込まないようにする。
  - レビュー: `getPublishedItems(limit?)` はカテゴリパラメータを受け付けない。ページ側でも `searchParams` を参照しておらず、全件取得後クライアントで絞り込む実装のまま。
- **FR-ITEM-ALL-005** `COULD`: 商品一覧は無限スクロール方式を採用し、追加読み込みで結果を遷移せずに継続表示できるようにする。
  - レビュー: 未実装。全件を一括取得して表示。
- **FR-ITEM-ALL-006** `COULD`: 検索・絞り込み機能を強化し、コレクション・サイズ・カラー・価格など複数属性で絞り込み可能とする。
  - レビュー: 未実装。カテゴリ（TOPS, BOTTOMS 等）のみクライアント側で絞り込み可能。
- **FR-ITEM-ALL-007** `COULD`: 一覧にソート機能を追加し、新着順、価格昇順/降順、人気順などの切り替えを提供する。
  - レビュー: 未実装。
- **FR-ITEM-ALL-008** `SHOULD`: ITEMページに `generateMetadata` を実装し、`title` / `description` を設定する。
  - レビュー: `src/app/item/page.tsx` に `generateMetadata` エクスポートがない。SEO 対応が未実施。

---

### 1.5 商品詳細ページ（ITEM DETAIL）— `GET /item/[id]`

**概要**: 個別商品の詳細表示、バリアント選択、カート・ウィッシュリスト操作。

#### 表示・操作

- **FR-ITEM-DETAIL-001** `MUST`: クライアントサイドで `/api/items/[id]` から公開済み商品データを読み込み、ページを構成する。
  - レビュー: `"use client"` コンポーネントで `useEffect` から `fetch('/api/items/${id}')` を実行。要件を満たしている。
- **FR-ITEM-DETAIL-002** `MUST`: 画像カルーセルを表示し、モバイルでは横スクロール、デスクトップではサムネイルを使った選択 UI を提供する。
  - レビュー: `carouselRef` で横スクロールを実装し `handleCarouselScroll` でインデックスを追従。サムネイルクリックで画像切替。要件を満たしている。
- **FR-ITEM-DETAIL-003** `MUST`: 商品のカラー、サイズ、数量をユーザーが選択できるようにし、選択状態を明確に表示する。
  - レビュー: カラー・サイズのボタン選択 + `Stepper` コンポーネントで数量指定。要件を満たしている。
- **FR-ITEM-DETAIL-004** `MUST`: カート追加ボタンとウィッシュリスト切替ボタンを提供し、状態変更時に適切なフィードバックを返す。
  - レビュー: カート追加・ウィッシュリスト切替ともに実装済み。ただしフィードバックが `alert()` を使用しており、アクセシビリティ・UX の観点から Toast 等への改善が望ましい。
- **FR-ITEM-DETAIL-005** `MUST`: 商品読み込み中はローディングを表示し、404 時にはエラーメッセージと戻るボタンを表示する。
  - レビュー: ローディング中は「読み込み中...」テキストを表示。エラー時は "BACK TO ITEMS" ボタンを表示。要件を満たしている。
- **FR-ITEM-DETAIL-006** `MUST`: レスポンシブレイアウトを採用し、モバイルでは固定フッターボタンを含む使いやすい操作領域を維持する。
  - レビュー: デスクトップは `md:sticky` で粘着配置。モバイルは `fixed bottom-0` の固定フッターボタンを実装し、メインボタンが見える間は `translate-y-full` で非表示にする IntersectionObserver 制御。要件を満たしている。
- **FR-ITEM-DETAIL-007** `SHOULD`: 在庫状態を表示し、サイズ・カラー選択時に「残りわずか」「売り切れ」情報を明示する。選択不可バリエーションは無効化して表示する。
  - レビュー: 在庫状態の表示ロジックがなく、品切れバリアントの無効化も未実装。
- **FR-ITEM-DETAIL-008** `SHOULD`: カラー・サイズのボタンに `aria-pressed` などのアクセシビリティ属性を付与し、エラーメッセージには `role="alert"` を含めてスクリーンリーダー対応を改善する。
  - レビュー: カラー・サイズボタンに `aria-pressed` なし。エラーメッセージに `role="alert"` なし。未対応。
- **FR-ITEM-DETAIL-009** `SHOULD`: 商品詳細ページは `generateMetadata` でSEOメタ情報を設定する（クライアントコンポーネントのため Server Component ラッパーに切り出して対応）。
  - レビュー: ページ全体が `"use client"` で `generateMetadata` エクスポート不可。SEO 未対応。Server Component ラッパーへの切り出しが必要。
- **FR-ITEM-DETAIL-010** `SHOULD`: パンくずナビゲーションと「ITEM一覧へ戻る」の明示的リンクを設ける。
  - レビュー: エラー時のみ "BACK TO ITEMS" ボタン（`history.back()` 使用）が表示される。正常時にパンくずも `/item` 固定リンクも存在しない。
- **FR-ITEM-DETAIL-011** `COULD`: `compare_at_price` / セール価格対応や「NEW」「SALE」「SOLD OUT」バッジ表示を追加し、税込み・配送別など価格情報の表現を強化する。
  - レビュー: 未実装。価格は `¥{item.price.toLocaleString()}` のみ。
- **FR-ITEM-DETAIL-012** `COULD`: 同カテゴリ・おすすめルックなどの関連商品提案を追加し、ページ下部に「この商品におすすめ」セクションを設ける。
  - レビュー: 未実装。
- **FR-ITEM-DETAIL-013** `SHOULD`: 画像の alt テキストは商品名だけでなく色・角度などを含めて付与し、ズームやライトボックスを将来的に検討する。
  - レビュー: メイン画像の alt は `item.name` のみ。カルーセル画像は `\`${item.name} ${index + 1}\`` で連番のみ。色・角度情報の付与は未対応。

---

### 1.6 ルック一覧ページ（LOOK）— `GET /look`

**概要**: 公開済みルックのカタログ表示とシーズンフィルタ。

- **FR-LOOK-ALL-001** `MUST`: 公開済みルックをカードグリッドで一覧表示する。
  - レビュー: `PublicLookGrid variant="catalog"` で RSC として実装。`getPublishedLooks` でデータ取得しレスポンシブグリッド表示。要件を満たしている。
- **FR-LOOK-ALL-002** `MUST`: ルックカードはシーズンラベル・テーマタイトル・メインビジュアル・紐づけ商品名を表示し、クリックでルック詳細ページへ遷移できる。
  - レビュー: `formatLookSeason` でシーズンラベル、`look.theme` でタイトル、メインビジュアル（`alt=look.theme`）、`look.linkedItems.map` で商品名リンクをすべて表示。要件を満たしている。
- **FR-LOOK-ALL-003** `COULD`: `/look` ページは全公開ルックをカタログ表示し、少なくともページングまたは無限スクロールで6件以上を表示する。
  - レビュー: 全件を一括表示しており件数制限やページネーションは未実装。データ量が増えた際のパフォーマンス改善が課題。
- **FR-LOOK-ALL-004** `MUST`: HOME の LOOK セクション表示時は `PublicLookGrid variant="home"` を使用し、最大6件まで表示しつつ「VIEW LOOKBOOK」ボタンで詳細一覧に誘導する。
  - レビュー: ホームページで `<PublicLookGrid variant="home" />` を使用。要件を満たしている。
- **FR-LOOK-ALL-005** `SHOULD`: LOOK一覧ページに `generateMetadata` を実装し、`title` / `description` などの SEO メタ情報を設定する。
  - レビュー: `src/app/look/page.tsx` に `generateMetadata` を実装済み。要件を満たしている。
- **FR-LOOK-ALL-006** `MUST`: LOOK 一覧ページでシーズン（ALL / SS / AW）をフィルタでき、desktop では左サイドバー、tablet/mobile では FILTER ボタンと Drawer を表示する。
  - レビュー: `src/app/look/page.tsx`, `src/features/look/components/PublicLookGrid.tsx`, `src/features/look/components/PublicLookCatalogGrid.tsx`, `src/lib/look/look-view.ts` で実装。`season` クエリと UI 状態を同期し、MultiSelect で単一シーズンを切り替える。

---

### 1.7 ルック詳細ページ（LOOK DETAIL）— `GET /look/[id]`

**概要**: 個別ルックの詳細表示と前後ルックナビゲーション。

- **FR-LOOK-DETAIL-001** `MUST`: 公開済みルックの詳細ページを表示し、テーマ・シーズンラベル・メインビジュアル・説明文を含める。
  - レビュー: RSC でシーズンラベル（`formatLookSeason`）、`h1` にテーマ、メインビジュアル（`imageUrls[0]`）、`themeDescription` を表示。要件を満たしている。
- **FR-LOOK-DETAIL-002** `MUST`: ルック詳細ページには紐づけ商品（STYLING ITEMS）を一覧表示し、各商品への遷移リンクを提供する。
  - レビュー: `List` コンポーネントで商品名・カテゴリ・価格・画像を表示。`/item/${item.id}` へのリンク付き。要件を満たしている。
- **FR-LOOK-DETAIL-003** `MUST`: 前後のルックへのナビゲーションリンクを表示し、連続して閲覧できるようにする。
  - レビュー: `getPublishedLooks()` で全件取得後にインデックスで前後ルックを特定し PREV/NEXT リンクを表示。要件を満たしている。なお全件取得はパフォーマンス上の改善余地あり。
- **FR-LOOK-DETAIL-004** `MUST`: 存在しないルック ID の場合はエラーメッセージと `/look` への戻るリンクを表示する。
  - レビュー: `currentIndex < 0` で "Look not found" を表示し "Back to Lookbook" リンク（`href="/look"`）を提供。要件を満たしている。
- **FR-LOOK-DETAIL-005** `SHOULD`: `currentLook.imageUrls` の複数画像をサムネイル付きギャラリーまたはカルーセルで表示する。
  - レビュー: `imageUrls[0]`（1枚目）のみ表示。複数画像がある場合でも1枚しか表示されない。
- **FR-LOOK-DETAIL-006** `SHOULD`: `generateMetadata` を実装し、ページタイトルと description を設定する。また `Back to Lookbook` リンクと適切な `aria-label` を追加する。
  - レビュー: `generateMetadata` エクスポートなし。正常時の画面に "Back to Lookbook" リンクも存在しない（404 時のみ存在）。PREV/NEXT リンクにも `aria-label` なし。未対応。
- **FR-LOOK-DETAIL-007** `WONT`: 同シーズンや関連コーディネートの推薦セクションを追加する（将来対応）。
  - レビュー: 未実装。現フェーズ対応外。

---

### 1.8 アバウトページ（ABOUT）— `GET /about`

**概要**: ブランドコンセプト・価値観・ストーリーの紹介ページ。

- **FR-ABOUT-001** `MUST`: ブランド哲学（Brand Philosophy）を紹介するセクションを表示する。
  - レビュー: テキストと画像の2カラムグリッドで表示。要件を満たしている。
- **FR-ABOUT-002** `MUST`: 品質・クラフトマンシップ（Quality & Craftsmanship）を紹介するセクションを表示する。
  - レビュー: 2セクション目として画像とテキストを逆順配置で表示。要件を満たしている。
- **FR-ABOUT-003** `MUST`: `Timeless` / `Sustainable` / `Thoughtful` の価値観をアイコン付き3カラムで掲載する。
  - レビュー: Remixicon アイコン（`ri-time-line`, `ri-leaf-line`, `ri-heart-line`）付きで3カラム表示。要件を満たしている。
- **FR-ABOUT-004** `MUST`: 画像とテキストを交互に配置したレスポンシブレイアウトでブランドストーリーを伝える。
  - レビュー: 1セクション目は画像左・テキスト右、2セクション目は `lg:order-2` / `lg:order-1` で逆順。要件を満たしている。
- **FR-ABOUT-005** `SHOULD`: ページに `h1` を含む見出し階層を明示し、`generateMetadata` で `title` / `description` を設定する。
  - レビュー: ページ内に `h1` がなく `h2` から始まる（アクセシビリティ・SEO の問題）。`generateMetadata` エクスポートもなし。
- **FR-ABOUT-006** `COULD`: ブランドストーリー後に `COLLECTIONを見る` / `LOOKBOOKを見る` / `CONTACTする` などの CTA を設置する。
  - レビュー: CTA セクションが存在しない。
- **FR-ABOUT-007** `SHOULD`: 装飾アイコンに `aria-hidden="true"` を設定し、画像 `alt` 属性をより具体的な説明にする。
  - レビュー: 装飾アイコン（`<i className="ri-...">` タグ）に `aria-hidden="true"` が設定されていない。画像の alt は "Brand Philosophy" / "Quality & Craftsmanship" と汎用的で、画像の内容を具体的に表現していない。
- **FR-ABOUT-008** `MUST`: 画像を外部の動的生成 URL（readdy.ai）から静的ローカルアセットまたは管理された CDN 画像に移行する。
  - レビュー: 全2枚の画像が `readdy.ai` API URL を使用。サービス停止・レートリミット時にページが壊れるリスクがあり、本番環境には不適切。

---

### 1.9 コンタクトページ（CONTACT）— `GET /contact`

**概要**: ユーザーからの問い合わせ受付フォーム。

- **FR-CONTACT-001** `MUST`: 名前・メールアドレス・件名・メッセージを入力するフォームフィールドを表示する。
  - レビュー: `TextField`（name, email, subject）と `TextAreaField`（message, maxLength=500）で構築。`h1` "Contact / お問い合わせ" あり。要件を満たしている。
- **FR-CONTACT-002** `MUST`: お問い合わせ内容を選択するドロップダウンを表示し、ユーザーが問い合わせ種別を選べるようにする。
  - レビュー: `SingleSelect` コンポーネントで「商品について / ご注文について / その他」を選択可能。要件を満たしている。
- **FR-CONTACT-003** `MUST`: フォームはクライアントサイドで表示し、送信ボタンを備えたインタラクティブなページとする。
  - レビュー: `"use client"` で実装。"SEND MESSAGE" 送信ボタンあり。要件を満たしている。
- **FR-CONTACT-004** `MUST`: フォームのレイアウトはモバイルとデスクトップの両方で使いやすいレスポンシブ構成とする。
  - レビュー: `max-w-4xl` で幅制限しつつ `px-4 sm:px-6 lg:px-12` でパディング調整。要件を満たしている。
- **FR-CONTACT-005** `MUST`: `form` に `onSubmit` ハンドラを実装し、問い合わせデータを API エンドポイントに送信できるようにする。
  - レビュー: `<form>` に `onSubmit` ハンドラがなく、送信処理が実装されていない。フォームは表示のみの状態。
- **FR-CONTACT-006** `MUST`: 送信中のローディング表示・送信成功メッセージ・送信失敗メッセージを実装する。送信後はフォームリセットまたはサンクス画面に遷移する。
  - レビュー: 未実装。送信処理自体がないためフィードバック表示もない。
- **FR-CONTACT-007** `SHOULD`: 入力エラー時にユーザー向けの説明表示を行い、`aria-describedby` でエラーメッセージを関連付ける。
  - レビュー: バリデーションエラーの表示ロジックが存在しない。`aria-describedby` も未設定。
- **FR-CONTACT-008** `MUST`: 問い合わせデータを受け取る API ルートを実装し、メール送信処理と問い合わせ履歴の保存を行う（Supabase + メールライブラリを活用）。
  - レビュー: `/api/contact` または相当するエンドポイントが存在しない。バックエンド処理が未実装。
- **FR-CONTACT-009** `SHOULD`: `message` フィールドに文字数カウンターを追加し、送信ボタンは入力状態・送信中に応じて無効化して誤送信を防止する。
  - レビュー: `TextAreaField` に `maxLength={500}` は設定されているが、文字数カウンターの表示・送信中の disabled 制御は未実装。
- **FR-CONTACT-010** `SHOULD`: 送信完了後にサンクス画面またはモーダルを表示し、ユーザーに送信完了を明確に伝える。
  - レビュー: 未実装。
- **FR-CONTACT-011** `MUST`: 問い合わせ送信時、問い合わせしたユーザー本人へ確認メールを送信する。確認メールには受付内容（種別・件名・本文）を含め、Reply-To にスレッド返信用アドレスを設定してメール返信をスレッドに取り込めるようにする。
  - レビュー: `POST /api/contact` で `sendMail`（顧客宛・`replyTo=buildReplyAddress`）を追加。問い合わせは `contact_inquiries`（スレッドヘッダ）＋ `contact_messages`（初回メッセージ）として保存される。
- **FR-CONTACT-012** `SHOULD`: 問い合わせフォームに任意の「注文番号（ORD-…）」入力欄を設け、入力された注文番号が本人（メール一致またはログインユーザー）の注文と一致する場合に問い合わせへ紐づける。
  - レビュー: フォームに `orderNumber` 欄を追加。API 側 `resolveLinkedOrderId` で本人所有の注文のみ `order_id` に紐づけ、MANAGE で該当注文番号を表示する。
- **FR-CONTACT-013** `MUST`: ゲスト（非会員）は受信メールへの返信で会話を継続でき、その返信は Resend 受信 Webhook（署名検証・HMAC 相関・送信元一致確認・冪等化）経由でスレッドに取り込まれ、MANAGE で管理できる。
  - レビュー: `POST /api/contact/inbound` を追加。Svix 署名検証、`parseReplyAddress` による相関、`from` 一致確認、`inbound_provider_id` の一意制約で冪等化し、`contact_messages`（channel=email）として保存する。

---

### 1.10 商品扱い店舗ページ（STOCKIST）— `GET /stockist`

**概要**: 商品を取り扱う実店舗の一覧表示。

- **FR-STOCKIST-001** `MUST`: 公開済みのストックリストを `PublicStockistGrid variant="catalog"` で表示し、レスポンシブグリッドレイアウトに対応する。
  - レビュー: `PublicStockistGrid` は RSC で `getPublicStockists()` を呼び出し `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3` でレスポンシブ表示。要件を満たしている。
- **FR-STOCKIST-002** `MUST`: 各ストックリストカードに店舗名・住所・電話番号・営業時間・定休日を含め、店舗情報を判別しやすくする。
  - レビュー: `Card` コンポーネントで `shop.name`（h2）, `shop.address`, `shop.phone`, `shop.time`, `shop.holiday` を Remixicon アイコン付き行として表示。要件を満たしている。
- **FR-STOCKIST-003** `MUST`: Supabase の `stockists` テーブルから `status = 'published'` の店舗データを取得し、取得失敗時は空状態またはエラーハンドリングを行う。
  - レビュー: `getPublicStockists()` で `.eq('status', 'published')` フィルタを適用。要件を満たしている。
- **FR-STOCKIST-004** `MUST`: HOME 用 `PublicStockistGrid variant="home"` は最大6件を優先表示し、モバイルでは上位3件を表示してタブレット以上で全件を見せる。
  - レビュー: `getHomePublicStockists()` が `limit: 6` で最大6件を取得。コンポーネント側では `mobileLimit = 3` でモバイル3件表示・タブレット以上で全件表示。`src/app/page.tsx` にも `<PublicStockistGrid variant="home" />` を配置済み。要件を満たしている。
- **FR-STOCKIST-005** `SHOULD`: STOCKIST ページに `generateMetadata` で `title` / `description` を設定する。
  - レビュー: `src/app/stockist/page.tsx` に `generateMetadata` エクスポートがない。SEO 未対応。
- **FR-STOCKIST-006** `WONT`: キーワード検索、ソート、ページネーションを提供する（将来対応）。
  - レビュー: 未実装。現フェーズ対応外。地方/都道府県別フィルターは FR-STOCKIST-010 として実装済み。
- **FR-STOCKIST-010** `SHOULD`: STOCKIST 一覧に「地方（北海道/東北/関東/中部/近畿/中国/四国/九州・沖縄）→都道府県」のネストしたチェックボックスツリー型フィルターを提供する。`ALL` と、店舗が存在する地方（親）・その地方配下で店舗が存在する都道府県（子・インデント表示）のみを表示し、地方チェックで配下都道府県を一括選択、都道府県チェックで個別に絞り込める。複数都道府県を持つ地方（東北・関東など）は親要素を折りたたみ／展開でき、北海道のように単一都道府県の地方は親子に分けず1つのチェックボックスとする。フィルター UI は LOOK/ITEM 一覧と統一し、desktop は左サイドバー、tablet/mobile は FILTER ボタンと Drawer を表示する。選択中の都道府県は店舗住所の先頭都道府県名と突き合わせて絞り込む。
  - レビュー: `src/features/stockist/region.ts`（地方⇔都道府県マッピング・住所からの都道府県判定・短縮ラベル）、`src/features/stockist/components/PublicStockistCatalog.tsx`（折りたたみ式ネストチェックボックスツリー、`pref` クエリ同期）で実装。未選択時は全件表示、地方（親）は配下都道府県が全選択のとき✓となる。
- **FR-STOCKIST-007** `WONT`: ストックリストカードに Google Maps リンク・外部リンク・取扱カテゴリ・店舗画像またはロゴを含める（将来対応）。
  - レビュー: 基本情報（住所・電話・営業時間・定休日）のみ。Maps リンク等は未実装。将来拡充予定。
- **FR-STOCKIST-008** `SHOULD`: カードのキーには `shop.name` ではなく `id` やユニークキーを使用し、スクリーンリーダー対応を改善する。
  - レビュー: `key={shop.name}` を使用。`PublicStockist` 型に `id` が含まれていないためリファクタが必要。`StockistRecord` には `id` が存在するため型の見直しで対応可能。

---

### 1.11 ウィッシュリストページ（WISHLIST）— `GET /wishlist`

**概要**: ユーザーがお気に入り登録した商品の管理。

- **FR-WISHLIST-001** `MUST`: `/wishlist` ページは `h1` 見出しを含み、クライアントコンポーネント `WishlistClient` でウィッシュリストアイテムを表示する。
  - レビュー: `page.tsx` は RSC で `h1` "Wishlist" を持ち `<WishlistClient />` を内包。要件を満たしている。
- **FR-WISHLIST-002** `MUST`: `WishlistClient` は `/api/wishlist` からセッションベースのウィッシュリストデータを取得し、読み込み中・エラー・空状態の各 UI を表示する。
  - レビュー: `useEffect` で `fetch('/api/wishlist')` ✅、loading/error/empty の各ブランチ実装済み ✅。エラー時は `alert()` を使用しており、インライン表示への改善が望ましい。
- **FR-WISHLIST-003** `MUST`: ウィッシュリストカードは商品画像・カテゴリ・商品名・価格を表示し、クリックで商品詳細ページへ遷移できる。
  - レビュー: `Image` コンポーネントで `image_url` ✅、カテゴリ ✅、商品名 ✅、価格 ✅、`/item/${item.items.id}` リンク ✅。要件を満たしている。
- **FR-WISHLIST-004** `MUST`: ユーザーはカード上の削除ボタンでウィッシュリストからアイテムを削除でき、削除後に一覧を再レンダリングする。
  - レビュー: `DELETE /api/wishlist/${wishlistId}` 呼び出し後に `filter` で画面更新 ✅。エラー時は `alert()` のみで toast/インラインエラー未実装 ❌。
- **FR-WISHLIST-005** `MUST`: ウィッシュリスト API は `GET /api/wishlist`、`POST /api/wishlist`、`DELETE /api/wishlist/[id]` を有し、`session_id` に基づいてセッション間でウィッシュリストを管理する。
  - レビュー: クライアントコードで `GET` / `DELETE` が実装済み。`POST` は商品詳細ページから呼び出される。`session_id` クッキーベース。要件を満たしている。
- **FR-WISHLIST-006** `MUST`: ウィッシュリストが空の場合は案内テキストと `/item` への継続購入リンクを提供する。
  - レビュー: 「ウィッシュリストは空です」と `Link href="/item"` 「買い物を続ける」を表示 ✅。要件を満たしている。
- **FR-WISHLIST-007** `COULD`: 各カードに「カートに追加」ボタンを追加し、ウィッシュリストから直接購入に移せるようにする。
  - レビュー: 未実装。カードには削除ボタンのみ存在する。
- **FR-WISHLIST-008** `SHOULD`: 削除ボタンに `aria-label="ウィッシュリストから削除"` を付与し、カードリストに適切な role を設定してアクセシビリティを改善する。
  - レビュー: `<button>` に `aria-label` が設定されていない ❌。アイコンのみで支援技術がボタンの目的を読み上げられない。
- **FR-WISHLIST-009** `WONT`: 認証連携による永続化・デバイス間同期（将来対応）。
  - レビュー: 現在は `session_id` クッキーベースで動作。ログイン後の永続化・同期は未実装。現フェーズ対応外。
- **FR-WISHLIST-010** `SHOULD`: `item.items` が `null` の場合のフォールバック UI と API レスポンスの型チェックを強化する。
  - レビュー: `client.tsx` の `map` 内で `item.items.*` を null ガードなしに直接参照。API が `null` を返した場合にランタイムエラーが発生する可能性がある。

---

### 1.12 カートページ（CART）— `GET /cart`

**概要**: カートアイテムの確認・数量変更・削除、注文サマリーの表示。

- **FR-CART-001** `MUST`: `/cart` ページは `GET /api/cart` からカートアイテムを取得し、商品画像・商品名・価格・カラー・サイズ・数量変更 UI を表示する。
  - レビュー: `useEffect` で `fetch('/api/cart')` ✅、画像/名前/価格/カラー/サイズ/`Stepper` を表示 ✅。ただし画像の `<Link>` が `href={/item/${item.id}}` (カート UUID) を参照しており、正しくは `item.items.id` (商品 ID) であるべきバグが存在する ❌。
- **FR-CART-002** `MUST`: カートは `proxy.ts` で生成される `session_id` クッキーに基づき 30 日間保持され、ログイン不要の永続カートを実現する。
  - レビュー: `session_id` クッキーベース。ページコードからは直接確認できないが、設計上 middleware で管理。要件を満たしている。
- **FR-CART-003** `MUST`: 数量変更は `Stepper` で可能とし、クライアントで即時反映したうえで 500ms のデバウンスで `PATCH /api/cart/[id]` を呼び出す。
  - レビュー: `scheduleUpdate` で 500ms デバウンス ✅、`inFlight` で二重送信防止 ✅、楽観的 UI 更新 ✅。要件を満たしている。
- **FR-CART-004** `MUST`: アイテム削除は `DELETE /api/cart/[id]` で実行し、削除後にカート件数と画面を更新する。
  - レビュー: `DELETE /api/cart/${cartId}` ✅、`setCartItems(filter)` で即時反映 ✅、`updateCartCount()` でバッジ更新 ✅。エラー時は `alert()` のみ ❌。
- **FR-CART-005** `MUST`: 注文サマリーは小計・配送料（無料表示）・合計を表示し、`/checkout` への遷移ボタンを設置する。
  - レビュー: 小計 ✅、配送料「無料」✅、合計 ✅、`Button href="/checkout"` ✅。`total = subtotal` で送料は合計に含まれない（無料扱い）。要件を満たしている。
- **FR-CART-006** `SHOULD`: プロモーションコード入力欄と適用ボタンを UI に含む。
  - レビュー: `TextField` + `Button「適用」` の UI は存在 ✅。ただしコード検証・割引計算ロジックは未実装（プレースホルダー文字列のみ）❌。
- **FR-CART-007** `MUST`: カートが空の場合は `EmptyCart` コンポーネントを表示し、`/item` への「買い物を続ける」リンクを設ける。
  - レビュー: `cartItems.length === 0` 時に `<EmptyCart />` をレンダリング ✅。`/item` リンクあり ✅。要件を満たしている。
- **FR-CART-008** `MUST`: `CartContext` は `/api/cart` からカート件数を取得し、ヘッダーバッジ表示と動的更新をサポートする。
  - レビュー: `useCart()` から `updateCartCount` / `wishlistedItems` / `toggleWishlist` を呼び出し。要件を満たしている。
- **FR-CART-009** `WONT`: プロモーションコードのサーバ側バリデーション・割引計算（将来対応）。
  - レビュー: 未実装。「WELCOME10 または SAVE20」のプレースホルダーテキストのみ表示。現フェーズ対応外。
- **FR-CART-010** `COULD`: 各カートアイテム行に「単価 × 数量 = 小計」を明示し、注文サマリーに「税」「送料」「割引」行を追加する。
  - レビュー: 単価のみ表示、行サブトータル未表示 ❌。注文サマリーも小計・配送料（無料）・合計のみで税/割引行なし。
- **FR-CART-011** `SHOULD`: 商品ごとの在庫チェックを組み込み、「在庫あり / 売り切れ / 残り○点」を表示し、チェックアウト前に在庫不足をバリデーションする。
  - レビュー: 在庫チェック・残数表示は未実装 ❌。
- **FR-CART-012** `SHOULD`: 削除ボタン・ウィッシュリストボタンに `aria-label` を付与し、カートアイテムリストに `role="list"` / `role="listitem"` を設定する。
  - レビュー: `<Button>` 内にアイコンのみで `aria-label` がない ❌。リストの ARIA role 未設定 ❌。
- **FR-CART-013** `SHOULD`: API の取得失敗時に「再試行」ボタンとリロード案内を表示する。
  - レビュー: `error` ステートを赤枠で表示 ✅。再試行ボタンは未実装 ❌。
- **FR-CART-014** `COULD`: モバイルでは `/checkout` ボタンを固定 CTA として設置し、カート内容更新時にサマリーを即時再計算する。
  - レビュー: `sticky top-32` のサイドバーはデスクトップのみ。モバイル固定 CTA 未実装 ❌。小計はカート更新に連動して即時再計算 ✅。

---

### 1.13 チェックアウトページ（CHECKOUT）— `GET /checkout`

**概要**: 配送先入力・決済処理・注文確定フロー。

- **FR-CHECKOUT-001** `MUST`: 決済ゲートウェイに Stripe を採用し、主要カード・Apple Pay・Google Pay 等のトークン化対応を実装する。
  - レビュー: `@stripe/react-stripe-js/checkout` の `CheckoutProvider` + `PaymentElement` を使用 ✅。カード・PayPay・コンビニ決済の `CheckoutPaymentMethod` 型を定義。要件を満たしている。
- **FR-CHECKOUT-002** `MUST`: カード情報は Stripe のトークン化に委託し、PCI 準拠の運用を確保する。
  - レビュー: カード情報入力は Stripe Elements に完全委譲 ✅。PCI 準拠 ✅。
- **FR-CHECKOUT-003** `SHOULD`: 注文金額明細として小計・税・送料・合計を明示し、決済前に金額内訳をユーザーに分かりやすく提示する。
  - レビュー: `subtotal`, `shipping = 0`, `total = subtotal + shipping` を算出 ✅。タックス計算なし ❌。注文サマリーに税行が未表示。
- **FR-CHECKOUT-004** `MUST`: 配送先入力フォームに必須チェックとフォーマット検証を実装し、入力エラーは `aria-describedby` 付きで明示する。
  - レビュー: `handleShippingNext` で `e.preventDefault()` のみ。フォーム必須チェック・バリデーションエラー表示・`aria-describedby` いずれも未実装 ❌。
- **FR-CHECKOUT-005** `MUST`: 郵便番号入力に基づく住所自動補完を実装する。
  - レビュー: `formatPostalCodeInput` / `isCompletePostalCode` / `normalizePostalCode` ユーティリティ + `/api/checkout/postal-code` への fetch で自動補完 ✅。競合リクエストも `latestPostalLookupRef` で防止。
- **FR-CHECKOUT-006** `SHOULD`: 注文確定後に自動で注文確認メールを送信し、完了画面でメール送信済みであることを明示する。
  - レビュー: 完了画面に「確認メールをお送りしました」テキストを表示 ✅。実際のメール送信は `/api/checkout/complete` または Webhook 側の実装に依存するため、クライアント側では確認不可。
- **FR-CHECKOUT-007** `SHOULD`: チェックアウト時にカート内商品の在庫を再確認し、在庫不足時は購入不可とする。
  - レビュー: 在庫チェック未実装 ❌。
- **FR-CHECKOUT-008** `MUST`: Stripe の決済キャンセル時は明確なメッセージと再試行導線を表示する。
  - レビュー: `checkoutError` ステートでエラーメッセージを表示 ✅。再試行ボタンは未設置 ❌。
- **FR-CHECKOUT-009** `SHOULD`: Stripe Checkout の完了を Webhook で補強し、重複注文を防止する冪等性を備える。
  - レビュー: `processedCallback` フラグでクライアント側の二重呼び出しを防止 ✅。サーバ側 `/api/checkout/complete` の冪等性はコードから確認不可。
- **FR-CHECKOUT-010** `SHOULD`: 郵便番号自動補完に使用する zipcloud への依存リスクを低減するため、Supabase の `postal_code_cache` テーブルを活用したキャッシュ層を整備する。
  - レビュー: `/api/checkout/postal-code` を経由してサーバ側で処理。`postal_code_cache` テーブルのマイグレーション（024）が存在 ✅。キャッシュ利用の詳細は API 実装側で確認が必要。
- **FR-CHECKOUT-012** `MUST`: ログイン済みユーザーの配送先入力フォームは account に保存済みのプロフィール・配送情報を既定値として表示する。
  - レビュー: checkout 初期表示時に `/api/profile` を取得し、メールアドレス・氏名・電話番号・住所を空欄にのみマージする実装を追加 ✅。
- **FR-CHECKOUT-011** `WONT`: 日本国内の税計算（消費税 10%、軽減税率含む）に対応する（将来対応）。
  - レビュー: 税計算なし。`total = subtotal + 0`。現フェーズ対応外。

---

### 1.14 ログインページ（LOGIN）— `GET /login`

**概要**: メール + パスワード + メール OTP による2要素認証（2FA）とソーシャルログイン。

- **FR-LOGIN-001** `MUST`: メールアドレスとパスワードで認証し、成功後にメール OTP（第2要素）で本人確認する2段階のログインを提供する。
  - レビュー: `login/page.tsx` は `<LoginModal open={true} />` を全画面ページとして再利用。ステップ1（EMAIL + PASSWORD）→ `POST /api/auth/login` でパスワード検証しメール OTP を送信、ステップ2（8桁コード）→ `POST /api/auth/otp/verify` でセッション確定。Turnstile CAPTCHA 付き。パスワード検証済みは短命の署名 Cookie（`sb-login-2fa-session`）で担保し、OTP 単独ログインを防止 ✅。
- **FR-LOGIN-002** `MUST`: Google OAuth によるソーシャルログインボタンを表示する。
  - レビュー: `LoginModal` 内に Google OAuth ボタンが存在し、Google への遷移時に `prompt=select_account` を付与してログインアカウントを選択できるようにする ✅。
- **FR-LOGIN-003** `SHOULD`: パスワードリセットページとメールによる再発行フローを提供する。
  - レビュー: `/auth/password-reset` ルートが存在 ✅。パスワード導入により実運用上の意味を持つ。
- **FR-LOGIN-004** `MUST`: 専用の新規登録ページ（`/register`）を実装し、メールアドレス + パスワードでアカウントを作成できる。ログインと登録は分離する。
  - レビュー: `src/app/register/page.tsx` + `RegisterModal` を実装。`POST /api/auth/register`（`signUp`）で確認メールを送信し、メールのリンク（`/api/auth/confirm`）で登録を確定 ✅。ログイン時の自動アカウント作成は廃止（`shouldCreateUser: false`）✅。
- **FR-LOGIN-005** `SHOULD`: ログインページに `generateMetadata` を実装し、`title` / `description` を設定する。
  - レビュー: ページを RSC 化し `generateMetadata` を実装済み ✅。
- **FR-LOGIN-006** `MUST`: OTP 送信後のカウントダウンタイマー（再送信制限）を実装する。
  - レビュー: `otpSentTime` と `timeRemaining` によるダウンカウント（60秒）と再送信制限を実装 ✅。要件を満たしている。
- **FR-LOGIN-007** `MUST`: 2要素認証（2FA）に対応する。標準ユーザーはパスワード + メール OTP、管理者/サポーターは追加で TOTP を要求する。
  - レビュー: 全ユーザーがパスワード + メール OTP を必須。特権ロールは `/auth/verified` で TOTP を追加要求（多層）✅。
- **FR-LOGIN-008** `MUST`: メール OTP の有効期限は 5 分（Supabase `Auth > Providers > Email > Email OTP Expiration` = 300 秒）とする。UI の再送クールダウンは 60 秒を維持する。
  - レビュー: Supabase 側で OTP Expiration = 300 に設定。UI 再送カウントダウンは 60 秒 ✅。

---

### 1.15 会員ページ（ACCOUNT）— `GET /account`

**概要**: ログインユーザーのプロフィール・配送情報・注文履歴の管理。

- **FR-ACCOUNT-001** `MUST`: プロフィールタブ・配送情報タブ・注文履歴タブを持つタブ型レイアウトを提供する。
  - レビュー: `TabSegmentControl` で profile / shipping / orders の3タブを実装 ✅。旧 `?tab=address` は `shipping` へ正規化 ✅。
- **FR-ACCOUNT-002** `MUST`: プロフィールタブではメールアドレス（読み取り専用）・氏名・電話番号を表示・編集できる。
  - レビュー: メールアドレスはプロフィールカード内で `/api/profile` から取得した認証済みユーザーの実アドレスを表示 ✅。氏名・電話番号も `/api/profile` GET/POST で取得・保存し、プロフィール削除時はプロフィール項目のみクリア ✅。
- **FR-ACCOUNT-003** `MUST`: 未ログイン状態のアクセスは適切にハンドリングする（ログインへのリダイレクトまたは案内表示）。
  - レビュー: `!isLoggedIn` 時に「会員情報を確認するにはログインが必要です」+「ログイン」ボタンを表示 ✅。自動リダイレクトはなし（要件「または案内表示」を満たしている）。
- **FR-ACCOUNT-004** `MUST`: 配送情報タブで郵便番号・都道府県・市区町村・番地を入力・保存でき、郵便番号入力時に住所自動補完を実行する。
  - レビュー: 配送情報タブで住所フォームを提供 ✅。郵便番号補完は `/api/checkout/postal-code` 経由 ✅。保存処理は `/api/profile` POST へ統合済みで、配送情報削除時は住所項目のみクリア ✅。
- **FR-ACCOUNT-005** `MUST`: 注文履歴タブでは過去の注文を一覧表示し、注文詳細への遷移を提供する。
  - レビュー: `/api/orders` と `/api/orders/[id]` を通じて本人注文一覧と詳細遷移を実装 ✅。custom auth cookie / Bearer token による認証取得も修正済み ✅。
- **FR-ACCOUNT-006** `SHOULD`: 顧客プロフィールの保存項目を拡張し、フリガナ・住所を含めた完全な顧客情報を管理できるようにする。
  - レビュー: 氏名・電話番号・フリガナ・住所フィールドを実装 ✅。保存先は `/api/profile` へ統合済み ✅。
- **FR-ACCOUNT-007** `MUST`: account ページからログアウトできる導線を提供し、ログアウト後は未ログイン状態の案内表示またはログインページ遷移で状態変化を明示する。
  - レビュー: account ページ内にログアウト導線を追加し、`/api/auth/logout` とクライアント状態更新を連動させる実装を追加済み ✅。
- **FR-ACCOUNT-008** `MUST`: 会員は「お問い合わせ」タブで自分の問い合わせ履歴を一覧表示し、スレッドを選ぶと管理者とのやり取りをチャット形式で確認でき、その場から返信できる。
  - レビュー: `AccountInquiries` コンポーネント＋ `/api/contact/threads`・`/api/contact/threads/[id]`・`/api/contact/threads/[id]/reply` を追加。`user_id` またはログイン中メール一致でスレッドを取得し、`contact_messages` を吹き出し表示、`channel='web'` で返信を追加する。

---

### 1.16 管理画面（ADMIN）— `GET /admin`

**概要**: 管理者・サポーターによる KPI・コンテンツ・注文・ユーザー管理。

#### アクセス制御

- **FR-ADMIN-001** `MUST`: RBAC（ロールベースアクセス制御）を実装し、`admin` ロールは全タブ、`supporter` ロールは ORDER タブのみにアクセス可能とする。
  - レビュー: `userRole` に基づき `visibleTabs` を `useMemo` で動的生成 ✅。`renderContent` 内でも `userRole !== 'admin'` を再チェックする二重防護あり ✅。`visibleTabs.length === 0` 時はアクセス不可ガードが機能 ✅。

#### KPI ダッシュボード

- **FR-ADMIN-002** `MUST`: KPI タブに売上・注文数・コンバージョン率・顧客指標などの主要指標を表示する。期間フィルタを提供し、日/週/月での集計を切り替えられる。
  - レビュー: `KpiSection` コンポーネント + `DateTimePicker` による期間フィルタを実装 ✅。`fetchKpi` は `/api/admin/kpi` を呼び出し、エラー時は `onRetry` コールバックでリトライ可能 ✅。admin ページ側の `periodFrom`/`periodTo` は ORDER タブ専用であり、KPI への期間フィルタは `KpiSection` 内部で管理 ✅。

#### コンテンツ管理

- **FR-ADMIN-003** `MUST`: NEWS タブでニュース記事の一覧・作成・編集・削除・ステータス変更（公開/下書き）を管理する。
  - レビュー: `NewsSection` コンポーネントで管理 ✅。`admin` ロールのみ "新規作成" ボタン表示 ✅。
- **FR-ADMIN-004** `MUST`: ITEM タブで商品の一覧・作成・編集・削除・SKU 単位の在庫管理を行う。
  - レビュー: `ItemSection` コンポーネントで管理 ✅。`admin` ロールのみ "新規作成" ボタン表示 ✅。
- **FR-ADMIN-005** `MUST`: LOOK タブでルックの一覧・作成・編集・削除・商品紐づけを管理する。
  - レビュー: `LookSection` コンポーネントで管理 ✅。`admin` ロールのみ "新規作成" ボタン表示 ✅。
- **FR-ADMIN-006** `MUST`: STOCKIST タブで店舗の一覧・作成・編集・削除・ステータス管理を行う。
  - レビュー: `StockistSection` コンポーネントで管理 ✅。`admin` ロールのみ "新規作成" ボタン表示 ✅。

#### ユーザー・注文管理

- **FR-ADMIN-007** `MUST`: USER タブで顧客一覧・検索・詳細閲覧・ロール変更を管理する。
  - レビュー: `UserSection` コンポーネントで管理 ✅。`admin` ロールのみアクセス可 ✅。
- **FR-ADMIN-008** `MUST`: ORDER タブで注文一覧・ステータスフィルタ・キーワード検索・ページネーション・CSV エクスポートを提供する。
  - レビュー: ページネーション（pageSize=20）はサーバーサイド ✅。キーワード検索・ステータスフィルタはクライアントサイド（現在ページの20件のみ対象）❌ 全件検索不可。CSV エクスポートは表示中の "決済完了" ステータスのみ対象（全件エクスポートではない点に注意）。注文操作はキャンセル（`POST /api/admin/orders/:id/status`）と全額返金（`POST /api/admin/orders/:id/refund`）のみ実装 ✅。期間フィルタは `periodFrom > periodTo` の不正値バリデーション付き ✅。
- **FR-ADMIN-009** `MUST`: CONTACT タブで問い合わせスレッドの一覧・ステータス/種別フィルタ・検索・ページネーションを提供し、スレッド詳細（名前・メール・種別・件名・注文番号・チャット履歴）を表示、返信テンプレートを選択して返信・ステータス変更ができる。返信テンプレートは MANAGE 上で作成・編集・削除（CRUD）できる。`admin` と `supporter` がアクセス可能。
  - レビュー: `ContactSection` コンポーネント＋ `/api/admin/contact`（一覧）・`/api/admin/contact/[id]`（詳細/ステータス）・`/api/admin/contact/[id]/reply`（返信＋顧客メール）・`/api/admin/contact/templates`（テンプレ CRUD）を追加。すべて `authorizeAdminPermission('admin.contact.read'|'.manage')` で保護し `logAudit` で監査記録。権限は移行 059 で admin/supporter に付与。

---

### 1.17 プライバシーポリシーページ（PRIVACY）— `GET /privacy`

- **FR-PRIVACY-001** `MUST`: プライバシーポリシーの内容を静的ページとして表示する。
  - レビュー: `PrivacyPage` RSC として実装 ✅。`h1` "Privacy Policy"、各セクションを `<section>` + `<h2>` で構造化 ✅。
- **FR-PRIVACY-002** `SHOULD`: `generateMetadata` で `title` / `description` を設定する。
  - レビュー: `generateMetadata` を実装し、title / description / Open Graph を設定済み ✅。

---

### 1.18 利用規約ページ（TERMS）— `GET /terms`

- **FR-TERMS-001** `MUST`: 利用規約の内容を静的ページとして表示する。
  - レビュー: `TermsPage` RSC として実装 ✅。`h1` "Terms of Service"、利用規約コンテンツを `<section>` + `<h2>` で構造化 ✅。
- **FR-TERMS-002** `SHOULD`: `generateMetadata` で `title` / `description` を設定する。
  - レビュー: `generateMetadata` を実装し、title / description / Open Graph を設定済み ✅。

---

### 1.19 検索ページ（SEARCH）— `GET /search`

- **FR-SEARCH-001** `MUST`: `/search?q=` ページは入力キーワードを URL パラメータとして受け取り、商品・ルック・ニュースを横断して検索し、種別タブで結果を切り替えられるようにする。
  - レビュー: `src/app/search/page.tsx` と `SearchPageClient` を実装 ✅。`q` / `tab` を URL 同期し、ALL / ITEM / LOOK / NEWS タブで表示切替可能 ✅。
- **FR-SEARCH-002** `MUST`: ヘッダーの検索アイコンから検索ページへ遷移でき、`/?q=` ではホーム上で即時プレビューを表示する。
  - レビュー: `Header` の検索アイコンは `/search` へ遷移 ✅。ホームでは `SearchHomePreview` が `/?q=` を検知して即時プレビューを表示 ✅。
- **FR-SEARCH-003** `MUST`: 商品・ルック・ニュース各エンティティへの検索と、結果内の一致箇所ハイライトを提供する。
  - レビュー: `/api/search` と `/api/suggest` を実装 ✅。UI は `mark` で一致箇所をハイライト表示 ✅。
- **FR-SEARCH-004** `MUST`: 検索結果ゼロの場合は「○○ の検索結果はありません」メッセージと人気商品の提案を表示する。
  - レビュー: ゼロ件時に検索語付きメッセージと POPULAR ITEMS セクションを表示 ✅。
- **FR-SEARCH-005** `MUST`: 検索履歴を `localStorage` に保持し、再訪時にサジェストとして表示する。
  - レビュー: `search.history` を保存し、検索ページ再訪時に履歴候補を表示 ✅。入力中は `/api/suggest` による候補も表示 ✅。

---

## 5. 非機能要件

> **IDプレフィックス凡例**
> `NFR-PERF` パフォーマンス / `NFR-SCALE` スケーラビリティ / `NFR-AVAIL` 可用性 / `NFR-SEC` セキュリティ / `NFR-SEO` SEO / `NFR-I18N` 国際化 / `NFR-A11Y` アクセシビリティ / `NFR-LOG` ロギング・監視 / `NFR-DR` DR・バックアップ / `NFR-COST` コスト管理 / `NFR-COMP` コンプライアンス
> `AC-*` 各カテゴリの受け入れ基準

### 5.1 パフォーマンス

- **NFR-PERF-001**: ファーストバイト短縮、LCP/CLS 改善、ページロード高速化を達成する。
- **NFR-PERF-002**: 99 パーセンタイルでも応答時間を低く保つ（目標: ページ表示 < 2s）。
- **NFR-PERF-003**: 目標指標 — LCP < 2.5s、FID < 100ms、CLS < 0.1（モバイルファースト）。
- **NFR-PERF-004**: ページ種別ごとのベンチマークを設定する — トップ / カテゴリ / 商品 / カート / Checkout の 90/95/99 パーセンタイルを計測して閾値を決定する。
- **NFR-PERF-005**: フロントエンド最適化 — 画像の遅延読み込み（lazy loading）、プレロード・プリフェッチの活用、Critical CSS 抽出を実施する。
- **NFR-PERF-006**: アセット配信 — CDN を用いた静的アセット配信、HTTP/2 または HTTP/3 の利用、Brotli/Gzip 圧縮を行う。
- **NFR-PERF-007**: キャッシュ戦略 — ISR/SSG/SSR の使い分け、エッジキャッシュ（CDN）TTL の設計、API レスポンスの Cache-Control 設定を行う。
- **NFR-PERF-008**: RUM（Real User Monitoring）と合成監視（Synthetic）を組み合わせてユーザー体験を定量化する。合成監視は 5 分間隔で実施する。
- **AC-PERF-001**: 受け入れ基準 — 95 パーセンタイルのページ表示時間が 2.5s 未満であること。

### 5.2 スケーラビリティ

- **NFR-SCALE-001**: ピーク時（プロモーション / セール）にスケール可能なアーキテクチャとする。
- **NFR-SCALE-002**: ステートレスアーキテクチャとし、セッションは外部ストア（Redis / DynamoDB 等）に保存する。
- **NFR-SCALE-003**: 注文処理や在庫同期はキュー（RabbitMQ / SQS / Pub/Sub）で非同期化し、リトライ / デッドレターを実装する。
- **NFR-SCALE-004**: トラフィックとジョブ負荷に基づくオートスケールポリシーを定義する（CPU / RPS / キュー長）。

### 5.3 可用性・運用

- **NFR-AVAIL-001**: SLA 目標: 99.9%（確定）。
- **NFR-AVAIL-002**: 自動復旧・監視・アラートを実装する（エラー率、レイテンシ、ジョブ失敗）。
- **NFR-AVAIL-003**: 目標稼働率とエラーバジェットを定義し、主要サービスごとの SLO を設定する。
- **NFR-AVAIL-004**: 冗長化設計 — 複数 AZ / リージョンでの冗長化、DB はリードレプリカとフェイルオーバー構成とする。
- **NFR-AVAIL-005**: RPO = 1 時間、RTO = 2 時間を目標に定義し、定期リストア検証を実施する。
- **NFR-AVAIL-006**: インシデント対応ランブック、ポストモーテム文化、定期的なフェイルオーバーテストを整備する。
- **AC-AVAIL-001**: 受け入れ基準 — 月間稼働率が 99.9% 以上であること。

### 5.4 セキュリティ

- **NFR-SEC-001**: TLS 必須、HSTS 設定を行う。
- **NFR-SEC-002**: 決済情報は PCI 準拠（トークン化）とする。
- **NFR-SEC-003**: 入力検証と XSS/CSRF 対策（CSP 導入含む）を実施する。
- **NFR-SEC-004**: パスワードハッシュ化（Argon2 / Bcrypt）を使用する。
- **NFR-SEC-005**: 権限管理と監査ログを整備する。
- **NFR-SEC-006**: VPC 分離、最小権限のセキュリティグループ設計を行う。
- **NFR-SEC-007**: パラメータ化クエリで SQL インジェクションを防止する。
- **NFR-SEC-008**: 強力なパスワードポリシー、オプションで SAML / OAuth SSO、RBAC を実装する。
- **NFR-SEC-009**: KMS / Secrets Manager で鍵・トークンを管理し、ハードコーディングを禁止する。
- **NFR-SEC-010**: 保存データは必要に応じて暗号化（静止・転送中）し、個人情報はマスキングする。
- **NFR-SEC-011**: 監査ログを保持し改ざん防止、セキュリティイベントの SIEM 統合を行う。
- **NFR-SEC-012**: 自動化された脆弱性スキャンを月次で実行する。ペネトレーションテストは 4 か月に 1 回（年 3 回相当）実施する。
- **AC-SEC-001**: 受け入れ基準 — 重大な脆弱性は発見後 30 日以内に修正すること。

### 5.5 SEO / インデックス

- **NFR-SEO-001**: 商品ページの構造化データ（Schema.org: 商品・在庫・価格・BreadcrumbList）に対応する。
- **NFR-SEO-002**: SSR / プリレンダでクローラービリティを確保する。
- **NFR-SEO-003**: メタ情報（title / description）、OG タグ、canonical を適切に設定する。
- **NFR-SEO-004**: URL 設計、robots.txt、サイトマップ自動生成を整備する。
- **NFR-SEO-005**: Core Web Vitals を改善する施策を優先する。

### 5.6 国際化（i18n）・地域対応

- **NFR-I18N-001**: 多言語（翻訳管理）・多通貨・ローカライズされた配送オプションをサポートする（日本向けが最優先、欧州対応は WANT）。
- **NFR-I18N-002**: 日付・数字・通貨表現のローカライズを行う。
- **NFR-I18N-003**: 言語 / 通貨ごとのコンテンツ戦略（地域別コンテンツ、価格差、配送条件の管理）を定義する。
- **NFR-I18N-004**: 翻訳管理ワークフロー（Crowdin 等の外部サービス連携）と翻訳のバージョン管理を導入する。
- **NFR-I18N-005**: 地域ごとの税計算と配送可否のルールエンジンを実装する。

### 5.7 アクセシビリティ

- **NFR-A11Y-001**: WCAG 2.1 AA 準拠を最低ラインとする。
- **NFR-A11Y-002**: キーボード操作・スクリーンリーダー対応・色彩コントラストを確保する。
- **NFR-A11Y-003**: 主要テンプレートの自動・手動チェックを組み合わせる。
- **NFR-A11Y-004**: スクリーンリーダーとキーボードでの E2E テスト、色覚多様性チェックを実施する。
- **NFR-A11Y-005**: alt テキスト必須、フォームのラベル付与、フォーカス管理を行う。
- **AC-A11Y-001**: 受け入れ基準 — 主要テンプレートで自動チェックのエラーがゼロであること。

### 5.8 ロギング・監視・アラート

- **NFR-LOG-001**: メトリクス（レイテンシ、エラー率、スループット、決済失敗率、カート放棄率）を可視化する。
- **NFR-LOG-002**: 構造化ログ（JSON）と OpenTelemetry による分散トレーシングを実装する。
- **NFR-LOG-003**: SLO に基づくアラートポリシーを定義する。通知先は Slack（運用通知）、オンコールは管理者の Slack アカウントで対応する。
- **NFR-LOG-004**: ログ保存期間 — 高解像度ログ（詳細）を 30 日保存、低解像度ログ（集計 / アーカイブ）を 1 年保存する。

### 5.9 バックアップ・DR

- **NFR-DR-001**: DB は増分バックアップ（毎 1 時間）、フルバックアップは日次で取得する。
- **NFR-DR-002**: ユーザーアップロードは冗長なオブジェクトストレージに保存する（バージョニング有効）。
- **NFR-DR-003**: 主要リージョン障害時のフェイルオーバー手順を整備し、定期的な復旧演習を実施する。

### 5.10 運用コスト管理

- **NFR-COST-001**: クラウドリソースのタグ付けとコストアロケーションを行う。
- **NFR-COST-002**: スケール / 予約インスタンスやスポット利用によるコスト最適化を検討する。

### 5.11 コンプライアンス・法令対応

- **NFR-COMP-001**: PCI DSS 準拠とする（カード情報はトークン化してプロバイダに委託）。
- **NFR-COMP-002**: GDPR / CCPA 等該当法準拠、データアクセス要求・消去フローを実装する（GDPR は必須、EU 向け）。
- **NFR-COMP-003**: 法令に従ったログ・領収書の保管期間と取り扱いルールを定義する。


## 6. 統合要件

> **IDプレフィックス凡例**
> `INT-NNN` 統合優先度リスト / `INT-PAY-NNN` 決済 / `INT-SHIP-NNN` 配送 / `INT-ERP-NNN` ERP・在庫 / `INT-TAX-NNN` 税エンジン / `INT-WHK-NNN` Webhook / `INT-DATA-NNN` データ・分析

### 6.1 外部連携優先度

| ID | 統合対象 | 優先度 | 確定プロバイダ / 候補 |
|----|----------|--------|-----------------------|
| **INT-001** | 決済 | 必須・最優先 | Stripe（確定） |
| **INT-002** | DB・認証 | 高 | Supabase（Postgres + Auth）（確定） |
| **INT-003** | ホスティング・CDN | 高 | Vercel（Next.js 向け）+ エッジ CDN<br>CDN 方針: 当面は無料枠（Cloudflare Free / Vercel エッジ）を活用 — 公開対象が日本のみのためコスト最適化を優先 |
| **INT-004** | 検索・パーソナライズ | MVP 必須 | Supabase フルテキスト検索（一次）→ Meilisearch（段階導入）、パーソナライズはルールベース実装から開始 |
| **INT-005** | トランザクションメール | 高 | SendGrid / Mailgun（注文・通知用。マーケティングメールは現フェーズ不要） |
| **INT-006** | 分析 | 中 | Google Analytics 4 + BigQuery |
| **INT-007** | 配送・ロジスティクス | 低 | 外部 3PL 委託（将来 Shippo 等 API 連携） |
| **INT-008** | CRM・MA | 低 | HubSpot 等（要件確定後に導入） |
| **INT-009** | PIM・ERP | 要件次第 | Akeneo 等（SKU 増加・複雑化後） |

- **INT-010**: まず最小構成でローンチし、運用優先度に応じて Meilisearch・BI・PIM を順次導入する。

## 7. 運用・サポート要件

> **IDプレフィックス凡例**
> `OPS-NNN` 運用全般 / `OPS-CICD-NNN` CI/CD / `OPS-ENV-NNN` 環境管理 / `OPS-MON-NNN` 監視 / `OPS-SLA-NNN` SLA / `OPS-CHK-NNN` 運用チェックリスト

- **OPS-001**: バックアップ戦略（DB・メディア）を定義し、定期リストア検証を実施する。
- **OPS-002**: リリース手順（ステージング → 本番）とロールバックプランを整備する。
- **OPS-003**: サポート体制（問い合わせ対応 SLA、チャット / メール連携）を定義する。
- **OPS-004**: 定期セキュリティ診断（脆弱性スキャン、依存性チェック）を実施する。

## 8. 法務・コンプライアンス

> **IDプレフィックス凡例**  `LEGAL-NNN`

- **LEGAL-001**: プライバシーポリシー・利用規約を整備する。
- **LEGAL-002**: 個人情報保護（データ保持ポリシー、同意管理）の仕組みを実装する。
- **LEGAL-003**: 返品 / 交換ポリシーと表示義務（国別要件に対応）を実装する。
- **LEGAL-004**: 税務・輸出入規制の遵守（国際販売時）を確認する。

## 9. モニタリング・テスト

> **IDプレフィックス凡例**  `QA-NNN` テスト品質 / `QA-INT-NNN` 統合テスト

- **QA-001**: 主要購入フローの E2E テストと CI パイプラインを整備する。
- **QA-002**: ログと指標（エラー率、注文処理時間、決済失敗率）を収集・可視化する。
- **QA-003**: A/B テスト基盤（UI・プロモーション効果検証）を実装する。
- **QA-INT-001**: 決済・配送を含む E2E テストを CI に組み込み定期実行する。
- **QA-INT-002**: 外部 API をモック / スタブ化したテスト環境を提供する。
- **QA-INT-003**: ピーク想定の負荷試験と性能限界テストを実施する。

## 10. 優先度・マイルストーン

> **IDプレフィックス凡例**  `MS-M1-NNN` / `MS-M2-NNN` / `MS-M3-NNN` マイルストーン / `PRIO-NNN` 優先度判断

### 10.1 マイルストーン

| ID | マイルストーン | スコープ |
|----|----------------|----------|
| **MS-M1-001** | M1（MVP） | 商品一覧・商品詳細・カート・チェックアウト・決済連携・管理画面の基本 |
| **MS-M2-001** | M2 | 会員機能・ウィッシュリスト・プロモーション管理 |
| **MS-M3-001** | M3 | パーソナライズ・分析と最適化・多言語化・多通貨 |

### 10.2 優先度判断

- **PRIO-001**: 日本向けの多言語・多通貨対応 — 高（最優先）。
- **PRIO-002**: 欧州対応 — WANT（要望だが MUST ではない）。
- **PRIO-003**: ブランド表現・購入導線・モバイル・セキュリティ等 — 高。

## 11. 参考 / 意思決定ポイント

> **IDプレフィックス凡例**  `DEC-NNN` 意思決定ポイント

- **DEC-001**: ヘッドレス化（フロント独立） vs モノリシック — 速度・開発運用コストのバランスを検討する。
- **DEC-002**: 商品データは PIM を導入するか否か — SKU 数・チャネル数による。
- **DEC-003**: 決済・配送のサードパーティ選定は手数料とサポート地域を重視する。

> 詳細な統合・運用要件は「12. 統合・運用要件（詳細）」を参照。

## 13. デザイン要件（ブランド: Le Fil des Heures）

> **IDプレフィックス凡例**
> `DES-TYPO-NNN` タイポグラフィ / `DES-COLOR-NNN` カラー / `DES-LAYOUT-NNN` レイアウト / `DES-UI-NNN` UIコンポーネント / `DES-VIS-NNN` ビジュアル言語 / `DES-PRICE-NNN` 価格表示 / `DES-UX-NNN` マイクロインタラクション / `DES-BRAND-NNN` ブランディング体験 / `DES-A11Y-NNN` アクセシビリティ配慮 / `DES-IMPL-NNN` 実装ガイド / `AC-DES-NNN` デザイン受け入れ基準

ブランドコンテキスト: 「Le Fil des Heures（ル フィル デ ザール）」は、ミニマル × モードの交差から生まれるタイムレスな日常着を提供するコンテンポラリーブランドです。価格帯はミドル〜ミドルハイ（約 ¥20,000〜¥80,000）。以下はブランド表現を EC 上で一貫して担保するためのデザイン要件です。

### 13.1 タイポグラフィ

- **DES-TYPO-001**: ブランド見出しフォントは `Didot`（必須） — ロゴ・H1/H2 の見出しに使用し、縦線の繊細さと高コントラストを活かす。
- **DES-TYPO-002**: 本文フォント（UI 用）は可読性の高いサンセリフ（例: `Inter`、`Noto Sans JP`）を組み合わせ、言語切替時の日本語表示は `Noto Sans JP` を併用する。
- **DES-TYPO-003**: フォント運用 — 見出しは Didot のサブセットをプリロードし、`font-display: swap` を設定して FOUT 対策を行う。
- **DES-TYPO-004**: レスポンシブ用のタイポグラフィスケールを定義する（H1/H2/H3/Body/Small の rem 値）。

### 13.2 カラーパレット

- **DES-COLOR-001**: Absolute Black `#000000` — ロゴ、プライマリ CTA、見出し、ボーダー強調。
- **DES-COLOR-002**: Graphite Grey `#474747` — サブテキスト、アイコン、セカンダリ UI 要素。
- **DES-COLOR-003**: Sand Beige `#d5d0c9` — バックグラウンドアクセント、カードの背景、区切り線。
- **DES-COLOR-004**: Optical White `#ffffff` — ページ背景、カード、テキストエリア。
- **DES-COLOR-005**: カラー運用 — CSS 変数（`--brand-black`、`--brand-graphite`、`--brand-sand`、`--brand-white`）でトークン化し、ハードコーディングを禁止する。

### 13.3 レイアウト原則

- **DES-LAYOUT-001**: モバイルファーストで設計し、デスクトップは拡張として定義する。
- **DES-LAYOUT-002**: 余白と間隔は統一されたスペーシングスケール（4px 基準）を用い、コンテンツに呼吸感を持たせる。
- **DES-LAYOUT-003**: グリッドシステム — 商品一覧はモバイル 2 列 / デスクトップ 3〜4 列とし、画像は縦長（4:5）を基本とする。

### 13.4 UI コンポーネント（ブランド表現）

- **DES-UI-001**: プライマリボタン（購入系）— 黒背景（`#000`）+ 白テキスト、角は中程度の丸み（4〜8px）。
- **DES-UI-002**: セカンダリボタン（ナビ等）— 白背景 + 黒境界線 + 黒テキスト、ホバーで Graphite Grey にフェード。
- **DES-UI-003**: CTA は視覚的に優先度が高く、ファーストビューや PDP で常時アクセス可能にする（フローティング CTA 等）。
- **DES-UI-004**: 入力 / フォーム — シンプルなボーダー、プレースホルダは Graphite Grey、エラーメッセージは控えめな赤（可読性重視）。
- **DES-UI-005**: カード — 白 / Beige の二層表現。影は最小限にしてフラットで上品な質感を保つ。

### 13.5 画像・ビジュアル言語

- **DES-VIS-001**: 写真はモノクローム に近いトーン、またはニュートラルな色味（サンドトーンの背景）で素材感と構築的ラインを強調する。人物は自然光で非演出寄り。
- **DES-VIS-002**: テクスチャ（糸目、ニットの表情）を見せるクローズアップを必ず含める。
- **DES-VIS-003**: アスペクト比 — 商品メインは 4:5（縦長）推奨、ギャラリーに 1:1 / 3:4 も併用。

### 13.6 価格表示・商品情報

- **DES-PRICE-001**: 価格表示は控えめで上品に。セール時は旧価格を小さく表示し、新価格は太字で強調する。
- **DES-PRICE-002**: 素材・ケア情報は PDP 内でアイコンと短文を組み合わせて視覚的に明確に表示する。

### 13.7 マイクロインタラクション・トーン

- **DES-UX-001**: アニメーションは控えめ（ease-in-out、150〜250ms）、ホバーでの微かなリフトやフェードのみ使用する。
- **DES-UX-002**: ローディング — プレースホルダは単色ベースのシンプルプレースホルダを採用し、高級感を損なわない。

### 13.8 ブランディング体験（梱包・メール等）

- **DES-BRAND-001**: 梱包 — Absolute Black のロゴ（Didot）を Optical White のボックスまたは Sand Beige の包装紙で表現。タグやインボイスは最小限の情報で上品に仕上げる。
- **DES-BRAND-002**: メール — 件名は短くエレガントに。HTML メールはブランドカラーと Didot の見出しを使用し、本文はサンセリフで可読性を確保する。

### 13.9 アクセシビリティと可読性（Didot 特有の配慮）

- **DES-A11Y-001**: Didot は見出し専用とし、本文にはサンセリフを使用する（可読性確保のため）。
- **DES-A11Y-002**: コントラスト — 主要テキストは最低でも WCAG AA（重要コンテンツは AAA）を満たす。
- **DES-A11Y-003**: 小さいサイズで Didot を使用する場合は字間（letter-spacing）を広げて視認性を補完する。

### 13.10 実装ガイド（CSS 変数）

- **DES-IMPL-001**: 以下の CSS 変数を共通トークンとして定義し、ハードコーディングを禁止する。

```css
:root {
  --brand-black: #000000;
  --brand-graphite: #474747;
  --brand-sand: #d5d0c9;
  --brand-white: #ffffff;
  --font-heading: 'Didot', serif;
  --font-body: 'Inter', 'Noto Sans JP', sans-serif;
}
```

### 13.11 受け入れ基準（デザイン QA）

- **AC-DES-001**: ホーム・商品・チェックアウトの主要テンプレートでブランドカラーが一貫して適用されていること。
- **AC-DES-002**: Didot を見出しに使用し、本文はサンセリフで読みやすいこと（自動チェックと目視確認）。
- **AC-DES-003**: 主要 CTA のコントラスト比が WCAG 基準を満たしていること（ツールでの数値検証）。

---

## 14. 技術要件（コア & 推奨）

> **IDプレフィックス凡例**
> `TECH-CORE-NNN` コアスタック / `TECH-LIB-NNN` 推奨ライブラリ / `TECH-INFRA-NNN` インフラ / `TECH-3P-NNN` サードパーティ / `TECH-OPT-NNN` 追加検討 / `AC-TECH-NNN` 技術受け入れ基準

基本方針: フロントは React / TypeScript を中心に、サーバは Node.js ベースで、DB は Supabase（Postgres）を採用する前提で、開発生産性・運用性・スケーラビリティを担保する推奨技術を列挙します。

### 14.1 コアスタック（既定）

- **TECH-CORE-001**: フロントエンド — React + TypeScript。
- **TECH-CORE-002**: フレームワーク — Next.js（既存ワークスペースに合わせ推奨）。
- **TECH-CORE-003**: バックエンドランタイム / API — Node.js（Next API routes / serverless functions）。
- **TECH-CORE-004**: DB・認証 — Supabase（Postgres + Auth）。

### 14.2 推奨ライブラリ・ツール

- **TECH-LIB-001**: データフェッチ / キャッシュ — `@tanstack/react-query`（データ同期・キャッシュ戦略が容易）。
- **TECH-LIB-002**: フォーム — `react-hook-form`（パフォーマンス良好・バリデーション統合容易）。
- **TECH-LIB-003**: スタイル — `Tailwind CSS` または CSS Modules（ブランドトークン反映が容易）。
- **TECH-LIB-004**: 画像最適化 — Next/Image（Next.js 使用時）または Cloudinary / imgix（CDN + 最適化）。
- **TECH-LIB-005**: 検索 — Meilisearch（セルフホスト / 低レイテンシ）または Algolia（マネージド・高機能）。
- **TECH-LIB-006**: 決済 — Stripe（サブスクリプション / 一括払い / Apple Pay 等対応）。
- **TECH-LIB-007**: バックグラウンドジョブ / キュー — BullMQ + Redis（リトライ・デッドレター管理）。
- **TECH-LIB-008**: キャッシュ / セッション — Redis（セッション、ロック、レート制御）。
- **TECH-LIB-009**: E2E テスト — Playwright（フル機能・クロスブラウザ）。
- **TECH-LIB-010**: 単体 / 統合テスト — Jest + Testing Library / Vitest。
- **TECH-LIB-011**: コンポーネントカタログ — Storybook（デザイン → 実装の整合に有用）。
- **TECH-LIB-012**: Lint / Format — ESLint + Prettier + TypeScript ESLint。
- **TECH-LIB-013**: CI/CD — GitHub Actions（Lint / Tests / Build / Deploy 自動化）。
- **TECH-LIB-014**: モニタリング / エラートラッキング — Sentry + OpenTelemetry（分散トレーシング）。
- **TECH-LIB-015**: ログ / 可観測性 — 構造化ログ（JSON）→ SIEM または ELK / CloudWatch / Datadog。
- **TECH-LIB-016**: 管理画面認可 — RBAC 実装、SSO（SAML / OAuth）は必要に応じて導入。

### 14.3 インフラ・運用

- **TECH-INFRA-001**: ホスティング — Vercel（Next.js 最適）または AWS（ECS）/ GCP（Cloud Run）。
- **TECH-INFRA-002**: CDN — Cloudflare / Fastly（静的資産と画像のエッジ配信）。
- **TECH-INFRA-003**: Secrets 管理 — AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault。
- **TECH-INFRA-004**: バックアップ — DB スナップショット + オブジェクトストレージのバージョニング（S3 互換）。

### 14.4 サードパーティ（運用用途）

- **TECH-3P-001**: メール — SendGrid / Mailgun（トランザクション・マーケティング）。
- **TECH-3P-002**: 分析 — GA4 + BigQuery（イベント収集 → DWH）。
- **TECH-3P-003**: タックス — TaxJar / Avalara（国際販売の税計算自動化）。

### 14.5 追加検討技術（要件次第）

- **TECH-OPT-001**: フロント分離（ヘッドレス）を強く望む場合 — Headless CMS（Contentful / Sanity） + Next.js。
- **TECH-OPT-002**: 高速全文検索が最優先なら Algolia を採用（有料だが速度 / 機能優位）。
- **TECH-OPT-003**: フルマネージドワークフローを好む場合 — Supabase + Vercel の組合せで最小構成運用可能。

### 14.6 受け入れ基準（技術面）

- **AC-TECH-001**: 開発環境 — `npm run dev` でローカル起動可能かつ型チェックエラーがゼロであること。
- **AC-TECH-002**: CI — プルリクエストで Lint / Unit / E2E が通過すること。
- **AC-TECH-003**: 本番デプロイ — Canary または Blue-Green でロールアウトでき、障害時に自動ロールバックが動作すること。

---

## 付録D: 画面ごとの詳細ワイヤー（文章版）

> **IDプレフィックス凡例**
> `WF-HOME-NNN` トップページ / `WF-ITEM-ALL-NNN` カテゴリ一覧 / `WF-ITEM-DETAIL-NNN` 商品詳細 / `WF-CART-NNN` カート / `WF-CHECKOUT-NNN` チェックアウト / `WF-ACCOUNT-NNN` マイページ / `WF-ADMIN-NNN` 管理画面 / `WF-COMMON-NNN` 共通

以下は主要画面について、要素・レイアウト・動作・受け入れ基準を記載した文章版ワイヤーです。モバイル優先で記載し、デスクトップ差分を補足します。

### D.1 トップページ

- **WF-HOME-001**: 目的 — ブランド訴求と導線（カテゴリ / コレクション / キャンペーン）への誘導。
- **WF-HOME-002**: ヘッダー（モバイル）— ハンバーガー（カテゴリ）、ロゴ（中央）、検索・カート・アカウントアイコン。
- **WF-HOME-003**: ヒーローセクション — フル幅スライダー（CTA ボタン）、アクセシブルな画像代替テキスト必須。
- **WF-HOME-004**: コレクションリンク — グリッドまたはカード（画像 + ラベル）。
- **WF-HOME-005**: 注目商品カルーセル — 横スワイプ可能、タップで商品ページへ遷移。
- **WF-HOME-006**: フッター — サイトマップ、カスタマーサポートリンク、SNS。
- **WF-HOME-007**: キー動作 — スワイプでカルーセル移動、遅延画像読み込み。
- **AC-WF-HOME-001**: 受け入れ基準 — ファーストビューに CTA があり、ヒーローから目的ページへ 2 タップ以内で遷移できること。

### D.2 カテゴリ一覧ページ

- **WF-ITEM-ALL-001**: 目的 — 絞り込みと商品ブラウズの効率化。
- **WF-ITEM-ALL-002**: スタンディング検索バー（常時表示またはスクロールで固定）。
- **WF-ITEM-ALL-003**: フィルタドロワー — サイズ / カラー / 価格 / 在庫（複数選択可）。
- **WF-ITEM-ALL-004**: 商品グリッド — 2 列、商品カードに価格・バッジ（SALE/NEW）表示。
- **WF-ITEM-ALL-005**: キー動作 — フィルタ適用は即時かつ非同期更新（ローディングインジケータ表示）、無制限スクロールまたはページネーションは選択可能。
- **AC-WF-ITEM-ALL-001**: 受け入れ基準 — フィルタ適用後の結果表示が 2 秒以内であること。絞り込み条件が URL パラメータで共有可能であること。

### D.3 商品詳細ページ（PDP）

- **WF-ITEM-DETAIL-001**: 目的 — 購入意思決定を支援し、バリエーション選択を容易にする。
- **WF-ITEM-DETAIL-002**: 画像ギャラリー — ピンチズーム、スワイプ対応。
- **WF-ITEM-DETAIL-003**: タイトル・ブランド・価格（割引ラベル）の表示。
- **WF-ITEM-DETAIL-004**: バリエーション選択（サイズ / カラー）— 選択不可のオプションは非活性表示とツールチップで説明。
- **WF-ITEM-DETAIL-005**: 在庫表示（在庫あり / 残りわずか / 入荷予定）。
- **WF-ITEM-DETAIL-006**: サイズガイドリンク（モーダルで表示）。
- **WF-ITEM-DETAIL-007**: 配送の概算（郵便番号入力で変化）。
- **WF-ITEM-DETAIL-008**: CTA — カートに追加（フローティングする設計を推奨）。
- **WF-ITEM-DETAIL-009**: 関連商品・コーデ提案セクション。
- **WF-ITEM-DETAIL-010**: キー動作 — バリエーション選択で価格や在庫が即時更新、画像はバリアントに紐づく切替。
- **AC-WF-ITEM-DETAIL-001**: 受け入れ基準 — 主要バリエーション選択から カート追加までが 3 ステップ以内で完了すること。

### D.4 カートページ

- **WF-CART-001**: 目的 — 注文確定前の最終確認とコンバージョン促進。
- **WF-CART-002**: 商品一覧（画像、タイトル、バリエーション、数量、小計）。
- **WF-CART-003**: クーポン入力欄、送料見積り（郵便番号入力）。
- **WF-CART-004**: 小計 / 税 / 送料の明細と合計（固定フッターに合計と「チェックアウトへ」ボタン）。
- **WF-CART-005**: 推奨商品（クロスセル）を控えめに表示。
- **WF-CART-006**: キー動作 — 数量変更は即時計算（Undo UX）、在庫不足時は代替提案。
- **AC-WF-CART-001**: 受け入れ基準 — 合計金額と適用割引が明示されていること。チェックアウトボタンは常に表示されること。

### D.5 チェックアウト（多段ステップ）

- **WF-CHECKOUT-001**: 目的 — 支払い完了までの摩擦を最小化する。
- **WF-CHECKOUT-002**: ステップ構成 — 1) 配送先 → 2) 配送方法 → 3) 支払い → 4) 確認。
- **WF-CHECKOUT-003**: ステップインジケータ（現在位置を明示）。
- **WF-CHECKOUT-004**: 住所入力補助（オートコンプリート、住所帳の呼び出し）。
- **WF-CHECKOUT-009**: ログイン済み時は account の保存済み配送情報を配送先フォーム初期値として自動反映する。
- **WF-CHECKOUT-005**: 配送方法はコストと到着目安を明示。
- **WF-CHECKOUT-006**: 支払いは外部決済・カードトークン入力をサポート。
- **WF-CHECKOUT-007**: 注文確認で最終金額（税・送料・割引）を必ず表示。
- **WF-CHECKOUT-008**: キー動作 — バック操作でデータ保持、必要最小限の必須項目のみ要求（ゲスト購入対応）。
- **AC-WF-CHECKOUT-001**: 受け入れ基準 — E2E テストでゲスト購入フローが成功すること。支払いプロバイダ統合で決済が確定できること。

### D.6 マイページ（アカウント）

- **WF-ACCOUNT-001**: 目的 — 顧客の自己管理（プロフィール確認、配送情報管理、注文確認、サイズプロファイル）。
- **WF-ACCOUNT-002**: 主なセクション — プロフィール、配送情報、注文履歴（ステータスリンク）、ウィッシュリスト、クーポン履歴。
- **AC-WF-ACCOUNT-001**: 受け入れ基準 — 注文の詳細ページで追跡番号とステータスが確認できること。

### D.7 管理画面（ダッシュボード / 商品エディタ）

- **WF-ADMIN-001**: ダッシュボード — 速報（売上、注文数、在庫警告）、最近の注文件数、アクティビティログ。
- **WF-ADMIN-002**: 商品エディタ — 基本情報、バリアント（SKU）管理、メディアアップロード（ドラッグ & ドロップ）、プレビュー。
- **WF-ADMIN-003**: バルク操作 — CSV インポートとプレビュー、バリデーションエラーの返却。
- **AC-WF-ADMIN-001**: 受け入れ基準 — 商品登録後に公開状態でフロントに表示されるまでのパイプラインが CI でテストされること。

### D.8 モバイル / デスクトップ差分

- **WF-COMMON-001**: ヘッダー — デスクトップはグローバルナビ + 検索、モバイルはハンバーガー / ドロワー。
- **WF-COMMON-002**: 商品グリッド — デスクトップは 4 列 / 3 列、モバイルは 2 列。
- **WF-COMMON-003**: PDP — デスクトップはサイドにサムネイル / 詳細、モバイルは縦積みで CTA を常設。
- **WF-COMMON-004**: チェックアウト — デスクトップはサイドで注文要約、モバイルはステップ式フルスクリーン。

### D.9 アクセシビリティ・国際化考慮（UI 面）

- **WF-COMMON-005**: フォーカスの可視化、キーボード操作で到達可能な全インタラクションを実装する。
- **WF-COMMON-006**: 画像 alt、ラベル、リンクテキストは非依存テキストを使用する。
- **WF-COMMON-007**: 言語切替はユーザーコンテキストを保持して行う（通貨と配送条件の変化を明示）。


## 12. 統合・運用要件（詳細）

以下は、外部連携と日常運用に関する要件・設計指針です。実装時は担当部署と SLA やデータ保管ポリシーを確定してください。

### 12.1 決済連携

- **INT-PAY-001**: 対応決済 — 主要クレジットカード、Apple Pay、Google Pay、PayPal、地域別ローカル決済（Konbini、Alipay 等）。
- **INT-PAY-002**: セキュリティ — カード情報は自社で保持せずトークン化（PCI DSS 準拠）。
- **INT-PAY-003**: リトライとエラー処理 — 一時的失敗は指数バックオフで再試行、永続失敗は顧客通知とオペレーター通知。
- **INT-PAY-004**: 返金処理 — 管理画面からの部分 / 全額返金を API で反映し、会計連携を行う。
- **INT-PAY-005**: ロギング — 決済イベントは不可変ログ（トランザクション ID、ステータス、金額）を保存。

### 12.2 配送・フルフィルメント連携

- **INT-SHIP-001**: 出荷 API — 主要配送業者の API と連携してラベル生成・追跡番号取得を自動化。
- **INT-SHIP-002**: フルフィルメントモデル — 自社倉庫 / 外部 3PL / 店舗ピックアップをサポート。
- **INT-SHIP-003**: 在庫引当 — 注文確定時に SKU 在庫を予約し、ピッキングリストを生成。
- **INT-SHIP-004**: 追跡と通知 — 配送ステータス更新を顧客へ自動通知（メール / SMS）。
- **INT-SHIP-005**: 返品処理 — 返品受付、倉庫受領、返金または再入庫処理のフローを定義。

### 12.3 在庫・ERP / PIM 連携

- **INT-ERP-001**: 同期方式 — 双方向同期（Webhooks / Batch）または片方向バッチ（夜間）を選定。
- **INT-ERP-002**: データ整合性 — 最終更新タイムスタンプ、衝突解決ルール、リコンサイル手順。
- **INT-ERP-003**: スキーママッピング — PIM / ERP のフィールドと商品 / バリアントスキーマのマッピング定義。
- **INT-ERP-004**: スループット制約 — 大量商品更新時のレート制限とバッチ分割。

### 12.4 税・価格計算エンジン

- **INT-TAX-001**: 地域別税率、免税ルール、インボイス要件に対応する税エンジンを導入。
- **INT-TAX-002**: 価格ルール — プロモーション・割引の優先順位と適用順序を明確化。

### 12.5 イベントと Webhooks

- **INT-WHK-001**: 主要イベント — 注文作成、支払い完了、出荷、返品、在庫閾値アラート。
- **INT-WHK-002**: 配信保証 — 少なくとも 1 回（at-least-once）配信、冪等性キーで重複処理を回避。
- **INT-WHK-003**: DLQ / 再試行 — 配信失敗はデッドレターキューに保存して再試行フローを用意。

### 12.6 ログ・分析・データパイプライン

- **INT-DATA-001**: 分析イベント — 購入ファネル、カート放棄、商品閲覧、キャンペーン効果をトラッキング。
- **INT-DATA-002**: ETL — 週次 / 日次でデータウェアハウス（BigQuery / Redshift 等）に取り込み、BI で分析。
- **INT-DATA-003**: 個人情報の扱い — PII はマスキング / ハッシュ化して解析用に保存。

### 12.7 CI / CD・デプロイメント

- **OPS-CICD-001**: ブランチ戦略 — trunk-based development 推奨、プルリクエストで自動テスト。
- **OPS-CICD-002**: パイプライン — Lint → Unit → Integration → E2E（ステージング）→ Canary / Blue-Green デプロイ。
- **OPS-CICD-003**: ロールバック — 自動ロールバック条件（エラー率閾値）と手順を用意。

### 12.8 環境と設定管理

- **OPS-ENV-001**: 環境区分 — 開発・検証・ステージング・本番を分離。
- **OPS-ENV-002**: 機密情報 — 環境別の Secrets 管理（KMS / Secrets Manager）。
- **OPS-ENV-003**: コンフィグの変更履歴 — Feature flag と設定のバージョン管理。

### 12.9 監視・アラート・運用フロー

- **OPS-MON-001**: 監視対象 — アプリヘルス、キュー長、決済失敗率、注文処理時間、在庫同期エラー。
- **OPS-MON-002**: アラートポリシー — SLO に紐づくアラート、夜間 / 休日のエスカレーションルール。
- **OPS-MON-003**: ランブック — インシデント時のステップバイステップ手順（優先度別）。

### 12.10 ベンダー SLA・契約管理

- **OPS-SLA-001**: 決済・配送・CDN 等主要ベンダーの SLA を明確化し、障害時の責任と補償を定義。
- **OPS-SLA-002**: ベンダー障害時の代替手段（フェイルオーバー）を設計。

### 12.11 テスト戦略（統合・運用面）

- **QA-INT-004**: モック / スタブ — 外部 API を模擬するテスト環境を提供。
- **QA-INT-005**: E2E — 支払い・配送含む E2E テストを CI で定期実行。
- **QA-INT-006**: 負荷 — ピーク想定の負荷試験と性能限界のテスト。

### 12.12 運用チェックリスト（日次 / 週次）

- **OPS-CHK-001**: 日次 — 注文 / 決済エラー確認、未処理注文の有無、在庫警告。
- **OPS-CHK-002**: 週次 — バッチ成功確認、バックアップ正常性、セキュリティパッチ適用状況。
- **OPS-CHK-003**: 月次 — SLA のレビュー、コスト・使用状況レビュー。

### 12.13 受け入れ基準（統合・運用）

- **AC-INT-001**: 外部連携 — 決済・配送の主要フローがステージングで成功すること。
- **AC-INT-002**: 障害対応 — 重大インシデントに対する初動対応が定義された SLA 内で行われること。
- **AC-INT-003**: データ整合性 — 日次の在庫差分が許容閾値内であること（例: 0.5% 未満）。


## 付録 A: 機能要件の詳細化（主要）

### A.1 商品データ（推奨スキーマ）

- **SCHEMA-PROD-001**: `product` — id, title, slug, description, vendor, collection, tags, published。
- **SCHEMA-PROD-002**: `variant`（SKU）— id, product_id, sku, price, compare_at_price, currency, size, color, stock, weight。
- **SCHEMA-PROD-003**: `media` — id, product_id, url, type（image / video）, alt_text, position。
- **SCHEMA-PROD-004**: `attributes` — 素材、原産国、ケア情報、フィットタイプ。

### A.2 注文データ（推奨フィールド）

- **SCHEMA-ORDER-001**: `order` — id, user_id（nullable）, order_number, status, total_amount, currency, tax, shipping_cost, payment_status, placed_at。
- **SCHEMA-ORDER-002**: `order_item` — id, order_id, variant_id, quantity, unit_price。
- **SCHEMA-ORDER-003**: `shipping` — method, carrier, tracking_number, cost, address。

### A.3 顧客データ

- **SCHEMA-USER-001**: `customer` — id, email, name, phone, default_address_id, addresses[], created_at, last_order_at, tags。
- **SCHEMA-USER-002**: 顧客の好み（サイズ、フィット、好みの色）を保持してパーソナライズに利用。

### A.4 主要 API

- **API-001**: `GET /api/products` — カタログ取得（クエリ: q, category, price_min, price_max, size, color, sort, page）。
- **API-002**: `GET /api/products/:slug` — 商品詳細（在庫・バリエーション含む）。
- **API-003**: `POST /api/cart` — カート追加。
- **API-004**: `PATCH /api/cart` — カート更新（数量・バリアント変更）。
- **API-005**: `POST /api/checkout` — 注文作成（支払い、配送情報連携）。
- **API-006**: `GET /api/orders/:id` — 注文ステータス取得。

### A.5 バリデーションと業務ルール

- **BIZ-RULE-001**: SKU 単位で在庫チェックを行い、注文確定時に在庫を確保（予約）する。
- **BIZ-RULE-002**: 在庫不足時はユーザー向けに代替サイズ / カラーを提案。
- **BIZ-RULE-003**: クーポンは適用条件（対象商品 / カテゴリー、最小購入金額、利用回数制限）を厳密に検証。

## 付録 B: 主要画面フロー（文章版ワイヤー）

### B.1 トップページ

- **WF-HOME-B01**: ヒーローバナー（新コレクション）、プロモーションバナー。
- **WF-HOME-B02**: カテゴリリンク、注目商品（カルーセル）、新着・人気セクション。

### B.2 カテゴリ一覧

- **WF-ITEM-ALL-B01**: 絞り込みサイドバー（モバイルはドロワー）— サイズ、カラー、価格帯。
- **WF-ITEM-ALL-B02**: 商品カード — 画像、商品名、価格、バッジ（新着 / セール）。

### B.3 商品詳細ページ

- **WF-ITEM-DETAIL-B01**: メイン画像ギャラリー、サムネイル、ズーム。
- **WF-ITEM-DETAIL-B02**: 選択部（サイズ / カラー / 数量）、在庫表示、サイズガイドリンク。
- **WF-ITEM-DETAIL-B03**: 価格・クーポン欄、配送情報（概算）。
- **WF-ITEM-DETAIL-B04**: 関連商品・コーデ表示。
- **WF-ITEM-DETAIL-B05**: CTA — カートに追加、ウィッシュリスト、シェア。

### B.4 カート

- **WF-CART-B01**: 商品リスト（サムネイル・バリエーション・数量調整）。
- **WF-CART-B02**: 小計、適用クーポン、送料見積もり入力（郵便番号）。
- **WF-CART-B03**: ログイン促進とゲストチェックアウトを明示。
- **WF-CART-B04**: CTA — チェックアウトへ。

### B.5 チェックアウト（ステップ式）

- **WF-CHECKOUT-B01**: ステップ 1 — 配送先情報（住所入力、住所帳から選択、ログイン時は account 保存値を既定表示）。
- **WF-CHECKOUT-B02**: ステップ 2 — 配送方法（料金・到着目安を明示）。
- **WF-CHECKOUT-B03**: ステップ 3 — 支払い（決済方法選択、カード入力または外部決済）。
- **WF-CHECKOUT-B04**: ステップ 4 — 注文確認（注文要約、税・送料、利用規約同意）。

### B.6 マイページ

- **WF-ACCOUNT-B01**: プロフィール、配送情報、注文履歴、注文詳細、返品申請、サイズプロファイル。

## 付録 C: 運用・監視の推奨チェックリスト

- **OPS-CHK-004**: 重要ジョブ（注文処理、在庫同期、メール配信）の監視と再試行ポリシー。
- **OPS-CHK-005**: 決済失敗や配送エラーに対するアラートと担当者エスカレーション。
- **OPS-CHK-006**: 週次レポート — 注文数、売上、決済失敗率、在庫警告。

## 15. KPI（事業・品質指標）

### 15.1 優先度

- **PRIO-004**: 日本向けの多言語・多通貨対応 — 高（最優先）。
- **PRIO-005**: 欧州対応 — WANT（要望だが MUST ではない）。
- **PRIO-006**: その他の目標（ブランド表現、購入導線、モバイル、セキュリティ等）— 高。

### 15.2 セキュリティ・法令

- **LEGAL-005**: 決済 — PCI DSS は必須（カード情報はトークン化などで準拠）。
- **LEGAL-006**: プライバシー — GDPR は必須（EU 向けデータ処理・削除フロー等の整備）。
- **LEGAL-007**: 2FA — 実装は望ましいが必須ではない（できれば導入）。

### 15.3 パフォーマンス KPI

- **KPI-PERF-001**: ページ表示時間（95 パーセンタイル）< 2.5s。
- **KPI-PERF-002**: LCP（モバイル）< 2.5s。

### 15.4 コンバージョン KPI

- **KPI-CVR-001**: コンバージョン率（購入 / セッション）— ベースラインを計測して改善目標を設定。
- **KPI-CVR-002**: カート放棄率 — 現状比で改善目標を設定。
- **KPI-CVR-003**: 平均注文額（AOV）— 追跡して増加を目指す。

### 15.5 信頼性・運用 KPI

- **KPI-REL-001**: 決済成功率 — 99% 以上（地域差を考慮）。
- **KPI-REL-002**: サイト稼働率 — 99.9%（SLA 目安）。

### 15.6 顧客維持 KPI

- **KPI-RET-001**: リピート購入率（LTV 指標）— 指標設定と改善計画。
- **KPI-RET-002**: NPS / CSAT — 定期計測。

> KPI はローンチ前に現状値を計測して目標値を確定します。

---

## 要求トレーサビリティ追記（ヘッダー Drawer UI 改善）

| 要求ID  | 要求の内容 | 要件ID | 要件の内容 | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|--------|-----------|----------------|------------------|
| FREQ-24 | Drawerにサイトタイトル「Le Fil des Heures」を表示しないこと | FREQ-24-REQ-01 | Drawerを開いたとき、サイトタイトルのテキストが存在しないこと | FREQ-24-AC-01 | Drawer内に「Le Fil des Heures」というテキストが表示されないこと |
| FREQ-25 | DrawerのSNSアイコンが枠（40×40px）の中央に配置されること | FREQ-25-REQ-01 | SNSアイコンが横・縦ともに枠内で視覚的に中央揃えされること | FREQ-25-AC-01 | SNSアイコンのリンク要素が flex かつ items-center justify-center で実装されていること |
| FREQ-26 | DrawerのSNSアイコン（TikTok・X）がグレーを含まず白黒のみで表示されること | FREQ-26-REQ-01 | アイコンフォントのアンチエイリアスに起因するグレーピクセルを排除し、通常時は純黒・ホバー時は純白で描画すること | FREQ-26-AC-01 | 通常時：アイコンに `filter: brightness(0)` が適用されて純黒で表示されること。ホバー時：`filter: brightness(0) invert(1)` が適用されて純白で表示されること |
| FREQ-27 | Drawerのアコーディオン展開時に子要素と次の親要素との間に十分な余白があること | FREQ-27-REQ-01 | アコーディオンのコンテンツエリア下部に十分なパディングを設けること | FREQ-27-AC-01 | アコーディオン展開時、子要素の末尾から次の親アコーディオン項目のborder-topまでの間隔が20px以上あること |
| FREQ-28 | Drawerの閉じる×ボタンがハンバーガーメニューと同じ座標に配置されること | FREQ-28-REQ-01 | Drawer上部の×ボタンをヘッダーのハンバーガーメニューボタンと水平方向で同一位置に揃えること | FREQ-28-AC-01 | Drawerを開いた際、×ボタンの中心X座標がハンバーガーメニューボタンの中心X座標と±2px以内で一致すること |
| FREQ-29 | Drawerのアコーディオン子要素リンクの文字色が黒であること | FREQ-29-REQ-01 | アコーディオン展開時の子要素リンク（サブナビリンク）の文字色をグレーではなく黒にすること | FREQ-29-AC-01 | アコーディオン展開時、子要素リンクのcolorがrgb(17, 17, 17)であること |
| FREQ-30 | フッターのSHOP・INFORMATIONの各リンク項目間に十分な余白があること | FREQ-30-REQ-01 | フッターのナビリンクリストの項目間隔を広げ、窮屈さを解消すること | FREQ-30-AC-01 | フッターのSHOP・INFORMATIONリスト内で隣接するリンク項目同士の縦方向の間隔が10px以上あること |

## 要求トレーサビリティ追記（NEWS 一覧・Admin News 画像廃止）

| 要求ID  | 要求の内容 | 要件ID | 要件の内容 | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|--------|-----------|----------------|------------------|
| FREQ-31 | NEWS 一覧ページにページ見出し「NEWS」を表示しないこと | FREQ-31-REQ-01 | NEWS 一覧ページからページタイトルの見出し要素を削除すること | FREQ-31-AC-01 | NEWS 一覧ページにテキスト「NEWS」の見出し（h1）が表示されないこと |
| FREQ-32 | NEWS 一覧ページの各記事カードに画像（アイキャッチ）を表示しないこと | FREQ-32-REQ-01 | NEWS 一覧ページの記事カードから画像表示を削除すること | FREQ-32-AC-01 | NEWS 一覧ページの記事カード内に img 要素が表示されないこと |
| FREQ-33 | Admin の News 管理で画像のアップロードを行わないこと | FREQ-33-REQ-01 | News 作成・編集フォームから画像アップロードの入力欄と処理を削除し、画像なしで作成・更新できること | FREQ-33-AC-01 | News 作成・編集フォームに画像アップロード欄が存在せず、画像を添付せずに保存・更新が完了すること |

## 要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）

| 要求ID  | 要求の内容 | 要件ID | 要件の内容 | 受け付け基準ID | 受け付け基準の内容 |
|---------|-----------|--------|-----------|----------------|------------------|
| FREQ-34 | ITEM 一覧ページにページ見出し「ITEM」を表示しないこと | FREQ-34-REQ-01 | ITEM 一覧ページからページタイトルの見出し要素を削除すること | FREQ-34-AC-01 | ITEM 一覧ページにテキスト「ITEM」の見出し（h1）が表示されないこと |
| FREQ-35 | ITEM 一覧ページにパンくずリストを表示しないこと | FREQ-35-REQ-01 | ITEM 一覧ページからパンくずナビゲーション要素を削除すること | FREQ-35-AC-01 | ITEM 一覧ページに aria-label="Breadcrumb" のナビゲーション要素が表示されないこと |
| FREQ-36 | ITEM 一覧ページに終端表示「ALL ITEMS SHOWN」を表示しないこと | FREQ-36-REQ-01 | ITEM 一覧ページの無限スクロール終端メッセージを削除すること | FREQ-36-AC-01 | ITEM 一覧ページにテキスト「ALL ITEMS SHOWN」が表示されないこと |
| FREQ-37 | ITEM 一覧ページに件数表示「〇〇件」を表示しないこと | FREQ-37-REQ-01 | ITEM 一覧ページの結果バーから商品件数の表示を削除すること | FREQ-37-AC-01 | ITEM 一覧ページに「〇〇件」形式の件数テキストが表示されないこと |
| FREQ-38 | デスクトップのITEM一覧で右側のITEMをスクロールしてもフィルターが動かないこと | FREQ-38-REQ-01 | デスクトップのフィルターサイドバーをヘッダー自動非表示に連動させず、定数のヘッダー高さに固定すること | FREQ-38-AC-01 | デスクトップ表示でページを下方向にスクロールしても、フィルターサイドバーの上端Y座標が変化しないこと |
| FREQ-39 | デスクトップのITEM一覧でフィルター列の幅を広げ、ITEMグリッドとの間に余白を設けること | FREQ-39-REQ-01 | フィルターサイドバーの幅をフィボナッチ階調で拡張し、ITEMグリッドとの間に十分な水平余白を確保すること | FREQ-39-AC-01 | デスクトップ(1280px)でフィルターサイドバーの幅が233px以上であり、サイドバー右端とITEMグリッド左端の間隔が21px以上あること |
| FREQ-40 | PRICEスライダーが価格フィルタ適用後も0〜最大価格の全レンジを操作できること | FREQ-40-REQ-01 | スライダーの上下限を適用済みフィルタ結果ではなく、読み込んだ全商品の最大レンジに基づいて保持し、適用後に縮まないようにすること | FREQ-40-AC-01 | 価格上限を絞って適用した後も、PRICEスライダーの最大つまみの上限値（aria-valuemax）が適用前の最大価格と一致し、再び最大価格までスライドできること |
| FREQ-41 | フィルタにAPPLYボタンを設けず、操作停止後に自動でフィルタを適用すること | FREQ-41-REQ-01 | APPLYボタンを廃止し、フィルタ操作（チェックボックス・PRICEスライダー等）が止まってから 300ms（操作停止の検出に基づく一般的なデバウンス時間）後に自動でフィルタを適用してURLを更新・再読み込みすること | FREQ-41-AC-01 | フィルターUIにAPPLYボタンが存在しないこと | FREQ-41-AC-02 | PRICEスライダーや絞り込みを操作して何もしないまま 300ms 程度待つと、APPLYを押さずにURLのフィルタクエリが更新されること |
| FREQ-42 | CATEGORY を複数選択したときは OR（いずれかに該当）で検索・表示すること | FREQ-42-REQ-01 | サーバー側の商品取得で複数カテゴリ指定時に IN 句で OR 検索し、API も複数カテゴリのカンマ区切りを受理すること | FREQ-42-AC-01 | category に複数カテゴリ（例: TOPS,BOTTOMS）を指定したとき、返る商品がすべて指定カテゴリのいずれかに該当し、件数が各単一カテゴリの合計に等しい（AND による空結果にならない）こと |
| FREQ-43 | 同一画面サイズでは FILTER 列と ITEM 列の横幅を検索結果の有無に関わらず一定に保つこと | FREQ-43-REQ-01 | ページ全体ラッパー（element-width）が flex 親（main）内で内容幅に縮まないよう明示的に full 幅を指定し、検索結果が0件でも列幅を内容に依存させないこと | FREQ-43-AC-01 | デスクトップで検索結果が0件のときと商品がある状態とで、FILTER 列（aside）と ITEM 列の横幅がそれぞれ一致すること |
| FREQ-44 | COLOR・STOCK・SIZE・SEASON のフィルターを統一したマルチセレクトにすること | FREQ-44-REQ-01 | ALL を押したら他のチェックを外して ALL のみ選択にし、それ以外は各選択肢を独立してトグル（複数選択）できること。STOCK は in/out、SEASON は AW/SS をそれぞれ単独・複数とも選択可能とすること | FREQ-44-AC-01 | STOCK で OUT OF STOCK 選択中に IN STOCK を押すと両方が選択状態になること（逆も同様） | FREQ-44-AC-02 | SEASON で AW 選択中に SS を押すと両方が選択状態になること（逆も同様） | FREQ-44-AC-03 | STOCK・SEASON で ALL を押すと他のチェックが外れ ALL のみが選択状態になること |
| FREQ-45 | ITEM 一覧の FILTER の文字サイズと余白の使い方を stein（ssstein.com）と HYKE（hyke.jp）の FILTER を参考に調整すること | FREQ-45-REQ-01 | 親（セクション見出し）と子（選択肢）の間隔は stein を参考にゆったり取り、選択肢同士の間隔と文字サイズは両サイトを参考にした値にすること。見出しには控えめなトラッキングを与えること | FREQ-45-AC-01 | フィルターのセクション見出し（CATEGORY 等）と直下の最初の選択肢との縦の間隔が、選択肢同士の縦の間隔より広いこと | FREQ-45-AC-02 | フィルターの選択肢ラベルの文字サイズが 10px 以上 13px 以下であること |
| FREQ-46 | ITEM 一覧の並び替えプルダウンと FILTER ボタンの文字サイズ・字間をフィルター見出しに揃えること | FREQ-46-REQ-01 | 右上の並び替えプルダウン（NEWEST 等）の文字サイズと文字同士の間隔を、フィルターの親要素（セクション見出し）と同一にすること。モバイル・タブレットで表示される FILTER ボタンの文字サイズを、並び替えプルダウンと同一にすること | FREQ-46-AC-01 | デスクトップで並び替えプルダウンの文字サイズと letter-spacing が、フィルターのセクション見出しと一致すること | FREQ-46-AC-02 | モバイル・タブレットで FILTER ボタンの文字サイズが、並び替えプルダウンの文字サイズと一致すること |
| FREQ-47 | NEWS 一覧のモバイル・タブレットの FILTER ボタンを ITEM 一覧の FILTER ボタンと同じにすること | FREQ-47-REQ-01 | NEWS 一覧でモバイル・タブレット表示時に出る FILTER ボタンの文字サイズ・字間を、ITEM 一覧の FILTER ボタンと同一にすること | FREQ-47-AC-01 | モバイル・タブレットで NEWS 一覧の FILTER ボタンの文字サイズと letter-spacing が、ITEM 一覧の FILTER ボタンと一致すること |
| FREQ-48 | NEWS 一覧の FILTER の選択肢（要素と要素の間隔・要素自体）を ITEM 一覧の Accordion 内の子要素と同じにすること | FREQ-48-REQ-01 | NEWS 一覧の FILTER の選択肢同士の間隔（option-list の gap）と選択肢自体の見た目（文字サイズ・字間・チェック表示）を、ITEM 一覧の Accordion 内 MultiSelect の選択肢と同一にすること | FREQ-48-AC-01 | NEWS 一覧の FILTER 選択肢リストの gap が、ITEM 一覧の FILTER 選択肢リストの gap と一致すること | FREQ-48-AC-02 | NEWS 一覧の FILTER 選択肢ラベルの letter-spacing が、ITEM 一覧の FILTER 選択肢ラベルと一致すること |
| FREQ-49 | NEWS 一覧のフィルター縦線とコンテンツの距離を ITEM 一覧と同じにすること | FREQ-49-REQ-01 | デスクトップで NEWS 一覧のフィルターサイドバー右端の縦線とコンテンツ列の間隔（コンテンツ列の左 padding）を、ITEM 一覧の同間隔と一致させること | FREQ-49-AC-01 | デスクトップ（lg/xl/2xl の各幅）で NEWS 一覧のコンテンツ列の左 padding が、ITEM 一覧のコンテンツ列の左 padding と一致すること |
| FREQ-50 | LOOK 一覧ページ最上部の「LOOK BOOK」見出しを表示しないこと | FREQ-50-REQ-01 | LOOK 一覧ページのページ最上部に表示していた「LOOK BOOK」見出し（h1）を削除すること | FREQ-50-AC-01 | LOOK 一覧ページに「LOOK BOOK」という見出しテキストが表示されないこと |
| FREQ-51 | LOOK 一覧のフィルターを NEWS 一覧と同じ配置にすること | FREQ-51-REQ-01 | LOOK 一覧の SEASON フィルターを、横並びタブから NEWS 同様の配置（PC は左サイドバー、モバイル・タブレットは FILTER ボタンで開く drawer）に変更すること | FREQ-51-AC-01 | デスクトップで LOOK 一覧の SEASON フィルターが左サイドバーに表示され、横並びタブが表示されないこと | FREQ-51-AC-02 | モバイル・タブレットで FILTER ボタンを押すと drawer が開き、SEASON を切り替えられること |
| FREQ-52 | LOOK 一覧フィルターの選択肢同士の間隔を NEWS 一覧フィルターと揃えること | FREQ-52-REQ-01 | LOOK 一覧の SEASON フィルターを NEWS と同じく .filter-sections で包み、選択肢同士の間隔（option-list の gap）を NEWS と共通の式（--ui-font-size × 0.5）にし、PC は size 3xs・drawer は size xs と一致させること | FREQ-52-AC-01 | デスクトップで LOOK 一覧の SEASON フィルター選択肢リストの gap が、NEWS 一覧フィルターの選択肢リストの gap と一致すること |
| FREQ-53 | LOOK カードの関連商品同士の間隔を近接の原則で詰めること | FREQ-53-REQ-01 | 関連商品リンクに付与していた上下 padding（py-[5px] sm:py-[6px]）を撤廃し、行間を .look-related-items の gap（φ 比率）のみで決定して関連商品同士を一群として近接させること | FREQ-53-AC-01 | LOOK カードの各関連商品リンクの上下 padding が 1px 以下であること | FREQ-53-AC-02 | 関連商品リンク同士の見た目の縦間隔が、各行のフォントサイズ ÷ φ（≒0.618em）に一致すること |
| FREQ-54 | LOOK カードのコレクション時期・名前・関連アイテムの縦間隔を近接の原則で整えること | FREQ-54-REQ-01 | コレクション時期（◯◯ COLLECTION）と名前を同一グループとして近接させ、別グループの関連アイテムとの間隔を広げること。すなわち「時期↔名前」の間隔を「名前↔関連アイテム」の間隔より狭くすること | FREQ-54-AC-01 | LOOK カードでコレクション時期と名前の縦間隔が、名前と最初の関連アイテムの縦間隔より狭いこと |
| FREQ-55 | LOOK 一覧グリッドのカード行どうしの縦方向の間隔を広げること | FREQ-55-REQ-01 | LOOK 一覧（catalog）のグリッドで縦方向の gap（row-gap）を横方向の gap（column-gap）より広げ、カード行どうしを明確に分離すること。モバイルを優先しタブレット・PC でも段階的に拡張すること | FREQ-55-AC-01 | モバイル・タブレット・PC の各幅で LOOK 一覧グリッドの row-gap が column-gap より大きいこと | FREQ-55-AC-02 | モバイルで LOOK 一覧グリッドの row-gap が従来値（16px）より大きいこと |
| FREQ-56 | LOOK カードの関連アイテムをモバイルでは商品名と価格を縦積みで表示すること | FREQ-56-REQ-01 | モバイル幅では関連アイテムの商品名と価格を上下2行（縦積み）で表示し、商品名の折り返しを避けること。タブレット・PC では従来どおり商品名と価格を同一行（左右両端）で表示すること | FREQ-56-AC-01 | モバイル幅で関連アイテムの商品名と価格が縦方向に積まれている（価格の上端が商品名の下端以上）こと | FREQ-56-AC-02 | タブレット・PC 幅で関連アイテムの商品名と価格が同一行に並ぶ（縦方向に重なる）こと |
| FREQ-57 | STOCKIST 一覧に地方→都道府県のネストチェックボックスフィルターを付けること | FREQ-57-REQ-01 | STOCKIST 一覧に `ALL`・地方（親）・都道府県（子・インデント）を同時に表示するネストしたチェックボックスツリー型フィルターを設けること。地方チェックで配下都道府県を一括選択し、都道府県チェックで個別に絞り込めること。選択中の都道府県は店舗住所の先頭都道府県名と突き合わせること。UI は LOOK/ITEM と統一し PC は左サイドバー、モバイル・タブレットは FILTER ボタンの drawer とすること | FREQ-57-AC-01 | STOCKIST 一覧で地方（親）チェックを入れるとその地方配下の都道府県の店舗のみが表示されること | FREQ-57-AC-02 | 都道府県（子）チェックを入れるとその都道府県の店舗のみが表示されること | FREQ-57-AC-03 | モバイル・タブレットで FILTER ボタンを押すと drawer が開き地方・都道府県を絞り込めること |

## 要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）

| 要求ID | 要求 | 要件ID | 要件 | 受け付け基準ID | 受け付け基準 |
|---------|-----------|--------|-----------|----------------|------------------|
| FREQ-58 | ログインをメールアドレス + パスワード + メールOTP の2要素認証にすること | FREQ-58-REQ-01 | ログインページでEMAILとPASSWORDを入力して認証し、成功後にメールOTP（8桁）で本人確認する2段階フローとすること。パスワード検証済みを短命の署名Cookieで担保し、OTP単独ログインを防ぐこと | FREQ-58-AC-01 | ログインページにEMAIL入力欄とPASSWORD入力欄が表示されること | FREQ-58-AC-02 | パスワード入力後にログインするとOTPコード入力欄（8桁）が表示されること |
| FREQ-59 | 新規登録とログインを分離し、専用の新規登録ページを設けること | FREQ-59-REQ-01 | `/register` にメールアドレス・パスワード・パスワード（確認）の入力欄を持つ登録ページを設け、登録は確認メールのリンクで完了すること。ログイン時の自動アカウント作成は廃止すること。ログインページに新規登録への導線を設けること | FREQ-59-AC-01 | `/register` にEMAIL・PASSWORD・PASSWORD（確認）の入力欄が表示されること | FREQ-59-AC-02 | ログインページに「新規登録」への導線が表示されること |
| FREQ-60 | メールOTPの有効期限を5分にすること | FREQ-60-REQ-01 | Supabase の Email OTP Expiration を300秒に設定すること。UI の再送クールダウンは60秒を維持すること | FREQ-60-AC-01 | ログインでOTPを送信した後、再送カウントダウン表示（「後に再送可能」）が表示されること |
| FREQ-61 | ログインと新規登録を1ページに統合し、タブで切り替えられるようにすること | FREQ-61-REQ-01 | `/login` と `/register` を「ログイン」「新規登録」タブを持つ単一の認証UIに統合し、タブ切替で表示フォームとURL（/login ⇄ /register）を同期すること | FREQ-61-AC-01 | /login に「ログイン」「新規登録」のタブが表示され、「ログイン」タブが選択状態で、PASSWORD（確認）入力欄が表示されないこと | FREQ-61-AC-02 | 「新規登録」タブを押すとPASSWORD（確認）入力欄が表示され、URLが /register になること | FREQ-61-AC-03 | /register では「新規登録」タブが選択状態で表示され、「ログイン」タブを押すとログインフォームが表示されURLが /login になること |
| FREQ-62 | 認証ページ下部の区切り線と切替文言の間に十分な余白を設け、規約同意文を自然に折り返すこと | FREQ-62-REQ-01 | 高さ0のdivによるマージン相殺で区切り線が文言に密着していた区切りを実体のある hr に置き換え、線の上下に均等な余白（32px）を確保すること。規約同意文の強制改行（br）と固定幅を撤廃し、コンテナ幅に応じて自然折り返し（text-wrap: balance）とすること | FREQ-62-AC-01 | /login・/register で区切り線（hr）と「アカウントをお持ちでない方は…」「既にアカウントをお持ちの方は…」テキストの縦間隔が21px以上であること | FREQ-62-AC-02 | 規約同意文（「続行することで、…」）に強制改行（br要素）が含まれないこと |
| FREQ-63 | 会員登録とログインを `/login` に一本化し、専用 `/register` ルートを廃止すること（FREQ-59・FREQ-61 のURL分離方針を反転） | FREQ-63-REQ-01 | `src/app/register/page.tsx` を削除し `/register` ルートを廃止する。認証UIは `/login` のタブ切替のみで完結させ、タブ切替時にURLを `/register` へ変更しないこと。LoginModal の「会員登録はこちら」および RegisterModal の「既にアカウントをお持ちの方はこちら」は `/login`・`/register` への遷移リンクを廃止し、タブ切替（onSwitchToRegister / onSwitchToLogin）のみ残すこと | FREQ-63-AC-01 | `/register` にアクセスすると 404 になること | FREQ-63-AC-02 | `/login` で「新規登録」タブを押すとPASSWORD（確認）入力欄が表示され、URLが `/login` のまま変わらないこと | FREQ-63-AC-03 | 会員登録タブの「既にアカウントをお持ちの方はこちら」がリンクではなくタブ切替ボタンで、押すとログインタブに切り替わりURLが `/login` のまま変わらないこと |
| FREQ-64 | note のログインUIを参考に、認証UI（`/login` のログイン・会員登録タブ）を角丸デザインへ刷新すること。ソーシャルログインは参考先ではなく現行デザインを維持し、「ログインでお困りの方」導線は設けないこと | FREQ-64-REQ-01 | 認証カード枠・入力欄・ボタン（Googleボタン含む）を角丸（border-radius > 0）にする。認証カード枠の枠線は参考先に合わせグレー系（純黒でない）にする。英字ラベルとログイン/会員登録タブは維持すること | FREQ-64-AC-01 | `/login` の認証カード枠・EMAIL入力欄・ログインボタンの border-radius が 0 より大きいこと | FREQ-64-AC-02 | `/login` に「ログインでお困りの方」導線が表示されないこと | FREQ-64-AC-03 | `/login` の認証カード枠の枠線色が純黒（rgb(0, 0, 0)）でないグレー系であること | FREQ-64-AC-04 | `/login` のログインボタンの border-radius が隣接する入力欄と調和する中庸な角丸（4px〜12px の範囲）であり、過度に丸いピル状（>12px）でないこと |
| FREQ-65 | 認証UIの非選択タブをグレー表示にし、送信ボタンは必須項目が未入力の間は無効（グレー）、入力されたら有効（黒）にすること | FREQ-65-REQ-01 | ログイン/会員登録タブの非選択側を黒背景からグレー背景へ変更する。タブの状態は背景の塗り分け（選択=白／非選択=グレー）のみで表し、区切り線（下線・タブ間の縦線）は入れない（塗りのみで統一）こと。ログインボタンは EMAIL・PASSWORD が未入力の間 disabled にし、会員登録の「登録して確認メールを受け取る」ボタンは EMAIL・PASSWORD・PASSWORD（確認）が未入力の間 disabled にする。disabled 時はグレー、入力充足時は黒で表示すること | FREQ-65-AC-01 | `/login` の非選択タブの背景色が純黒（rgb(0, 0, 0)）でないグレー系であること | FREQ-65-AC-02 | `/login` の EMAIL・PASSWORD が未入力のときログインボタンが無効（disabled）であること | FREQ-65-AC-03 | `/login` の EMAIL・PASSWORD を入力するとログインボタンが有効（enabled）になること | FREQ-65-AC-04 | 会員登録タブで EMAIL・PASSWORD・PASSWORD（確認）が未入力のとき登録ボタンが無効（disabled）であること | FREQ-65-AC-05 | `/login` の各タブに区切り線（border）が入っていない（border 幅が 0）こと |
| FREQ-66 | 「パスワードをお忘れの方はこちら」導線を、近接の原則に従いパスワード入力欄の直下（ログインボタンの上）に右寄せで配置すること | FREQ-66-REQ-01 | 従来ログインボタンの下にあった当該リンクを、パスワード入力欄とグループ化してその直下へ移動し、右寄せにする。パスワード入力欄との間隔をログインボタンとの間隔より小さくして近接させること | FREQ-66-AC-01 | `/login` で「パスワードをお忘れの方はこちら」リンクがログインボタンより上に表示されること | FREQ-66-AC-02 | 当該リンクとパスワード入力欄の縦間隔が、当該リンクとログインボタンの縦間隔より小さいこと（パスワード欄に近接） | FREQ-66-AC-03 | 当該リンクが右寄せ（右端がパスワード入力欄の右端とほぼ一致）であること |
| FREQ-67 | 対比（コントラスト）の原則に従い、認証UI（`/login`）のフォントサイズとコンポーネントサイズで要素の優先度を明快に示すこと（note のログインUIを参考） | FREQ-67-REQ-01 | 主要CTA（ログイン／登録ボタン）を最大フォント・最大の高さにし、入力欄はそれに次ぐサイズ、「パスワードをお忘れの方はこちら」は本文より小さくして最下位の優先度にする。会員登録タブも同様の階層にすること | FREQ-67-AC-01 | `/login` でログインボタンのフォントサイズが EMAIL 入力欄のフォントサイズより大きいこと | FREQ-67-AC-02 | `/login` で「パスワードをお忘れの方はこちら」のフォントサイズが本文（会員登録はこちらリンク）より小さいこと | FREQ-67-AC-03 | `/login` でログインボタンの高さが EMAIL 入力欄および Google ボタンの高さ以上（最も高い操作要素）であること |
| FREQ-68 | 近接・整列の原則に従い、認証UIの操作ボタン（Google／主要CTA）のサイズを揃えること。ログインタブと会員登録タブのボタンサイズも揃えること | FREQ-68-REQ-01 | 各フォーム内の Google ボタンと主要CTA（ログイン／登録して確認メールを受け取る）を同じ高さ・同じフォントサイズに揃える。ログイン側と会員登録側で対応するボタンのサイズも一致させること。主要CTAの優先度は黒背景（色）で示すこと | FREQ-68-AC-01 | `/login` の Google ボタンと主要CTAの高さおよびフォントサイズが一致すること | FREQ-68-AC-02 | ログインタブと会員登録タブで、Google ボタン同士・主要CTA同士の高さおよびフォントサイズが一致すること |
| FREQ-69 | `/login` の main を画面全体の高さにし、その中心にフォームを配置すること。初期表示で Footer が見えないようにすること | FREQ-69-REQ-01 | `/login` の main をビューポート高（ヘッダ分を除いた 100dvh）以上にして中央寄せでフォームを配置する。Footer は折り返し（fold）より下へ送り、初期表示のビューポート内に見えないようにすること | FREQ-69-AC-01 | `/login` 初期表示で Footer の上端がビューポート下端以上（＝Footer が見えない）であること | FREQ-69-AC-02 | `/login` の main の下端がビューポート下端に到達している（main が画面下まで占める）こと | FREQ-69-AC-03 | `/login` のフォーム（認証カード）が縦方向にほぼ中央（中心のずれがビューポート高の15%以内）に配置され、ヘッダに重ならないこと |
| FREQ-70 | パスワード再設定ページ（`/auth/password-reset`）の見た目を `/login` と統一すること（`/auth` プレフィックスは `/auth/callback`・`/auth/verified` と同じ認証フロー系グルーピングのため維持） | FREQ-70-REQ-01 | `/login` と同じ角丸カード枠（border-black/20・rounded-2xl）で囲み、入力欄は角丸(size lg)・送信ボタンは角丸(size xl)・未入力時はグレー無効/入力後は黒とする。main を画面全体高にして中央配置し、初期表示で Footer を見せないこと | FREQ-70-AC-01 | `/auth/password-reset` に角丸カード枠（border-radius > 0）が表示され、送信ボタンが角丸（4〜12px）であること | FREQ-70-AC-02 | `/auth/password-reset` 初期表示で Footer が見えず（上端がビューポート下端以上）、フォームが縦方向にほぼ中央に配置されること | FREQ-70-AC-03 | `/auth/password-reset` で EMAIL 未入力時は送信ボタンが無効、入力すると有効になること | FREQ-70-AC-04 | 見出し「パスワード再設定の申請」が `/login` のタブと同じフォント（acumin-pro 系サンセリフ）で表示され、対比の原則によりページ内で最大級のフォントサイズ（本文・入力欄より大きい）であること |
| FREQ-71 | `/login` のログイン・会員登録フォームを iPhone SE サイズ（375×667）で 1 画面（スクロールなし）に収めること。tablet/PC は現状維持（モバイル時のみ余白・入力欄高さを縮小） | FREQ-71-REQ-01 | モバイル（sm 未満）でのみ認証カード内の縦余白（Google/OR/フォーム/区切り線/切替文言の各マージン、パネル上余白、フォーム行間）と入力欄の最小高さを縮小し、375×667 でログイン・会員登録の両タブのカードがビューポート内に収まるようにする。`sm:` 以上（tablet/PC）は従来値を維持すること | FREQ-71-AC-01 | 375×667 で `/login`（ログインタブ）の認証カード下端がビューポート下端以下に収まり、Footer が見えない（初期表示でスクロール不要）こと | FREQ-71-AC-02 | desktop（1280 幅）で認証カードの縦余白が従来どおり（モバイル用の縮小が適用されない）であること | FREQ-71-AC-03 | 375×667 で会員登録タブの認証カード下端がビューポート下端以下に収まり、Footer が見えないこと |
| FREQ-72 | 未ログイン時のアカウントページ（`/account`）UIを、ブランド（Le Fil des Heures）の世界観に沿った洗練デザインに刷新すること | FREQ-72-REQ-01 | 汎用ユーザーアイコンを廃し、ブランドフォント Didot の見出し「ACCOUNT」・糸モチーフの細いヘアライン・モノクロ（黒/グレー/白）・十分な余白で構成する。main を画面高いっぱいに使いフォームを縦中央に配置し、初期表示で Footer を見せないこと。「ログイン」CTA から `/login` へ遷移できること | FREQ-72-AC-01 | 未ログイン `/account` に見出し「ACCOUNT」が Didot 系セリフフォントで表示されること | FREQ-72-AC-02 | 未ログイン `/account` に汎用ユーザーアイコン（`ri-user-line`）が表示されないこと | FREQ-72-AC-03 | 未ログイン `/account` 初期表示で Footer が見えず（上端がビューポート下端以上）、コンテンツが縦方向にほぼ中央に配置されること | FREQ-72-AC-04 | 「ログイン」CTA が `/login` へのリンクであること | FREQ-72-AC-05 | 対比の原則により、見出し「ACCOUNT」のフォントサイズがゲート内の本文（説明文）およびログインCTAより大きい（最大の）こと |
| FREQ-73 | Google ログイン等の後に表示される認証確認ページ（`/auth/verified`）を、ブランド（Le Fil des Heures）の世界観に沿った画面に刷新すること（このページはロール判定による振り分け・特権ロールの TOTP 登録/認証のため必要なので廃止せず、見た目のみブランド適合させる） | FREQ-73-REQ-01 | 素の見出し「認証確認」と汎用余白レイアウトを廃し、ブランドフォント Didot の見出し「Le Fil des Heures」・糸モチーフの細いヘアライン・モノクロ（黒/グレー/白）・十分な余白で構成する。main を画面高いっぱいに使いコンテンツを縦中央に配置し、初期表示で Footer を見せないこと。ローディング文言を「サインインを確認しています…」に整えること。未認証でアクセスした場合は `/login` への導線を表示すること | FREQ-73-AC-01 | `/auth/verified` に見出し「Le Fil des Heures」が Didot 系セリフフォントで表示されること | FREQ-73-AC-02 | 未認証で `/auth/verified` にアクセスすると「ログインページへ」リンク（`/login`）が表示されること | FREQ-73-AC-03 | `/auth/verified` 初期表示で Footer が見えず（上端がビューポート下端以上）、見出しが縦方向にほぼ中央に配置されること | FREQ-73-AC-04 | 見出し直下に糸モチーフの細いヘアライン（幅約1pxの縦線）が表示されること | FREQ-73-AC-05 | 対比の原則により、見出し「Le Fil des Heures」のフォントサイズが本文（説明文）より大きいこと |
| FREQ-74 | 注文完了画面（`/checkout` 決済完了時）をブランド（Le Fil des Heures）の世界観に沿ったミニマル・モードなデザインに調整すること（フォント・フォントサイズ・余白中心。安心感のためのアイコンは維持） | FREQ-74-REQ-01 | 英語「THANK YOU FOR YOUR ORDER」を Didot のオーバーライン（見出しの上・小サイズ・トラッキング広め）とし、日本語見出し「ご注文ありがとうございます」を主とする（FREQ 済 CO-5 の主従関係は維持）。見出しと説明文の間に糸モチーフの細いヘアラインを配置する。案内3カード（確認メール/配送/お問い合わせ）の丸型アイコンは維持しつつ一回り小さく（40px）、カード見出しは本文と同系のサンセリフ（acumin-pro）・本文の行間は φ（1.618）とする。ブロック間余白を1段階拡張（--gap-layout）し、画面上下にも余白を設ける。注文番号・注文日はモバイルで1カラムに折り返すこと | FREQ-74-AC-01 | 注文完了画面で「THANK YOU FOR YOUR ORDER」が見出し「ご注文ありがとうございます」より上に表示されること | FREQ-74-AC-02 | 見出しと説明文の間に糸モチーフの細いヘアライン（幅約1pxの縦線）が表示されること | FREQ-74-AC-03 | 案内3カード（確認メール/配送/お問い合わせ）に丸型アイコン（ri-mail-line / ri-truck-line / ri-customer-service-line）が表示されること | FREQ-74-AC-04 | 390px 幅で注文番号と注文日が縦積み（1カラム）で表示され、横スクロールが発生しないこと |
| FREQ-75 | LOADINGデザインギャラリーページ（`/loading`）を新規追加し、Adminページと同様に管理者（admin ロール）にのみ表示すること | FREQ-75-REQ-01 | `/loading` に Standard（8パターン）/ Full Screen（16パターン）/ Animation Components（7コンポーネント）/ Brand Name（16パターン）の各セクションを表示し、各パターンには SHOW .TSX CODE ボタンでコピー可能なコードを表示する。認証解決前は「読み込み中...」を表示し、未ログインまたは admin 以外のロールには「アクセス権限がありません」を表示してギャラリーを表示しないこと | FREQ-75-AC-01 | admin でログイン時、`/loading` に見出し「Loading」とセクション見出し（Standard / Full Screen / Animation Components / Brand Name）が表示されること | FREQ-75-AC-02 | 未ログイン時、`/loading` に「アクセス権限がありません」が表示され、見出し「Loading」が表示されないこと | FREQ-75-AC-03 | admin 以外のロール（user / supporter）でログイン時、`/loading` に「アクセス権限がありません」が表示されること | FREQ-75-AC-04 | SHOW .TSX CODE ボタンをクリックするとコードブロックが表示され、HIDE CODE で非表示になること |
| FREQ-76 | ヘッダーに LOADING メニュー（`/loading` への導線）を管理者にのみ追加し、`/loading` の Animation Components を動作（再生）できるようにし、ブランドのミニマル・モードな世界観に合う実コンテンツ向けモーションアイデア（Content Motion）を追記すること | FREQ-76-REQ-01 | ヘッダーのデスクトップナビとドロワーに admin ロールのときのみ LOADING リンクを表示する。Animation Components の各デモに REPLAY ボタンを設け、クリックでアニメーションを再実行できるようにする（FadeIn / StaggerChildren / TextReveal はスクロール再進入でも再アニメーション）。`/loading` 末尾に Content Motion セクション（THREAD DRAW / IMAGE WIPE / SLOW ZOOM / UNDERLINE TRACK / FILL SWEEP / SKELETON / MARQUEE / MASK LINES の8パターン、各用途説明とコード付き）を表示する | FREQ-76-AC-01 | admin でログイン時、ヘッダー（desktop はナビ、mobile/tablet はドロワー）に LOADING リンクが表示され `/loading` へ遷移できること | FREQ-76-AC-02 | 未ログインおよび admin 以外のロールでは LOADING リンクが表示されないこと | FREQ-76-AC-03 | Animation Components の各デモに REPLAY ボタンが表示され、クリックするとアニメーションが再実行されること（例: AnimatedCounter が再カウントアップする） | FREQ-76-AC-04 | `/loading` に Content Motion セクションと8パターン（THREAD DRAW / IMAGE WIPE / SLOW ZOOM / UNDERLINE TRACK / FILL SWEEP / SKELETON / MARQUEE / MASK LINES）が表示されること |
| FREQ-77 | 注文完了画面の表示開始位置と完了CTAを改善すること（完了時にページ先頭から表示する。「買い物を続ける」「注文履歴を見る」ボタンをページ内の他CTAとサイズ統一する。角は角丸にせず直角を維持する＝決済直後こそUI一貫性が安心感を生むため。柔らかさは丸型アイコンで担保） | FREQ-77-REQ-01 | 完了画面へ切り替わった際に `window.scrollTo(0, 0)` でページ先頭（見出し）から表示する。完了CTAは共通 Button コンポーネント（primary／secondary・size lg・shape square 既定）で実装し、2つのボタンの高さを一致させる（デスクトップは min-width 220px で幅も統一、モバイルは全幅縦積み）。完了画面のカード・ボタンに角丸は導入しないこと | FREQ-77-AC-01 | 注文完了画面の表示直後にページ先頭が表示され、見出し「THANK YOU FOR YOUR ORDER」がビューポート内にあること | FREQ-77-AC-02 | 「買い物を続ける」と「注文履歴を見る」ボタンの高さが一致すること | FREQ-77-AC-03 | 完了画面のカード・ボタンに角丸（border-radius > 0）が適用されていないこと（丸型アイコンを除く） |
| FREQ-78 | アカウントページの購入履歴タブから遷移する注文詳細ページ（`/account/orders/[id]`）に、注文日時・注文番号・配送ステータス・注文したITEM（購入履歴タブと同じ表示）・支払金額（小計/送料/クーポン値引き/支払金額）・配送先・支払方法（クレジットカード/コンビニ払い/PayPay）を表示すること | FREQ-78-REQ-01 | 注文詳細 API（`/api/orders/[id]`）は注文日時（日本時間・分単位）、支払金額の内訳（小計・送料・クーポン値引き・支払金額）、支払方法（checkout_drafts の payment_method から判定：stripe_card=クレジットカード / stripe_konbini=コンビニ払い / stripe_paypay=PayPay）、各商品の在庫状況を返す。注文詳細ページは注文番号・注文日時・配送ステータス（進捗バー含む）・注文商品（購入履歴タブと同じ表示＝サムネイル/商品名/カラー・サイズ/数量/金額/再購入・予約注文ボタン）・支払金額の内訳・配送先・支払方法を表示すること | FREQ-78-AC-01 | 注文詳細ページに注文番号と注文日時（時刻を含む）が表示されること | FREQ-78-AC-02 | 配送ステータス（進捗バー）とステータスの日本語ラベルが表示されること | FREQ-78-AC-03 | 注文した商品が購入履歴タブと同じ表示（商品名・カラー/サイズ・数量・金額・再購入ボタン）で表示されること | FREQ-78-AC-04 | 支払金額として小計・送料・クーポン値引き・支払金額の4項目が表示されること | FREQ-78-AC-05 | 配送先（氏名・住所）が表示されること | FREQ-78-AC-06 | 支払方法（クレジットカード/コンビニ払い/PayPay のいずれか）が表示されること |
| FREQ-79 | アカウントページの購入履歴タブの各注文カードのヘッダー右側（注文番号・注文日の並びの右端）に、注文詳細ページへ遷移する「注文詳細」ボタンを配置すること | FREQ-79-REQ-01 | 各注文カードのヘッダー行（注文番号・注文日）の右端に共通 Button コンポーネント（FREQ-87 により variant link / size sm のテキストリンク）で「注文詳細」リンクを表示し、リンク先は `/account/orders/{注文ID}` とすること | FREQ-79-AC-01 | 購入履歴タブの各注文カードに「注文詳細」ボタンが表示されること | FREQ-79-AC-02 | 「注文詳細」ボタンのリンク先が `/account/orders/{注文ID}` であること |
| FREQ-80 | 注文詳細ページの配送ステータスバーの先頭（受注の前）に「支払い完了」ステップを追加すること。あわせて重複となるヘッダーの「ステータス」行と「合計（税込・送料込）」行を削除すること | FREQ-80-REQ-01 | 進捗ステップを 支払い完了/受注/発送/配達 の4段階とし、paid・processing・preparing は「受注」まで、shipped は「発送」まで、delivered・completed は「配達」まで完了表示とする。未決済（pending）・キャンセル等は進捗バーを表示しない。注文詳細ヘッダーは注文番号・注文日時のみ表示すること | FREQ-80-AC-01 | 注文詳細ページの進捗バーに「支払い完了」「受注」「発送」「配達」の4ステップが表示され、先頭が「支払い完了」であること | FREQ-80-AC-02 | 決済済み（paid）の注文で「支払い完了」と「受注」が完了表示、「発送」「配達」が未完了表示であること | FREQ-80-AC-03 | 注文詳細ヘッダーに「ステータス」ラベル行が表示されないこと | FREQ-80-AC-04 | 注文詳細ヘッダーに「合計（税込・送料込）」が表示されないこと |
| FREQ-81 | 注文詳細ページをレスポンシブ最適化すること。tablet/PC では横幅を活かし、商品リスト（主）と決済サマリー（従）を黄金比の2カラムで配置する | FREQ-81-REQ-01 | lg（1024px）以上でコンテナを max-w-6xl に拡げ、注文メタ＋進捗バーを全幅ヘッダーとしたうえで、ご注文商品を 61.8%・支払金額/配送先情報/支払方法のサマリーを 38.2% の2カラムグリッドに配置する（サマリーは sticky）。lg 未満は従来どおり1カラム縦積み（商品→支払金額→配送先→支払方法）。カードの padding はモバイル 20px / sm 以上 32px とする | FREQ-81-AC-01 | desktop（1280px）でご注文商品セクションと支払金額セクションが横並び（支払金額の左端がご注文商品の右端より右）であること | FREQ-81-AC-02 | mobile（390px）/ tablet（768px）ではご注文商品の下に支払金額が縦積みで表示されること | FREQ-81-AC-03 | いずれのビューポートでも横スクロールが発生しないこと |
| FREQ-82 | 注文詳細ページの「ご注文商品」の窮屈さを解消すること（画像とテキストの密着、商品名と再購入ボタンの衝突による折返し） | FREQ-82-REQ-01 | 注文詳細ページのルートに account.css の間隔変数スコープ（.account-page）を適用し、商品行の画像・テキスト・行間に購入履歴タブと同じ近接スケール（--gap-*）を効かせる。sm（640px）未満では再購入/予約注文ボタンを商品情報列内（金額の下）にコンテンツ幅で配置し（FREQ-87 により全幅から変更）、商品名の表示幅を確保する。sm 以上は従来どおり右端に配置すること | FREQ-82-AC-01 | 商品サムネイルと商品名テキストの間に 8px 以上の間隔があること | FREQ-82-AC-02 | mobile（390px）で再購入ボタンが商品情報（金額）より下にコンテンツ幅で表示されること | FREQ-82-AC-03 | tablet/desktop では再購入ボタンが商品情報の右側（同じ行）に表示されること |
| FREQ-83 | 注文詳細ページの「配送先情報」と「支払方法」をヘッダー（注文メタ＋進捗バー）直下へ移動し、全幅の横長配置にすること。配送先情報は住所のみ表示し、氏名・メールアドレス・電話番号は表示しないこと | FREQ-83-REQ-01 | ヘッダーカード直下に全幅バンド（sm 以上は 61.8% : 38.2% の2カラム、sm 未満は縦積み）として配送先情報カードと支払方法カードを配置する。右カラムの決済サマリーは支払金額のみとする。配送先情報カードには住所のみ表示すること | FREQ-83-AC-01 | 配送先情報と支払方法がご注文商品セクションより上に表示されること | FREQ-83-AC-02 | sm（640px）以上で配送先情報と支払方法が横並びで表示されること | FREQ-83-AC-03 | 配送先情報に住所のみが表示され、氏名・メールアドレス・電話番号が表示されないこと |
| FREQ-84 | 注文詳細ページの配送ステータスバーがモバイル（iPhone SE 375px 等）でラベルが縦に折り返されて崩れるのを改善すること | FREQ-84-REQ-01 | sm（640px）未満ではステップラベルを丸数字の下に配置（縦積み）し、`whitespace-nowrap` で折返しを禁止する。ステップ間の結線は丸数字の中心高さに揃える。sm 以上は従来どおり丸数字の右にラベルを配置すること | FREQ-84-AC-01 | 375px / 390px でステップラベル（支払い完了/受注/発送/配達）が折り返されず1行で表示されること | FREQ-84-AC-02 | sm 未満でステップラベルが丸数字の下に表示されること | FREQ-84-AC-03 | sm 以上でステップラベルが丸数字の右（同じ行）に表示されること | FREQ-84-AC-04 | 375px で横スクロールが発生しないこと |
| FREQ-85 | 注文詳細ページの「この注文について問い合わせる」ボタンの位置と幅を改善すること（左下に孤立させず、注文サマリーに近接させる） | FREQ-85-REQ-01 | ボタンを右カラムの決済サマリー（支払金額カード）直下に移動し、サマリー幅いっぱい（w-full）で表示する。あわせてページコンテナに w-full を適用し、コンテンツ量によらず設計幅（max-w-4xl / lg:max-w-6xl）まで使用すること | FREQ-85-AC-01 | 「この注文について問い合わせる」ボタンが支払金額セクションの直下に表示されること | FREQ-85-AC-02 | ボタンの幅が支払金額カードと同幅であること | FREQ-85-AC-03 | desktop（1280px）でボタンが右カラム（支払金額と同じ列）に表示されること | FREQ-85-AC-04 | desktop（1280px）でページコンテナが設計幅（1152px）まで拡がること |
| FREQ-86 | 購入履歴タブの注文商品の再購入ボタンを注文詳細ページと同じ仕様に統一し、両画面の注文商品行・再購入処理を共通化すること | FREQ-86-REQ-01 | 注文商品1行の表示（画像・商品名・カラー/サイズ・数量・金額・再購入/予約注文ボタン）を共通コンポーネント OrderItemRow に切り出し、購入履歴タブと注文詳細ページの双方で利用する。再購入処理（/api/cart への追加・実行中状態）は共通フック useReorder に切り出す。ボタンは sm 未満で商品情報列内（金額の下）にコンテンツ幅（FREQ-87 により全幅から変更）、sm 以上で商品情報の右側（w-auto）に配置すること | FREQ-86-AC-01 | 購入履歴タブの mobile（390px）で再購入ボタンが商品情報（金額）より下にコンテンツ幅で表示されること | FREQ-86-AC-02 | 購入履歴タブの tablet/desktop で再購入ボタンが商品情報の右側（同じ行）に表示されること |
| FREQ-87 | 購入履歴タブのモバイル表示で横長ボタンが多く視認性が悪い問題を、デザイン4原則（近接・整列・反復・対比）に基づくアクション階層化で改善すること | FREQ-87-REQ-01 | 注文カード内のアクションを2階層に分離する。枠付きボタン（secondary / sm）は商品単位の商行為（再度購入・予約注文）のみとし、sm 未満では商品情報列内（金額の下）にコンテンツ幅で配置する（近接・整列）。ナビ/サポート導線はテキストリンク（Button variant link / sm）に格下げする（対比）：「注文詳細」はヘッダー右端に矢印アイコン付きで注文番号と baseline 整列、「この注文について問い合わせる」はカード下部に配置。リンクのタップ領域は縦 24px 以上を確保すること | FREQ-87-AC-01 | mobile（390px）の購入履歴タブで「再度購入」ボタンが商品情報列内（金額の下）にコンテンツ幅（商品情報列の全幅でない）で表示されること | FREQ-87-AC-02 | 「注文詳細」と「この注文について問い合わせる」が枠なしのテキストリンク（variant link）として表示されること | FREQ-87-AC-03 | tablet/desktop で「再度購入」ボタンが商品情報の右側（同じ行）に表示されること | FREQ-87-AC-04 | 「注文詳細」「この注文について問い合わせる」リンクのタップ領域の高さが 24px 以上であること |
| FREQ-88 | アカウントページの購入履歴タブを、年別タイムライン表示（年見出し＋縦ライン＋サムネイル/注文番号/合計金額/ステータス/注文日の1行）に変更すること | FREQ-88-REQ-01 | 注文を注文日の年ごとにグループ化し、年見出しと縦ライン（糸モチーフ）を左に配置する。各注文は1行（先頭商品のサムネイル・注文番号・合計金額・ステータス・注文日＋矢印）で表示し、行全体を注文詳細ページ（`/account/orders/{注文ID}`）へのリンクにする。進捗バー・商品明細・再購入ボタン・問い合わせリンクは購入履歴タブから撤去し注文詳細ページへ集約する（FREQ-79・FREQ-86・FREQ-87 の購入履歴タブ側の受け付け基準を置き換え。FR-ACCOUNT-021 / FR-ACCOUNT-022 は廃止） | FREQ-88-AC-01 | 購入履歴タブに注文年（例: 2026）の見出しが表示されること | FREQ-88-AC-02 | 各注文行に注文番号・合計金額・ステータス・注文日が表示されること | FREQ-88-AC-03 | 注文行のリンク先が `/account/orders/{注文ID}` であること | FREQ-88-AC-04 | 購入履歴タブに「再度購入」ボタンおよび商品名の明細行が表示されないこと |
| FREQ-89 | `/login` のログインフォームの Email/Password 入力欄を、下線のみ＋先頭アイコン＋パスワード表示切替のデザインに刷新し、寸法を黄金比で導出すること | FREQ-89-REQ-01 | 共通 TextField に下線のみの shape（`underline`）と右端要素（`trailingIcon`）を追加する。先頭アイコン径は黄金比のテキストボックス高（font-size×√φ、Button の icon-only と同径）とし、入力の左字下げ＝アイコン径＋gap（pad-x/φ）で導出する。ログインの Email/Password をこの shape で表示し、先頭アイコン（Email=ri-mail-line / Password=ri-lock-line）、Password 右端に表示/非表示トグル（ri-eye-off-line↔ri-eye-line）を配置する。下線は resting=black/10・focus=黒、アイコン/プレースホルダは black/20 とすること | FREQ-89-AC-01 | `/login` ログインタブの Email 入力欄先頭にメールアイコン、Password 入力欄先頭に鍵アイコンが表示されること | FREQ-89-AC-02 | 入力欄が四方の枠線ではなく下線のみ（border-bottom のみ）で表示されること | FREQ-89-AC-03 | Password 入力欄の右端に表示切替ボタンがあり、押すと入力 type が password↔text に切り替わること | FREQ-89-AC-04 | 先頭アイコンの表示サイズ（font-size）が入力本文のフォントサイズより大きい（黄金比 √φ 倍相当）こと | FREQ-89-AC-05 | 先頭アイコンの左側とパスワード表示切替ボタンの右側に、黄金比 x/y（font-size÷φ）相当の余白が確保されていること |
| FREQ-90 | `/login` のログイン/会員登録タブを下線デザインにし、外周のグレーのカード枠を撤去すること。タブ内の「会員登録はこちら」「既にアカウントをお持ちの方はこちら」導線を撤去し、タブ切替に一本化すること（FREQ-63 のタブ内切替リンクの受け付け基準を置き換え） | FREQ-90-REQ-01 | タブ（ログイン/会員登録）を背景色ボックスから下線スタイル（選択=黒下線・黒文字／非選択=淡いグレー下線・グレー文字）に変更し、周囲を囲む角丸カード枠（border-black/20・rounded-2xl）を削除する。ログインタブ下部の「会員登録はこちら」ボタン、会員登録タブ下部の「既にアカウントをお持ちの方はこちら」ボタンと関連処理を削除すること | FREQ-90-AC-01 | `/login` のタブ（ログイン/会員登録）がそれぞれ下線（border-bottom）を持ち、タブ群を囲む角丸カード枠（border-radius > 0 の外周枠）が無いこと | FREQ-90-AC-02 | ログインタブに「会員登録はこちら」ボタンが表示されないこと | FREQ-90-AC-03 | 会員登録タブに「既にアカウントをお持ちの方はこちら」ボタンが表示されないこと | FREQ-90-AC-04 | 整列の原則により、タブ（ログイン/会員登録）の左右端が入力欄・ボタンの左右端と同じ列に揃っていること |
| FREQ-91 | 会員登録タブをログインタブと同一のデザインに統一すること（下線＋先頭アイコンの入力欄・パスワード表示切替・配置順・区切りの扱い） | FREQ-91-REQ-01 | 会員登録タブの Email/Password/Password（確認）を下線のみの入力欄（shape=underline）＋先頭アイコン（Email=ri-mail-line / Password・確認=ri-lock-line）にし、Password と Password（確認）に表示/非表示トグル（ri-eye-off-line↔ri-eye-line）を付ける。配置順をログインタブと同じく フォーム → OR → Google（Googleで登録）とし、OR は本文より小さく（xs＋トラッキング）de-emphasize する。ボタンはログインタブと同じ shape（square 既定）・サイズ（xl）に統一すること | FREQ-91-AC-01 | 会員登録タブの Email 入力欄先頭にメールアイコン、Password・Password（確認）入力欄先頭に鍵アイコンが表示されること | FREQ-91-AC-02 | 会員登録タブの各入力欄が下線のみ（border-bottom のみ）で表示されること | FREQ-91-AC-03 | Password・Password（確認）の各入力欄に表示切替ボタンがあり、押すと入力 type が password↔text に切り替わること | FREQ-91-AC-04 | 会員登録タブで「Googleで登録」ボタンが送信ボタン（登録して確認メールを受け取る）より下に配置されること |
| FREQ-92 | パスワード再設定ページ（`/auth/password-reset`）をログインタブと同じ下線ミニマルデザインに刷新すること（FREQ-70 の角丸カードデザインを置換） | FREQ-92-REQ-01 | 角丸カード枠（border・rounded-2xl）を撤去し、Email/新しいパスワードを下線のみの入力欄（shape=underline）＋先頭アイコン（Email=ri-mail-line / New Password=ri-lock-line）にする。新しいパスワードには表示/非表示トグル（ri-eye-off-line↔ri-eye-line）を付け、送信ボタンは直角（square）にする。見出し「パスワード再設定」は acumin-pro 系サンセリフで入力欄より大きく（対比）、コンテンツはログインと同じ列（px-6）に整列すること | FREQ-92-AC-01 | `/auth/password-reset` にタブ群を囲む角丸カード枠が無く（border-width 0・border-radius 0）、送信ボタンが直角（border-radius 0）であること | FREQ-92-AC-02 | Email 入力欄が下線のみ（border-bottom のみ）で表示され、先頭にメールアイコンがあること | FREQ-92-AC-03 | 見出しが acumin-pro 系サンセリフで、入力欄本文より大きいフォントサイズであること |
| FREQ-93 | account ページの配送情報タブの配送先カードを、上部右に「MAIN」バッジ＋郵便番号と住所を1行に結合した表示＋「編集」「削除」ボタンのデザインに変更すること（FR-ACCOUNT-004 の郵便番号/住所を個別ラベル表示していた受け付け基準を置換） | FREQ-93-REQ-01 | メイン（isDefault）の配送先カードは、カード上部右に黒背景・白文字の「MAIN」バッジを配置する（左側のグレー「メイン」ラベルは MAIN バッジと重複するため設けない）。郵便番号と住所（都道府県＋市区町村＋番地＋建物）は個別の「郵便番号」「住所」ラベルを撤去し、半角スペース区切りで1行に結合表示する。操作ボタンは「編集」「削除」とし、非メインの配送先には「メインにする」ボタンを併置すること | FREQ-93-AC-01 | メインの配送先カードの上部右に「MAIN」バッジが表示され、左側に「メイン」ラベルが表示されないこと | FREQ-93-AC-02 | 郵便番号と住所が「981-3351 宮城県富谷市鷹乃杜202号」のように1行に結合表示され、「郵便番号」「住所」の個別ラベルが表示されないこと | FREQ-93-AC-03 | 配送先カードに「編集」ボタンと「削除」ボタンが表示されること |
| FREQ-94 | accountページのお客様情報タブの表示ビューを、ラベル左・値右の1行レイアウトに変更すること | FREQ-94-REQ-01 | TextFieldに`leadingText`（入力左端に文言を置く。WITH ICON パターンの応用）を追加し、お客様情報の表示ビューを shape=underline + leadingText の読み取り専用フィールドで構成すること。氏名・フリガナ・メールアドレス・電話番号を各1行で「ラベル左／値右（右寄せ）」で表示し、各行の下線を区切り線とする。操作は「編集」ボタン1つとする | FREQ-94-AC-01 | お客様情報タブに氏名・フリガナ・メールアドレス・電話番号の各ラベルが左、値が右寄せで表示されること | FREQ-94-AC-02 | 各行が下線（border-bottom）で区切られて表示されること | FREQ-94-AC-03 | 表示ビューに「編集」ボタンが表示され、押すと編集フォームに切り替わること |
| FREQ-95 | accountページのサイドバーと本文（お客様情報等）の間の余白を1段階広げること | FREQ-95-REQ-01 | デスクトップ（768px以上）の`.account-layout` グリッド列間隔を、黄金比スケールで1段階（×√φ）広い `calc(--gap-layout * --sqrt-phi)` にすること | FREQ-95-AC-01 | デスクトップ幅でサイドバーと本文の列間隔（column-gap）が従来の --gap-layout より広く表示されること |
| FREQ-96 | accountページのお客様情報タブの下線フィールドを、クリック/フォーカスしても下線を黒にせずグレーのまま維持すること | FREQ-96-REQ-01 | `.account-profile-view` 内の shape=underline + leadingText フィールドの `:focus-within` 時に、border-bottom-color を黒（--field-border-focus）にせず淡色（--field-border-color）で維持すること | FREQ-96-AC-01 | 氏名などの行をクリック/フォーカスしても下線の色が resting（グレー）と同じで、黒に変化しないこと |
| FREQ-97 | accountページのお客様情報タブの編集フォームを、表示ビューと同じ「ラベル左・値右」の下線フィールドの編集可能デザインに変更すること（従来の枠付きボックス入力＋上部ラベルを置換） | FREQ-97-REQ-01 | 編集フォームを `.account-profile-view` 上で構成し、氏名・フリガナ・メールアドレス・電話番号を shape=underline + leadingText のフィールドで表示すること。氏名・フリガナ・電話番号は編集可能（readOnly なし）、メールアドレスは readOnly を維持する。枠付き `account-card` ボックスは使わない | FREQ-97-AC-01 | 編集ボタン押下後、氏名・フリガナ・電話番号が underline + leadingText の編集可能フィールドで表示されること | FREQ-97-AC-02 | 編集フォームのメールアドレスフィールドは readOnly で編集できないこと | FREQ-97-AC-03 | 編集画面でカーソルがある（フォーカス中の）編集可能フィールドの下線が黒（--field-border-focus）で表示され、フォーカスを外すとグレーに戻ること（readOnly のメールアドレスは黒にならない） | FREQ-97-AC-04 | フォーカス中の編集可能フィールドの左側の見出し文字（leadingText）も下線と同様に黒（--field-fg）で表示され、フォーカスを外すとグレーに戻ること |
| FREQ-98 | accountページの配送情報タブについて、カードデザイン（FREQ-93）の配置はそのまま、フォントサイズ・余白・コンポーネントサイズをデザイン4原則で調整すること | FREQ-98-REQ-01 | 郵便番号を補助情報として `--lk-size-2xs`・#767676・letter-spacing 0.08em の淡色キャプションにし（対比。書式は account-label と同一＝反復）、住所（--lk-size-md 黒）との間隔を `--gap-tight` にする（近接）。MAIN バッジと「MAINにする」ボタンは同幅（モバイル 6rem / 640px以上 7.5rem）・同文字サイズ（--lk-size-xs）にそろえ（整列・反復）、モバイルでは幅を一段狭めて住所の折返しを減らす。「+ 住所を追加」は subtle デザインのまま文字を 10px から --lk-size-xs に、色を #767676（コントラスト4.5:1）に引き上げ、padding-block 0.5rem でタップ領域を 24px 以上にする（対比・WCAG 2.5.8） | FREQ-98-AC-01 | 郵便番号の font-size が住所より小さく、色が #767676 で表示されること | FREQ-98-AC-02 | MAIN バッジと「MAINにする」ボタンの幅および font-size が互いに等しいこと | FREQ-98-AC-03 | 「+ 住所を追加」ボタンの高さが 24px 以上、font-size が 12px 以上であること |
| FREQ-99 | accountページのお客様情報タブのラベル（氏名・フリガナ・メールアドレス・電話番号）のグレーが薄すぎる（TextField underline 既定の rgba(0,0,0,0.2)＝コントラスト1.6:1）ため視認性が低い問題を、WCAG・視認性・他ラベルとの統一の観点で改善すること | FREQ-99-REQ-01 | `.account-profile-view .text-field__leading-text` の色を、当ページの他ラベル（account-label＝郵便番号キャプション・購入履歴の日付など）と同じ #767676 に統一する（WCAG AA コントラスト 4.54:1、視認性向上、反復）。編集フォームでフォーカス中の編集可能フィールドのラベルは従来どおり黒（--field-fg）に上書きされること | FREQ-99-AC-01 | 氏名・フリガナ・メールアドレス・電話番号のラベル色が #767676（rgb(118,118,118)）で表示されること | FREQ-99-AC-02 | ラベル色のコントラスト比が白背景に対して 4.5:1 以上であること | FREQ-99-AC-03 | 編集フォームでフォーカス中の編集可能フィールドのラベルは黒（rgb(0,0,0)）で表示されること |
| FREQ-100 | プライバシーポリシーページに、同業ブランド（HYKE / ssstein / AURALEE）を参考に不足していた法的項目を追加すること | FREQ-100-REQ-01 | 「個人情報の取扱いの委託」「個人情報の保有期間」「個人情報の国外移転」「保有個人データの開示・訂正・利用停止等の請求」「本ポリシーの変更」「お問い合わせ窓口（事業者名・メール窓口）」の各セクションを /privacy に追加すること | FREQ-100-AC-01 | /privacy に見出し「5. 個人情報の取扱いの委託」「6. 個人情報の保有期間」「7. 個人情報の国外移転」「10. 保有個人データの開示・訂正・利用停止等の請求」「11. 本ポリシーの変更」「12. お問い合わせ窓口」が表示されること | FREQ-100-AC-02 | /privacy にお問い合わせ先メール「privacy@lefildesheures.com」が表示されること |
| FREQ-101 | プライバシーポリシー・利用規約ページのフォントサイズと余白を、参照先（HYKE / ssstein / AURALEE）を参考に可読性向上の観点で改善すること | FREQ-101-REQ-01 | 本文（bodyText）に行間 line-height 1.9 を付与し、セクション見出しを `--lk-size-xl`、ページ見出しを `--lk-size-5xl` に拡大し、セクション間の縦余白を `space-y-12` に広げること（/privacy・/terms 共通） | FREQ-101-AC-01 | /privacy と /terms の本文段落の line-height が 1.5 より大きく（1.9 相当）表示されること | FREQ-101-AC-02 | /privacy と /terms のセクション見出し（h2）のフォントサイズが本文段落より大きいこと |
| FREQ-102 | 利用規約 第5条（商品の配送）を、受注生産という実態（在庫あり＝即発送、在庫なし＝一定数の注文がまとまってから製造・完成まで約2ヶ月）に合わせて修正し、特定商取引法に基づく表記（/legal）の引渡時期とも整合させること。「注文確定後3〜7営業日で配送」という在庫販売前提の記載が受注生産の実態および第6条（受注生産のため返品不可）と矛盾している問題を解消する | FREQ-102-REQ-01 | /terms 第5条を、在庫がある場合（注文確定後3〜7営業日以内に発送）と在庫がなく受注生産となる場合（一定数の注文がまとまってから製造開始、注文確定後数週間〜2ヶ月以上で発送）に分けて記載し、発送時期の目安は各商品ページ・注文確定時案内に委ねる旨を明記すること。納期に関する記述は「発送」、届ける行為・遅延は「配送」で用語を使い分けること | FREQ-102-REQ-02 | /legal の「商品の引渡時期」を第5条と同一内容（在庫あり3〜7営業日、受注生産は数週間〜2ヶ月以上）に更新し、プレースホルダ「◯営業日以内（※日数 要記入）」を解消すること | FREQ-102-AC-01 | /terms 第5条に「受注生産」「在庫がある場合」「在庫がなく受注生産となる場合」「約2ヶ月」の文言が表示されること | FREQ-102-AC-02 | /terms 第5条に「3〜7営業日」が表示され、かつ在庫がある場合の条件として提示されていること | FREQ-102-AC-03 | /legal の「商品の引渡時期」に「◯営業日」「要記入」の文字列が表示されないこと | FREQ-102-AC-04 | /legal の「商品の引渡時期」に「3〜7営業日」および「2ヶ月」が表示されること |
| FREQ-103 | 特定商取引法に基づく表記（/legal）を同業ブランド（ssstein / HYKE / AURALEE）の記載を参考に見直し、税の二重計上を解消して不足項目を補うこと | FREQ-103-REQ-01 | 販売価格を「消費税込み」と表記している以上、「商品代金以外の必要料金」に消費税を重複して列挙しないこと | FREQ-103-REQ-02 | 参考3社が独立項目としている「送料」を独立の行として表示すること | FREQ-103-REQ-03 | コンビニ決済の未入金時キャンセル運用を「申込の有効期限」項目として追加すること | FREQ-103-AC-01 | /legal に「送料」という独立したラベル行が表示されること | FREQ-103-AC-02 | /legal に「申込の有効期限」ラベル行が表示され、コンビニ決済・キャンセルに言及していること | FREQ-103-AC-03 | /legal の「商品代金以外の必要料金」の値に「消費税」の文字列が含まれないこと |
| FREQ-104 | 特定商取引法に基づく表記（/legal）を、送料込み販売（送料無料）・決済手数料の負担区分（コンビニ決済手数料はお客様負担、クレジットカード / PayPay 等その他の決済手数料は当社負担）・今後提供予定の試着サービス料金の方針に合わせて更新すること。これに伴い送料を独立行として表示する運用（FREQ-103-REQ-02 / FREQ-103-AC-01）を廃止する | FREQ-104-REQ-01 | /legal の「商品以外の必要代金」欄に、送料は無料（商品価格に含む）・コンビニ決済をご利用の場合はコンビニ決済手数料をお客様が負担・クレジットカード / PayPay 等その他の決済手数料は当社が負担・今後提供予定の試着サービス利用時は往復配送料 / クリーニング代等を含む所定の試着サービス料金を別途申し受ける旨を記載し、独立した「送料」行は設けないこと | FREQ-104-REQ-02 | /legal の「販売価格」欄に、表示価格が消費税込みである旨を明記すること | FREQ-104-AC-01 | /legal の「商品以外の必要代金」の値に、送料が無料（商品価格に含む）である旨が表示されること | FREQ-104-AC-02 | /legal の「商品以外の必要代金」の値に、コンビニ決済手数料をお客様が負担する旨が表示されること | FREQ-104-AC-03 | /legal の「商品以外の必要代金」の値に、試着サービスの料金を別途申し受ける旨が表示されること | FREQ-104-AC-04 | /legal に独立した「送料」ラベル行（dt が「送料」のみ）が表示されないこと | FREQ-104-AC-05 | /legal の「販売価格」の値に「消費税込み」が表示されること |
| FREQ-105 | 特定商取引法に基づく表記（/legal）の「支払方法」と「支払時期」を1項目に統合し、当社が採用する各決済手段（クレジットカード / PayPay / コンビニ決済）ごとに支払時期を明記すること | FREQ-105-REQ-01 | /legal の「支払方法・支払時期」欄に、クレジットカード決済＝ご注文時に確定、PayPay＝ご注文時に確定、コンビニ決済＝発行される払込番号の期限（ご注文から7日以内）までにお支払い、を各手段ごとに表示し、独立した「支払方法」「支払時期」行は設けないこと（代金引換は非対応のため記載しない） | FREQ-105-AC-01 | /legal に「支払方法・支払時期」ラベル行が表示されること | FREQ-105-AC-02 | 値にクレジットカード・PayPay・コンビニ決済それぞれの支払時期が表示されること | FREQ-105-AC-03 | /legal に独立した「支払時期」ラベル行（dt が「支払時期」のみ）が表示されないこと |
| FREQ-106 | コンビニ決済の払込期限を7日に設定すること（Stripe デフォルト3日は短く離脱・キャンセルを招くため、他社EC の一般的な前払い期限＝7日前後に合わせる）。Stripe 設定と /legal の表記を同一日数に揃えること | FREQ-106-REQ-01 | Stripe Checkout セッション作成時に `payment_method_options.konbini.expires_after_days` を 7 に設定すること（custom UI / hosted の両セッション生成箇所）。定数で一元管理し /legal の文言と同期する旨をコメントで明記すること | FREQ-106-REQ-02 | /legal の「支払方法・支払時期」および「申込の有効期限」のコンビニ決済期限を「ご注文から7日以内」に統一表記すること | FREQ-106-AC-01 | /legal の「支払方法・支払時期」の値に、コンビニ決済の期限として「7日以内」が表示されること | FREQ-106-AC-02 | /legal の「申込の有効期限」の値に「7日以内」が表示されること |
| FREQ-107 | /legal の独立項目「申込の有効期限」を廃止し、その内容（コンビニ決済の未入金時キャンセル運用）を「支払方法・支払時期」欄のコンビニ決済の直下に統合すること。これに伴い独立行の表示を前提とした FREQ-103-AC-02 / FREQ-106-AC-02 を置き換える | FREQ-107-REQ-01 | 「支払方法・支払時期」欄のコンビニ決済期限の直下に、ご注文後7日以内にお支払い（入金）が確認できない場合はご注文をキャンセルすることがある旨を記載し、独立した「申込の有効期限」行は設けないこと | FREQ-107-AC-01 | /legal に独立した「申込の有効期限」ラベル行（dt が「申込の有効期限」のみ）が表示されないこと | FREQ-107-AC-02 | /legal の「支払方法・支払時期」の値に、コンビニ決済の未入金時（7日以内）にキャンセルすることがある旨が表示されること |
| FREQ-108 | /legal「支払方法・支払時期」のコンビニ決済の未入金時キャンセル注記（※）を、本文より小さいフォント・淡色のフットノートとして視覚的に de-emphasize すること（注記であることが一目で伝わるよう対比を付ける） | FREQ-108-REQ-01 | 当該注記を本文（--lk-size-xs）より小さい --lk-size-2xs、色 #767676（白背景に対しコントラスト4.5:1以上）の独立ブロックで、直前のコンビニ決済期限行の直下に配置すること | FREQ-108-AC-01 | 当該※注記の font-size が同一 dd の本文より小さいこと | FREQ-108-AC-02 | 当該※注記の文字色が #767676（rgb(118,118,118)）で表示されること |
| FREQ-109 | /legal の「返品・交換・キャンセルについて」を、原則不可＋初期不良（定義付き）例外・返品送料の負担区分・返品不可となる具体的ケース一覧・自社受注生産（天然素材の風合い）を踏まえた良品範囲・返品期限（7日）を含む詳細な内容に改善すること。再販業者向けの「メーカー品質基準／国内正規代理店の検査基準」表現は自社ブランドに合わせて改文すること | FREQ-109-REQ-01 | 原則として申込撤回・返品・交換不可、初期不良（仕様上の不具合／誤配送）に限り商品到着後7日以内の連絡で返品・交換対応、使用済み・タグ/付属品欠品等は不可、を明記すること | FREQ-109-REQ-02 | 返品送料は原則お客様負担、当社の責めに帰すべき場合は当社負担、を明記すること | FREQ-109-REQ-03 | 返品・交換不可となるケースを箇条書き（7日以上経過／使用済み／破損・汚損／加工・修理／付属品の汚損・破損・紛失）で列挙すること | FREQ-109-REQ-04 | 天然素材特有の風合い（細かな傷・色むら・黒点等）を良品として扱う旨、および返品期限（7日・未使用でも超過不可・サイズ交換は未使用/在庫ありに限る・送料お客様負担）を明記すること | FREQ-109-AC-01 | /legal の「返品・交換・キャンセルについて」の値に「初期不良」「7日以内」が表示されること | FREQ-109-AC-02 | 同値に返品送料がお客様負担である旨と、当社の責めに帰すべき場合は当社負担である旨が表示されること | FREQ-109-AC-03 | 同値に返品・交換不可のケースが箇条書き（li 5項目以上）で表示されること | FREQ-109-AC-04 | 同値に「返品期限」の見出しと「サイズ交換」に関する記載が表示されること | FREQ-109-AC-05 | 同値に「国内正規代理店」の文字列が含まれないこと |
