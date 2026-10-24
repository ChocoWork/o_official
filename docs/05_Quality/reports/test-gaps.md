# 試験の穴

> 状態: 自動生成 | 生成日: 2026-10-24 | 対象: NEWS

## 概要

試験が足りない項目、名前に ID の無い試験、分岐の網羅で届かない所を並べた表。

`npm run trace:report` が作る。手で直さない（「届かない分岐」の節だけは手で書き、生成し直しても残る）。

## 試験の足りない項目

| 項目 | 足りない試験 | 場所 |
| --- | --- | --- |
| FREQ-14-AC-01 ニュースの管理でエラーが出ず登録・編集・削除が終わる | E2E | `docs/02_Requirements/areas/news.md:807` |
| FREQ-31-AC-01 一覧に h1「NEWS」が無い | E2E | `docs/02_Requirements/areas/news.md:820` |
| FREQ-32-AC-01 記事カードに img が無い | E2E | `docs/02_Requirements/areas/news.md:833` |
| FREQ-47-AC-01 モバイル・タブレットで FILTER ボタンの文字が ITEM と一致する | E2E | `docs/02_Requirements/areas/news.md:859` |
| FREQ-48-AC-01 選択肢の gap が ITEM と一致する | E2E | `docs/02_Requirements/areas/news.md:872` |
| FREQ-48-AC-02 選択肢の字間が ITEM と一致する | E2E | `docs/02_Requirements/areas/news.md:885` |
| FREQ-49-AC-01 lg・xl・2xl で本文の列の左 padding が ITEM と一致する | E2E | `docs/02_Requirements/areas/news.md:898` |
| FREQ-119-AC-01 デスクトップで4ページのサイドバーの幅が一致する | E2E | `docs/02_Requirements/areas/news.md:911` |
| FREQ-119-AC-02 デスクトップで4ページの本文の左の余白が一致する | E2E | `docs/02_Requirements/areas/news.md:924` |
| FREQ-126-AC-01 ITEMS の見出しの右に /item への VIEW ALL がある | E2E | `docs/02_Requirements/areas/news.md:937` |
| FREQ-126-AC-02 LOOK の見出しの右に /look への VIEW ALL がある | E2E | `docs/02_Requirements/areas/news.md:950` |
| FREQ-126-AC-03 NEWS の見出しの右に /news への VIEW ALL がある | E2E | `docs/02_Requirements/areas/news.md:963` |
| FREQ-126-AC-04 下の中央の VIEW ALL ボタンが無い | E2E | `docs/02_Requirements/areas/news.md:976` |
| FREQ-146-AC-01 VIEW ALL に data-ui-button と secondary が付く | E2E | `docs/02_Requirements/areas/news.md:989` |
| FREQ-146-AC-02 VIEW ALL に右矢印のアイコンが無い | E2E | `docs/02_Requirements/areas/news.md:1002` |
| FREQ-149-AC-01 390・768・1280px で NEWS が最大6件出る | E2E | `docs/02_Requirements/areas/news.md:1015` |
| FREQ-149-AC-02 総数が6件以下なら VIEW ALL が無く、多ければある | E2E | `docs/02_Requirements/areas/news.md:1028` |
| FREQ-185-AC-01 /api/search の画像の URL が署名つきの形になっている | E2E | `docs/02_Requirements/areas/news.md:1041` |
| FREQ-185-AC-02 3つの幅で検索の結果の画像が読み込まれる | E2E | `docs/02_Requirements/areas/news.md:1054` |
| FREQ-252-AC-01 作成と編集のフォームに画像の欄と file の入力がある | E2E | `docs/02_Requirements/areas/news.md:1067` |
| FREQ-252-AC-02 作る時に画像が無いと送らず、直す時は画像なしで更新できる | E2E | `docs/02_Requirements/areas/news.md:1080` |
| FREQ-252-AC-03 種類の外・5MB 超はそれぞれの文言で断る | E2E | `docs/02_Requirements/areas/news.md:1093` |
| FREQ-274-AC-01 1920px で左のフィルターの左端が 40px 以内にある | E2E | `docs/02_Requirements/areas/news.md:1106` |
| FREQ-274-AC-02 1280px で左のフィルターの左端が 40px 以内にある | E2E | `docs/02_Requirements/areas/news.md:1119` |
| FREQ-275-AC-01 3つの幅で5つの見出しの文字の大きさが同じ | E2E | `docs/02_Requirements/areas/news.md:1132` |
| FREQ-275-AC-02 390・768px で 20px、1280px で 28px | E2E | `docs/02_Requirements/areas/news.md:1145` |
| FREQ-275-AC-03 3つの幅で5つの見出しに下線がある | E2E | `docs/02_Requirements/areas/news.md:1158` |
| FR-NEWS-ALL-001-AC-01 一覧の記事が公開日の新しい順に並ぶ | E2E | `docs/02_Requirements/areas/news.md:1175` |
| FR-NEWS-ALL-001-AC-02 非公開の記事が一覧に出ない | E2E | `docs/02_Requirements/areas/news.md:1187` |
| FR-NEWS-ALL-002-AC-01 7つの分類の選択肢が出る | E2E | `docs/02_Requirements/areas/news.md:1199` |
| FR-NEWS-ALL-002-AC-02 分類を選ぶとその分類の記事だけが出る | E2E | `docs/02_Requirements/areas/news.md:1211` |
| FR-NEWS-ALL-002-AC-03 ALL を選ぶと全部の記事が出る | E2E | `docs/02_Requirements/areas/news.md:1223` |
| FR-NEWS-ALL-003-AC-01 分類を選ぶと URL の category に出る | E2E | `docs/02_Requirements/areas/news.md:1235` |
| FR-NEWS-ALL-003-AC-02 category 付きの URL を開くとその分類が選ばれている | E2E | `docs/02_Requirements/areas/news.md:1247` |
| FR-NEWS-ALL-004-AC-01 カードに公開日・分類・題・概要が出る | E2E | `docs/02_Requirements/areas/news.md:1259` |
| FR-NEWS-ALL-004-AC-02 カードを押すとその記事の詳細が出る | E2E | `docs/02_Requirements/areas/news.md:1271` |
| FR-NEWS-ALL-005-AC-01 category 付きで開くとその分類の記事だけが出る | E2E | `docs/02_Requirements/areas/news.md:1283` |
| FR-NEWS-ALL-006-AC-01 一覧の title と description が出る | E2E | `docs/02_Requirements/areas/news.md:1295` |
| FR-NEWS-ALL-007-AC-01 分類を変えた後に戻ると前の選択に戻る | E2E | `docs/02_Requirements/areas/news.md:1307` |
| FR-NEWS-ALL-007-AC-02 詳細から戻ると一覧の選択が残っている | E2E | `docs/02_Requirements/areas/news.md:1319` |
| FR-NEWS-DETAIL-001-AC-01 公開済みの記事の詳細に題が出る | E2E | `docs/02_Requirements/areas/news.md:1331` |
| FR-NEWS-DETAIL-001-AC-02 無い記事・非公開の記事の詳細は 404 | E2E | `docs/02_Requirements/areas/news.md:1343` |
| FR-NEWS-DETAIL-002-AC-01 題・公開日・分類・本文が出る | E2E | `docs/02_Requirements/areas/news.md:1355` |
| FR-NEWS-DETAIL-003-AC-01 前後のリンクと VIEW ALL が出て、VIEW ALL で一覧へ移る | E2E | `docs/02_Requirements/areas/news.md:1367` |
| FR-NEWS-DETAIL-004-AC-01 category 付きの詳細では VIEW ALL と前後に同じ category が付く | E2E | `docs/02_Requirements/areas/news.md:1379` |
| FR-NEWS-DETAIL-004-AC-02 正しくない category は ALL として扱う | E2E | `docs/02_Requirements/areas/news.md:1391` |
| FR-NEWS-DETAIL-005-AC-01 詳細の title に NEWS を含み、description が空でない | E2E | `docs/02_Requirements/areas/news.md:1403` |
| FR-NEWS-DETAIL-006-AC-01 一覧へのリンクと分類の一覧へのリンクが出る | E2E | `docs/02_Requirements/areas/news.md:1415` |
| FR-NEWS-DETAIL-007-AC-01 前後のリンクに行き先の題を含む aria-label が付く | E2E | `docs/02_Requirements/areas/news.md:1427` |
| FR-NEWS-DETAIL-008-AC-01 本文が段落ごとの p で出る | E2E | `docs/02_Requirements/areas/news.md:1439` |
| FR-ADMIN-003-AC-01 NEWS タブに記事の一覧が出る | E2E | `docs/02_Requirements/areas/news.md:1451` |
| FR-ADMIN-003-AC-02 作った記事が一覧に出る | E2E | `docs/02_Requirements/areas/news.md:1463` |
| FR-ADMIN-003-AC-03 直した内容が一覧に出る | E2E | `docs/02_Requirements/areas/news.md:1475` |
| FR-ADMIN-003-AC-04 消した記事が一覧から消える | E2E | `docs/02_Requirements/areas/news.md:1487` |
| FR-ADMIN-003-AC-05 公開・非公開を切り替えると状態の表示が変わる | E2E | `docs/02_Requirements/areas/news.md:1499` |
| SEC-NEWS-001-AC-01 anon と一般会員の直接の読み出しに非公開の記事が出ない | E2E | `docs/02_Requirements/areas/news.md:1526` |
| SEC-NEWS-001-AC-02 公開の画面・API・検索に非公開の記事が出ない | E2E | `docs/02_Requirements/areas/news.md:1538` |
| SEC-NEWS-002-AC-01 aal1 の session では非公開の記事を直接読めない | E2E | `docs/02_Requirements/areas/news.md:1563` |
| SEC-NEWS-002-AC-02 aal1 の session では記事を直接書き換え・消去できない | E2E | `docs/02_Requirements/areas/news.md:1575` |
| SEC-NEWS-002-AC-03 ログアウトした session の token では news_articles を直接読めない | E2E | `docs/02_Requirements/areas/news.md:1587` |
| SEC-NEWS-003-AC-01 移行だけを当てた DB で置き場が非公開になる | E2E | `docs/02_Requirements/areas/news.md:1612` |
| SEC-NEWS-003-AC-02 公開の URL では記事の画像を開けない | E2E | `docs/02_Requirements/areas/news.md:1624` |
| SEC-NEWS-004-AC-01 署名つき URL の期限が1時間以下 | E2E | `docs/02_Requirements/areas/news.md:1649` |
| SEC-NEWS-004-AC-02 最適化の画像のキャッシュが署名の期限を超えない | E2E | `docs/02_Requirements/areas/news.md:1661` |
| SEC-NEWS-005-AC-01 /api/news の応答に image_url が無い | E2E | `docs/02_Requirements/areas/news.md:1686` |
| SEC-NEWS-005-AC-02 公開の一覧と詳細の頁に署名つき URL が無い | E2E | `docs/02_Requirements/areas/news.md:1698` |
| SEC-NEWS-006-AC-01 /api/news の成功の応答に no-store が付く | E2E | `docs/02_Requirements/areas/news.md:1723` |
| SEC-NEWS-006-AC-02 /api/news の失敗と回数の制限の応答に no-store が付く | E2E | `docs/02_Requirements/areas/news.md:1735` |
| SEC-NEWS-007-AC-01 news/ の外の道筋には署名しない | E2E | `docs/02_Requirements/areas/news.md:1760` |
| SEC-NEWS-007-AC-02 別のホストの URL には署名しない | E2E | `docs/02_Requirements/areas/news.md:1772` |
| SEC-NEWS-008-AC-01 署名の失敗で元の値を返さない | E2E | `docs/02_Requirements/areas/news.md:1797` |
| SEC-NEWS-008-AC-02 署名の失敗が記録に1件残る | E2E | `docs/02_Requirements/areas/news.md:1809` |
| SEC-NEWS-009-AC-01 /api/news は20件を超えて返さない | E2E | `docs/02_Requirements/areas/news.md:1834` |
| SEC-NEWS-009-AC-02 /api/news は10分に61回目を断る | E2E | `docs/02_Requirements/areas/news.md:1846` |
| SEC-NEWS-009-AC-03 公開の一覧の取り出しは上限を渡さなくても上限で止まる | E2E | `docs/02_Requirements/areas/news.md:1858` |
| SEC-NEWS-009-AC-04 詳細の前後の取り出しは公開済みの全部を読まない | E2E | `docs/02_Requirements/areas/news.md:1870` |
| SEC-NEWS-010-AC-01 anon の search_news は大きな件数を求めても上限で止まる | E2E | `docs/02_Requirements/areas/news.md:1895` |
| SEC-NEWS-010-AC-02 anon は search_public_news を呼べない | E2E | `docs/02_Requirements/areas/news.md:1907` |
| SEC-NEWS-011-AC-01 x-forwarded-for を変えても61回目を断る | E2E | `docs/02_Requirements/areas/news.md:1932` |
| SEC-NEWS-012-AC-01 /api/news は許可の一覧に無い分類を取り出しに渡さない | E2E | `docs/02_Requirements/areas/news.md:1957` |
| SEC-NEWS-012-AC-02 数でない記事の id は 404 になる | E2E | `docs/02_Requirements/areas/news.md:1969` |
| SEC-NEWS-012-AC-03 編集のページは数でない id で窓口へ要求を送らない | E2E | `docs/02_Requirements/areas/news.md:1981` |
| SEC-NEWS-013-AC-01 本文の HTML の印は文字として出る | E2E | `docs/02_Requirements/areas/news.md:2006` |
| SEC-NEWS-013-AC-02 Markdown の javascript: のリンクは href にならない | E2E | `docs/02_Requirements/areas/news.md:2018` |
| SEC-NEWS-014-AC-01 別のサイトの Origin の書き換えを断る | E2E | `docs/02_Requirements/areas/news.md:2045` |
| SEC-NEWS-014-AC-02 Origin も Referer も無い削除を断る | E2E | `docs/02_Requirements/areas/news.md:2057` |
| SEC-NEWS-015-AC-01 権限の無い利用者は管理の一覧を読めない | E2E | `docs/02_Requirements/areas/news.md:2082` |
| SEC-NEWS-015-AC-02 aal1 の session は管理の窓口で断られる | E2E | `docs/02_Requirements/areas/news.md:2094` |
| SEC-NEWS-015-AC-03 読むだけの権限では記事を変えられない | E2E | `docs/02_Requirements/areas/news.md:2106` |
| SEC-NEWS-016-AC-01 記事を作ると監査の記録が1件残る | E2E | `docs/02_Requirements/areas/news.md:2131` |
| SEC-NEWS-016-AC-02 存在しない記事への書き換えは 404 で成功と記録しない | E2E | `docs/02_Requirements/areas/news.md:2143` |
| SEC-NEWS-017-AC-01 画像と偽った HTML を断る | E2E | `docs/02_Requirements/areas/news.md:2168` |
| SEC-NEWS-017-AC-02 直す時の保存の名前は確かめた種類の拡張子になる | E2E | `docs/02_Requirements/areas/news.md:2180` |
| SEC-NEWS-017-AC-03 5MB を超える画像を断る | E2E | `docs/02_Requirements/areas/news.md:2192` |
| SEC-NEWS-018-AC-01 記事を消すと画像も置き場から消える | E2E | `docs/02_Requirements/areas/news.md:2217` |
| SEC-NEWS-018-AC-02 画像を差し替えると前の画像が置き場から消える | E2E | `docs/02_Requirements/areas/news.md:2229` |
| SEC-NEWS-018-AC-03 作成の失敗で上げた画像が残らない | E2E | `docs/02_Requirements/areas/news.md:2241` |
| SEC-NEWS-019-AC-01 /api/news の失敗の応答は固定の文だけ | E2E | `docs/02_Requirements/areas/news.md:2266` |
| SEC-NEWS-019-AC-02 失敗の記録に鍵と token が含まれない | E2E | `docs/02_Requirements/areas/news.md:2278` |
| SEC-NEWS-020-AC-01 管理の一覧の取得の失敗を0件と別に表示する | E2E | `docs/02_Requirements/areas/news.md:2303` |
| SEC-NEWS-020-AC-02 管理の1件の取得は DB の失敗を 404 にしない | E2E | `docs/02_Requirements/areas/news.md:2315` |
| SEC-NEWS-020-AC-03 公開の一覧の取り出しの失敗が記録に残る | E2E | `docs/02_Requirements/areas/news.md:2327` |
| SEC-NEWS-021-AC-01 決めた回数を超えた作成を断る | E2E | `docs/02_Requirements/areas/news.md:2352` |
| SEC-NEWS-022-AC-01 anon は news_articles を空にも書き換えもできない | E2E | `docs/02_Requirements/areas/news.md:2377` |
| SEC-NEWS-023-AC-01 別のプロジェクトの画像を最適化に通さない | E2E | `docs/02_Requirements/areas/news.md:2402` |
| SEC-NEWS-024-AC-01 NEWS の頁と API に守りの見出しが付く | E2E | `docs/02_Requirements/areas/news.md:2427` |
| SEC-NEWS-025-AC-01 長すぎる題と置き場の外の道を表が断る | E2E | `docs/02_Requirements/areas/news.md:2452` |

