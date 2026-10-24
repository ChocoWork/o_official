# 試験の穴

> 状態: 自動生成 | 生成日: 2026-10-24 | 対象: NEWS・HOME・LOOK・ABOUT・STOCKIST・SEARCH・PRIVACY・AUTH・ADMIN

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
| FREQ-147-AC-01 390・768px で ITEM が最大6件出る | E2E | `docs/02_Requirements/areas/home.md:607` |
| FREQ-147-AC-02 1280px で ITEM が最大10件出る | E2E | `docs/02_Requirements/areas/home.md:620` |
| FREQ-147-AC-03 総数が表示数以下の幅では ITEM の VIEW ALL が無く、多ければある | E2E | `docs/02_Requirements/areas/home.md:633` |
| FREQ-148-AC-01 390・768px で LOOK が最大6件出る | E2E | `docs/02_Requirements/areas/home.md:646` |
| FREQ-148-AC-02 1280px で LOOK が最大8件出る | E2E | `docs/02_Requirements/areas/home.md:659` |
| FREQ-148-AC-03 総数が表示数以下の幅では LOOK の VIEW ALL が無く、多ければある | E2E | `docs/02_Requirements/areas/home.md:672` |
| FREQ-278-AC-01 3つの幅で h1 が1文字1つの span に分かれ、動きの後は全部見える | E2E | `docs/02_Requirements/areas/home.md:685` |
| FREQ-278-AC-02 3つの幅で縦線の動きの名前が threadDraw | E2E | `docs/02_Requirements/areas/home.md:698` |
| FREQ-278-AC-03 3つの幅で h1 の字の大きさが 6xl の算出値と同じ | E2E | `docs/02_Requirements/areas/home.md:711` |
| FREQ-278-AC-04 名前が「Le Fil des Heures」の見出しがちょうど1つ | E2E | `docs/02_Requirements/areas/home.md:724` |
| FREQ-278-AC-05 動きを減らす設定で文字は最初から見え、縦線は止まる | E2E | `docs/02_Requirements/areas/home.md:737` |
| FREQ-278-AC-06 3つの幅で縦線は1回だけ再生し、終わりの形を保つ | E2E | `docs/02_Requirements/areas/home.md:750` |
| FREQ-280-AC-01 本番ビルドのホームで、style 属性で当てた価格の字の大きさが崩れない | E2E | `docs/02_Requirements/areas/home.md:763` |
| FREQ-280-AC-02 本番の応答の CSP に style-src-elem があり、'unsafe-inline' を含まない | E2E | `docs/02_Requirements/areas/home.md:776` |
| FREQ-282-AC-01 縦線が上端から無限に伸び、途中で消えない | E2E | `docs/02_Requirements/areas/home.md:789` |
| FREQ-282-AC-02 動きを減らす設定で縦線の動きが無い | E2E | `docs/02_Requirements/areas/home.md:802` |
| FREQ-283-AC-01 SCROLL の字の色と縦線の色が白の 90% | E2E | `docs/02_Requirements/areas/home.md:815` |
| FR-HOME-001-AC-01 3つの幅で最初の画面いっぱいにヒーローの画像が出て、ブランド名の h1 が重なる | E2E | `docs/02_Requirements/areas/home.md:832` |
| FR-HOME-002-AC-01 3つの幅で ITEMS・LOOK・NEWS・ABOUT の区画が出る | E2E | `docs/02_Requirements/areas/home.md:844` |
| FR-HOME-003-AC-01 ABOUT の区画のリンクから /about が開く | E2E | `docs/02_Requirements/areas/home.md:856` |
| FR-HOME-004-AC-01 ITEM・LOOK・NEWS の区画の末尾から各一覧へ移れる | E2E | `docs/02_Requirements/areas/home.md:868` |
| FR-HOME-005-AC-01 ホームの取扱店は6件以下 | E2E | `docs/02_Requirements/areas/home.md:880` |
| FR-HOME-006-AC-01 ホームの title と description がホーム用の文 | E2E | `docs/02_Requirements/areas/home.md:892` |
| FR-HOME-007-AC-01 ヒーロー画像の先読みがあり、遅延読み込みでない | E2E | `docs/02_Requirements/areas/home.md:904` |
| FR-HOME-008-AC-01 ABOUT の画像が手元の画像から読まれる | E2E | `docs/02_Requirements/areas/home.md:916` |
| FR-HOME-009-AC-01 h1 がちょうど1つで、5つの区画の見出しが h2 | E2E | `docs/02_Requirements/areas/home.md:928` |
| NFR-HOME-001-AC-01 携帯の 3G 相当の回線でホームの読み込みが2秒以内に終わる | E2E | `docs/02_Requirements/areas/home.md:940` |
| NFR-HOME-002-AC-01 ヒーローと ABOUT の字のコントラスト比が AA の基準を満たす | E2E | `docs/02_Requirements/areas/home.md:952` |
| SEC-HOME-001-AC-01 未ログインのホームに下書きの物が出ない | E2E | `docs/02_Requirements/areas/home.md:981` |
| SEC-HOME-001-AC-02 下書きを読める管理者のホームにも下書きの物が出ない | E2E | `docs/02_Requirements/areas/home.md:993` |
| SEC-HOME-002-AC-01 管理者でも未ログインでも、ホームの商品と取扱店の中身が同じ | E2E | `docs/02_Requirements/areas/home.md:1018` |
| SEC-HOME-003-AC-01 aal1 の session では下書きの商品を直接読めない | E2E | `docs/02_Requirements/areas/home.md:1043` |
| SEC-HOME-003-AC-02 aal1 の session ではホームに出る商品の行を直接書き換え・消去できない | E2E | `docs/02_Requirements/areas/home.md:1055` |
| SEC-HOME-004-AC-01 anon の鍵で商品の原価と注記を読めない | E2E | `docs/02_Requirements/areas/home.md:1080` |
| SEC-HOME-004-AC-02 列を絞ってもホームの商品の節が出る | E2E | `docs/02_Requirements/areas/home.md:1092` |
| SEC-HOME-005-AC-01 anon の鍵でホームに出る商品の行を書き換え・消去できない | E2E | `docs/02_Requirements/areas/home.md:1117` |
| SEC-HOME-006-AC-01 下書きの商品の在庫がホームの応答に出ない | E2E | `docs/02_Requirements/areas/home.md:1142` |
| SEC-HOME-006-AC-02 置き場の道筋でない画像の住所はホームに出ない | E2E | `docs/02_Requirements/areas/home.md:1154` |
| SEC-HOME-007-AC-01 ホームの商品の画像の署名の期限が1時間以下 | E2E | `docs/02_Requirements/areas/home.md:1179` |
| SEC-HOME-008-AC-01 商品名に仕込んだスクリプトがホームで動かない | E2E | `docs/02_Requirements/areas/home.md:1204` |
| SEC-HOME-008-AC-02 ホームの応答の CSP が script に nonce を求める | E2E | `docs/02_Requirements/areas/home.md:1216` |
| SEC-HOME-009-AC-01 ホームの応答の CSP に使わない CDN が無い | E2E | `docs/02_Requirements/areas/home.md:1241` |
| SEC-HOME-009-AC-02 CDN の許可を外してもホームの見た目と動きが崩れない | E2E | `docs/02_Requirements/areas/home.md:1253` |
| SEC-HOME-010-AC-01 ホームの応答に守りの見出しがある | E2E | `docs/02_Requirements/areas/home.md:1278` |
| SEC-HOME-010-AC-02 ほかのサイトの枠の中にホームが表示されない | E2E | `docs/02_Requirements/areas/home.md:1290` |
| SEC-HOME-013-AC-01 ホームは描く件数だけ商品を取る | E2E | `docs/02_Requirements/areas/home.md:1359` |
| SEC-HOME-014-AC-01 1つの領域の取得が失敗してもホームのほかの節が出る | E2E | `docs/02_Requirements/areas/home.md:1384` |
| SEC-HOME-015-AC-01 検索の窓の失敗が端末の記録に中身を出さない | E2E | `docs/02_Requirements/areas/home.md:1409` |
| SEC-HOME-016-AC-01 ホームを開いた時の認証の状態の応答に、メールの住所が無い | E2E | `docs/02_Requirements/areas/home.md:1434` |
| SEC-HOME-017-AC-01 許していない場所の画像を最適化の中継に通せない | E2E | `docs/02_Requirements/areas/home.md:1459` |
| SEC-HOME-017-AC-02 許可を絞ってもホームの画像が出る | E2E | `docs/02_Requirements/areas/home.md:1471` |
| SEC-HOME-018-AC-01 ホームの OG の画像の住所がサイトの住所を指す | E2E | `docs/02_Requirements/areas/home.md:1496` |
| SEC-HOME-020-AC-01 anon の鍵と一般会員の JWT で原価の履歴を読み・書き・消せない | E2E | `docs/02_Requirements/areas/home.md:1543` |
| FREQ-11-AC-01 コーディネートを見る時にエラーが出ず関連コーディネートが出る | E2E | `docs/02_Requirements/areas/look.md:1760` |
| FREQ-12-AC-01 ほかの利用者のコーディネートを見る時にエラーが出ず関連コーディネートが出る | E2E | `docs/02_Requirements/areas/look.md:1773` |
| FREQ-17-AC-01 LOOK の管理でエラーが出ず登録・編集・削除が終わる | E2E | `docs/02_Requirements/areas/look.md:1786` |
| FREQ-50-AC-01 一覧に「LOOK BOOK」の見出しが無い | E2E | `docs/02_Requirements/areas/look.md:1799` |
| FREQ-51-AC-01 PC で SEASON のフィルターが左のサイドバーにあり、横並びのタブが無い | E2E | `docs/02_Requirements/areas/look.md:1812` |
| FREQ-51-AC-02 モバイル・タブレットで FILTER を押すと引き出しが開き、SEASON を替えられる | E2E | `docs/02_Requirements/areas/look.md:1825` |
| FREQ-52-AC-01 PC で選択肢の並びの gap が NEWS と一致する | E2E | `docs/02_Requirements/areas/look.md:1838` |
| FREQ-53-AC-01 関連商品のリンクの上下の padding が 1px 以下になる | E2E | `docs/02_Requirements/areas/look.md:1851` |
| FREQ-53-AC-02 関連商品どうしの縦の間隔が文字の大きさ÷φ に一致する | E2E | `docs/02_Requirements/areas/look.md:1864` |
| FREQ-54-AC-01 時期と名前の間隔が名前と最初の関連アイテムの間隔より狭い | E2E | `docs/02_Requirements/areas/look.md:1877` |
| FREQ-55-AC-01 各幅で一覧の row-gap が column-gap より大きい | E2E | `docs/02_Requirements/areas/look.md:1890` |
| FREQ-55-AC-02 モバイルで一覧の row-gap が 16px より大きい | E2E | `docs/02_Requirements/areas/look.md:1903` |
| FREQ-56-AC-01 モバイルで関連アイテムの名前と価格が縦に積まれる | E2E | `docs/02_Requirements/areas/look.md:1916` |
| FREQ-56-AC-02 タブレット・PC で関連アイテムの名前と価格が同じ行に並ぶ | E2E | `docs/02_Requirements/areas/look.md:1929` |
| FREQ-127-AC-01 シーズンの表記が「2026AW」の形で出る | E2E | `docs/02_Requirements/areas/look.md:1942` |
| FREQ-127-AC-02 シーズンの表記に「COLLECTION」が無い | E2E | `docs/02_Requirements/areas/look.md:1955` |
| FREQ-127-AC-03 シーズンの表記の年とシーズンの間に空白が無い | E2E | `docs/02_Requirements/areas/look.md:1968` |
| FREQ-128-AC-01 PC で画像の下部にシーズンとテーマが白い文字で出る | E2E | `docs/02_Requirements/areas/look.md:1981` |
| FREQ-128-AC-02 PC で画像の下の文字（look-card-caption）が出ない | E2E | `docs/02_Requirements/areas/look.md:1994` |
| FREQ-128-AC-03 モバイル・タブレットでオーバーレイが出ず、画像の下の文字が出る | E2E | `docs/02_Requirements/areas/look.md:2007` |
| FREQ-128-AC-04 オーバーレイの文字が画像の下半分にある | E2E | `docs/02_Requirements/areas/look.md:2020` |
| FREQ-129-AC-01 PC でオーバーレイのテーマがセリフ体で出る | E2E | `docs/02_Requirements/areas/look.md:2033` |
| FREQ-129-AC-02 テーマが大文字で出る | E2E | `docs/02_Requirements/areas/look.md:2046` |
| FREQ-129-AC-03 オーバーレイの背景に下から上へ透明になる黒の linear-gradient がある | E2E | `docs/02_Requirements/areas/look.md:2059` |
| FREQ-130-AC-01 グラデーションの色の段が4つ以上ある | E2E | `docs/02_Requirements/areas/look.md:2072` |
| FREQ-130-AC-02 グラデーションの上端の色が完全な透明になる | E2E | `docs/02_Requirements/areas/look.md:2085` |
| FREQ-131-AC-01 PC で関連アイテムのあるカードに乗ると題のブロックの opacity が 0 になる | E2E | `docs/02_Requirements/areas/look.md:2098` |
| FREQ-131-AC-02 乗った時に関連アイテムのブロックの opacity が 1 になる | E2E | `docs/02_Requirements/areas/look.md:2111` |
| FREQ-131-AC-03 乗っていない時は題が出て、関連アイテムのブロックの opacity が 0 になる | E2E | `docs/02_Requirements/areas/look.md:2124` |
| FREQ-132-AC-01 乗っても1枚目の画像が拡大されない | E2E | `docs/02_Requirements/areas/look.md:2137` |
| FREQ-132-AC-02 2枚目のあるカードに乗ると2枚目の画像の opacity が 1 になる | E2E | `docs/02_Requirements/areas/look.md:2150` |
| FREQ-132-AC-03 2枚目の無いカードにホバー用の画像が無い | E2E | `docs/02_Requirements/areas/look.md:2163` |
| FREQ-133-AC-01 PC でカードの下に関連アイテムの並びが出ない | E2E | `docs/02_Requirements/areas/look.md:2176` |
| FREQ-133-AC-02 モバイル・タブレットで関連アイテムのあるカードの下に並びが出る | E2E | `docs/02_Requirements/areas/look.md:2189` |
| FREQ-134-AC-01 PC で2つのブロックの下端がほぼ一致する | E2E | `docs/02_Requirements/areas/look.md:2202` |
| FREQ-134-AC-02 2つのブロックの左端が一致する | E2E | `docs/02_Requirements/areas/look.md:2215` |
| FREQ-135-AC-01 PC でテーマと最後の関連アイテムの文字の下端がそろう | E2E | `docs/02_Requirements/areas/look.md:2228` |
| FREQ-136-AC-01 PC で画像の箱の margin-bottom が 0px になる | E2E | `docs/02_Requirements/areas/look.md:2241` |
| FREQ-137-AC-01 各幅で HOME と一覧の格子の row-gap と column-gap が等しい | E2E | `docs/02_Requirements/areas/look.md:2267` |
| FREQ-137-AC-02 PC（1280px）で縦横とも 24px になる | E2E | `docs/02_Requirements/areas/look.md:2280` |
| FREQ-138-AC-01 モバイル・タブレットでシーズンが「2026 AW」の形で画像の下に出る | E2E | `docs/02_Requirements/areas/look.md:2293` |
| FREQ-138-AC-02 モバイル・タブレットでテーマがセリフ体・大文字で画像の下に出る | E2E | `docs/02_Requirements/areas/look.md:2306` |
| FREQ-138-AC-03 関連アイテムのあるカードでテーマと並びの間に罫線が出る | E2E | `docs/02_Requirements/areas/look.md:2319` |
| FREQ-138-AC-04 タブレットで関連アイテムの価格が右端に寄る | E2E | `docs/02_Requirements/areas/look.md:2332` |
| FREQ-138-AC-05 PC ではオーバーレイが出て、画像の下の文字・罫線・並びが出ない | E2E | `docs/02_Requirements/areas/look.md:2345` |
| FREQ-139-AC-01 画像の箱の margin-bottom がモバイル 13px・タブレット 21px になる | E2E | `docs/02_Requirements/areas/look.md:2358` |
| FREQ-139-AC-02 モバイル・タブレットでテーマの文字が関連アイテムの文字の 1.5 倍以上になる | E2E | `docs/02_Requirements/areas/look.md:2371` |
| FREQ-139-AC-03 シーズンとテーマの間隔がテーマと罫線の間隔より小さい | E2E | `docs/02_Requirements/areas/look.md:2384` |
| FREQ-139-AC-04 罫線の上と下の余白が等しい | E2E | `docs/02_Requirements/areas/look.md:2397` |
| FREQ-139-AC-05 PC では画像の下の文字が出ず、margin-bottom が 0 のままになる | E2E | `docs/02_Requirements/areas/look.md:2410` |
| FREQ-140-AC-01 モバイルで row-gap が 34px、column-gap が 16px になる | E2E | `docs/02_Requirements/areas/look.md:2423` |
| FREQ-140-AC-02 タブレットで row-gap が 55px、column-gap が HOME 24px・一覧 32px になる | E2E | `docs/02_Requirements/areas/look.md:2436` |
| FREQ-140-AC-03 モバイル・タブレットで row-gap が column-gap より大きい | E2E | `docs/02_Requirements/areas/look.md:2449` |
| FREQ-140-AC-04 PC で row-gap と column-gap が等しく 24px になる | E2E | `docs/02_Requirements/areas/look.md:2462` |
| FREQ-141-AC-01 モバイルで一覧の本文の列の左右の padding が 13px になる | E2E | `docs/02_Requirements/areas/look.md:2475` |
| FREQ-141-AC-02 タブレットで一覧の column-gap が 24px になる | E2E | `docs/02_Requirements/areas/look.md:2488` |
| FREQ-141-AC-03 モバイル・タブレットで一覧とホームの row-gap・column-gap が一致する | E2E | `docs/02_Requirements/areas/look.md:2501` |
| FREQ-141-AC-04 PC の一覧の gap と左の padding が今までどおりになる | E2E | `docs/02_Requirements/areas/look.md:2514` |
| FREQ-142-AC-01 モバイル・タブレットでカードに 1px のグレーの枠線が出る | E2E | `docs/02_Requirements/areas/look.md:2527` |
| FREQ-142-AC-02 モバイル・タブレットで画像の左右の端が枠線の内側に付く | E2E | `docs/02_Requirements/areas/look.md:2540` |
| FREQ-142-AC-03 モバイル・タブレットで情報パネルの文字が枠線から離れる | E2E | `docs/02_Requirements/areas/look.md:2553` |
| FREQ-142-AC-04 PC でカードに枠線が出ない | E2E | `docs/02_Requirements/areas/look.md:2566` |
| FREQ-143-AC-01 モバイル・タブレットでシーズンの文字の不透明度が 0.5 より大きい | E2E | `docs/02_Requirements/areas/look.md:2579` |
| FREQ-143-AC-02 モバイル・タブレットでシーズンの font-weight が 500 以上になる | E2E | `docs/02_Requirements/areas/look.md:2592` |
| FREQ-143-AC-04 シーズンが「2026 AW」の形のままで番号が無い | E2E | `docs/02_Requirements/areas/look.md:2618` |
| FREQ-144-AC-01 関連 ITEM の名前の書体・太さ・字間が ITEM カードと一致する | E2E | `docs/02_Requirements/areas/look.md:2631` |
| FREQ-144-AC-02 関連 ITEM の価格の太さ・色が ITEM カードと一致する | E2E | `docs/02_Requirements/areas/look.md:2644` |
| FREQ-144-AC-03 関連 ITEM の価格が半角の「¥」で始まる | E2E | `docs/02_Requirements/areas/look.md:2657` |
| FREQ-144-AC-04 関連 ITEM の名前・価格の文字が黒になる | E2E | `docs/02_Requirements/areas/look.md:2670` |
| FREQ-145-AC-01 モバイル・タブレットでシーズンの字間が文字の大きさの 10% より狭い | E2E | `docs/02_Requirements/areas/look.md:2683` |
| FREQ-145-AC-02 シーズンの濃さと太さの強調が残っている | E2E | `docs/02_Requirements/areas/look.md:2696` |
| FREQ-150-AC-01 PC で関連 ITEM の行に乗ると下線が左起点で出る | E2E | `docs/02_Requirements/areas/look.md:2709` |
| FREQ-150-AC-02 PC で関連 ITEM の行に乗っていない時は下線が出ない | E2E | `docs/02_Requirements/areas/look.md:2722` |
| FREQ-150-AC-03 PC で関連 ITEM の行を押すとその ITEM の頁へ移る | E2E | `docs/02_Requirements/areas/look.md:2735` |
| FREQ-150-AC-04 モバイル・タブレットではオーバーレイの関連 ITEM の行が出ない | E2E | `docs/02_Requirements/areas/look.md:2748` |
| FREQ-151-AC-01 モバイル・タブレットで関連 ITEM のリンクに乗ると下線が左起点で出る | E2E | `docs/02_Requirements/areas/look.md:2761` |
| FREQ-151-AC-02 モバイル・タブレットで関連 ITEM のリンクに乗っていない時は下線が出ない | E2E | `docs/02_Requirements/areas/look.md:2774` |
| FREQ-151-AC-03 モバイル・タブレットで関連 ITEM のリンクを押すとその ITEM の頁へ移る | E2E | `docs/02_Requirements/areas/look.md:2787` |
| FREQ-151-AC-04 PC では情報パネルの関連 ITEM のリンクが出ない | E2E | `docs/02_Requirements/areas/look.md:2800` |
| FREQ-176-AC-01 3つの幅で並びの上端・下端の線の色が区切り線と同じになる | E2E | `docs/02_Requirements/areas/look.md:2813` |
| FREQ-176-AC-02 3つの幅で上端・下端・区切りの全部の線が 1px になる | E2E | `docs/02_Requirements/areas/look.md:2826` |
| FREQ-177-AC-01 3つの幅で関連アイテムの見本の高さが文字の大きさ×φ³×√φ になる | E2E | `docs/02_Requirements/areas/look.md:2839` |
| FREQ-178-AC-01 3つの幅で通常の表示に「Back to Lookbook」が無い | E2E | `docs/02_Requirements/areas/look.md:2852` |
| FREQ-178-AC-02 無い LOOK の URL では「Back to Lookbook」が出る | E2E | `docs/02_Requirements/areas/look.md:2865` |
| FREQ-179-AC-01 モバイルでカルーセルが出て、サムネイルとメインの画像の枠が出ない | E2E | `docs/02_Requirements/areas/look.md:2878` |
| FREQ-179-AC-02 タブレットでカルーセルが出て、次送りを押すと前送りが出る | E2E | `docs/02_Requirements/areas/look.md:2891` |
| FREQ-179-AC-03 PC でサムネイルの列とメインの画像が出て、サムネイルで画像が替わる | E2E | `docs/02_Requirements/areas/look.md:2904` |
| FREQ-180-AC-01 1024px と 1280px で画像の枠の右端が文字の列の左端と重ならない | E2E | `docs/02_Requirements/areas/look.md:2917` |
| FREQ-180-AC-02 1024px と 1280px で画像の枠の縦横比が 2/3 になる | E2E | `docs/02_Requirements/areas/look.md:2930` |
| FREQ-181-AC-01 3つの幅で3つのラベルが出て、LOOK LIST が /look へのリンクになる | E2E | `docs/02_Requirements/areas/look.md:2943` |
| FREQ-181-AC-02 3つの幅で中と右の列の左に 1px の縦の区切り線が出る | E2E | `docs/02_Requirements/areas/look.md:2956` |
| FREQ-181-AC-03 ナビの中に LOOK のテーマ名が出ない | E2E | `docs/02_Requirements/areas/look.md:2969` |
| FREQ-182-AC-01 3つの幅で3つのアイコンが svg で、アイコンのフォントの要素が無い | E2E | `docs/02_Requirements/areas/look.md:2982` |
| FREQ-182-AC-02 3つの幅でアイコンの線幅が1・塗りなし・線の色が文字の色になる | E2E | `docs/02_Requirements/areas/look.md:2995` |
| FREQ-183-AC-01 3つの幅でラベルとアイコンの色が rgb(0, 0, 0) になる | E2E | `docs/02_Requirements/areas/look.md:3021` |
| FREQ-183-AC-02 3つの幅でアイコンの大きさが --lk-size-7xl になる | E2E | `docs/02_Requirements/areas/look.md:3034` |
| FREQ-183-AC-03 3つの幅で3列のラベルの字間が同じになる | E2E | `docs/02_Requirements/areas/look.md:3047` |
| FREQ-279-AC-01 初めに画面の外の画像の枠に data-reveal="true" が無く、スクロールすると付く | E2E | `docs/02_Requirements/areas/look.md:3099` |
| FREQ-279-AC-02 リビールの後の画像の枠の ::after の animation-name が reveal-cover-act になる | E2E | `docs/02_Requirements/areas/look.md:3112` |
| FREQ-279-AC-03 リビールの後の商品名・LOOK のテーマの transform が none になる | E2E | `docs/02_Requirements/areas/look.md:3125` |
| FREQ-279-AC-04 /・/item・/look のカードに data-reveal-group と .reveal-cover がある | E2E | `docs/02_Requirements/areas/look.md:3138` |
| FREQ-279-AC-05 カードの上端だけを見せて2秒待っても文字が出ず、文字まで進むと出る | E2E | `docs/02_Requirements/areas/look.md:3151` |
| FREQ-288-AC-01 3つの幅で画像の下に枚数分の線が出て、選んだ線だけに色が付く | E2E | `docs/02_Requirements/areas/look.md:3164` |
| FREQ-288-AC-02 タブレットで送りのボタンの上下の中心が画像の枠の中心と一致する | E2E | `docs/02_Requirements/areas/look.md:3177` |
| FREQ-288-AC-03 PC で画像の枠が 2:3 で画面の縦に収まり、情報の列の幅が画像の幅と等しい | E2E | `docs/02_Requirements/areas/look.md:3190` |
| FREQ-289-AC-01 1280×725 で ITEM 詳細のインジケータの下端が画面の下端から 12px 以上離れる | E2E | `docs/02_Requirements/areas/look.md:3203` |
| FREQ-289-AC-02 1280×725 で LOOK 詳細のインジケータの下端が画面の下端から 12px 以上離れる | E2E | `docs/02_Requirements/areas/look.md:3216` |
| FREQ-343-AC-01 モバイルで固定のナビが出て、下端が画面の下端に付いたまま動かない | E2E | `docs/02_Requirements/areas/look.md:3333` |
| FREQ-343-AC-02 モバイルの固定のナビに3つのラベルが出て、LOOK LIST が /look へのリンクになる | E2E | `docs/02_Requirements/areas/look.md:3346` |
| FREQ-343-AC-03 モバイルは3列のナビが出ず、タブレット・PC は3列のナビだけが出る | E2E | `docs/02_Requirements/areas/look.md:3359` |
| FREQ-343-AC-04 モバイルで最下部まで進むと法務の3つのリンクが固定のナビより上にある | E2E | `docs/02_Requirements/areas/look.md:3372` |
| FREQ-343-AC-05 モバイルで固定のナビのラベルの文字の大きさが --lk-size-7xs になる | E2E | `docs/02_Requirements/areas/look.md:3385` |
| FREQ-344-AC-01 3つの幅で頁の scrollWidth が clientWidth 以下になる | E2E | `docs/02_Requirements/areas/look.md:3398` |
| FREQ-344-AC-02 3つの幅で画面の右端を越える要素が無い | E2E | `docs/02_Requirements/areas/look.md:3411` |
| FREQ-344-AC-03 モバイルで固定のナビの下端が画面の下端と一致する | E2E | `docs/02_Requirements/areas/look.md:3424` |
| FR-LOOK-ALL-001-AC-01 一覧に公開済みの LOOK がカードの格子で並ぶ | E2E | `docs/02_Requirements/areas/look.md:3441` |
| FR-LOOK-ALL-001-AC-02 非公開の LOOK が一覧に出ない | E2E | `docs/02_Requirements/areas/look.md:3453` |
| FR-LOOK-ALL-002-AC-01 カードにシーズン・テーマ・画像・関連商品名が出る | E2E | `docs/02_Requirements/areas/look.md:3465` |
| FR-LOOK-ALL-002-AC-02 カードを押すとその LOOK の詳細が出る | E2E | `docs/02_Requirements/areas/look.md:3477` |
| FR-LOOK-ALL-003-AC-01 公開の LOOK が7件以上ある時に6件以上のカードが出る | E2E | `docs/02_Requirements/areas/look.md:3489` |
| FR-LOOK-ALL-004-AC-01 ホームに LOOK の区画があり、LOOK のカードが出る | E2E | `docs/02_Requirements/areas/look.md:3501` |
| FR-LOOK-ALL-004-AC-02 公開の LOOK が表示数より多い時、ホームの LOOK の区画から /look へ移れる | E2E | `docs/02_Requirements/areas/look.md:3513` |
| FR-LOOK-ALL-005-AC-01 一覧の title に LOOK を含み、description が空でない | E2E | `docs/02_Requirements/areas/look.md:3525` |
| FR-LOOK-ALL-006-AC-01 SS を選ぶと SS の LOOK だけが出る | E2E | `docs/02_Requirements/areas/look.md:3537` |
| FR-LOOK-ALL-006-AC-02 ALL を選ぶと全部の LOOK が出る | E2E | `docs/02_Requirements/areas/look.md:3549` |
| FR-LOOK-DETAIL-001-AC-01 詳細にテーマの h1・シーズン・画像・説明文が出る | E2E | `docs/02_Requirements/areas/look.md:3561` |
| FR-LOOK-DETAIL-001-AC-02 非公開の LOOK の詳細は中身を出さない | E2E | `docs/02_Requirements/areas/look.md:3573` |
| FR-LOOK-DETAIL-002-AC-01 紐づけた商品の名前と価格が並ぶ | E2E | `docs/02_Requirements/areas/look.md:3585` |
| FR-LOOK-DETAIL-002-AC-02 商品を押すとその商品の頁へ移る | E2E | `docs/02_Requirements/areas/look.md:3597` |
| FR-LOOK-DETAIL-003-AC-01 前後の LOOK へのリンクが出て、押すとその LOOK へ移る | E2E | `docs/02_Requirements/areas/look.md:3609` |
| FR-LOOK-DETAIL-003-AC-02 先頭の LOOK は前へ、末尾の LOOK は次へのリンクが無い | E2E | `docs/02_Requirements/areas/look.md:3621` |
| FR-LOOK-DETAIL-004-AC-01 無い ID の詳細に「Look not found」が出る | E2E | `docs/02_Requirements/areas/look.md:3633` |
| FR-LOOK-DETAIL-004-AC-02 無い ID の詳細に /look への戻りのリンクが出る | E2E | `docs/02_Requirements/areas/look.md:3645` |
| FR-LOOK-DETAIL-005-AC-01 PC で複数の画像の LOOK にサムネイルが並び、選ぶとメインの画像が替わる | E2E | `docs/02_Requirements/areas/look.md:3657` |
| FR-LOOK-DETAIL-006-AC-01 詳細の title にテーマを含み、description が空でない | E2E | `docs/02_Requirements/areas/look.md:3669` |
| FR-LOOK-DETAIL-006-AC-02 前後のリンクに行き先のテーマを含む aria-label が付く | E2E | `docs/02_Requirements/areas/look.md:3681` |
| FR-LOOK-DETAIL-007-AC-01 詳細に同じシーズンか関連のコーディネートを薦める節が出る | E2E | `docs/02_Requirements/areas/look.md:3693` |
| FR-ADMIN-005-AC-01 LOOK タブに LOOK の一覧が出る | E2E | `docs/02_Requirements/areas/look.md:3705` |
| FR-ADMIN-005-AC-02 作った LOOK が一覧に出る | E2E | `docs/02_Requirements/areas/look.md:3717` |
| FR-ADMIN-005-AC-03 直した内容が一覧に出る | E2E | `docs/02_Requirements/areas/look.md:3729` |
| FR-ADMIN-005-AC-04 消した LOOK が一覧から消える | E2E | `docs/02_Requirements/areas/look.md:3741` |
| FR-ADMIN-005-AC-05 紐づけた商品が公開の詳細の商品の並びに出る | E2E | `docs/02_Requirements/areas/look.md:3753` |
| SEC-LOOK-001-AC-01 anon と一般会員の直接の読み出しに非公開の LOOK が出ない | E2E | `docs/02_Requirements/areas/look.md:3782` |
| SEC-LOOK-001-AC-02 公開の画面に非公開の LOOK が出ない | E2E | `docs/02_Requirements/areas/look.md:3794` |
| SEC-LOOK-002-AC-01 anon の直接の読み出しに非公開の商品の紐づきが出ない | E2E | `docs/02_Requirements/areas/look.md:3819` |
| SEC-LOOK-002-AC-02 一般会員の直接の読み出しに非公開の商品の紐づきが出ない | E2E | `docs/02_Requirements/areas/look.md:3831` |
| SEC-LOOK-003-AC-01 aal1 の session では非公開の LOOK を直接読めない | E2E | `docs/02_Requirements/areas/look.md:3856` |
| SEC-LOOK-003-AC-02 aal1 の session では LOOK と関連を直接書き換え・消去できない | E2E | `docs/02_Requirements/areas/look.md:3868` |
| SEC-LOOK-004-AC-01 anon に LOOK の表の書き込みの権限が無い | E2E | `docs/02_Requirements/areas/look.md:3893` |
| SEC-LOOK-004-AC-02 authenticated に LOOK の表の要らない権限が無い | E2E | `docs/02_Requirements/areas/look.md:3905` |
| SEC-LOOK-005-AC-01 移行だけを当てた DB で置き場が非公開になる | E2E | `docs/02_Requirements/areas/look.md:3930` |
| SEC-LOOK-005-AC-02 公開の URL では LOOK の画像を開けない | E2E | `docs/02_Requirements/areas/look.md:3942` |
| SEC-LOOK-006-AC-01 非公開にした後に開いた頁に、その LOOK の画像の URL が出ない | E2E | `docs/02_Requirements/areas/look.md:3967` |
| SEC-LOOK-006-AC-02 詳細の頁の `og:image` が期限の切れる署名つき URL でない | E2E | `docs/02_Requirements/areas/look.md:3979` |
| SEC-LOOK-007-AC-01 決まりの外の道筋は署名されない | E2E | `docs/02_Requirements/areas/look.md:4004` |
| SEC-LOOK-008-AC-01 外の URL や署名できない値が画像の読み込み先にならない | E2E | `docs/02_Requirements/areas/look.md:4029` |
| SEC-LOOK-009-AC-01 一覧の頁に、一覧で表示しない項目が含まれない | E2E | `docs/02_Requirements/areas/look.md:4054` |
| SEC-LOOK-009-AC-02 上限を超える公開の LOOK があっても、一覧の1回の表示は上限まで | E2E | `docs/02_Requirements/areas/look.md:4066` |
| SEC-LOOK-010-AC-01 大きな件数を求めても上限までしか返らない | E2E | `docs/02_Requirements/areas/look.md:4091` |
| SEC-LOOK-010-AC-02 使わない検索の関数を anon が呼べない | E2E | `docs/02_Requirements/areas/look.md:4103` |
| SEC-LOOK-011-AC-01 送り元の見出しを変えても、同じ操作者の回数は止まる | E2E | `docs/02_Requirements/areas/look.md:4128` |
| SEC-LOOK-012-AC-01 5MB を超える画像は断られ、置き場に残らない | E2E | `docs/02_Requirements/areas/look.md:4153` |
| SEC-LOOK-012-AC-02 7枚以上の画像は断られる | E2E | `docs/02_Requirements/areas/look.md:4165` |
| SEC-LOOK-012-AC-03 作成と更新を合わせた1時間の量で止まる | E2E | `docs/02_Requirements/areas/look.md:4177` |
| SEC-LOOK-013-AC-01 画像でない中身は、申告が画像でも断られる | E2E | `docs/02_Requirements/areas/look.md:4202` |
| SEC-LOOK-013-AC-02 保存の道筋はファイル名に左右されない | E2E | `docs/02_Requirements/areas/look.md:4214` |
| SEC-LOOK-014-AC-01 LOOK を消すと画像も置き場から消える | E2E | `docs/02_Requirements/areas/look.md:4239` |
| SEC-LOOK-014-AC-02 画像を差し替えると古い画像が置き場から消える | E2E | `docs/02_Requirements/areas/look.md:4251` |
| SEC-LOOK-015-AC-01 関連の追加が失敗しても、前の関連商品が残る | E2E | `docs/02_Requirements/areas/look.md:4276` |
| SEC-LOOK-016-AC-01 形の合わない id の詳細は「見つからない」になる | E2E | `docs/02_Requirements/areas/look.md:4301` |
| SEC-LOOK-016-AC-02 管理の1件の窓口は数でない id を 400 で断る | E2E | `docs/02_Requirements/areas/look.md:4313` |
| SEC-LOOK-016-AC-03 状態の変更の本文が JSON でないと 400 になる | E2E | `docs/02_Requirements/areas/look.md:4325` |
| SEC-LOOK-017-AC-01 テーマと説明文のタグは文字として出る | E2E | `docs/02_Requirements/areas/look.md:4350` |
| SEC-LOOK-018-AC-01 他のオリジンからの変更は 403 で断られる | E2E | `docs/02_Requirements/areas/look.md:4375` |
| SEC-LOOK-018-AC-02 Origin も Referer も無い変更は 403 で断られる | E2E | `docs/02_Requirements/areas/look.md:4387` |
| SEC-LOOK-019-AC-01 ログインしていない要求は 401 で断られる | E2E | `docs/02_Requirements/areas/look.md:4412` |
| SEC-LOOK-019-AC-02 2要素を済ませていない session は 403 で断られる | E2E | `docs/02_Requirements/areas/look.md:4424` |
| SEC-LOOK-019-AC-03 権限ごとに、読み出しと変更が分かれる | E2E | `docs/02_Requirements/areas/look.md:4436` |
| SEC-LOOK-019-AC-04 変更の権限が無い人には、LOOK の操作のボタンが出ない | E2E | `docs/02_Requirements/areas/look.md:4448` |
| SEC-LOOK-020-AC-01 管理の変更ごとに監査の行が残る | E2E | `docs/02_Requirements/areas/look.md:4473` |
| SEC-LOOK-020-AC-02 監査の行に送り元が入る | E2E | `docs/02_Requirements/areas/look.md:4485` |
| SEC-LOOK-021-AC-01 画像の書き込みの失敗は決まった文言で返る | E2E | `docs/02_Requirements/areas/look.md:4510` |
| SEC-LOOK-022-AC-01 DB の失敗の時、公開の一覧は「LOOK が無い」ではなく誤りの画面を出す | E2E | `docs/02_Requirements/areas/look.md:4535` |
| SEC-LOOK-022-AC-02 管理の1件の取得は、DB の失敗を 404 にしない | E2E | `docs/02_Requirements/areas/look.md:4547` |
| SEC-LOOK-023-AC-01 長すぎるテーマと置き場の外の道筋を表が断る | E2E | `docs/02_Requirements/areas/look.md:4572` |
| FR-ABOUT-001-AC-01 ブランド哲学の見出しと文が見える | E2E | `docs/02_Requirements/areas/about.md:218` |
| FR-ABOUT-002-AC-01 服をつくる理由の見出しと Founder の名乗りが見える | E2E | `docs/02_Requirements/areas/about.md:230` |
| FR-ABOUT-003-AC-01 3つの原則が番号・英語のラベル・日本語の見出し付きで見える | E2E | `docs/02_Requirements/areas/about.md:242` |
| FR-ABOUT-004-AC-01 商品設計の考え方の見出しと、商品・LOOK への CTA がある | E2E | `docs/02_Requirements/areas/about.md:254` |
| FR-ABOUT-004-AC-02 CTA が 390px で縦、768px 以上で横に並び、横にずれない | E2E | `docs/02_Requirements/areas/about.md:266` |
| FR-ABOUT-005-AC-01 h1 の見出しが1つ見える | E2E | `docs/02_Requirements/areas/about.md:278` |
| FR-ABOUT-005-AC-02 ページの題と説明がある | E2E | `docs/02_Requirements/areas/about.md:290` |
| FR-ABOUT-006-AC-01 COLLECTION・LOOKBOOK・CONTACT への CTA がある | E2E | `docs/02_Requirements/areas/about.md:302` |
| FR-ABOUT-007-AC-01 装飾のアイコンが読み上げから外れている | E2E | `docs/02_Requirements/areas/about.md:314` |
| FR-ABOUT-007-AC-02 画像の代わりの文が具体的である | E2E | `docs/02_Requirements/areas/about.md:326` |
| FR-ABOUT-008-AC-01 画像が readdy.ai から読まれない | E2E | `docs/02_Requirements/areas/about.md:338` |
| SEC-ABOUT-001-AC-01 本文の画像と OG の画像が外のオリジンを指さない | E2E | `docs/02_Requirements/areas/about.md:365` |
| SEC-ABOUT-001-AC-02 OG の画像が取得できる | E2E | `docs/02_Requirements/areas/about.md:377` |
| SEC-ABOUT-002-AC-01 /about の応答に守りの見出しが付く | E2E | `docs/02_Requirements/areas/about.md:402` |
| SEC-ABOUT-003-AC-01 /about の CSP に使わない外のオリジンが無い | E2E | `docs/02_Requirements/areas/about.md:429` |
| SEC-ABOUT-003-AC-02 画像の最適化の入口が使わない外のオリジンの画像を取りに行かない | E2E | `docs/02_Requirements/areas/about.md:441` |
| SEC-ABOUT-004-AC-01 Cookie を付けた /about の応答が共有のキャッシュに残らない指定を持つ | E2E | `docs/02_Requirements/areas/about.md:466` |
| SEC-ABOUT-004-AC-02 Cookie を持つ要求への /about の応答も共有のキャッシュに残らない指定を持つ | E2E | `docs/02_Requirements/areas/about.md:478` |
| SEC-ABOUT-005-AC-01 要求の見出しを偽っても OG の URL が変わらない | E2E | `docs/02_Requirements/areas/about.md:503` |
| SEC-ABOUT-006-AC-01 Supabase に届かない状態でも /about が表示される | E2E | `docs/02_Requirements/areas/about.md:528` |
| SEC-ABOUT-007-AC-01 設定が無い時に OG の URL が手元の URL にならない | E2E | `docs/02_Requirements/areas/about.md:555` |
| FREQ-13-AC-01 取扱店の確認でエラーが出ず、正しい店の情報が出る | E2E | `docs/02_Requirements/areas/stockist.md:317` |
| FREQ-18-AC-01 取扱店の管理でエラーが出ず登録・編集・削除が終わる | E2E | `docs/02_Requirements/areas/stockist.md:330` |
| FREQ-57-AC-01 地方を選ぶとその地方の県の店だけが出る | E2E | `docs/02_Requirements/areas/stockist.md:343` |
| FREQ-57-AC-02 都道府県を選ぶとその県の店だけが出る | E2E | `docs/02_Requirements/areas/stockist.md:356` |
| FREQ-57-AC-03 モバイル・タブレットでは FILTER の引き出しから絞れる | E2E | `docs/02_Requirements/areas/stockist.md:369` |
| FR-STOCKIST-001-AC-01 一覧の列の数が幅で変わる | E2E | `docs/02_Requirements/areas/stockist.md:384` |
| FR-STOCKIST-001-AC-02 1536px 以上では4列になる | E2E | `docs/02_Requirements/areas/stockist.md:396` |
| FR-STOCKIST-002-AC-01 640px 以上のカードに5つの情報が出る | E2E | `docs/02_Requirements/areas/stockist.md:408` |
| FR-STOCKIST-002-AC-02 モバイルのカードに店舗名と住所が出る | E2E | `docs/02_Requirements/areas/stockist.md:420` |
| FR-STOCKIST-003-AC-01 非公開の店が一覧とホームに出ない | E2E | `docs/02_Requirements/areas/stockist.md:432` |
| FR-STOCKIST-003-AC-02 公開の店が無い時も頁が出て、空の文が出る | E2E | `docs/02_Requirements/areas/stockist.md:444` |
| FR-STOCKIST-004-AC-01 モバイルのホームの取扱店は3件まで | E2E | `docs/02_Requirements/areas/stockist.md:456` |
| FR-STOCKIST-004-AC-02 タブレット以上のホームの取扱店は最大6件を全部出す | E2E | `docs/02_Requirements/areas/stockist.md:468` |
| FR-STOCKIST-005-AC-01 取扱店の頁の title と description が出る | E2E | `docs/02_Requirements/areas/stockist.md:480` |
| FR-STOCKIST-006-AC-01 一覧に言葉の検索・並び替え・ページ分けが無い | E2E | `docs/02_Requirements/areas/stockist.md:492` |
| FR-STOCKIST-007-AC-01 カードに取扱の分類と店の画像・ロゴが無い | E2E | `docs/02_Requirements/areas/stockist.md:504` |
| FR-STOCKIST-008-AC-01 同じ名前の店が2つあっても両方のカードが出る | E2E | `docs/02_Requirements/areas/stockist.md:516` |
| FR-STOCKIST-008-AC-02 各カードの店舗名が見出しとして読める | E2E | `docs/02_Requirements/areas/stockist.md:528` |
| FR-STOCKIST-010-AC-01 店の無い地方と県はフィルターに出ない | E2E | `docs/02_Requirements/areas/stockist.md:540` |
| FR-STOCKIST-010-AC-02 県が1つの地方は1つのチェックボックスで出る | E2E | `docs/02_Requirements/areas/stockist.md:552` |
| FR-STOCKIST-010-AC-03 ALL を選ぶと絞り込みが解けて全部の店が出る | E2E | `docs/02_Requirements/areas/stockist.md:564` |
| FR-STOCKIST-010-AC-04 1024px 以上は左の列、未満は FILTER のボタンでフィルターを出す | E2E | `docs/02_Requirements/areas/stockist.md:576` |
| FR-ADMIN-006-AC-01 STOCKIST タブに全部の店が公開の状態つきで出る | E2E | `docs/02_Requirements/areas/stockist.md:588` |
| FR-ADMIN-006-AC-02 作成のフォームで保存すると一覧に新しい店が出る | E2E | `docs/02_Requirements/areas/stockist.md:600` |
| FR-ADMIN-006-AC-03 編集のフォームで更新すると一覧の中身が変わる | E2E | `docs/02_Requirements/areas/stockist.md:612` |
| FR-ADMIN-006-AC-04 公開の切り替えで札と公開の頁が変わる | E2E | `docs/02_Requirements/areas/stockist.md:624` |
| FR-ADMIN-006-AC-05 削除を確かめると一覧から店が消える | E2E | `docs/02_Requirements/areas/stockist.md:636` |
| SEC-STOCKIST-001-AC-01 anon と一般会員の直接の読み出しに非公開の店舗が出ない | E2E | `docs/02_Requirements/areas/stockist.md:663` |
| SEC-STOCKIST-001-AC-02 公開の画面に非公開の店舗が出ない | E2E | `docs/02_Requirements/areas/stockist.md:675` |
| SEC-STOCKIST-002-AC-01 管理の権限でログインしたまま公開の画面を開いても非公開の店舗が出ない | E2E | `docs/02_Requirements/areas/stockist.md:700` |
| SEC-STOCKIST-003-AC-01 aal1 の session では非公開の店舗を直接読めない | E2E | `docs/02_Requirements/areas/stockist.md:725` |
| SEC-STOCKIST-003-AC-02 aal1 の session では店舗を直接作る・書き換える・消すことができない | E2E | `docs/02_Requirements/areas/stockist.md:737` |
| SEC-STOCKIST-003-AC-03 失効させた session の token では店舗を直接書き換えられない | E2E | `docs/02_Requirements/areas/stockist.md:749` |
| SEC-STOCKIST-004-AC-01 別のオリジンからの変更の要求は拒まれる | E2E | `docs/02_Requirements/areas/stockist.md:774` |
| SEC-STOCKIST-004-AC-02 CSRF の token が無い・違う変更の要求は拒まれる | E2E | `docs/02_Requirements/areas/stockist.md:786` |
| SEC-STOCKIST-005-AC-01 別のオリジンからの要求を続けて送っても本人の変更が 429 にならない | E2E | `docs/02_Requirements/areas/stockist.md:811` |
| SEC-STOCKIST-006-AC-01 未ログインの要求は 401 になる | E2E | `docs/02_Requirements/areas/stockist.md:836` |
| SEC-STOCKIST-006-AC-02 取扱店の権限を持たない管理者は 403 になる | E2E | `docs/02_Requirements/areas/stockist.md:848` |
| SEC-STOCKIST-006-AC-03 aal1 の session の要求は 403 になる | E2E | `docs/02_Requirements/areas/stockist.md:860` |
| SEC-STOCKIST-006-AC-04 読みの権限だけでは変更できない | E2E | `docs/02_Requirements/areas/stockist.md:872` |
| SEC-STOCKIST-007-AC-01 変更の21回目は 429 になる | E2E | `docs/02_Requirements/areas/stockist.md:897` |
| SEC-STOCKIST-007-AC-02 送り元の見出しを変えても操作者の枠で止まる | E2E | `docs/02_Requirements/areas/stockist.md:909` |
| SEC-STOCKIST-008-AC-01 anon・authenticated に表の余分な権限が無い | E2E | `docs/02_Requirements/areas/stockist.md:934` |
| SEC-STOCKIST-009-AC-01 管理の応答に決めた列のほかが出ない | E2E | `docs/02_Requirements/areas/stockist.md:959` |
| SEC-STOCKIST-010-AC-01 管理の応答に no-store が付く | E2E | `docs/02_Requirements/areas/stockist.md:984` |
| SEC-STOCKIST-011-AC-01 制御文字を含む値は保存されない | E2E | `docs/02_Requirements/areas/stockist.md:1009` |
| SEC-STOCKIST-012-AC-01 偽の送り元の見出しが監査の ip にそのまま入らない | E2E | `docs/02_Requirements/areas/stockist.md:1034` |
| SEC-STOCKIST-013-AC-01 無い店舗への変更は 404 になり成功の監査が残らない | E2E | `docs/02_Requirements/areas/stockist.md:1059` |
| SEC-STOCKIST-013-AC-02 削除の監査に消した店舗の中身が残る | E2E | `docs/02_Requirements/areas/stockist.md:1071` |
| SEC-STOCKIST-014-AC-01 検証の誤りの応答に制約の中身が出ない | E2E | `docs/02_Requirements/areas/stockist.md:1096` |
| SEC-STOCKIST-014-AC-02 JSON でない本文は 400 になる | E2E | `docs/02_Requirements/areas/stockist.md:1108` |
| SEC-STOCKIST-015-AC-01 数でない id の編集の頁は API を呼ばない | E2E | `docs/02_Requirements/areas/stockist.md:1133` |
| SEC-STOCKIST-016-AC-01 店名と住所に入れた台本が動かず文字として出る | E2E | `docs/02_Requirements/areas/stockist.md:1158` |
| SEC-STOCKIST-016-AC-02 住所のリンクは決まった先にだけ向く | E2E | `docs/02_Requirements/areas/stockist.md:1170` |
| SEC-STOCKIST-017-AC-01 一覧に無い pref は無視され全件が出る | E2E | `docs/02_Requirements/areas/stockist.md:1195` |
| SEC-STOCKIST-018-AC-01 anon の直接の読み出しが行の上限を超えない | E2E | `docs/02_Requirements/areas/stockist.md:1220` |
| SEC-STOCKIST-019-AC-01 未ログインで管理の作成の頁を開くとフォームが出ない | E2E | `docs/02_Requirements/areas/stockist.md:1245` |
| SEC-STOCKIST-019-AC-02 取扱店の権限を持たない管理者には管理の作成の頁のフォームが出ない | E2E | `docs/02_Requirements/areas/stockist.md:1257` |
| SEC-STOCKIST-020-AC-01 権限の無い token の要求を続けて送ると 429 になる | E2E | `docs/02_Requirements/areas/stockist.md:1282` |
| SEC-STOCKIST-021-AC-01 権限の無い管理の要求の監査が残る | E2E | `docs/02_Requirements/areas/stockist.md:1307` |
| FREQ-01-AC-01 商品の検索でエラーが出ず、関連する商品が出る | E2E | `docs/02_Requirements/areas/search.md:770` |
| FREQ-184-AC-01 1280px で左右の2カラム、390・768px で縦積みになり横にはみ出さない | E2E | `docs/02_Requirements/areas/search.md:783` |
| FREQ-184-AC-02 「N RESULTS」「SORT BY」「RELEVANCE」と、行の種別・題・サムネイル・矢印が出る | E2E | `docs/02_Requirements/areas/search.md:796` |
| FREQ-184-AC-03 8件を超える時だけ LOAD MORE が出て、押すと行が増える | E2E | `docs/02_Requirements/areas/search.md:809` |
| FREQ-186-AC-01 RPC が paid の数量の合計の順に返し、popularItems は公開の ITEM だけ | E2E | `docs/02_Requirements/areas/search.md:822` |
| FREQ-186-AC-02 anon・authenticated に EXECUTE が無く、応答に purchase_count が無い | E2E | `docs/02_Requirements/areas/search.md:835` |
| FREQ-186-AC-03 3つの幅で語なしの /search に POPULAR ITEMS と ITEM の行が出る | E2E | `docs/02_Requirements/areas/search.md:848` |
| FREQ-187-AC-01 preview を付けない検索は1種別で3件を超えて返り得る | E2E | `docs/02_Requirements/areas/search.md:861` |
| FREQ-187-AC-02 preview=true の検索は各種別3件以下 | E2E | `docs/02_Requirements/areas/search.md:874` |
| FREQ-187-AC-03 preview を付けない検索を20回続けても 429 にならない | E2E | `docs/02_Requirements/areas/search.md:887` |
| FREQ-188-AC-01 3つの幅でフッターが最初の画面に出ない | E2E | `docs/02_Requirements/areas/search.md:900` |
| FREQ-188-AC-02 1280px で左のカラムの中身が縦の中央寄りにある | E2E | `docs/02_Requirements/areas/search.md:913` |
| FREQ-188-AC-03 3つの幅で横にはみ出さない | E2E | `docs/02_Requirements/areas/search.md:926` |
| FREQ-189-AC-01 語なしで入力欄に触れても RECENT SEARCHES が出ない | E2E | `docs/02_Requirements/areas/search.md:939` |
| FREQ-189-AC-02 検索しても localStorage に search.history が残らない | E2E | `docs/02_Requirements/areas/search.md:952` |
| FREQ-190-AC-01 入力すると種別付きの候補が最大8件、行の高さ 44px 以上で出る | E2E | `docs/02_Requirements/areas/search.md:965` |
| FREQ-190-AC-02 combobox の ARIA が付き、↓ と Escape で状態が変わる | E2E | `docs/02_Requirements/areas/search.md:978` |
| FREQ-190-AC-03 選んだ候補を Enter かクリックで確定すると、URL の q と tab が候補に合う | E2E | `docs/02_Requirements/areas/search.md:991` |
| FREQ-190-AC-04 出る候補のラベルが全部入力語を含む | E2E | `docs/02_Requirements/areas/search.md:1004` |
| FREQ-191-AC-01 RELEVANCE が出て、SORT BY が出ない | E2E | `docs/02_Requirements/areas/search.md:1017` |
| FREQ-191-AC-02 「{件数} RESULTS」が今までどおり出る（FREQ-191） | E2E | `docs/02_Requirements/areas/search.md:1030` |
| FREQ-192-AC-01 フォームの高さが 36px 以上 44px 未満、候補の行が 40px 以上 44px 未満 | E2E | `docs/02_Requirements/areas/search.md:1043` |
| FREQ-192-AC-02 タブの下線が共通の線のクラスを持ち、高さ 1px・黒・0.3s | E2E | `docs/02_Requirements/areas/search.md:1056` |
| FREQ-192-AC-03 選んだタブの下線の横の伸びが 1、ほかは 0 で、触れると 1 になる | E2E | `docs/02_Requirements/areas/search.md:1069` |
| FREQ-193-AC-02 3つの幅でタブの下線の左端が最初の文字の左端と 1px 以内 | E2E | `docs/02_Requirements/areas/search.md:1095` |
| FREQ-195-AC-02 3つの幅で横にはみ出さない（FREQ-195） | E2E | `docs/02_Requirements/areas/search.md:1121` |
| FREQ-196-AC-01 結果を出した時に RELEVANCE が出ない | E2E | `docs/02_Requirements/areas/search.md:1134` |
| FREQ-196-AC-02 「{件数} RESULTS」が今までどおり出る（FREQ-196） | E2E | `docs/02_Requirements/areas/search.md:1147` |
| FREQ-197-AC-01 768px で2カラムになり、タブが縦に並び、左が sticky | E2E | `docs/02_Requirements/areas/search.md:1160` |
| FREQ-197-AC-02 768px で左のカラムの中身が縦の中央寄りにある | E2E | `docs/02_Requirements/areas/search.md:1173` |
| FREQ-197-AC-03 390px は縦積み・タブ横並びのままで、どの幅も横にはみ出さない | E2E | `docs/02_Requirements/areas/search.md:1186` |
| FREQ-198-AC-01 390px で h1 の描かれる高さが 1px 以下 | E2E | `docs/02_Requirements/areas/search.md:1199` |
| FREQ-198-AC-02 390px でも h1 が DOM にあり「SEARCH」の字を持つ | E2E | `docs/02_Requirements/areas/search.md:1212` |
| FREQ-198-AC-03 768・1280px で h1 が今までどおり見える | E2E | `docs/02_Requirements/areas/search.md:1225` |
| FREQ-199-AC-01 390px で4つのタブが横一列で、先頭と末尾がタブの列の端に合う | E2E | `docs/02_Requirements/areas/search.md:1238` |
| FREQ-199-AC-02 390px で結果の行の文字が 768・1280px より小さく、大小の順が保たれる | E2E | `docs/02_Requirements/areas/search.md:1251` |
| FREQ-199-AC-03 390px の結果の行が 768・1280px より低く、どの幅も横にはみ出さない | E2E | `docs/02_Requirements/areas/search.md:1264` |
| FREQ-200-AC-01 390px で先頭と末尾のタブがタブの列の端より 8px 以上内側にある | E2E | `docs/02_Requirements/areas/search.md:1277` |
| FREQ-200-AC-02 3つの幅でタブの字間が文字の大きさの 0.1 倍 | E2E | `docs/02_Requirements/areas/search.md:1290` |
| FREQ-200-AC-03 3つの幅で下線の両端が文字の両端と 1px 以内 | E2E | `docs/02_Requirements/areas/search.md:1303` |
| FREQ-201-AC-01 3つの幅で ITEM の行のメタが「¥」で始まる価格で、カテゴリ名でない | E2E | `docs/02_Requirements/areas/search.md:1316` |
| FREQ-201-AC-02 3つの幅で LOOK はシーズン、NEWS は公開日のまま | E2E | `docs/02_Requirements/areas/search.md:1329` |
| FREQ-201-AC-03 応答の items の meta が価格の形で、purchase_count が無い | E2E | `docs/02_Requirements/areas/search.md:1342` |
| FR-SEARCH-001-AC-01 /search?q=<語> を開くと入力欄に語が入り、4つのタブが出る | E2E | `docs/02_Requirements/areas/search.md:1359` |
| FR-SEARCH-001-AC-02 タブを押すと URL の tab が変わり、その種別の結果が出る | E2E | `docs/02_Requirements/areas/search.md:1371` |
| FR-SEARCH-001-AC-03 tab 付きの URL を開くとそのタブが選ばれている | E2E | `docs/02_Requirements/areas/search.md:1383` |
| FR-SEARCH-002-AC-01 ヘッダーの検索のアイコンを押すと /search へ移る | E2E | `docs/02_Requirements/areas/search.md:1395` |
| FR-SEARCH-002-AC-02 /?q=<語> を開くとホームにプレビューが出る | E2E | `docs/02_Requirements/areas/search.md:1407` |
| FR-SEARCH-003-AC-01 結果の題の中の語に合う部分が mark で強調される | E2E | `docs/02_Requirements/areas/search.md:1419` |
| FR-SEARCH-003-AC-02 商品・ルック・ニュースのそれぞれの題に含まれる語で、その種別の結果が出る | E2E | `docs/02_Requirements/areas/search.md:1431` |
| FR-SEARCH-004-AC-01 一致の無い語で開くと、0件の文と POPULAR ITEMS が出る | E2E | `docs/02_Requirements/areas/search.md:1443` |
| SEC-SEARCH-001-AC-01 検索の結果とサジェストに非公開の物の題が出ない | E2E | `docs/02_Requirements/areas/search.md:1472` |
| SEC-SEARCH-001-AC-02 人気商品に非公開の商品が出ない | E2E | `docs/02_Requirements/areas/search.md:1484` |
| SEC-SEARCH-002-AC-01 管理の読み取りの権限を持つ aal1 の session でも、検索の関数が下書きを返さない | E2E | `docs/02_Requirements/areas/search.md:1509` |
| SEC-SEARCH-003-AC-01 記号だけの語で全件が返らない | E2E | `docs/02_Requirements/areas/search.md:1534` |
| SEC-SEARCH-004-AC-01 制御文字を含む語は検索でも 400 になる | E2E | `docs/02_Requirements/areas/search.md:1559` |
| SEC-SEARCH-005-AC-01 上限を超えた検索とサジェストは 429 になる | E2E | `docs/02_Requirements/areas/search.md:1584` |
| SEC-SEARCH-005-AC-02 速く打ってもサジェストは入力が止まってから呼ぶ | E2E | `docs/02_Requirements/areas/search.md:1596` |
| SEC-SEARCH-006-AC-01 送り元の見出しを変えても制限を逃れられない | E2E | `docs/02_Requirements/areas/search.md:1621` |
| SEC-SEARCH-007-AC-01 大きな件数で直接呼んでも上限を超えて返らない | E2E | `docs/02_Requirements/areas/search.md:1646` |
| SEC-SEARCH-008-AC-01 anon は使わない検索の関数を呼べない | E2E | `docs/02_Requirements/areas/search.md:1671` |
| SEC-SEARCH-009-AC-01 anon と一般会員は人気商品の関数を呼べない | E2E | `docs/02_Requirements/areas/search.md:1696` |
| SEC-SEARCH-009-AC-02 検索の応答に購入数が含まれない | E2E | `docs/02_Requirements/areas/search.md:1708` |
| SEC-SEARCH-010-AC-01 検索とサジェストの応答に no-store が付く | E2E | `docs/02_Requirements/areas/search.md:1733` |
| SEC-SEARCH-011-AC-01 検索の後に端末の保存の場所に検索語が残らない | E2E | `docs/02_Requirements/areas/search.md:1758` |
| SEC-SEARCH-012-AC-01 検索の頁の応答に Referrer-Policy が付く | E2E | `docs/02_Requirements/areas/search.md:1783` |
| SEC-SEARCH-013-AC-01 HTML を含む題と語が文字として表示される | E2E | `docs/02_Requirements/areas/search.md:1808` |
| SEC-SEARCH-014-AC-01 検索の応答の画像の URL が1時間で切れる | E2E | `docs/02_Requirements/areas/search.md:1833` |
| SEC-SEARCH-015-AC-01 署名できない画像の値は null になる | E2E | `docs/02_Requirements/areas/search.md:1858` |
| SEC-SEARCH-016-AC-01 決まった場所の外の道筋には署名しない | E2E | `docs/02_Requirements/areas/search.md:1883` |
| SEC-SEARCH-017-AC-01 関数の失敗で「検索結果はありません」を出さない | E2E | `docs/02_Requirements/areas/search.md:1908` |
| SEC-SEARCH-018-AC-01 検索とサジェストの失敗の記録に検索語と誤りの全体が無い | E2E | `docs/02_Requirements/areas/search.md:1933` |
| SEC-SEARCH-019-AC-01 検索の応答に処理の時間の見出しが無い | E2E | `docs/02_Requirements/areas/search.md:1958` |
| SEC-SEARCH-020-AC-01 他人の送り元を名乗っても、その利用者の検索が止まらない | E2E | `docs/02_Requirements/areas/search.md:1983` |
| SEC-SEARCH-021-AC-01 /?q=<文> で、ホームの説明の文にその文が埋まらない | E2E | `docs/02_Requirements/areas/search.md:2008` |
| FREQ-100-AC-01 足した6つの節の見出しが出る | E2E | `docs/02_Requirements/areas/privacy.md:172` |
| FREQ-100-AC-02 窓口のメールが出る | E2E | `docs/02_Requirements/areas/privacy.md:185` |
| FREQ-101-AC-01 本文の行間が字の大きさの 1.5 倍より広い | E2E | `docs/02_Requirements/areas/privacy.md:198` |
| FREQ-101-AC-02 節の見出しの字が本文より大きい | E2E | `docs/02_Requirements/areas/privacy.md:213` |
| FR-PRIVACY-001-AC-01 頁の見出しと、FREQ-100 以外の節の見出しが出る | E2E | `docs/02_Requirements/areas/privacy.md:228` |
| FR-PRIVACY-002-AC-01 頁の title と description が出る | E2E | `docs/02_Requirements/areas/privacy.md:242` |
| SEC-PRIVACY-001-AC-01 anon と一般会員の鍵で設定の関数を呼べない | E2E | `docs/02_Requirements/areas/privacy.md:271` |
| SEC-PRIVACY-001-AC-02 anon と一般会員の鍵で設定の表を読めない | E2E | `docs/02_Requirements/areas/privacy.md:283` |
| SEC-PRIVACY-002-AC-01 頁に担当者のメールが表示されない | E2E | `docs/02_Requirements/areas/privacy.md:308` |
| SEC-PRIVACY-003-AC-01 発送が多くても頁の表示が遅くならない | E2E | `docs/02_Requirements/areas/privacy.md:333` |
| SEC-PRIVACY-004-AC-01 回数の上限を超えると DB を読まない | E2E | `docs/02_Requirements/areas/privacy.md:358` |
| SEC-PRIVACY-005-AC-01 設定を読めない時に委託の一覧が表示されない | E2E | `docs/02_Requirements/areas/privacy.md:383` |
| SEC-PRIVACY-006-AC-01 追跡がオフの時に 17TRACK の一文が表示されない | E2E | `docs/02_Requirements/areas/privacy.md:408` |
| SEC-PRIVACY-006-AC-02 鍵が無くても設定がオンなら一文が表示される | E2E | `docs/02_Requirements/areas/privacy.md:420` |
| SEC-PRIVACY-007-AC-01 応答の見出しが共有のキャッシュを止める | E2E | `docs/02_Requirements/areas/privacy.md:445` |
| SEC-PRIVACY-008-AC-01 失敗の画面に DB の誤りの文が表示されない | E2E | `docs/02_Requirements/areas/privacy.md:470` |
| SEC-PRIVACY-009-AC-01 失敗の画面に窓口の案内が表示される | E2E | `docs/02_Requirements/areas/privacy.md:495` |
| SEC-PRIVACY-010-AC-01 aal1 の管理者は直接も窓口からも切り替えられない | E2E | `docs/02_Requirements/areas/privacy.md:520` |
| SEC-PRIVACY-010-AC-02 anon と一般会員は切り替えられない | E2E | `docs/02_Requirements/areas/privacy.md:532` |
| SEC-PRIVACY-011-AC-01 外部サービスの名前が表示される | E2E | `docs/02_Requirements/areas/privacy.md:557` |
| SEC-PRIVACY-011-AC-02 無い機能の使い道が表示されない | E2E | `docs/02_Requirements/areas/privacy.md:569` |
| SEC-PRIVACY-012-AC-01 追跡をオンにすると改定日がオンにした日になる | E2E | `docs/02_Requirements/areas/privacy.md:594` |
| SEC-PRIVACY-013-AC-01 応答に枠の禁止と基本の守りの見出しが付く | E2E | `docs/02_Requirements/areas/privacy.md:619` |
| SEC-PRIVACY-014-AC-01 CSP が nonce を求める | E2E | `docs/02_Requirements/areas/privacy.md:644` |
| SEC-PRIVACY-014-AC-02 CSP が頁で使わない外のドメインを許さない | E2E | `docs/02_Requirements/areas/privacy.md:656` |
| SEC-PRIVACY-015-AC-01 初めての閲覧で session_id が発行されない | E2E | `docs/02_Requirements/areas/privacy.md:681` |
| SEC-PRIVACY-016-AC-01 頁を開いた時の認証の状態の応答にメールが無い | E2E | `docs/02_Requirements/areas/privacy.md:706` |
| SEC-PRIVACY-017-AC-01 頁に窓口のメールとフォームが表示される | E2E | `docs/02_Requirements/areas/privacy.md:731` |
| SEC-PRIVACY-018-AC-01 運用の文書に迷惑メールの選別と見直しの手順が在る | E2E | `docs/02_Requirements/areas/privacy.md:756` |
| SEC-PRIVACY-019-AC-01 頁に本人の確かめの後に応える旨が表示される | E2E | `docs/02_Requirements/areas/privacy.md:781` |
| FREQ-28-AC-01 × の中心の X 座標がハンバーガーと ±2px で一致する | E2E | `docs/02_Requirements/areas/auth.md:2031` |
| FREQ-29-AC-01 開いた時の子のリンクの color が rgb(17, 17, 17) | E2E | `docs/02_Requirements/areas/auth.md:2044` |
| FREQ-58-AC-01 ログインページに EMAIL と PASSWORD の欄が出る | E2E | `docs/02_Requirements/areas/auth.md:2057` |
| FREQ-58-AC-02 パスワードの後に 8 桁のコードの欄が出る | E2E | `docs/02_Requirements/areas/auth.md:2070` |
| FREQ-59-AC-01 /register に EMAIL・PASSWORD・PASSWORD（確認）が出る | E2E | `docs/02_Requirements/areas/auth.md:2083` |
| FREQ-59-AC-02 ログインページに新規登録への導線が出る | E2E | `docs/02_Requirements/areas/auth.md:2096` |
| FREQ-60-AC-01 コードを送った後に再送の残り時間が出る | E2E | `docs/02_Requirements/areas/auth.md:2109` |
| FREQ-61-AC-01 /login にタブが出てログインが選ばれ、PASSWORD（確認）が無い | E2E | `docs/02_Requirements/areas/auth.md:2122` |
| FREQ-61-AC-02 新規登録タブで PASSWORD（確認）が出て URL が /register になる | E2E | `docs/02_Requirements/areas/auth.md:2135` |
| FREQ-61-AC-03 /register で新規登録タブが選ばれ、ログインタブで URL が /login になる | E2E | `docs/02_Requirements/areas/auth.md:2148` |
| FREQ-63-AC-01 /register を開くと 404 になる | E2E | `docs/02_Requirements/areas/auth.md:2187` |
| FREQ-63-AC-02 新規登録タブで PASSWORD（確認）が出て、URL は /login のまま | E2E | `docs/02_Requirements/areas/auth.md:2200` |
| FREQ-63-AC-03 「既にアカウントをお持ちの方はこちら」がタブ切替のボタンになる | E2E | `docs/02_Requirements/areas/auth.md:2213` |
| FREQ-64-AC-01 カードの枠・EMAIL の欄・ログインボタンの角が丸い | E2E | `docs/02_Requirements/areas/auth.md:2226` |
| FREQ-64-AC-02 「ログインでお困りの方」の導線が出ない | E2E | `docs/02_Requirements/areas/auth.md:2239` |
| FREQ-64-AC-03 カードの枠線が純黒でないグレー | E2E | `docs/02_Requirements/areas/auth.md:2252` |
| FREQ-64-AC-04 ログインボタンの角が 4px〜12px の中ほどの丸み | E2E | `docs/02_Requirements/areas/auth.md:2265` |
| FREQ-65-AC-01 非選択のタブの背景が純黒でないグレー | E2E | `docs/02_Requirements/areas/auth.md:2278` |
| FREQ-65-AC-02 EMAIL・PASSWORD が空の間はログインボタンが無効 | E2E | `docs/02_Requirements/areas/auth.md:2291` |
| FREQ-65-AC-03 EMAIL・PASSWORD を入れるとログインボタンが有効になる | E2E | `docs/02_Requirements/areas/auth.md:2304` |
| FREQ-65-AC-04 会員登録タブで3つの欄が空の間は登録ボタンが無効 | E2E | `docs/02_Requirements/areas/auth.md:2317` |
| FREQ-65-AC-05 タブに区切り線が無い | E2E | `docs/02_Requirements/areas/auth.md:2330` |
| FREQ-66-AC-01 リンクがログインボタンより上に出る | E2E | `docs/02_Requirements/areas/auth.md:2343` |
| FREQ-66-AC-02 リンクとパスワードの欄の間隔がボタンとの間隔より狭い | E2E | `docs/02_Requirements/areas/auth.md:2356` |
| FREQ-66-AC-03 リンクの右端がパスワードの欄の右端とほぼそろう | E2E | `docs/02_Requirements/areas/auth.md:2369` |
| FREQ-67-AC-01 ログインボタンの文字が EMAIL の欄の文字より大きい | E2E | `docs/02_Requirements/areas/auth.md:2382` |
| FREQ-67-AC-02 忘れた方のリンクの文字が本文より小さい | E2E | `docs/02_Requirements/areas/auth.md:2395` |
| FREQ-67-AC-03 ログインボタンが一番高い操作の要素 | E2E | `docs/02_Requirements/areas/auth.md:2408` |
| FREQ-68-AC-01 Google ボタンと主ボタンの高さと文字の大きさが一致する | E2E | `docs/02_Requirements/areas/auth.md:2421` |
| FREQ-68-AC-02 2つのタブで対応するボタンの高さと文字の大きさが一致する | E2E | `docs/02_Requirements/areas/auth.md:2434` |
| FREQ-69-AC-01 初めの表示でフッターが見えない | E2E | `docs/02_Requirements/areas/auth.md:2447` |
| FREQ-69-AC-02 main の下端がビューポートの下端に届く | E2E | `docs/02_Requirements/areas/auth.md:2460` |
| FREQ-69-AC-03 フォームが縦のほぼ中央にあり、ヘッダーに重ならない | E2E | `docs/02_Requirements/areas/auth.md:2473` |
| FREQ-70-AC-01 角丸のカードがあり、送信ボタンの角が 4px〜12px | E2E | `docs/02_Requirements/areas/auth.md:2486` |
| FREQ-70-AC-02 初めの表示でフッターが見えず、フォームが縦のほぼ中央にある | E2E | `docs/02_Requirements/areas/auth.md:2499` |
| FREQ-70-AC-03 EMAIL が空の間は送信ボタンが無効で、入れると有効になる | E2E | `docs/02_Requirements/areas/auth.md:2512` |
| FREQ-70-AC-04 見出し「パスワード再設定の申請」が /login のタブと同じ書体で一番大きい | E2E | `docs/02_Requirements/areas/auth.md:2525` |
| FREQ-71-AC-01 375×667 でログインタブのカードが画面に収まりフッターが見えない | E2E | `docs/02_Requirements/areas/auth.md:2538` |
| FREQ-71-AC-02 1280 幅でモバイル用の縮みが効かない | E2E | `docs/02_Requirements/areas/auth.md:2551` |
| FREQ-71-AC-03 375×667 で会員登録タブのカードが画面に収まる | E2E | `docs/02_Requirements/areas/auth.md:2564` |
| FREQ-73-AC-01 見出し「Le Fil des Heures」が Didot 系で出る | E2E | `docs/02_Requirements/areas/auth.md:2577` |
| FREQ-73-AC-02 未認証で開くと「ログインページへ」のリンクが出る | E2E | `docs/02_Requirements/areas/auth.md:2590` |
| FREQ-73-AC-03 初めの表示でフッターが見えず、見出しが縦のほぼ中央にある | E2E | `docs/02_Requirements/areas/auth.md:2603` |
| FREQ-73-AC-04 見出しの直下に幅約 1px の縦のヘアラインが出る | E2E | `docs/02_Requirements/areas/auth.md:2616` |
| FREQ-73-AC-05 見出しの文字が本文より大きい | E2E | `docs/02_Requirements/areas/auth.md:2629` |
| FREQ-89-AC-01 Email の欄にメール、Password の欄に鍵のアイコンが出る | E2E | `docs/02_Requirements/areas/auth.md:2642` |
| FREQ-89-AC-02 入力欄が下線だけで出る | E2E | `docs/02_Requirements/areas/auth.md:2655` |
| FREQ-89-AC-03 表示切替のボタンで type が password と text で切り替わる | E2E | `docs/02_Requirements/areas/auth.md:2668` |
| FREQ-89-AC-04 先頭のアイコンが本文の文字より大きい | E2E | `docs/02_Requirements/areas/auth.md:2681` |
| FREQ-89-AC-05 アイコンの左と切替ボタンの右に font-size÷φ の余白がある | E2E | `docs/02_Requirements/areas/auth.md:2694` |
| FREQ-90-AC-01 タブが下線を持ち、タブを囲む角丸の枠が無い | E2E | `docs/02_Requirements/areas/auth.md:2707` |
| FREQ-90-AC-02 ログインタブに「会員登録はこちら」が出ない | E2E | `docs/02_Requirements/areas/auth.md:2720` |
| FREQ-90-AC-03 会員登録タブに「既にアカウントをお持ちの方はこちら」が出ない | E2E | `docs/02_Requirements/areas/auth.md:2733` |
| FREQ-90-AC-04 タブの左右の端が入力欄・ボタンの端とそろう | E2E | `docs/02_Requirements/areas/auth.md:2746` |
| FREQ-91-AC-01 登録の欄にメールと鍵のアイコンが出る | E2E | `docs/02_Requirements/areas/auth.md:2759` |
| FREQ-91-AC-02 登録の欄が下線だけで出る | E2E | `docs/02_Requirements/areas/auth.md:2772` |
| FREQ-91-AC-03 Password と Password（確認）に表示切替がある | E2E | `docs/02_Requirements/areas/auth.md:2785` |
| FREQ-91-AC-04 「Googleで登録」が送信ボタンより下にある | E2E | `docs/02_Requirements/areas/auth.md:2798` |
| FREQ-92-AC-01 カードの枠が無く、送信ボタンが直角 | E2E | `docs/02_Requirements/areas/auth.md:2811` |
| FREQ-92-AC-02 Email の欄が下線だけで先頭にメールのアイコンがある | E2E | `docs/02_Requirements/areas/auth.md:2824` |
| FREQ-92-AC-03 見出しが acumin-pro 系で入力欄より大きい | E2E | `docs/02_Requirements/areas/auth.md:2837` |
| FREQ-194-AC-02 下線の左端と最初の文字の左端の差が 1px 以内 | E2E | `docs/02_Requirements/areas/auth.md:2863` |
| FREQ-239-AC-01 /admin のヘッダーのサイトの題が Didot で公開ページと一致する | E2E | `docs/02_Requirements/areas/auth.md:2876` |
| FREQ-239-AC-02 /admin のフッターの見出しが Didot で公開ページと一致する | E2E | `docs/02_Requirements/areas/auth.md:2889` |
| FREQ-239-AC-03 ACCOUNTING の見出しは acumin-pro のまま | E2E | `docs/02_Requirements/areas/auth.md:2902` |
| FREQ-239-AC-04 3つの幅で横のスクロールが出ない | E2E | `docs/02_Requirements/areas/auth.md:2915` |
| FREQ-309-AC-01 商品がある時に count のバッジが1つ出て点数が出る | E2E | `docs/02_Requirements/areas/auth.md:2928` |
| FREQ-309-AC-02 1桁でも2桁でもバッジの幅と高さが等しい | E2E | `docs/02_Requirements/areas/auth.md:2941` |
| FREQ-309-AC-03 点数が 128 の時に 99+ と出る | E2E | `docs/02_Requirements/areas/auth.md:2954` |
| FREQ-309-AC-04 バッジの中心が右上の角にあり、白いリングが付く | E2E | `docs/02_Requirements/areas/auth.md:2967` |
| FREQ-309-AC-05 カートが空の時にバッジが無い | E2E | `docs/02_Requirements/areas/auth.md:2980` |
| FREQ-316-REQ-01-AC-01 Cookie の access token だけで管理の窓口が通り、iss か aud の違うトークンは断られる | E2E | `docs/02_Requirements/areas/auth.md:2993` |
| FREQ-316-REQ-02-AC-01 TOTP の確認の後の Cookie の access token が aal2 になり、aal1 のトークンでは管理の窓口が 403 になる | E2E | `docs/02_Requirements/areas/auth.md:3005` |
| FREQ-316-REQ-03-AC-01 ログアウトの後、その前の access token で管理の窓口が 401 になる | E2E | `docs/02_Requirements/areas/auth.md:3017` |
| FREQ-316-AC-01 管理の窓口が 401・更新が 429 でも、更新の呼び出しが1回以下 | E2E | `docs/02_Requirements/areas/auth.md:3029` |
| FREQ-316-AC-02 更新が 401 の時に「アクセス権限がありません」が出て、更新の呼び出しが1回以下 | E2E | `docs/02_Requirements/areas/auth.md:3042` |
| FREQ-319-AC-01 「再設定メールを送信」で 500 にならず 200 が返る | E2E | `docs/02_Requirements/areas/auth.md:3055` |
| FREQ-319-AC-02 未登録の宛先でも応答が同じで、メールが送られない | E2E | `docs/02_Requirements/areas/auth.md:3068` |
| FREQ-319-AC-03 リンクを開いても link の POST を繰り返しても消費されない | E2E | `docs/02_Requirements/areas/auth.md:3081` |
| FREQ-319-AC-04 期限切れのリンクで理由の文が出る | E2E | `docs/02_Requirements/areas/auth.md:3094` |
| FREQ-319-AC-05 更新の失敗で 500 になり、成功後は古いトークンが 401 になる | E2E | `docs/02_Requirements/areas/auth.md:3107` |
| FREQ-320-AC-01 DB の関数が失敗すると再設定は 500、登録は 503 で、監査が success にならない | E2E | `docs/02_Requirements/areas/auth.md:3120` |
| FREQ-320-AC-02 sb-access-token の Max-Age が 604800 で、ログアウトで他の端末が切れない | E2E | `docs/02_Requirements/areas/auth.md:3133` |
| FREQ-320-AC-03 登録済みと未登録で /api/auth/register の応答が一致する | E2E | `docs/02_Requirements/areas/auth.md:3146` |
| FREQ-320-AC-04 登録の後の画面に「既に登録」の文言が出ない | E2E | `docs/02_Requirements/areas/auth.md:3159` |
| FREQ-323-AC-01 漏れたパスワードで 400 になり、外へ出る URL に本体と6文字目以降が無い | E2E | `docs/02_Requirements/areas/auth.md:3172` |
| FREQ-323-AC-02 HIBP が応答しなくても登録でき、監査に検査不能が残る | E2E | `docs/02_Requirements/areas/auth.md:3185` |
| FREQ-323-AC-03 15 文字は断られ 16 文字は通り、記号や数字が無くても通る | E2E | `docs/02_Requirements/areas/auth.md:3198` |
| FREQ-323-AC-04 再設定の2つの欄の placeholder に「16+ characters」があり、「8文字以上」が無い | E2E | `docs/02_Requirements/areas/auth.md:3211` |
| FREQ-327-AC-01 proxy に並べていない /api の窓口へ許可の外のオリジンから POST すると 403 | E2E | `docs/02_Requirements/areas/auth.md:3224` |
| FREQ-327-AC-02 外した道への Origin 無しの POST と、/api の外への POST は 403 にならない | E2E | `docs/02_Requirements/areas/auth.md:3237` |
| FREQ-327-AC-03 許可の外のオリジンからの /api/contact への POST に proxy の応答が 403 で返る | E2E | `docs/02_Requirements/areas/auth.md:3250` |
| FREQ-327-AC-04 同じ利用者の問い合わせの返信が1時間に30件を超えると 429 | E2E | `docs/02_Requirements/areas/auth.md:3263` |
| FREQ-328-AC-01 /auth/password-reset に Turnstile が描かれトークンが出る | E2E | `docs/02_Requirements/areas/auth.md:3276` |
| FREQ-328-AC-02 Turnstile の幅が送信ボタン（/login では Google ボタンも）と一致する | E2E | `docs/02_Requirements/areas/auth.md:3289` |
| FREQ-328-AC-03 375px で横のスクロールが出ない | E2E | `docs/02_Requirements/areas/auth.md:3302` |
| FREQ-328-AC-04 送信ボタンの直前の要素との間隔が 21px | E2E | `docs/02_Requirements/areas/auth.md:3315` |
| FREQ-329-AC-01 送信の後に送信ボタンと Email の欄が出ない | E2E | `docs/02_Requirements/areas/auth.md:3328` |
| FREQ-329-AC-02 「再送信すると前回のリンクは無効です」が出て宛先が出ない | E2E | `docs/02_Requirements/areas/auth.md:3341` |
| FREQ-329-AC-03 送信の直後に残り時間が出て「再送信する」が無い | E2E | `docs/02_Requirements/areas/auth.md:3354` |
| FREQ-329-AC-04 再送が 429 の時に上限の文が出て「再送信する」が無い | E2E | `docs/02_Requirements/areas/auth.md:3367` |
| FREQ-329-AC-05 更新の成功の後に「パスワードを更新しました」と「ログインへ」が出る | E2E | `docs/02_Requirements/areas/auth.md:3380` |
| FREQ-330-AC-01 ログインの再試行で2回目に違うトークンを送る | E2E | `docs/02_Requirements/areas/auth.md:3393` |
| FREQ-330-AC-02 OTP の再送が /api/auth/login/resend へ本文なしで送られる | E2E | `docs/02_Requirements/areas/auth.md:3406` |
| FREQ-330-AC-03 再設定の再試行で2回目に違うトークンを送る | E2E | `docs/02_Requirements/areas/auth.md:3419` |
| FREQ-330-REQ-02-AC-01 ログイン・会員登録・再設定のウィジェットの引き直しが useTurnstileWidget の1か所にある | E2E | `docs/02_Requirements/areas/auth.md:3433` |
| FREQ-331-AC-01 送信の後に封筒の図が出て南京錠が出ない（完了の画面は逆） | E2E | `docs/02_Requirements/areas/auth.md:3445` |
| FREQ-331-AC-02 送信の後の h1 が1つで「再設定メールを送信しました」 | E2E | `docs/02_Requirements/areas/auth.md:3458` |
| FREQ-331-AC-03 注意書きが背景 rgb(237, 237, 237) の左寄せの要素の中にある | E2E | `docs/02_Requirements/areas/auth.md:3471` |
| FREQ-331-AC-04 隙間が ① < ② < ③ < ④ で、④ の3か所が 3px 未満の差でそろう | E2E | `docs/02_Requirements/areas/auth.md:3484` |
| FREQ-331-AC-05 送信の後と完了の画面で h1 が1行 | E2E | `docs/02_Requirements/areas/auth.md:3497` |
| FREQ-331-AC-06 注意書きが3行で、どの行も1行に収まる | E2E | `docs/02_Requirements/areas/auth.md:3510` |
| FREQ-331-AC-07 図・題・詳細の中の隙間がパネルまでの隙間の半分以下 | E2E | `docs/02_Requirements/areas/auth.md:3523` |
| FREQ-332-AC-01 verify を開くと「パスワードを再設定する」が出ず、link の POST がちょうど1回 | E2E | `docs/02_Requirements/areas/auth.md:3536` |
| FREQ-332-AC-02 link の POST が通ると New Password の欄が出る | E2E | `docs/02_Requirements/areas/auth.md:3549` |
| FREQ-332-AC-03 link の POST が通信の誤りの時に再試行のボタンが出る | E2E | `docs/02_Requirements/areas/auth.md:3562` |
| FREQ-332-AC-04 expires_at が 10 分後、Cookie の Max-Age が 600、本文に「10分間有効」 | E2E | `docs/02_Requirements/areas/auth.md:3575` |
| FREQ-333-AC-01 2つが違うと「パスワードが一致しません」が出て confirm が送られない | E2E | `docs/02_Requirements/areas/auth.md:3588` |
| FREQ-333-AC-02 確認の欄に表示切替があり、2つの placeholder が決まりどおり | E2E | `docs/02_Requirements/areas/auth.md:3601` |
| FREQ-333-AC-03 片方だけでは更新ボタンが無効で、送る本文のキーが new_password だけ | E2E | `docs/02_Requirements/areas/auth.md:3614` |
| FREQ-333-AC-04 再設定のモードで #email が無い | E2E | `docs/02_Requirements/areas/auth.md:3627` |
| FREQ-334-AC-01 2FA の Cookie なしで /login/verify を開くと /login へ移り、入力欄が出ない | E2E | `docs/02_Requirements/areas/auth.md:3640` |
| FREQ-334-AC-02 パスワードの後に /login/verify へ着き、戻るでフォームへ戻らない | E2E | `docs/02_Requirements/areas/auth.md:3653` |
| FREQ-334-AC-03 有効な Cookie で /login を開くと /login/verify へ移る | E2E | `docs/02_Requirements/areas/auth.md:3666` |
| FREQ-334-AC-04 検証の画面に生のメールが出ず、伏せた文字が出る | E2E | `docs/02_Requirements/areas/auth.md:3679` |
| FREQ-334-AC-05 再送で /api/auth/login/resend が呼ばれ、本文にメールもパスワードも無い | E2E | `docs/02_Requirements/areas/auth.md:3692` |
| FREQ-334-AC-06 やり直しの後に /login/verify を開いても入力の画面が出ない | E2E | `docs/02_Requirements/areas/auth.md:3705` |
| FREQ-335-AC-01 同じアカウントで誤りを5回送ると6回目が 429 で、他のアカウントは減らない | E2E | `docs/02_Requirements/areas/auth.md:3718` |
| FREQ-335-AC-03 1回送ると verifyOtp が type email で1回だけ呼ばれる | E2E | `docs/02_Requirements/areas/auth.md:3744` |
| FREQ-335-AC-04 ログインが出す sb-login-2fa-session の Max-Age が 300 | E2E | `docs/02_Requirements/areas/auth.md:3757` |
| FREQ-336-AC-01 発行から 30 分を超えたトークンは exp が先でも無効で、再送で上限が延びない | E2E | `docs/02_Requirements/areas/auth.md:3770` |
| FREQ-336-AC-02 resend が IP 単位とアカウント単位の両方の制限を呼び、IP の上限で 429 | E2E | `docs/02_Requirements/areas/auth.md:3783` |
| FREQ-336-AC-03 otp/verify の本文が code だけで、email を混ぜても宛先が変わらない | E2E | `docs/02_Requirements/areas/auth.md:3796` |
| FREQ-336-AC-04 Cookie なしの cancel は 200 と破棄の指示を返し、監査を残さない | E2E | `docs/02_Requirements/areas/auth.md:3809` |
| FREQ-336-AC-05 localhost・127.0.0.1 でない時に setLoginTwoFactorCookie が例外を投げる | E2E | `docs/02_Requirements/areas/auth.md:3822` |
| FREQ-515-AC-01 管理画面のユーザー一覧で選んだ役割で送られ、失敗したら元の役割に戻る | E2E | `docs/02_Requirements/areas/auth.md:3835` |
| FREQ-515-AC-02 ログインの確認で2つ目の認証要素を選んでコードを送ると、2つ目で確かめる | E2E | `docs/02_Requirements/areas/auth.md:3848` |
| FREQ-515-AC-03 お知らせの作成・編集で選んだカテゴリーで保存される | E2E | `docs/02_Requirements/areas/auth.md:3861` |
| FR-LOGIN-001-AC-01 パスワードの後に認証コードの画面へ移り、コードを入れるまでログインしない | E2E | `docs/02_Requirements/areas/auth.md:3878` |
| FR-LOGIN-001-AC-02 パスワードを通っていないと認証コードだけではログインできない | E2E | `docs/02_Requirements/areas/auth.md:3890` |
| FR-LOGIN-002-AC-01 Google のボタンが出て、押すとアカウントを選ぶ Google の画面へ移る | E2E | `docs/02_Requirements/areas/auth.md:3902` |
| FR-LOGIN-003-AC-01 ログインの画面から再設定のページへ移れる | E2E | `docs/02_Requirements/areas/auth.md:3914` |
| FR-LOGIN-004-AC-01 会員登録タブから確認メールを受け取り、リンクで登録を終える | E2E | `docs/02_Requirements/areas/auth.md:3926` |
| FR-LOGIN-005-AC-01 題が「LOGIN \| Le Fil des Heures」で説明が入る | E2E | `docs/02_Requirements/areas/auth.md:3938` |
| FR-LOGIN-006-AC-01 送った後 60 秒は再送できず、残り時間が出る | E2E | `docs/02_Requirements/areas/auth.md:3950` |
| FR-LOGIN-006-AC-02 再送が断られた時に理由と待ちを出し、中の文を出さない | E2E | `docs/02_Requirements/areas/auth.md:3962` |
| FR-LOGIN-007-AC-01 一般の会員はメール OTP の後に会員ページへ移る | E2E | `docs/02_Requirements/areas/auth.md:3974` |
| FR-LOGIN-007-AC-02 管理者とサポーターは TOTP を通るまで管理画面へ進めない | E2E | `docs/02_Requirements/areas/auth.md:3986` |
| FR-LOGIN-008-AC-01 確認の画面に5分の有効期限が出る | E2E | `docs/02_Requirements/areas/auth.md:3998` |
| FR-LOGIN-008-AC-02 送ってから5分を過ぎたコードではログインできない | E2E | `docs/02_Requirements/areas/auth.md:4010` |
| FR-AUTH-001-AC-01 ドロワーに「Le Fil des Heures」の文字が出ない | E2E | `docs/02_Requirements/areas/auth.md:4022` |
| FR-AUTH-002-AC-01 SNS のリンクが flex で縦横の中央寄せになっている | E2E | `docs/02_Requirements/areas/auth.md:4036` |
| FR-AUTH-003-AC-01 通常は brightness(0)、ホバーは brightness(0) invert(1) が効く | E2E | `docs/02_Requirements/areas/auth.md:4050` |
| FR-AUTH-004-AC-01 子の末尾から次の親の上の線まで 20px 以上ある | E2E | `docs/02_Requirements/areas/auth.md:4064` |
| SEC-AUTH-001-AC-01 同じメールで6回目のログインが 429 になる | E2E | `docs/02_Requirements/areas/auth.md:4093` |
| SEC-AUTH-001-AC-02 Turnstile に落ちた送信はメールの枠を減らさない | E2E | `docs/02_Requirements/areas/auth.md:4105` |
| SEC-AUTH-002-AC-01 誤ったコードを6回送ると保留が消える | E2E | `docs/02_Requirements/areas/auth.md:4130` |
| SEC-AUTH-002-AC-02 本文に別の宛先を書いても、数えるのは保留の宛先 | E2E | `docs/02_Requirements/areas/auth.md:4142` |
| SEC-AUTH-003-AC-01 保留の Cookie が無い OTP の送信は 401 | E2E | `docs/02_Requirements/areas/auth.md:4167` |
| SEC-AUTH-003-AC-02 署名を書き換えた保留の Cookie は 401 | E2E | `docs/02_Requirements/areas/auth.md:4179` |
| SEC-AUTH-004-AC-01 30 分を過ぎた保留での再送は 401 | E2E | `docs/02_Requirements/areas/auth.md:4204` |
| SEC-AUTH-004-AC-02 本文に別の宛先を書いても、再送は保留の宛先にだけ届く | E2E | `docs/02_Requirements/areas/auth.md:4216` |
| SEC-AUTH-005-AC-01 Supabase Auth の password grant で得た JWT ではアプリの会員の窓口が通らない | E2E | `docs/02_Requirements/areas/auth.md:4241` |
| SEC-AUTH-005-AC-02 同じ JWT で PostgREST から `profiles` と注文が読めない | E2E | `docs/02_Requirements/areas/auth.md:4253` |
| SEC-AUTH-006-AC-01 マジックリンクの印で確認のリンクを開いても session ができない | E2E | `docs/02_Requirements/areas/auth.md:4278` |
| SEC-AUTH-006-AC-02 会員登録の確認の印では今どおり session ができる | E2E | `docs/02_Requirements/areas/auth.md:4290` |
| SEC-AUTH-007-AC-01 登録を始めていない端末で確認のリンクを開いても、黙ってログインしない | E2E | `docs/02_Requirements/areas/auth.md:4315` |
| SEC-AUTH-008-AC-01 Google でログインした管理者は、TOTP の前に管理の窓口が 403 | E2E | `docs/02_Requirements/areas/auth.md:4340` |
| SEC-AUTH-009-AC-01 同じ利用者の6回目の TOTP の確認が 429 | E2E | `docs/02_Requirements/areas/auth.md:4365` |
| SEC-AUTH-009-AC-02 TOTP の失敗が監査に残る | E2E | `docs/02_Requirements/areas/auth.md:4377` |
| SEC-AUTH-010-AC-01 aal1 の管理者の JWT で、他人の注文が読めない | E2E | `docs/02_Requirements/areas/auth.md:4402` |
| SEC-AUTH-010-AC-02 aal2 の管理者の JWT では今どおり読める | E2E | `docs/02_Requirements/areas/auth.md:4414` |
| SEC-AUTH-011-AC-01 anon・会員の JWT で認証の表を読むと権限の誤りになる | E2E | `docs/02_Requirements/areas/auth.md:4439` |
| SEC-AUTH-012-AC-01 anon・会員の JWT で認証の関数を呼ぶと権限の誤りになる | E2E | `docs/02_Requirements/areas/auth.md:4464` |
| SEC-AUTH-013-AC-01 `x-forwarded-for` を毎回変えても IP 単位の制限が効く | E2E | `docs/02_Requirements/areas/auth.md:4489` |
| SEC-AUTH-013-AC-02 回数の制限の例外で窓口が先へ進まない | E2E | `docs/02_Requirements/areas/auth.md:4501` |
| SEC-AUTH-014-AC-01 漏洩済みのパスワードでの会員登録が 400 | E2E | `docs/02_Requirements/areas/auth.md:4526` |
| SEC-AUTH-014-AC-02 15 文字のパスワードでの再設定が 400 | E2E | `docs/02_Requirements/areas/auth.md:4538` |
| SEC-AUTH-015-AC-01 直接の `/auth/v1/signup` で 15 文字のパスワードの登録ができない | E2E | `docs/02_Requirements/areas/auth.md:4563` |
| SEC-AUTH-015-AC-02 直接の `/auth/v1/user` で再認証なしにパスワードを変えられない | E2E | `docs/02_Requirements/areas/auth.md:4575` |
| SEC-AUTH-015-AC-03 本番でメールの差し替えに新旧両方の確認が要る | E2E | `docs/02_Requirements/areas/auth.md:4587` |
| SEC-AUTH-016-AC-01 登録済みと未登録のメールで会員登録の応答が同じ | E2E | `docs/02_Requirements/areas/auth.md:4613` |
| SEC-AUTH-016-AC-02 未登録のメールで再設定を申請してもメールが届かない | E2E | `docs/02_Requirements/areas/auth.md:4625` |
| SEC-AUTH-016-AC-03 同じ宛先への会員登録を続けると、宛先単位の上限で断られる | E2E | `docs/02_Requirements/areas/auth.md:4637` |
| SEC-AUTH-017-AC-01 管理の鍵を付けて登録済みのメールを送っても 409 にならない | E2E | `docs/02_Requirements/areas/auth.md:4662` |
| SEC-AUTH-018-AC-01 使い終わったリンクをもう一度開いても再設定できない | E2E | `docs/02_Requirements/areas/auth.md:4687` |
| SEC-AUTH-018-AC-02 新しく申請すると前のリンクが使えない | E2E | `docs/02_Requirements/areas/auth.md:4699` |
| SEC-AUTH-019-AC-01 偽の `x-forwarded-host` での再設定の申請ではメールが届かない | E2E | `docs/02_Requirements/areas/auth.md:4724` |
| SEC-AUTH-020-AC-01 再設定の後、別の端末のセッションが 401 になる | E2E | `docs/02_Requirements/areas/auth.md:4749` |
| SEC-AUTH-021-AC-01 ログアウトの前の refresh token が使えない | E2E | `docs/02_Requirements/areas/auth.md:4774` |
| SEC-AUTH-022-AC-01 トークンの更新と OTP の検証の応答の本文にトークンが無い | E2E | `docs/02_Requirements/areas/auth.md:4799` |
| SEC-AUTH-022-AC-02 認証の応答に no-store が付く | E2E | `docs/02_Requirements/areas/auth.md:4811` |
| SEC-AUTH-023-AC-01 Google のログインの後に、JS から読める Cookie にトークンが無い | E2E | `docs/02_Requirements/areas/auth.md:4836` |
| SEC-AUTH-024-AC-01 ログインの後の Cookie の属性が決まりどおり | E2E | `docs/02_Requirements/areas/auth.md:4861` |
| SEC-AUTH-025-AC-01 別のオリジンからの再設定の完了が 403 | E2E | `docs/02_Requirements/areas/auth.md:4886` |
| SEC-AUTH-026-AC-01 `/auth/callback?next=//evil.example` で外へ出ない | E2E | `docs/02_Requirements/areas/auth.md:4911` |
| SEC-AUTH-027-AC-01 再設定の Cookie を保留の2段目の Cookie に入れても通らない | E2E | `docs/02_Requirements/areas/auth.md:4936` |
| SEC-AUTH-028-AC-01 一般の会員のヘッダーに MANAGE・LOADING が出ない | E2E | `docs/02_Requirements/areas/auth.md:4961` |
| SEC-AUTH-028-AC-02 `user_metadata` に admin を書いた会員は管理の窓口が 403 | E2E | `docs/02_Requirements/areas/auth.md:4973` |
| SEC-AUTH-029-AC-01 会員登録の応答が 201 にならない | E2E | `docs/02_Requirements/areas/auth.md:4998` |
| SEC-AUTH-029-AC-02 5 分を過ぎたメール OTP が通らない | E2E | `docs/02_Requirements/areas/auth.md:5010` |
| SEC-AUTH-030-AC-01 TOTP の登録と確認の成功が監査に残る | E2E | `docs/02_Requirements/areas/auth.md:5035` |
| SEC-AUTH-030-AC-02 ログインの失敗が伏せた形で監査に残る | E2E | `docs/02_Requirements/areas/auth.md:5047` |
| SEC-AUTH-031-AC-01 メール OTP を通っていない aal1 の session では初めての TOTP を登録できない | E2E | `docs/02_Requirements/areas/auth.md:5072` |
| FREQ-25-AC-01 返信が顧客へメールで届き、スレッドに出る | E2E | `docs/02_Requirements/areas/admin.md:162` |
| FREQ-508-AC-01 店長だけに閲覧の権限が付き、権限のある店長に監査ログの一覧が表示される | E2E | `docs/02_Requirements/areas/admin.md:175` |
| FREQ-508-AC-02 店長以外には付けず、権限が無ければ店長でも 403 で監査ログを読まない | E2E | `docs/02_Requirements/areas/admin.md:188` |
| FREQ-508-AC-03 流し直しても付与が重ならず、ほかの結び付きが残り、「監査ログの閲覧」の名前で登録される | E2E | `docs/02_Requirements/areas/admin.md:201` |
| FR-ADMIN-009-AC-01 管理画面に CONTACT のタブが出て、押すと問い合わせの一覧が表示される | E2E | `docs/02_Requirements/areas/admin.md:218` |
| FR-ADMIN-009-AC-02 一覧が最後のやり取りの新しい順に 20 件ずつ出て、状態・種別・検索語で絞れる | E2E | `docs/02_Requirements/areas/admin.md:230` |
| FR-ADMIN-009-AC-03 詳細に名前・メール・種別・件名・注文番号とやり取りが古い順に出る | E2E | `docs/02_Requirements/areas/admin.md:242` |
| FR-ADMIN-009-AC-04 状態を4つの値のどれかに変えられ、ほかの値は断る | E2E | `docs/02_Requirements/areas/admin.md:254` |
| FR-ADMIN-009-AC-05 返信のテンプレートを作り・直し・消せ、選ぶと返信の本文に入る | E2E | `docs/02_Requirements/areas/admin.md:266` |
| FR-ADMIN-009-AC-06 閲覧の権限が無いと読めず、管理の権限が無いと返信・状態の変更・テンプレートの変更ができない | E2E | `docs/02_Requirements/areas/admin.md:278` |
| SEC-ADMIN-001-AC-01 JWT の無い要求を 401 で断る | E2E | `docs/02_Requirements/areas/admin.md:307` |
| SEC-ADMIN-001-AC-02 2要素を済ませていない session の JWT を 403 で断る | E2E | `docs/02_Requirements/areas/admin.md:319` |
| SEC-ADMIN-001-AC-03 サポーターは店長だけの窓口を使えない | E2E | `docs/02_Requirements/areas/admin.md:331` |
| SEC-ADMIN-001-AC-04 ユーザー作成の画面を開けても、権限が無ければ作れない | E2E | `docs/02_Requirements/areas/admin.md:343` |
| SEC-ADMIN-002-AC-01 aal1 の JWT で色見本を直接書けない | E2E | `docs/02_Requirements/areas/admin.md:368` |
| SEC-ADMIN-002-AC-02 強制失効の後の JWT で色見本を直接読めない | E2E | `docs/02_Requirements/areas/admin.md:380` |
| SEC-ADMIN-003-AC-01 anon と一般会員の JWT で管理の表を読めない・書けない | E2E | `docs/02_Requirements/areas/admin.md:405` |
| SEC-ADMIN-003-AC-02 管理の表の権限が anon・authenticated に無い | E2E | `docs/02_Requirements/areas/admin.md:417` |
| SEC-ADMIN-004-AC-01 anon・一般会員・店長の JWT で RPC を呼べない | E2E | `docs/02_Requirements/areas/admin.md:442` |
| SEC-ADMIN-005-AC-01 Origin も Referer も無い書き込みを 403 で断る | E2E | `docs/02_Requirements/areas/admin.md:467` |
| SEC-ADMIN-005-AC-02 別のオリジンからの書き込みを 403 で断る | E2E | `docs/02_Requirements/areas/admin.md:479` |
| SEC-ADMIN-006-AC-01 回数を超えた書き込みを 429 で断る | E2E | `docs/02_Requirements/areas/admin.md:504` |
| SEC-ADMIN-006-AC-02 送る IP の見出しを変えても数え直されない | E2E | `docs/02_Requirements/areas/admin.md:516` |
| SEC-ADMIN-007-AC-01 JWT の無い強制失効の要求を繰り返しても監査ログが際限なく増えない | E2E | `docs/02_Requirements/areas/admin.md:541` |
| SEC-ADMIN-008-AC-01 MFA のリセットの記録に対象のメールと理由の文が平文で出ない | E2E | `docs/02_Requirements/areas/admin.md:566` |
| SEC-ADMIN-008-AC-02 ユーザー作成の失敗の記録に Supabase の誤りの文が出ない | E2E | `docs/02_Requirements/areas/admin.md:578` |
| SEC-ADMIN-009-AC-01 送る側が足した IP が監査ログに残らない | E2E | `docs/02_Requirements/areas/admin.md:603` |
| SEC-ADMIN-010-AC-01 監査ログの行を書き換えると検知の確かめで分かる | E2E | `docs/02_Requirements/areas/admin.md:628` |
| SEC-ADMIN-010-AC-02 保持の期間を過ぎた行は写しを残してから消える | E2E | `docs/02_Requirements/areas/admin.md:640` |
| SEC-ADMIN-011-AC-01 店長の応答に行為者のメール・IP・ブラウザの情報・metadata が出ない | E2E | `docs/02_Requirements/areas/admin.md:665` |
| SEC-ADMIN-012-AC-01 15 文字のパスワードでの作成を断る | E2E | `docs/02_Requirements/areas/admin.md:690` |
| SEC-ADMIN-012-AC-02 漏れたパスワードでの作成を断る | E2E | `docs/02_Requirements/areas/admin.md:702` |
| SEC-ADMIN-013-AC-01 長すぎる表示名での作成を断る | E2E | `docs/02_Requirements/areas/admin.md:727` |
| SEC-ADMIN-013-AC-02 壊れた JSON と UUID でない id を 400 で断る | E2E | `docs/02_Requirements/areas/admin.md:739` |
| SEC-ADMIN-014-AC-01 ACL で特権を外した人の MFA はリセットしない | E2E | `docs/02_Requirements/areas/admin.md:764` |
| SEC-ADMIN-014-AC-02 リセットの後、対象の session が全部失効する | E2E | `docs/02_Requirements/areas/admin.md:776` |
| SEC-ADMIN-015-AC-01 自分自身の失効を断る | E2E | `docs/02_Requirements/areas/admin.md:801` |
| SEC-ADMIN-015-AC-02 存在しない利用者の失効を 404 で断る | E2E | `docs/02_Requirements/areas/admin.md:813` |
| SEC-ADMIN-016-AC-01 失効の後、自前と Auth の session が全部止まる | E2E | `docs/02_Requirements/areas/admin.md:838` |
| SEC-ADMIN-017-AC-01 印を変えた宛先への返信はスレッドに出ない | E2E | `docs/02_Requirements/areas/admin.md:863` |
| SEC-ADMIN-017-AC-02 秘密が未設定なら Reply-To の無いメールを送る | E2E | `docs/02_Requirements/areas/admin.md:875` |
| SEC-ADMIN-018-AC-01 改行入りの件名に返信しても、送るメールの件名に改行が無い | E2E | `docs/02_Requirements/areas/admin.md:900` |
| SEC-ADMIN-019-AC-01 区切りの字を含む検索語で、ほかの条件が足されない | E2E | `docs/02_Requirements/areas/admin.md:925` |
| SEC-ADMIN-020-AC-01 サポーターの詳細に IP とブラウザの情報が出ない | E2E | `docs/02_Requirements/areas/admin.md:950` |
| SEC-ADMIN-021-AC-01 存在しない id への変更を 404 で返し、成功を記録しない | E2E | `docs/02_Requirements/areas/admin.md:975` |
| SEC-ADMIN-021-AC-02 メールを送らなかった返信は mailSent を false で返す | E2E | `docs/02_Requirements/areas/admin.md:987` |
| SEC-ADMIN-022-AC-01 色見本の作成と削除が行為者付きで記録される | E2E | `docs/02_Requirements/areas/admin.md:1012` |
| SEC-ADMIN-022-AC-02 問い合わせの変更の記録に行為者のメールと IP が入る | E2E | `docs/02_Requirements/areas/admin.md:1024` |
| SEC-ADMIN-023-AC-01 問い合わせの詳細と監査ログを読むと、読んだ人付きの記録が増える | E2E | `docs/02_Requirements/areas/admin.md:1049` |

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
| e2e | `e2e/FR-HOME-001-hero-banner.spec.ts:4` | renders hero section with brand heading and background image |
| e2e | `e2e/FR-HOME-002-home-sections.spec.ts:16` | renders correctly on ${vp.name} (${vp.width}px) |
| e2e | `e2e/FR-HOME-004-view-all-buttons.spec.ts:7` | home sections include VIEW ALL links for item, lookbook, and news |
| e2e | `e2e/FR-HOME-005-stockist-home.spec.ts:4` | renders stockist section on home with up to 6 cards |
| e2e | `e2e/FR-HOME-006-007-011-home-quality.spec.ts:4` | sets home metadata, prioritizes hero image, and keeps accessible structure |
| e2e | `e2e/FR-HOME-006-home-metadata.spec.ts:4` | home page has specific title and description metadata |
| e2e | `e2e/FR-HOME-007-hero-priority.spec.ts:4` | preloads hero image for LCP optimization |
| e2e | `e2e/FR-HOME-008-about-image.spec.ts:4` | uses static local asset for ABOUT section image |
| e2e | `e2e/FR-HOME-009-heading-structure.spec.ts:4` | home page uses a single h1 and section headings as h2 |
| e2e | `e2e/FR-HOME-012-view-all-button-ui.spec.ts:15` | ${viewport.name}: VIEW ALL buttons use Button component without arrow icon |
| e2e | `e2e/FR-HOME-013-section-display-limits.spec.ts:83` | ${viewport.name}: sections show breakpoint-specific counts with conditional VIEW ALL |
| e2e | `e2e/FR-HOME-017-section-title-common.spec.ts:56` | ${vp.name}: FREQ-275-AC-01/AC-02/AC-03 見出しが共通サイズ・共通下線 |
| e2e | `e2e/FR-HOME-018-hero-motion.spec.ts:15` | ${vp.name} ブランド名が1文字ずつの span に分割され、完了後は全文字が見える |
| e2e | `e2e/FR-HOME-018-hero-motion.spec.ts:40` | ${vp.name} 縦線が heroThreadLoop で動き、ブランド名が 6xl サイズになる |
| e2e | `e2e/FR-HOME-018-hero-motion.spec.ts:68` | 見出しのアクセシブル名が1文字ずつに分解されない |
| e2e | `e2e/FR-HOME-018-hero-motion.spec.ts:82` | prefers-reduced-motion: reduce でヒーローのモーションが止まる |
| e2e | `e2e/FR-HOME-018-hero-motion.spec.ts:98` | CSP が inline style を落とさず、style-src-elem は締まったまま |
| e2e | `e2e/FR-HOME-019-hero-thread-loop.spec.ts:14` | ${vp.name} 縦線が上から下へ伸びる動きだけを無限再生する |
| e2e | `e2e/FR-HOME-019-hero-thread-loop.spec.ts:56` | prefers-reduced-motion: reduce で縦線が動かない |
| e2e | `e2e/FR-HOME-020-hero-scroll-color.spec.ts:13` | ${vp.name} SCROLL ラベルと縦線が白 90% で描画される |
| e2e | `e2e/NFR-HOME-001-home-performance.spec.ts:4` | initial load completes within 2 seconds |
| e2e | `e2e/NFR-HOME-002-wcag-accessibility.spec.ts:4` | hero text has a high-contrast white color and gradient overlay |
| e2e | `e2e/FR-LOOK-ALL-001-published-looks-grid.spec.ts:4` | 公開済みルックをカードグリッドで表示する |
| e2e | `e2e/FR-LOOK-ALL-002-look-card-fields-and-navigation.spec.ts:4` | カードにシーズン・テーマ・画像・紐づけ商品名を表示し詳細へ遷移できる |
| e2e | `e2e/FR-LOOK-ALL-003-look-list-render-capacity.spec.ts:4` | LOOK一覧でカードが表示され、6件以上存在する場合でも一覧表示が成立する |
| e2e | `e2e/FR-LOOK-ALL-004-home-look-section-and-cta.spec.ts:4` | HOMEのLOOKセクションでカード表示とLOOK一覧導線を確認する |
| e2e | `e2e/FR-LOOK-ALL-005-look-list-seo-metadata.spec.ts:4` | LOOK一覧ページにタイトルとdescriptionメタを設定する |
| e2e | `e2e/FR-LOOK-ALL-006-look-filter-sort-wont.spec.ts:6` | desktop では左サイドバーから season を切り替えられる |
| e2e | `e2e/FR-LOOK-ALL-006-look-filter-sort-wont.spec.ts:31` | ${vp.name} では FILTER ボタンから drawer を開ける |
| e2e | `e2e/FR-LOOK-ALL-007-related-item-spacing.spec.ts:75` | HOME の LOOK セクションで関連商品の見た目 gap が phi 比率に一致する |
| e2e | `e2e/FR-LOOK-ALL-007-related-item-spacing.spec.ts:87` | /look 一覧で関連商品の見た目 gap が phi 比率に一致する |
| e2e | `e2e/FR-LOOK-ALL-008-no-lookbook-heading.spec.ts:10` | ページ最上部に LOOK BOOK 見出しが無い |
| e2e | `e2e/FR-LOOK-ALL-009-filter-spacing-match-news.spec.ts:39` | desktop でサイドバーの option-list gap が LOOK と NEWS で一致する |
| e2e | `e2e/FR-LOOK-ALL-009-filter-spacing-match-news.spec.ts:52` | ${vp.name} で drawer の option-list gap が LOOK と NEWS で一致する |
| e2e | `e2e/FR-LOOK-ALL-010-related-item-proximity.spec.ts:46` | ${vp.name} HOME の LOOK で関連商品リンクに上下 padding が無い |
| e2e | `e2e/FR-LOOK-ALL-010-related-item-proximity.spec.ts:56` | ${vp.name} /look 一覧で関連商品リンクに上下 padding が無い |
| e2e | `e2e/FR-LOOK-ALL-011-card-text-proximity.spec.ts:66` | ${vp.name} HOME の LOOK で 時期↔名前 < 名前↔関連 になる |
| e2e | `e2e/FR-LOOK-ALL-011-card-text-proximity.spec.ts:73` | ${vp.name} /look 一覧で 時期↔名前 < 名前↔関連 になる |
| e2e | `e2e/FR-LOOK-ALL-012-grid-row-gap.spec.ts:34` | ${vp.name} で row-gap が column-gap より広い |
| e2e | `e2e/FR-LOOK-ALL-012-grid-row-gap.spec.ts:44` | mobile で row-gap が従来値（16px）より広い |
| e2e | `e2e/FR-LOOK-ALL-013-related-item-mobile-stack.spec.ts:34` | mobile では商品名と価格が縦積みになる |
| e2e | `e2e/FR-LOOK-ALL-013-related-item-mobile-stack.spec.ts:45` | tablet では商品名と価格が同一行に並ぶ |
| e2e | `e2e/FR-LOOK-ALL-013-related-item-mobile-stack.spec.ts:56` | desktop ではカード下の関連アイテムが表示されない |
| e2e | `e2e/FR-LOOK-ALL-014-season-label-format.spec.ts:41` | ${vp.name} HOME の LOOK セクションで所定形式になる |
| e2e | `e2e/FR-LOOK-ALL-014-season-label-format.spec.ts:52` | ${vp.name} /look 一覧で所定形式になる |
| e2e | `e2e/FR-LOOK-ALL-015-card-overlay-desktop.spec.ts:48` | desktop ${target.label} で画像下部に白文字オーバーレイを表示する |
| e2e | `e2e/FR-LOOK-ALL-015-card-overlay-desktop.spec.ts:80` | ${vp.name} ${target.label} ではオーバーレイ非表示・キャプション表示 |
| e2e | `e2e/FR-LOOK-ALL-016-overlay-serif-gradient.spec.ts:38` | desktop ${target.label} でセリフ体・大文字・グラデーションになる |
| e2e | `e2e/FR-LOOK-ALL-016-overlay-serif-gradient.spec.ts:60` | ${vp.name} ではオーバーレイが表示されない |
| e2e | `e2e/FR-LOOK-ALL-017-overlay-gradient-smooth.spec.ts:23` | desktop ${target.label} で多段ストップかつ上端が完全透明になる |
| e2e | `e2e/FR-LOOK-ALL-017-overlay-gradient-smooth.spec.ts:46` | ${vp.name} ではオーバーレイが表示されない |
| e2e | `e2e/FR-LOOK-ALL-018-hover-related-items.spec.ts:13` | desktop ${target.label} でホバーするとタイトルが消え関連アイテムが出る |
| e2e | `e2e/FR-LOOK-ALL-018-hover-related-items.spec.ts:52` | ${vp.name} ではオーバーレイが表示されない |
| e2e | `e2e/FR-LOOK-ALL-019-hover-second-image.spec.ts:7` | desktop ホバーしても1枚目画像が拡大されない |
| e2e | `e2e/FR-LOOK-ALL-019-hover-second-image.spec.ts:22` | desktop 2枚目画像があるカードはホバーで opacity 1 になる |
| e2e | `e2e/FR-LOOK-ALL-019-hover-second-image.spec.ts:46` | ${vp.name} では2枚目画像が opacity 0 のまま表示されない |
| e2e | `e2e/FR-LOOK-ALL-020-desktop-hide-below-related-items.spec.ts:14` | desktop ${target.label} でカード下の関連アイテムリストが表示されない |
| e2e | `e2e/FR-LOOK-ALL-020-desktop-hide-below-related-items.spec.ts:36` | ${vp.name} /look ではカード下に関連アイテムリストが表示される |
| e2e | `e2e/FR-LOOK-ALL-021-overlay-text-alignment.spec.ts:40` | desktop ${target.label} でタイトルと関連アイテムの下端・左端が揃う |
| e2e | `e2e/FR-LOOK-ALL-021-overlay-text-alignment.spec.ts:64` | ${vp.name} ではオーバーレイが表示されない |
| e2e | `e2e/FR-LOOK-ALL-022-overlay-last-baseline.spec.ts:47` | desktop ${target.label} で文字の下のラインが揃う |
| e2e | `e2e/FR-LOOK-ALL-022-overlay-last-baseline.spec.ts:68` | ${vp.name} ではオーバーレイが表示されない |
| e2e | `e2e/FR-LOOK-ALL-023-desktop-image-no-margin.spec.ts:29` | desktop ${target.label} で margin-bottom が 0px |
| e2e | `e2e/FR-LOOK-ALL-023-desktop-image-no-margin.spec.ts:55` | ${vp.name} では margin-bottom が ${vp.expected}px |
| e2e | `e2e/FR-LOOK-ALL-024-equal-card-gaps.spec.ts:38` | ${vp.name} ${target.label} で row-gap と column-gap が等しい |
| e2e | `e2e/FR-LOOK-ALL-025-card-info-panel.spec.ts:27` | ${vp.name} ${target.name} シーズンラベルが「{年} {SS\|AW}」形式で画像下に表示される |
| e2e | `e2e/FR-LOOK-ALL-025-card-info-panel.spec.ts:51` | ${vp.name} ${target.name} テーマ名がセリフ体・大文字で表示される |
| e2e | `e2e/FR-LOOK-ALL-025-card-info-panel.spec.ts:65` | ${vp.name} ${target.name} テーマ名と関連アイテムの間に罫線が表示される |
| e2e | `e2e/FR-LOOK-ALL-025-card-info-panel.spec.ts:94` | tablet /look 関連アイテムの価格が右寄せで表示される |
| e2e | `e2e/FR-LOOK-ALL-025-card-info-panel.spec.ts:114` | desktop /look ではオーバーレイが表示され画像下パネルが表示されない |
| e2e | `e2e/FR-LOOK-ALL-026-panel-spacing-typography.spec.ts:85` | ${vp.name} ${target.name} 余白と文字サイズが4原則に従う |
| e2e | `e2e/FR-LOOK-ALL-026-panel-spacing-typography.spec.ts:115` | desktop /look ではキャプションが表示されず画像 mb が 0 |
| e2e | `e2e/FR-LOOK-ALL-027-mobile-tablet-row-gap.spec.ts:33` | mobile ${target.name} row-gap 34px / column-gap 16px |
| e2e | `e2e/FR-LOOK-ALL-027-mobile-tablet-row-gap.spec.ts:47` | tablet ${target.name} row-gap 55px / column-gap 従来値 |
| e2e | `e2e/FR-LOOK-ALL-027-mobile-tablet-row-gap.spec.ts:61` | desktop ${target.name} は従来どおり縦横同値 24px |
| e2e | `e2e/FR-LOOK-ALL-028-catalog-match-home-mobile.spec.ts:56` | ${vp.name} /look の左右 padding がホーム LOOK セクションと同値 |
| e2e | `e2e/FR-LOOK-ALL-028-catalog-match-home-mobile.spec.ts:71` | ${vp.name} /look の row-gap / column-gap がホームと一致 |
| e2e | `e2e/FR-LOOK-ALL-028-catalog-match-home-mobile.spec.ts:93` | desktop /look の gap と左 padding が従来どおり |
| e2e | `e2e/FR-LOOK-ALL-029-card-gray-border.spec.ts:27` | ${vp.name} ${target.name} カードに 1px のグレー枠線が表示される |
| e2e | `e2e/FR-LOOK-ALL-029-card-gray-border.spec.ts:57` | ${vp.name} ${target.name} 画像は枠線に密着し情報パネルには内側余白がある |
| e2e | `e2e/FR-LOOK-ALL-029-card-gray-border.spec.ts:96` | desktop ${target.name} ではカードに枠線が表示されない |
| e2e | `e2e/FR-LOOK-ALL-030-season-label-emphasis.spec.ts:52` | ${vp.name} ${path} でシーズン表記が濃く・太くなる |
| e2e | `e2e/FR-LOOK-ALL-031-related-item-match-item-card.spec.ts:65` | ${vp.name} 関連 ITEM の商品名・価格が ITEM カードと一致する |
| e2e | `e2e/FR-LOOK-ALL-032-season-label-tracking-narrow.spec.ts:49` | ${vp.name} ${path} でシーズンタイトルの字間が詰まっている |
| e2e | `e2e/FR-LOOK-ALL-033-overlay-item-underline-link.spec.ts:27` | desktop ${target.label} で関連 ITEM ホバー時に左起点の下線が出る |
| e2e | `e2e/FR-LOOK-ALL-033-overlay-item-underline-link.spec.ts:73` | desktop ${target.label} で関連 ITEM クリックで /item/{id} へ遷移する |
| e2e | `e2e/FR-LOOK-ALL-033-overlay-item-underline-link.spec.ts:109` | ${vp.name} ではオーバーレイの関連 ITEM 行が表示されない |
| e2e | `e2e/FR-LOOK-ALL-034-panel-item-underline-link.spec.ts:34` | ${vp.name} ${target.label} で関連 ITEM ホバーで下線が出てクリックで /item/{id} へ遷移する |
| e2e | `e2e/FR-LOOK-ALL-034-panel-item-underline-link.spec.ts:72` | desktop では情報パネルの関連 ITEM リンクが表示されない |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:17` | desktop（1280px）でフィルターが画面左端に寄っている |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:25` | wide desktop（1920px）でもフィルターが画面左端に寄っている |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:33` | mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない |
| e2e | `e2e/FR-LOOK-ALL-037-card-scroll-reveal.spec.ts:36` | ${vp.name} 画面外の画像はスクロールで data-reveal が true になる |
| e2e | `e2e/FR-LOOK-ALL-037-card-scroll-reveal.spec.ts:55` | ${vp.name} 画像だけが画面に入っている間は文字のモーションが始まらない |
| e2e | `e2e/FR-LOOK-ALL-037-card-scroll-reveal.spec.ts:86` | ${vp.name} リビール後は画像カバーが reveal-cover-act で動き、文字が定位置に戻る |
| e2e | `e2e/FR-LOOK-ALL-037-card-scroll-reveal.spec.ts:111` | ${vp.name} ホームの LOOK カードもリビールの対象になる |
| e2e | `e2e/FR-LOOK-DETAIL-001-look-detail-core-display.spec.ts:5` | テーマ・シーズンラベル・メイン画像・説明文を表示する |
| e2e | `e2e/FR-LOOK-DETAIL-002-styling-items-links.spec.ts:5` | 紐づけ商品一覧と商品遷移リンクを表示する |
| e2e | `e2e/FR-LOOK-DETAIL-003-prev-next-navigation.spec.ts:5` | PREV/NEXTリンクを表示し遷移できる |
| e2e | `e2e/FR-LOOK-DETAIL-004-not-found-and-back-link.spec.ts:4` | エラーメッセージとLook一覧への戻りリンクを表示する |
| e2e | `e2e/FR-LOOK-DETAIL-005-multi-image-gallery.spec.ts:5` | メイン画像とサムネイルを表示し、サムネイル選択で切り替えできる |
| e2e | `e2e/FR-LOOK-DETAIL-006-metadata-backlink-aria.spec.ts:6` | title/descriptionメタと PREV/NEXT aria-label を提供する |
| e2e | `e2e/FR-LOOK-DETAIL-007-related-recommendations-wont.spec.ts:4` | 現フェーズ対象外（WONT）のため未実装 |
| e2e | `e2e/FR-LOOK-DETAIL-008-related-items-divider-unify.spec.ts:25` | ${vp.name} 上下の外枠線とアイテム間の線が同じ色・太さ |
| e2e | `e2e/FR-LOOK-DETAIL-009-related-item-preview-size.spec.ts:18` | ${vp.name} プレビュー高さが unit × φ³ × √φ |
| e2e | `e2e/FR-LOOK-DETAIL-010-remove-back-link.spec.ts:15` | ${vp.name} 通常表示に Back to Lookbook が表示されない |
| e2e | `e2e/FR-LOOK-DETAIL-010-remove-back-link.spec.ts:28` | 存在しない LOOK では Back to Lookbook が表示される |
| e2e | `e2e/FR-LOOK-DETAIL-011-image-gallery-match-item.spec.ts:9` | mobile スワイプカルーセルのみ表示される |
| e2e | `e2e/FR-LOOK-DETAIL-011-image-gallery-match-item.spec.ts:33` | tablet カルーセルと前後送りボタンで切り替えできる |
| e2e | `e2e/FR-LOOK-DETAIL-011-image-gallery-match-item.spec.ts:72` | desktop サムネイル縦列とメイン画像で切り替えできる |
| e2e | `e2e/FR-LOOK-DETAIL-012-desktop-image-no-overlap.spec.ts:14` | ${vp.name} 画像枠がテキスト列に重ならず aspect 2/3 を保つ |
| e2e | `e2e/FR-LOOK-DETAIL-012-desktop-image-no-overlap.spec.ts:43` | tablet（768px）ではメイン画像枠が表示されない（カルーセルのまま） |
| e2e | `e2e/FR-LOOK-DETAIL-013-bottom-nav-three-columns.spec.ts:16` | ${vp.name} 3ラベルと区切り線を表示しテーマ名を表示しない |
| e2e | `e2e/FR-LOOK-DETAIL-014-nav-icon-thin-svg.spec.ts:16` | ${vp.name} アイコンがフォントではなく細線 SVG で描画される |
| e2e | `e2e/FR-LOOK-DETAIL-015-nav-black-and-icon-size.spec.ts:18` | ${vp.name} ラベル・アイコンが黒で字間が揃いアイコンが 7xl |
| e2e | `e2e/FR-LOOK-DETAIL-016-tablet-desktop-match-item.spec.ts:16` | ${viewport.name} 複数枚のときセグメント線インジケータが枚数分表示される |
| e2e | `e2e/FR-LOOK-DETAIL-016-tablet-desktop-match-item.spec.ts:48` | tablet 前後送りシェブロンが画像枠の縦中央にある |
| e2e | `e2e/FR-LOOK-DETAIL-016-tablet-desktop-match-item.spec.ts:71` | desktop 画像枠が 2:3 で viewport に収まり情報列が画像と同幅 |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:18` | mobile 固定ナビが画面下端に貼り付く |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:38` | mobile 固定ナビに3項目が並び LOOK LIST が /look へのリンク |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:55` | mobile ではインラインナビを表示しない |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:63` | mobile 固定ナビがフッターの著作権表示・法務リンクを覆わない |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:82` | mobile 固定ナビのラベルが既定より 2 段階大きい |
| e2e | `e2e/FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav.spec.ts:108` | ${vp.name} ではインラインナビのみで固定ナビを表示しない |
| e2e | `e2e/FR-LOOK-DETAIL-018-no-horizontal-overflow.spec.ts:17` | ${vp.name} 横方向にはみ出す要素がない |
| e2e | `e2e/FR-LOOK-DETAIL-018-no-horizontal-overflow.spec.ts:77` | mobile 固定ナビの下端が viewport 下端と一致する |
| e2e | `e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts:4` | Brand Philosophy セクションを表示する |
| e2e | `e2e/FR-ABOUT-002-quality-craftsmanship-section.spec.ts:4` | 服づくりの理由と Founder の言葉を表示する |
| e2e | `e2e/FR-ABOUT-003-our-values-icons.spec.ts:4` | 3つのブランド原則を番号と見出し付きで表示する |
| e2e | `e2e/FR-ABOUT-004-responsive-story-layout.spec.ts:11` | ${viewport.name}: COLLECTION と CTA をレスポンシブ表示する |
| e2e | `e2e/FR-ABOUT-005-heading-and-metadata.spec.ts:4` | h1 を持ち title/description メタを設定する |
| e2e | `e2e/FR-ABOUT-006-cta-links.spec.ts:4` | COLLECTION / LOOKBOOK / CONTACT のCTAを表示する |
| e2e | `e2e/FR-ABOUT-007-icon-aria-and-image-alt.spec.ts:4` | 装飾アイコンに aria-hidden=true、画像altが具体的である |
| e2e | `e2e/FR-ABOUT-008-static-image-source.spec.ts:4` | aboutページ画像に readdy.ai が使われていない |
| e2e | `e2e/FR-STOCKIST-001-catalog-grid.spec.ts:4` | 公開済みストックリストをレスポンシブグリッドで表示する |
| e2e | `e2e/FR-STOCKIST-002-card-fields.spec.ts:4` | 店舗名・住所・電話・営業時間・定休日を表示する |
| e2e | `e2e/FR-STOCKIST-003-published-data-only.spec.ts:4` | stockistページは空状態または店舗カードを表示できる |
| e2e | `e2e/FR-STOCKIST-004-home-limit-behavior.spec.ts:4` | HOMEでは最大6件、モバイルでは上位3件が表示される |
| e2e | `e2e/FR-STOCKIST-005-stockist-metadata.spec.ts:4` | STOCKISTページにtitle/descriptionを設定する |
| e2e | `e2e/FR-STOCKIST-006-filter-search-sort-pagination-wont.spec.ts:4` | 現フェーズ対象外（WONT）のため未実装 |
| e2e | `e2e/FR-STOCKIST-007-maps-links-categories-image-wont.spec.ts:4` | 現フェーズ対象外（WONT）のため未実装 |
| e2e | `e2e/FR-STOCKIST-008-unique-key-and-a11y.spec.ts:4` | カードリストが安定表示され、店舗名重複時でもUI崩れしない |
| e2e | `e2e/FR-STOCKIST-009-divider-spacing.spec.ts:94` | ${scenario.label} applies phi-based divider spacing |
| e2e | `e2e/FR-STOCKIST-010-region-prefecture-filter.spec.ts:49` | ${vp.name}: 地方（親）チェックで配下の都道府県の店舗のみ表示する |
| e2e | `e2e/FR-STOCKIST-010-region-prefecture-filter.spec.ts:68` | ${vp.name}: 都道府県（子）チェックで個別に絞り込める |
| e2e | `e2e/FR-STOCKIST-010-region-prefecture-filter.spec.ts:82` | ${vp.name}: 店舗が無い地方・都道府県は選択肢に表示しない |
| e2e | `e2e/FR-SEARCH-001-cross-content-search.spec.ts:5` | /search が q と tab を URL 同期し、種別タブで結果を切り替えられる |
| e2e | `e2e/FR-SEARCH-002-search-entry-preview.spec.ts:5` | ヘッダー検索アイコンから search ページへ遷移し、/?q= で即時プレビューを表示する |
| e2e | `e2e/FR-SEARCH-003-fulltext-highlight.spec.ts:5` | 検索結果に一致箇所のハイライトを表示する |
| e2e | `e2e/FR-SEARCH-004-empty-results.spec.ts:4` | 検索結果がゼロ件のときメッセージと人気商品を表示する |
| e2e | `e2e/FR-SEARCH-005-search-history.spec.ts:9` | AC-01/AC-02 履歴は表示されず localStorage にも保存されない |
| e2e | `e2e/FR-SEARCH-006-two-column-redesign.spec.ts:30` | ${vp.name} レイアウト・結果ヘッダー・結果行・LOAD MORE |
| e2e | `e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts:15` | AC-01 /api/search の imageUrl が署名付き URL であること |
| e2e | `e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts:40` | AC-02 ${vp.name} サムネイル画像が実際に読み込まれること |
| e2e | `e2e/FR-SEARCH-008-popular-items-by-purchases.spec.ts:23` | AC-01/AC-02 公開 ITEM のみが並び、購入数はレスポンスに含めない |
| e2e | `e2e/FR-SEARCH-008-popular-items-by-purchases.spec.ts:44` | AC-03 ${vp.name} 検索語なしで POPULAR ITEMS が表示されること |
| e2e | `e2e/FR-SEARCH-009-preview-flag-parsing.spec.ts:16` | AC-01/AC-02 preview 未指定は 1種別最大8件、preview=true は最大3件 |
| e2e | `e2e/FR-SEARCH-009-preview-flag-parsing.spec.ts:39` | AC-03 preview 未指定は search:public として計上され 20 回連続でも 429 にならない |
| e2e | `e2e/FR-SEARCH-010-full-height-layout.spec.ts:14` | AC-01/AC-03 ${vp.name} フッターがファーストビューに出ず横スクロールもしない |
| e2e | `e2e/FR-SEARCH-010-full-height-layout.spec.ts:47` | AC-02 ${vp.name} で左カラムが縦中央寄りに配置される |
| e2e | `e2e/FR-SEARCH-011-suggestions-combobox.spec.ts:20` | AC-01/AC-04 候補は種別付き・40px以上・最大8件で、ラベルに入力語を含む |
| e2e | `e2e/FR-SEARCH-011-suggestions-combobox.spec.ts:49` | AC-02 ARIA combobox 属性とキーボード操作 |
| e2e | `e2e/FR-SEARCH-011-suggestions-combobox.spec.ts:73` | AC-03 ↓+Enter とクリックのどちらでも候補の語と種別で検索される |
| e2e | `e2e/FR-SEARCH-012-compact-form-and-tab-underline.spec.ts:13` | AC-01 フォームと候補行の高さが詰まっている |
| e2e | `e2e/FR-SEARCH-012-compact-form-and-tab-underline.spec.ts:37` | AC-02/AC-03 ${vp.name} タブの下線がヘッダーナビと同じ挙動 |
| e2e | `e2e/FR-SEARCH-014-tablet-desktop-parity-and-mobile-title.spec.ts:14` | ${vp.name} レイアウトと見出しの表示 |
| e2e | `e2e/FR-SEARCH-015-mobile-density.spec.ts:50` | AC-01 モバイルのタブが全幅に均等配置される |
| e2e | `e2e/FR-SEARCH-015-mobile-density.spec.ts:61` | AC-02/AC-03 モバイルは文字も行も tablet / desktop より小さい |
| e2e | `e2e/FR-SEARCH-016-tab-inset-and-letter-spacing.spec.ts:13` | AC-01 モバイルで先頭/末尾タブがタブ列端より内側に入る |
| e2e | `e2e/FR-SEARCH-016-tab-inset-and-letter-spacing.spec.ts:43` | AC-02/AC-03 ${vp.name} 字間 0.1em と下線の端揃え |
| e2e | `e2e/FR-SEARCH-017-item-meta-price.spec.ts:31` | AC-01/AC-02 ${vp.name} ITEM は価格・LOOK/NEWS は従来のメタ |
| e2e | `e2e/FR-SEARCH-017-item-meta-price.spec.ts:59` | AC-03 /api/search の items[].meta が価格・purchase_count 非公開 |
| e2e | `e2e/FR-PRIVACY-001-policy-content.spec.ts:4` | /privacy にプライバシーポリシー本文を表示する |
| e2e | `e2e/FR-PRIVACY-002-metadata.spec.ts:4` | /privacy に title と description と OGP を設定する |
| e2e | `e2e/FR-PRIVACY-003-additional-legal-sections.spec.ts:20` | ${vp.name}: 委託・保有期間・国外移転・開示請求・変更・窓口を表示する |
| e2e | `e2e/FR-PRIVACY-004-typography-spacing.spec.ts:15` | ${vp.name}: 本文行間が広く、見出しが本文より大きい |
| e2e | `e2e/FR-LOGIN-001-otp-turnstile.spec.ts:6` | verifies password then advances to OTP code entry |
| e2e | `e2e/FR-LOGIN-002-google-oauth.spec.ts:4` | shows the Google sign-in button on the login page |
| e2e | `e2e/FR-LOGIN-002-google-oauth.spec.ts:9` | starts Google OAuth with account chooser enabled |
| e2e | `e2e/FR-LOGIN-003-password-reset-link.spec.ts:4` | navigates to the password reset page from the login page |
| e2e | `e2e/FR-LOGIN-005-metadata.spec.ts:4` | sets login page title and description metadata |
| e2e | `e2e/FR-LOGIN-006-otp-resend-countdown.spec.ts:6` | shows the resend countdown immediately after OTP send |
| e2e | `e2e/FR-LOGIN-008-password-otp-2fa.spec.ts:14` | shows EMAIL and PASSWORD fields, then requires an OTP code |
| e2e | `e2e/FR-LOGIN-009-auth-tabs.spec.ts:16` | shows login tab selected on /login |
| e2e | `e2e/FR-LOGIN-009-auth-tabs.spec.ts:30` | switches to register form when register tab is clicked |
| e2e | `e2e/FR-LOGIN-009-auth-tabs.spec.ts:40` | can switch back to login from register tab |
| e2e | `e2e/FR-LOGIN-009-auth-tabs.spec.ts:53` | タブ内の切替リンクは撤去され、切替はタブのみで行う |
| e2e | `e2e/FR-LOGIN-011-auth-rounded-design.spec.ts:25` | email input and login button are not rounded (minimal design) |
| e2e | `e2e/FR-LOGIN-011-auth-rounded-design.spec.ts:34` | does not show a "ログインでお困りの方" link |
| e2e | `e2e/FR-LOGIN-011-auth-rounded-design.spec.ts:38` | the tab group has no surrounding card frame |
| e2e | `e2e/FR-LOGIN-012-auth-tab-and-button-states.spec.ts:17` | unselected tab uses a grayish (non-pure-black) background |
| e2e | `e2e/FR-LOGIN-012-auth-tab-and-button-states.spec.ts:27` | tabs use an underline (bottom border only), no box borders |
| e2e | `e2e/FR-LOGIN-012-auth-tab-and-button-states.spec.ts:49` | login button is disabled until email and password are filled |
| e2e | `e2e/FR-LOGIN-012-auth-tab-and-button-states.spec.ts:61` | register button is disabled until all fields are filled |
| e2e | `e2e/FR-LOGIN-013-password-reset-link-placement.spec.ts:12` | link sits below the password field, above the login button, right-aligned and closer to the password field |
| e2e | `e2e/FR-LOGIN-013-password-reset-link-placement.spec.ts:50` | register confirm-password remains vertically centered in the shared support row |
| e2e | `e2e/FR-LOGIN-014-auth-contrast-hierarchy.spec.ts:24` | primary login button has the largest font among controls |
| e2e | `e2e/FR-LOGIN-014-auth-contrast-hierarchy.spec.ts:31` | forgot-password link is smaller than body text |
| e2e | `e2e/FR-LOGIN-014-auth-contrast-hierarchy.spec.ts:39` | primary login button is the tallest control |
| e2e | `e2e/FR-LOGIN-015-auth-button-alignment.spec.ts:23` | google button and primary CTA share the same size on both tabs |
| e2e | `e2e/FR-LOGIN-016-auth-full-height-centered.spec.ts:12` | main fills the viewport, form is centered and footer is not visible initially |
| e2e | `e2e/FR-LOGIN-017-iphone-se-one-screen.spec.ts:6` | login form fits within the iPhone SE viewport without scrolling |
| e2e | `e2e/FR-LOGIN-017-iphone-se-one-screen.spec.ts:20` | register form also fits within the iPhone SE viewport without scrolling |
| e2e | `e2e/FR-LOGIN-017-iphone-se-one-screen.spec.ts:34` | desktop keeps the original (non-reduced) vertical spacing |
| e2e | `e2e/FR-LOGIN-018-verified-brand-design.spec.ts:22` | heading "Le Fil des Heures" uses the brand Didot serif font |
| e2e | `e2e/FR-LOGIN-018-verified-brand-design.spec.ts:31` | shows the thread hairline motif below the heading |
| e2e | `e2e/FR-LOGIN-018-verified-brand-design.spec.ts:39` | login link points to /login |
| e2e | `e2e/FR-LOGIN-018-verified-brand-design.spec.ts:46` | gate is vertically centered and footer is not visible |
| e2e | `e2e/FR-LOGIN-018-verified-brand-design.spec.ts:65` | heading is larger than the body message (contrast) |
| e2e | `e2e/FR-LOGIN-019-underline-input-fields.spec.ts:20` | AC-01: Email に mail アイコン / Password に lock アイコンが表示される |
| e2e | `e2e/FR-LOGIN-019-underline-input-fields.spec.ts:25` | AC-02: 入力欄は下線のみ（border-bottom のみ）で表示される |
| e2e | `e2e/FR-LOGIN-019-underline-input-fields.spec.ts:42` | AC-03: Password 表示切替ボタンで type が password↔text に切り替わる |
| e2e | `e2e/FR-LOGIN-019-underline-input-fields.spec.ts:56` | AC-04: 先頭アイコンが入力本文より大きい（黄金比 √φ 倍相当） |
| e2e | `e2e/FR-LOGIN-019-underline-input-fields.spec.ts:62` | AC-05: 左アイコンの左・右トグルの右に黄金比 x/y（font/φ）の余白がある |
| e2e | `e2e/FR-LOGIN-020-tab-underline-no-switch-links.spec.ts:17` | AC-01: タブが下線を持ち、タブ群を囲む角丸カード枠が無い |
| e2e | `e2e/FR-LOGIN-020-tab-underline-no-switch-links.spec.ts:45` | AC-04: タブの左右端が入力欄の左右端に整列している |
| e2e | `e2e/FR-LOGIN-020-tab-underline-no-switch-links.spec.ts:63` | AC-02: ログインタブに「会員登録はこちら」ボタンが無い |
| e2e | `e2e/FR-LOGIN-020-tab-underline-no-switch-links.spec.ts:69` | AC-03: 会員登録タブに「既にアカウントをお持ちの方はこちら」ボタンが無い |
| e2e | `e2e/FR-LOGIN-021-register-underline-fields.spec.ts:19` | AC-01: Email に mail、Password/確認 に lock アイコンが表示される |
| e2e | `e2e/FR-LOGIN-021-register-underline-fields.spec.ts:24` | AC-02: 各入力欄は下線のみ（border-bottom のみ）で表示される |
| e2e | `e2e/FR-LOGIN-021-register-underline-fields.spec.ts:42` | AC-03: Password・確認の表示切替で type が切り替わる |
| e2e | `e2e/FR-LOGIN-021-register-underline-fields.spec.ts:58` | AC-04: 「Googleで登録」が送信ボタンより下に配置される |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:12` | auth JSX uses lk-text classes instead of inline font-size tokens |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:26` | tabs repeat one font size and selection uses underline contrast |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:46` | type scale descends from tabs to actions, fields and support text |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:62` | tabs, fields, primary action and alternate action share one grid |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:84` | fields and auth buttons use the compact shared component sizes |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:104` | primary and Google actions have identical compact dimensions |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:122` | switching tabs keeps fields and action rows fixed |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:154` | form is grouped near its tabs |
| e2e | `e2e/FR-LOGIN-023-auth-viewport-centering.spec.ts:14` | ${route} is centered in the dynamic viewport (${viewport.name}) |
| e2e | `e2e/FR-LOGIN-023-auth-viewport-centering.spec.ts:47` | login remains viewport-centered after switching to registration |
| e2e | `e2e/FR-LOGIN-023-auth-viewport-centering.spec.ts:60` | short viewport keeps the login form reachable without clipping |
| e2e | `e2e/FR-LOGIN-024-register-no-account-enumeration.spec.ts:29` | the register form never reveals that an address is already taken |
| e2e | `e2e/FR-LOGIN-024-register-no-account-enumeration.spec.ts:50` | never answers 409 for the public signup path |
| e2e | `e2e/FR-LOGIN-025-turnstile-width-fit.spec.ts:51` | AC-02: /login で Turnstile・送信ボタン・Google ボタンの幅が一致する |
| e2e | `e2e/FR-LOGIN-025-turnstile-width-fit.spec.ts:64` | AC-02: /auth/password-reset で Turnstile と送信ボタンの幅が一致する |
| e2e | `e2e/FR-LOGIN-025-turnstile-width-fit.spec.ts:77` | AC-03: 横スクロールが発生しない |
| e2e | `e2e/FR-LOGIN-026-turnstile-token-single-use.spec.ts:32` | AC-01: ログイン失敗後の再試行は新しい Turnstile トークンを送る |
| e2e | `e2e/FR-LOGIN-026-turnstile-token-single-use.spec.ts:70` | AC-02: OTP 再送信は Turnstile を要求しない |
| e2e | `e2e/FR-LOGIN-026-turnstile-token-single-use.spec.ts:116` | AC-03: パスワード再設定の送信失敗後の再試行は新しい Turnstile トークンを送る |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:29` | AC-01: 2FA Cookie が無ければ /login へ送り返す |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:36` | AC-04: 宛先はマスクして表示する |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:43` | タブ（ログイン / 会員登録）を出さない |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:50` | リロードしてもコード入力が残る |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:57` | AC-06: 別のアドレスでやり直すと Cookie が消える |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:71` | AC-05: 再送はパスワードも宛先も送らない |
| e2e | `e2e/FR-LOGIN-028-otp-verify-hardening.spec.ts:54` | 2FA Cookie の偽造ヘルパは localhost 以外で例外を投げる |
| e2e | `e2e/FR-HEADER-001-drawer-no-site-title.spec.ts:15` | ${vp.name} (${vp.width}px): Drawer 内にサイトタイトルが存在しない |
| e2e | `e2e/FR-HEADER-001-drawer-no-site-title.spec.ts:36` | desktop (1280px): Drawer trigger is hidden |
| e2e | `e2e/FR-HEADER-002-drawer-sns-icon-centering.spec.ts:15` | ${vp.name} (${vp.width}px): SNS アイコンが枠内中央に配置されている |
| e2e | `e2e/FR-HEADER-002-drawer-sns-icon-centering.spec.ts:44` | desktop (1280px): Drawer SNS section is not rendered |
| e2e | `e2e/FR-HEADER-003-drawer-sns-icon-bw-filter.spec.ts:15` | ${vp.name} (${vp.width}px): SNS アイコンに brightness filter が適用されている |
| e2e | `e2e/FR-HEADER-003-drawer-sns-icon-bw-filter.spec.ts:39` | ${vp.name} (${vp.width}px): ホバー時に SNS アイコンが invert されること |
| e2e | `e2e/FR-HEADER-003-drawer-sns-icon-bw-filter.spec.ts:62` | desktop (1280px): Drawer SNS icons are not rendered |
| e2e | `e2e/FR-HEADER-004-drawer-accordion-child-spacing.spec.ts:16` | ${vp.name} (${vp.width}px): アコーディオン展開時の子要素と次の親要素の間隔が20px以上 |
| e2e | `e2e/FR-HEADER-005-drawer-close-button-position.spec.ts:16` | ${vp.name} (${vp.width}px): ×ボタンの中心XがハンバーガーメニューのX座標と±2px以内 |
| e2e | `e2e/FR-HEADER-006-drawer-subnav-link-black.spec.ts:16` | ${vp.name} (${vp.width}px): 子要素リンクの色がrgb(17, 17, 17) |
| e2e | `e2e/FR-HEADER-007-admin-font-scope-excludes-chrome.spec.ts:89` | ヘッダーのサイトタイトルは /admin でも他ページと同じフォント |
| e2e | `e2e/FR-HEADER-007-admin-font-scope-excludes-chrome.spec.ts:104` | フッターの見出しは /admin でも他ページと同じフォント |
| e2e | `e2e/FR-HEADER-007-admin-font-scope-excludes-chrome.spec.ts:119` | 管理コンテンツ側の見出しは Acumin のまま統一されている |
| e2e | `e2e/FR-HEADER-007-admin-font-scope-excludes-chrome.spec.ts:133` | 横方向のページスクロールが発生しない |
| e2e | `e2e/FR-HEADER-008-cart-count-badge.spec.ts:21` | ${viewport.name}（${viewport.width}px）でカート点数がバッジで示される |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:25` | has no card frame and a square submit button (minimal design like login) |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:38` | email input is an underline field with a leading mail icon |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:54` | is centered full-height with footer not visible |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:68` | heading uses the same font as login tabs and is the largest text (contrast) |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:88` | submit button is disabled until email is filled |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:96` | does not introduce horizontal overflow |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:105` | uses the same field and button sizing contract as login |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:132` | repeats the login form 13px grid and LiftKit type hierarchy |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:152` | completed reset exposes the login route as the primary action |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:25` | an expired link shows a reason instead of silently returning to the form |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:36` | the verify page posts once automatically instead of showing a button |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:54` | the request form is still reachable |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:65` | opening the link with GET forwards to the verify page without consuming |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:78` | a link without a token redirects with a reason |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:87` | the request endpoint no longer fails, and hides whether the account exists |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:104` | confirm rejects the removed legacy token payload |
| e2e | `e2e/FR-PWRESET-003-password-policy.spec.ts:17` | the password reset form states the 16 character minimum (${viewport.name}) |
| e2e | `e2e/FR-PWRESET-003-password-policy.spec.ts:41` | the new password fields carry the 16 character minimum (${viewport.name}) |
| e2e | `e2e/FR-PWRESET-004-turnstile-widget-render.spec.ts:20` | パスワード再設定画面に Turnstile が描画されトークンが発行される |
| e2e | `e2e/FR-PWRESET-005-reset-mail-sent-screen.spec.ts:43` | AC-01: 送信後はフォームを畳んで結果だけ残す |
| e2e | `e2e/FR-PWRESET-005-reset-mail-sent-screen.spec.ts:51` | AC-02: 前回のリンクが無効になる旨を示し、宛先は画面に残さない |
| e2e | `e2e/FR-PWRESET-005-reset-mail-sent-screen.spec.ts:61` | AC-03: 送信直後は残り時間だけを出し、再送信ボタンを出さない |
| e2e | `e2e/FR-PWRESET-005-reset-mail-sent-screen.spec.ts:68` | AC-05: パスワード更新の完了も同じ結果画面で、主アクションはログインへ |
| e2e | `e2e/FR-PWRESET-005-reset-mail-sent-screen.spec.ts:94` | AC-04: 再送信が 429 なら上限を伝え、再送信ボタンを引っ込める |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:45` | AC-01: 結果の先頭に封筒の図を置き、パスワード更新の図は出さない |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:52` | AC-02: ページ見出しを畳み、結果のタイトルを唯一の h1 にする |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:66` | AC-03: 注意書きはグレーの面に左寄せでまとめる |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:82` | AC-04: 隙間を意味の遠さに応じた 4 段階にする |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:131` | AC-01: パスワード更新の完了は南京錠の図で示す |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:157` | AC-06: 注意書きは 3 行で、どの画面幅でも折り返さない |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:176` | AC-07: 結果の宣言はひとまとまりに見える間隔にする |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:209` | AC-05: 結果のタイトルはどの画面幅でも 1 行に収める |
| e2e | `e2e/FR-PWRESET-006-reset-mail-sent-visual.spec.ts:230` | AC-04: Bot 検証ウィジェットと再送信ボタンの間も最も広い段に揃える |
| e2e | `e2e/FR-PWRESET-007-verify-auto-advance.spec.ts:42` | AC-02: 有効なリンクは確認画面を経ずに新パスワード入力へ着地する |
| e2e | `e2e/FR-PWRESET-007-verify-auto-advance.spec.ts:51` | AC-01: 自動送信は 1 回だけ |
| e2e | `e2e/FR-PWRESET-007-verify-auto-advance.spec.ts:65` | AC-03: 通信エラーのときだけ手動の再試行を出す |
| e2e | `e2e/FR-PWRESET-008-confirm-password-match.spec.ts:33` | AC-01: 一致しなければ送信しない |
| e2e | `e2e/FR-PWRESET-008-confirm-password-match.spec.ts:50` | AC-02: 2 つの欄の表示文字と、確認欄の表示切り替え |
| e2e | `e2e/FR-PWRESET-008-confirm-password-match.spec.ts:69` | AC-04: 再設定モードではメールアドレス欄を出さない |
| e2e | `e2e/FR-PWRESET-008-confirm-password-match.spec.ts:76` | AC-03: 片方だけでは押せず、一致すれば更新できる |
| e2e | `e2e/FR-SIGNUP-001-register-page.spec.ts:12` | returns 404 on /register |
| e2e | `e2e/FR-SIGNUP-001-register-page.spec.ts:20` | login page provides a path to registration via tab |
| e2e | `e2e/login-otp-resend-errors.spec.ts:8` | OTP resend ${status} feedback at ${viewport.width}px |