## 名前に ID の無い試験

| 段 | 場所 | 名前 |
| --- | --- | --- |
| e2e | `e2e/FR-NEWS-ALL-001-published-news-order.spec.ts:6` | 公開済みニュースが公開日降順で表示される |
| e2e | `e2e/FR-NEWS-ALL-002-category-filter-options.spec.ts:6` | ALLを含むカテゴリ絞り込みUIが提供される |
| e2e | `e2e/FR-NEWS-ALL-003-category-query-sync.spec.ts:6` | カテゴリ選択が category クエリに反映される |
| e2e | `e2e/FR-NEWS-ALL-004-news-card-content-and-navigation.spec.ts:6` | 記事カードが必要情報を表示し、クリックで詳細へ遷移する |
| e2e | `e2e/FR-NEWS-ALL-005-server-category-filter.spec.ts:6` | category クエリ指定時に一覧記事が指定カテゴリのみになる |
| e2e | `e2e/FR-NEWS-ALL-006-news-metadata.spec.ts:4` | ニュース一覧ページの title / description が設定されている |
| e2e | `e2e/FR-NEWS-ALL-007-category-history-restore.spec.ts:6` | ブラウザ戻るでカテゴリ絞り込み状態が復元される |
| e2e | `e2e/FR-NEWS-ALL-007-detail-back-filter-restore.spec.ts:4` | 単一カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される |
| e2e | `e2e/FR-NEWS-ALL-007-detail-back-filter-restore.spec.ts:19` | 複数カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される |
| e2e | `e2e/FR-NEWS-ALL-008-mobile-filter-initial-offset.spec.ts:6` | 初期表示でフィルターバーがヘッダー直下に収まり、先頭記事と重ならない |
| e2e | `e2e/FR-NEWS-ALL-009-mobile-filter-scroll-gap.spec.ts:78` | sm 幅で Header と FILTER バーの間に隙間が出ない |
| e2e | `e2e/FR-NEWS-ALL-009-mobile-filter-scroll-gap.spec.ts:95` | md 幅で Header と FILTER バーの間に隙間が出ない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:146` | 390px 幅で Header の隠れアニメーション中も FILTER バーが追従する |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:160` | 390px 幅で Header が隠れる前に FILTER バーが先に動かない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:174` | sm 幅で Header の隠れアニメーション中も FILTER バーが追従する |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:188` | md 幅で Header の隠れアニメーション中も FILTER バーが追従する |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:202` | md 幅で Header が隠れる前に FILTER バーが先に動かない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:216` | 390px 幅の wheel スクロールでも Header と FILTER バーが分離しない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:230` | md 幅の wheel スクロールでも Header と FILTER バーが分離しない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:244` | iPhone 12 エミュレーションでも Header の隠れアニメーション中に FILTER バーが分離しない |
| e2e | `e2e/FR-NEWS-ALL-010-mobile-filter-motion-phase.spec.ts:266` | iPad エミュレーションでも Header の隠れアニメーション中に FILTER バーが分離しない |
| e2e | `e2e/FR-NEWS-ALL-011-desktop-filter-initial-position.spec.ts:38` | laptop 幅でフィルター開始位置が Header 直下から過度に離れない |
| e2e | `e2e/FR-NEWS-ALL-011-desktop-filter-initial-position.spec.ts:55` | desktop 幅でフィルター開始位置が Header 直下から過度に離れない |
| e2e | `e2e/FR-NEWS-ALL-012-no-page-title.spec.ts:16` | ${vp.name} (${vp.width}px): ページ見出し h1「NEWS」が存在しない |
| e2e | `e2e/FR-NEWS-ALL-013-no-card-image.spec.ts:16` | ${vp.name} (${vp.width}px): 記事カード内に img が存在しない |
| e2e | `e2e/FR-NEWS-ALL-014-filter-button-matches-item.spec.ts:21` | NEWS の FILTER ボタンの文字サイズ・字間が ITEM と一致 |
| e2e | `e2e/FR-NEWS-ALL-015-filter-options-match-item.spec.ts:24` | desktop: 選択肢の gap と letter-spacing が ITEM と一致 |
| e2e | `e2e/FR-NEWS-ALL-016-filter-content-gap-matches-item.spec.ts:15` | NEWS のコンテンツ列の左 padding が ITEM と一致 |
| e2e | `e2e/FR-NEWS-ALL-017-desktop-filter-left-edge.spec.ts:17` | desktop（1280px）でフィルターが画面左端に寄っている |
| e2e | `e2e/FR-NEWS-ALL-017-desktop-filter-left-edge.spec.ts:25` | wide desktop（1920px）でもフィルターが画面左端に寄っている |
| e2e | `e2e/FR-NEWS-ALL-017-desktop-filter-left-edge.spec.ts:33` | mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない |
| e2e | `e2e/FR-NEWS-DETAIL-001-published-news-detail-display.spec.ts:5` | 公開済みニュース記事の詳細ページを表示できる |
| e2e | `e2e/FR-NEWS-DETAIL-002-detail-content-elements.spec.ts:5` | タイトル・公開日・カテゴリタグ・本文を表示する |
| e2e | `e2e/FR-NEWS-DETAIL-003-detail-navigation-links.spec.ts:5` | 前後記事ナビゲーションと一覧遷移を提供する |
| e2e | `e2e/FR-NEWS-DETAIL-004-category-query-navigation.spec.ts:5` | categoryクエリで同カテゴリ遷移を維持し、無効値はALL扱いにする |
| e2e | `e2e/FR-NEWS-DETAIL-005-metadata.spec.ts:5` | generateMetadataでtitleとdescriptionを設定する |
| e2e | `e2e/FR-NEWS-DETAIL-006-breadcrumb-or-category-link.spec.ts:5` | 現在位置把握とカテゴリ移動のためのリンクを提供する |
| e2e | `e2e/FR-NEWS-DETAIL-007-navigation-aria-labels.spec.ts:5` | 前後リンクにaria-labelを付与する |
| e2e | `e2e/FR-NEWS-DETAIL-008-content-paragraph-rendering.spec.ts:5` | 本文を段落構造でレンダリングする |

## 届かない分岐

手書きの節。分岐の網羅で届かない所を、1行に1件「- `場所:行` 理由。確認: 未」の形で書く。生成し直しても残る。

- `src/app/admin/news/NewsForm.tsx:253` の `NewsForm` の画像の欄の onClick の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。file の入力は押される枠そのものの子で、枠が描かれている間は ref が必ず入っているため。確認: 未
- `src/app/admin/news/NewsForm.tsx:257` の `NewsForm` の画像の欄の onKeyDown（Enter・Space）の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。理由は onClick と同じ。確認: 未
- `src/app/api/admin/news/[id]/route.ts:39` の `logNewsAudit` の引数 `resourceId` の既定値 `= null` は通らない。ファイルの中の呼び出し7か所が全部 `id` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:55` の `parseCategorySelection` の引数 `fallback` の既定値 `= "ALL"` は通らない。呼び出し2か所（初めの状態と URL の読み直しの effect）が全部 `catalogProps.initialCategory ?? "ALL"` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:127` の `syncCategoryQuery` の `variant !== "catalog"` の早期の戻りは通らない。呼ぶのは `applyCategorySelection` だけで、それを受ける `MultiSelect` は catalog の描画にしか出ず、home で呼ばれないため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:275` の `renderCategoryFilter` の引数 `size` の既定値 `= "3xs"` は通らない。呼び出し2か所が `"xs"` と `"3xs"` を必ず渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:452` の `PublicNewsGrid` の home の VIEW ALL の判断の `fetchLimit ?? 6` の右側は通らない。home では `fetchLimit` が `props.fetchLimit ?? 6` で必ず数になるため。確認: 未