## 届かない分岐

手書きの節。分岐の網羅で届かない所を、1行に1件「- `場所:行` 理由。確認: 未」の形で書く。生成し直しても残る。

- `src/app/admin/news/NewsForm.tsx:253` の `NewsForm` の画像の欄の onClick の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。file の入力は押される枠そのものの子で、枠が描かれている間は ref が必ず入っているため。確認: 未
- `src/app/admin/news/NewsForm.tsx:257` の `NewsForm` の画像の欄の onKeyDown（Enter・Space）の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。理由は onClick と同じ。確認: 未
- `src/app/api/admin/news/[id]/route.ts:39` の `logNewsAudit` の引数 `resourceId` の既定値 `= null` は通らない。ファイルの中の呼び出し7か所が全部 `id` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:55` の `parseCategorySelection` の引数 `fallback` の既定値 `= "ALL"` は通らない。呼び出し2か所（初めの状態と URL の読み直しの effect）が全部 `catalogProps.initialCategory ?? "ALL"` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:127` の `syncCategoryQuery` の `variant !== "catalog"` の早期の戻りは通らない。呼ぶのは `applyCategorySelection` だけで、それを受ける `MultiSelect` は catalog の描画にしか出ず、home で呼ばれないため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:275` の `renderCategoryFilter` の引数 `size` の既定値 `= "3xs"` は通らない。呼び出し2か所が `"xs"` と `"3xs"` を必ず渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:452` の `PublicNewsGrid` の home の VIEW ALL の判断の `fetchLimit ?? 6` の右側は通らない。home では `fetchLimit` が `props.fetchLimit ?? 6` で必ず数になるため。確認: 未
- `src/features/search/components/SearchPageClient.tsx:153` `renderSuggestionLabel` の「語が空なら label をそのまま返す」側。候補のリストは入力欄の値が前後の空白を除いて空でない時だけ開く（`isSuggestionListOpen`）ので、空の語で呼ばれない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:362` `commitSearch` の `nextTab` の既定値（`activeTab`）の側。呼ぶ所（送信・タブ・候補）が全部 `nextTab` を渡す。確認: 未
- `src/features/search/components/SearchPageClient.tsx:374` `nextUrl` の三項で `params.toString()` が空の側（`pathname` だけを返す側）。直前に `params.set("tab", ...)` で必ず `tab` を入れるので空にならない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:666` 人気商品の `map` の中の `results?.popularItems ?? []` の `results` が null の側。同じ条件の直前の判定で人気商品が1件以上と確かめた後の分岐で、同じ描画の中の値なので null にならない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:666` 同じ式の `?? []` の右側（空配列）。上と同じ理由で、1件以上と確かめた直後の分岐なので配列がある。確認: 未
- `src/features/stockist/components/PublicStockistGrid.tsx:328` の `renderAreaTree` の引数 `size` の既定値 `"xs"` は通らない。呼び出し2か所（デスクトップの `"3xs"`、モバイルの `"xs"`）が必ず値を渡し、この関数は export されないため。確認: 未
- `src/features/search/services/search.service.ts:55` `tokenizeQuery` の「正規化した語が空なら空配列を返す」側。呼ぶ `rankText` は書き出しの関数 `executeSearch`・`getSearchSuggestions` だけから来て、どちらも前後の空白を除いた空でない語しか渡さない（空は手前で戻る）。確認: 未
- `src/features/search/services/search.service.ts:88` `rankText` の「語が空、または分けた語が空なら 0 を返す」側。語は空でなく、記号だけの語も `tokenizeQuery` が語全体を1語に戻すので分けた語は空にならない。確認: 未
- `src/features/search/services/search.service.ts:102` `rankText` の `normalizedTexts[0] ?? ''` の右側。呼ぶ所が必ず題を先頭に1つ以上の欄を渡す。確認: 未
- `src/features/search/components/SearchPageClient.tsx:416` 外を押す聞き手の `searchBoxRef.current` が `null` の側は通らない（分岐の網羅の数には入らない）。聞き手は候補のリストが開いている間、つまり検索の箱を描いた後にだけ付くため。確認: 未
- `src/app/api/auth/confirm/route.ts:70` `GET` の入口の判断 `error || !data?.session || !data?.user` の `!data?.user` の `data` が `null` の側は通らない。直前の `!data?.session` が `data` が `null` の時に真になって先に抜けるため。確認: 済み
- `src/app/api/auth/confirm/route.ts:93` `GET` のセッションの保存に失敗した時の監査の `data.user?.email` の `user` が無い側は通らない。70 行の確かめを通った後なので `user` がある。確認: 済み
- `src/app/api/auth/confirm/route.ts:96` `GET` のセッションの保存に失敗した時の監査の `data.user?.id` の `user` が無い側は通らない。理由は 93 行と同じ。確認: 済み
- `src/app/api/auth/confirm/route.ts:110` `GET` の成功の監査の `data.user?.email` の `user` が無い側は通らない。理由は 93 行と同じ。確認: 済み
- `src/app/api/auth/confirm/route.ts:112` `GET` の成功の監査の `data.user?.id` の `user` が無い側は通らない。理由は 93 行と同じ。確認: 済み
- `src/app/api/auth/otp/verify/route.ts:93` `POST` の入口の判断 `verifyError || !data?.session || !data?.user` の `!data?.user` の `data` が `null` の側は通らない。直前の `!data?.session` が `data` が `null` の時に真になって先に抜けるため。確認: 済み
- `src/app/api/auth/register/route.ts:223` `POST` の `data.user?.id` の `user` が無い側（セッションの保存が結果を返さなかった時の監査）は通らない。手前の `if (!data.user)` で先に返るため。確認: 済み
- `src/app/api/auth/register/route.ts:243` `POST` の `data.user?.id` の `user` が無い側（セッションの保存が例外を投げた時の監査）は通らない。理由は 223 行と同じ。確認: 済み
- `src/app/api/auth/register/route.ts:247` `POST` の `data.user?.id` の `user` が無い側（成功の監査）は通らない。理由は 223 行と同じ。確認: 済み
- `src/app/auth/password-reset/page.tsx:234` `PasswordResetPage` の `handleResend` の先頭の `siteKey && !turnstileToken` が真の側は通らない。再送のボタンが同じ描画の値（`disabled={loading || (!!siteKey && !turnstileToken)}`）で押せなくなっており、この関数に入る時点で常に偽のため。確認: 済み
- `src/app/auth/verified/page.tsx:156` `VerifiedPage` の effect の `authBody?.user?.role` の `authBody?.` が `null` の側、三項の真側の `authBody?.` が `null` の側と `user?.` が `undefined` の側（3分岐）は通らない。直前の `authBody?.authenticated === true` を通った後なので `authBody` は `null` でなく、真側に入るには `role` を持つ `user` が要るため。確認: 済み
- `src/app/auth/verified/page.tsx:157` `VerifiedPage` の effect の `authBody?.user?.mfaVerified` の `authBody?.` が `null` の側は通らない。理由は 156 行と同じ。確認: 済み
- `src/app/login/verify/VerifyOtpClient.tsx:185` `VerifyOtpClient` の `resolvePostLoginPath` の `body?.user?.role` の `body` が `null` の側は通らない。直前の `body?.authenticated === true` を通った後なので `body` は `null` でない。確認: 済み
- `src/components/AuthResultScreen.tsx:114` `AuthResultScreen` の effect の `titleRef.current?.focus()` の `current` が `null` の側は通らない。見出しは条件なしで描かれ、描いた後に走る effect の時点で ref が入っているため。確認: 済み
- `src/components/AuthTabs.tsx:38` `AuthTabs` の `switchTab` の `TABS.find(...)?.path` の見つからない側は通らない。引数の型が `TABS` の key だけのため。確認: 済み
- `src/components/AuthTabs.tsx:49` `AuthTabs` の `handleTabKeyDown` の `tabRefs.current[next]?.focus()` の ref が無い側は通らない。2つのタブは常に描かれ、ref が入っているため。確認: 済み
- `src/components/Header.tsx:124` `Header` の `isActiveMenuItem` の `href === "/"` の真の側は通らない。呼ぶのはナビの項目・`/loading`・`/admin` だけで `/` が無いため（使われていないコード）。確認: 済み
- `src/components/Header.tsx:409` `Header` の `LoginModal` の引数の `open={loginOpen && !isLoggedIn}` の右側は通らない。`setLoginOpen(true)` の呼び出しがどこにも無く、`loginOpen` は初めの値 `false` のままのため（使われていないコード）。確認: 済み
- `src/app/admin/look/edit/[id]/page.tsx:88` `AdminLookEditPage` の `if (!initialValues)` の真の側（読み込みが終わったのに値も誤りも無い形）は通らない。成功時は必ず値を入れ、失敗時は必ず誤りを入れ、`isLoading` を外すのはその後（同じ描き直しにまとめられる）ため。確認: 未
- `src/app/api/admin/looks/[id]/route.ts:603` `PATCH` の catch の `error instanceof z.ZodError` の真の側（理由の文 `detail`）は通らない。本文の形は `safeParse` で確かめ、`request.json()` の失敗は `SyntaxError` で、`ZodError` を投げる部品がこの道に無いため。確認: 未
- `src/app/api/admin/looks/[id]/route.ts:604` 同じ分岐の `metadata`（`invalid_fields`）の側は通らない。理由は 603 行と同じ。確認: 未
- `src/features/look/components/PublicLookGrid.tsx:326` `PublicLookCatalog` の引数 `initialSeason` の既定値 `"ALL"` は通らない。唯一の呼び元 `PublicLookGrid` が `props.initialSeason ?? "ALL"` で必ず値を渡し、この関数は export されないため。確認: 未
- `src/features/look/components/PublicLookGrid.tsx:387` `renderSeasonFilter` の引数 `size` の既定値 `"3xs"` は通らない。呼び元2か所が `"xs"` と `"3xs"` を必ず渡すため。確認: 未
- `src/lib/look/public.ts:82` `normalizeLookSeasonSelection` の `lastValue ?? 'ALL'` の右側は通らない。0 件を直前で `ALL` として返すので、配列の最後の要素は必ずある。添え字の読みが `undefined` を含む型を満たすためだけの分岐。確認: 未
- `src/lib/look/server.ts:268` `hydrateLooks` の `signedImageUrlsMap.get(row.id) ?? []` の右側は通らない。全ての LOOK の行を `signedImageUrlsMap` に先に入れてから `map` するため。確認: 未
