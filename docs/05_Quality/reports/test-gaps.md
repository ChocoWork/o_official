# 試験の穴

> 状態: 自動生成 | 生成日: 2026-10-27 | 対象: NEWS・HOME・LOOK・ABOUT・STOCKIST・SEARCH・PRIVACY・AUTH・ADMIN

## 概要

試験が足りない項目、名前に ID の無い試験、飛ばしている試験、分岐の網羅で届かない所を並べた表。

`npm run trace:report` が作る。手で直さない（「届かない分岐」の節だけは手で書き、生成し直しても残る）。

## 試験の足りない項目

| 項目 | 足りない試験 | 場所 |
| --- | --- | --- |
| FREQ-275-AC-02 390・768px で 20px、1280px で 28px | E2E | `docs/02_Requirements/areas/news.md:1158` |
| SEC-NEWS-003-AC-01 移行だけを当てた DB で置き場が非公開になる | E2E | `docs/02_Requirements/areas/news.md:1625` |
| SEC-NEWS-008-AC-02 署名の失敗が記録に1件残る | E2E | `docs/02_Requirements/areas/news.md:1830` |
| SEC-NEWS-009-AC-03 公開の一覧の取り出しは上限を渡さなくても上限で止まる | E2E | `docs/02_Requirements/areas/news.md:1879` |
| SEC-NEWS-009-AC-04 詳細の前後の取り出しは公開済みの全部を読まない | E2E | `docs/02_Requirements/areas/news.md:1891` |
| SEC-NEWS-018-AC-03 作成の失敗で上げた画像が残らない | E2E | `docs/02_Requirements/areas/news.md:2277` |
| SEC-NEWS-019-AC-01 /api/news の失敗の応答は固定の文だけ | E2E | `docs/02_Requirements/areas/news.md:2302` |
| SEC-NEWS-019-AC-02 失敗の記録に鍵と token が含まれない | E2E | `docs/02_Requirements/areas/news.md:2314` |
| SEC-NEWS-020-AC-02 管理の1件の取得は DB の失敗を 404 にしない | E2E | `docs/02_Requirements/areas/news.md:2359` |
| SEC-NEWS-020-AC-03 公開の一覧の取り出しの失敗が記録に残る | E2E | `docs/02_Requirements/areas/news.md:2371` |
| SEC-NEWS-021-AC-01 決めた回数を超えた作成を断る | E2E | `docs/02_Requirements/areas/news.md:2396` |
| FREQ-278-AC-02 3つの幅で縦線の動きの名前が threadDraw | E2E | `docs/02_Requirements/areas/home.md:709` |
| FREQ-278-AC-06 3つの幅で縦線は1回だけ再生し、終わりの形を保つ | E2E | `docs/02_Requirements/areas/home.md:761` |
| SEC-HOME-014-AC-01 1つの領域の取得が失敗してもホームのほかの節が出る | E2E | `docs/02_Requirements/areas/home.md:1398` |
| FREQ-12-AC-01 ほかの利用者のコーディネートを見る時にエラーが出ず関連コーディネートが出る | E2E | `docs/02_Requirements/areas/look.md:1825` |
| FREQ-137-AC-01 各幅で HOME と一覧の格子の row-gap と column-gap が等しい | E2E | `docs/02_Requirements/areas/look.md:2319` |
| FR-LOOK-DETAIL-007-AC-01 詳細に同じシーズンか関連のコーディネートを薦める節が出る | E2E | `docs/02_Requirements/areas/look.md:3745` |
| SEC-LOOK-010-AC-01 大きな件数を求めても上限までしか返らない | E2E | `docs/02_Requirements/areas/look.md:4143` |
| SEC-ABOUT-006-AC-01 Supabase に届かない状態でも /about が表示される | E2E | `docs/02_Requirements/areas/about.md:530` |
| SEC-ABOUT-007-AC-01 設定が無い時に OG の URL が手元の URL にならない | E2E | `docs/02_Requirements/areas/about.md:557` |
| SEC-STOCKIST-008-AC-01 anon・authenticated に表の余分な権限が無い | E2E | `docs/02_Requirements/areas/stockist.md:941` |
| FREQ-184-AC-01 1280px で左右の2カラム、390・768px で縦積みになり横にはみ出さない | E2E | `docs/02_Requirements/areas/search.md:790` |
| FREQ-184-AC-02 「N RESULTS」「SORT BY」「RELEVANCE」と、行の種別・題・サムネイル・矢印が出る | E2E | `docs/02_Requirements/areas/search.md:803` |
| FREQ-190-AC-01 入力すると種別付きの候補が最大8件、行の高さ 44px 以上で出る | E2E | `docs/02_Requirements/areas/search.md:972` |
| FREQ-191-AC-01 RELEVANCE が出て、SORT BY が出ない | E2E | `docs/02_Requirements/areas/search.md:1024` |
| FREQ-199-AC-01 390px で4つのタブが横一列で、先頭と末尾がタブの列の端に合う | E2E | `docs/02_Requirements/areas/search.md:1245` |
| SEC-SEARCH-018-AC-01 検索とサジェストの失敗の記録に検索語と誤りの全体が無い | E2E | `docs/02_Requirements/areas/search.md:1940` |
| SEC-PRIVACY-003-AC-01 発送が多くても頁の表示が遅くならない | E2E | `docs/02_Requirements/areas/privacy.md:338` |
| SEC-PRIVACY-004-AC-01 回数の上限を超えると DB を読まない | E2E | `docs/02_Requirements/areas/privacy.md:363` |
| SEC-PRIVACY-006-AC-02 鍵が無くても設定がオンなら一文が表示される | E2E | `docs/02_Requirements/areas/privacy.md:425` |
| SEC-PRIVACY-018-AC-01 運用の文書に迷惑メールの選別と見直しの手順が在る | E2E | `docs/02_Requirements/areas/privacy.md:763` |
| FREQ-59-AC-01 /register に EMAIL・PASSWORD・PASSWORD（確認）が出る | E2E | `docs/02_Requirements/areas/auth.md:2106` |
| FREQ-61-AC-02 新規登録タブで PASSWORD（確認）が出て URL が /register になる | E2E | `docs/02_Requirements/areas/auth.md:2158` |
| FREQ-61-AC-03 /register で新規登録タブが選ばれ、ログインタブで URL が /login になる | E2E | `docs/02_Requirements/areas/auth.md:2171` |
| FREQ-63-AC-03 「既にアカウントをお持ちの方はこちら」がタブ切替のボタンになる | E2E | `docs/02_Requirements/areas/auth.md:2236` |
| FREQ-64-AC-01 カードの枠・EMAIL の欄・ログインボタンの角が丸い | E2E | `docs/02_Requirements/areas/auth.md:2249` |
| FREQ-64-AC-03 カードの枠線が純黒でないグレー | E2E | `docs/02_Requirements/areas/auth.md:2275` |
| FREQ-64-AC-04 ログインボタンの角が 4px〜12px の中ほどの丸み | E2E | `docs/02_Requirements/areas/auth.md:2288` |
| FREQ-65-AC-05 タブに区切り線が無い | E2E | `docs/02_Requirements/areas/auth.md:2353` |
| FREQ-70-AC-01 角丸のカードがあり、送信ボタンの角が 4px〜12px | E2E | `docs/02_Requirements/areas/auth.md:2509` |
| FREQ-320-AC-01 DB の関数が失敗すると再設定は 500、登録は 503 で、監査が success にならない | E2E | `docs/02_Requirements/areas/auth.md:3143` |
| FREQ-323-AC-02 HIBP が応答しなくても登録でき、監査に検査不能が残る | E2E | `docs/02_Requirements/areas/auth.md:3208` |
| FREQ-330-REQ-02-AC-01 ログイン・会員登録・再設定のウィジェットの引き直しが useTurnstileWidget の1か所にある | E2E | `docs/02_Requirements/areas/auth.md:3456` |
| FREQ-335-AC-03 1回送ると verifyOtp が type email で1回だけ呼ばれる | E2E | `docs/02_Requirements/areas/auth.md:3767` |
| FREQ-515-AC-01 管理画面のユーザー一覧で選んだ役割で送られ、失敗したら元の役割に戻る | E2E | `docs/02_Requirements/areas/auth.md:3858` |
| FREQ-515-AC-03 お知らせの作成・編集で選んだカテゴリーで保存される | E2E | `docs/02_Requirements/areas/auth.md:3884` |
| SEC-AUTH-008-AC-01 Google でログインした管理者は、TOTP の前に管理の窓口が 403 | E2E | `docs/02_Requirements/areas/auth.md:4483` |
| SEC-AUTH-013-AC-02 回数の制限の例外で窓口が先へ進まない | E2E | `docs/02_Requirements/areas/auth.md:4646` |
| SEC-AUTH-015-AC-03 本番でメールの差し替えに新旧両方の確認が要る | E2E | `docs/02_Requirements/areas/auth.md:4732` |
| SEC-AUTH-019-AC-01 偽の `x-forwarded-host` での再設定の申請ではメールが届かない | E2E | `docs/02_Requirements/areas/auth.md:4869` |
| SEC-AUTH-023-AC-01 Google のログインの後に、JS から読める Cookie にトークンが無い | E2E | `docs/02_Requirements/areas/auth.md:4983` |
| FREQ-508-AC-03 流し直しても付与が重ならず、ほかの結び付きが残り、「監査ログの閲覧」の名前で登録される | E2E | `docs/02_Requirements/areas/admin.md:206` |
| SEC-ADMIN-003-AC-02 管理の表の権限が anon・authenticated に無い | E2E | `docs/02_Requirements/areas/admin.md:422` |
| SEC-ADMIN-010-AC-01 監査ログの行を書き換えると検知の確かめで分かる | E2E | `docs/02_Requirements/areas/admin.md:642` |
| SEC-ADMIN-010-AC-02 保持の期間を過ぎた行は写しを残してから消える | E2E | `docs/02_Requirements/areas/admin.md:654` |
| SEC-ADMIN-012-AC-02 漏れたパスワードでの作成を断る | E2E | `docs/02_Requirements/areas/admin.md:720` |
| SEC-ADMIN-017-AC-02 秘密が未設定なら Reply-To の無いメールを送る | E2E | `docs/02_Requirements/areas/admin.md:900` |
| SEC-ADMIN-021-AC-02 メールを送らなかった返信は mailSent を false で返す | E2E | `docs/02_Requirements/areas/admin.md:1017` |

## 名前に ID の無い試験

| 段 | 場所 | 名前 |
| --- | --- | --- |
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
| e2e | `e2e/FR-NEWS-ALL-017-desktop-filter-left-edge.spec.ts:44` | mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない |
| e2e | `e2e/FR-LOOK-ALL-009-filter-spacing-match-news.spec.ts:58` | ${vp.name} で drawer の option-list gap が LOOK と NEWS で一致する |
| e2e | `e2e/FR-LOOK-ALL-019-hover-second-image.spec.ts:51` | ${vp.name} では2枚目画像が opacity 0 のまま表示されない |
| e2e | `e2e/FR-LOOK-ALL-028-catalog-match-home-mobile.spec.ts:74` | tablet /look の左右 padding がホーム LOOK セクションと同値 |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:17` | desktop（1280px）でフィルターが画面左端に寄っている |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:25` | wide desktop（1920px）でもフィルターが画面左端に寄っている |
| e2e | `e2e/FR-LOOK-ALL-035-desktop-filter-left-edge.spec.ts:33` | mobile（390px）/ tablet（768px）ではデスクトップフィルターを表示しない |
| e2e | `e2e/FR-STOCKIST-009-divider-spacing.spec.ts:94` | ${scenario.label} applies phi-based divider spacing |
| e2e | `e2e/FR-LOGIN-011-auth-rounded-design.spec.ts:25` | email input and login button are not rounded (minimal design) |
| e2e | `e2e/FR-LOGIN-013-password-reset-link-placement.spec.ts:50` | register confirm-password remains vertically centered in the shared support row |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:12` | auth JSX uses lk-text classes instead of inline font-size tokens |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:26` | tabs repeat one font size and selection uses underline contrast |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:46` | type scale descends from tabs to actions, fields and support text |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:84` | fields and auth buttons use the compact shared component sizes |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:104` | primary and Google actions have identical compact dimensions |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:122` | switching tabs keeps fields and action rows fixed |
| e2e | `e2e/FR-LOGIN-022-auth-layout-hierarchy.spec.ts:154` | form is grouped near its tabs |
| e2e | `e2e/FR-LOGIN-023-auth-viewport-centering.spec.ts:54` | login remains viewport-centered after switching to registration |
| e2e | `e2e/FR-LOGIN-023-auth-viewport-centering.spec.ts:67` | short viewport keeps the login form reachable without clipping |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:43` | タブ（ログイン / 会員登録）を出さない |
| e2e | `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts:50` | リロードしてもコード入力が残る |
| e2e | `e2e/FR-HEADER-001-drawer-no-site-title.spec.ts:38` | desktop (1280px): Drawer trigger is hidden |
| e2e | `e2e/FR-HEADER-002-drawer-sns-icon-centering.spec.ts:46` | desktop (1280px): Drawer SNS section is not rendered |
| e2e | `e2e/FR-HEADER-003-drawer-sns-icon-bw-filter.spec.ts:65` | desktop (1280px): Drawer SNS icons are not rendered |
| e2e | `e2e/FR-PWRESET-001-visual-consistency-with-login.spec.ts:105` | uses the same field and button sizing contract as login |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:57` | the request form is still reachable |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:69` | opening the link with GET forwards to the verify page |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:82` | a link without a token redirects with a reason |
| e2e | `e2e/FR-PWRESET-002-password-reset-hardening.spec.ts:111` | confirm rejects the removed legacy token payload |

## 飛ばしている試験

| 段 | 場所 | 指す項目 | 名前 |
| --- | --- | --- | --- |
| e2e | `e2e/FR-LOOK-DETAIL-007-related-recommendations-wont.spec.ts:4` | FR-LOOK-DETAIL-007-AC-01 | FR-LOOK-DETAIL-007-AC-01 詳細に同じシーズンか関連のコーディネートを薦める節が出る（現フェーズ対象外のため未実装） |
| integration | `tests/integration/ui/auth-header-visibility.test.tsx:95` | ARC-AUTH-008 | ARC-AUTH-008 CSS が印の true の時にヘッダーの高さを、false の時に 0 を --site-header-offset に入れる（計算後の CSS で確かめる手段が要る） |
| integration | `tests/integration/ui/auth-header-visibility.test.tsx:96` | ARC-AUTH-008 | ARC-AUTH-008 共有のレイアウトが html の初期値に data-header-visible="true" を持つ（レイアウトを描いて確かめる手段が要る） |
| integration | `tests/integration/db/auth_grants_inventory.integration.test.ts:383` | DATA-AUTH-006 | DATA-AUTH-006 anon の TRUNCATE を既知の例外の表からも外す（他領域の波で直す） |

## 届かない分岐

手書きの節。分岐の網羅で届かない所を、1行に1件「- `場所:行` 理由。確認: 未」の形で書く。生成し直しても残る。

- `src/app/admin/news/NewsForm.tsx:253` の `NewsForm` の画像の欄の onClick の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。file の入力は押される枠そのものの子で、枠が描かれている間は ref が必ず入っているため。確認: 未
- `src/app/admin/news/NewsForm.tsx:257` の `NewsForm` の画像の欄の onKeyDown（Enter・Space）の `fileInputRef.current?.click()` の `current` が `null` の側は通らない。理由は onClick と同じ。確認: 未
- `src/app/api/admin/news/[id]/route.ts:51` の `logNewsAudit` の引数 `resourceId` の既定値 `= null` は通らない。ファイルの中の呼び出し7か所が全部 `id` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:55` の `parseCategorySelection` の引数 `fallback` の既定値 `= "ALL"` は通らない。呼び出し2か所（初めの状態と URL の読み直しの effect）が全部 `catalogProps.initialCategory ?? "ALL"` を渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:127` の `syncCategoryQuery` の `variant !== "catalog"` の早期の戻りは通らない。呼ぶのは `applyCategorySelection` だけで、それを受ける `MultiSelect` は catalog の描画にしか出ず、home で呼ばれないため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:275` の `renderCategoryFilter` の引数 `size` の既定値 `= "3xs"` は通らない。呼び出し2か所が `"xs"` と `"3xs"` を必ず渡すため。確認: 未
- `src/features/news/components/PublicNewsGrid.tsx:452` の `PublicNewsGrid` の home の VIEW ALL の判断の `fetchLimit ?? 6` の右側は通らない。home では `fetchLimit` が `props.fetchLimit ?? 6` で必ず数になるため。確認: 未
- `src/features/search/components/SearchPageClient.tsx:159` `renderSuggestionLabel` の「語が空なら label をそのまま返す」側。候補のリストは入力欄の値が前後の空白を除いて空でない時だけ開く（`isSuggestionListOpen`）ので、空の語で呼ばれない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:380` `commitSearch` の `nextTab` の既定値（`activeTab`）の側。呼ぶ所（送信・タブ・候補）が全部 `nextTab` を渡す。確認: 未
- `src/features/search/components/SearchPageClient.tsx:394` `nextUrl` の三項で `params.toString()` が空の側（`pathname` だけを返す側）。直前に `params.set("tab", ...)` で必ず `tab` を入れるので空にならない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:684` 人気商品の `map` の中の `results?.popularItems ?? []` の `results` が null の側。同じ条件の直前の判定で人気商品が1件以上と確かめた後の分岐で、同じ描画の中の値なので null にならない。確認: 未
- `src/features/search/components/SearchPageClient.tsx:684` 同じ式の `?? []` の右側（空配列）。上と同じ理由で、1件以上と確かめた直後の分岐なので配列がある。確認: 未
- `src/features/stockist/components/PublicStockistGrid.tsx:328` の `renderAreaTree` の引数 `size` の既定値 `"xs"` は通らない。呼び出し2か所（デスクトップの `"3xs"`、モバイルの `"xs"`）が必ず値を渡し、この関数は export されないため。確認: 未
- `src/features/search/services/search.service.ts:84` `tokenizeQuery` の「正規化した語が空なら空配列を返す」側。呼ぶ `rankText` は書き出しの関数 `executeSearch`・`getSearchSuggestions` だけから来て、どちらも前後の空白を除いた空でない語しか渡さない（空は手前で戻る）。確認: 未
- `src/features/search/services/search.service.ts:117` `rankText` の「語が空、または分けた語が空なら 0 を返す」側。語は空でなく、記号だけの語も `tokenizeQuery` が語全体を1語に戻すので分けた語は空にならない。確認: 未
- `src/features/search/services/search.service.ts:131` `rankText` の `normalizedTexts[0] ?? ''` の右側。呼ぶ所が必ず題を先頭に1つ以上の欄を渡す。確認: 未
- `src/features/search/components/SearchPageClient.tsx:434` 外を押す聞き手の `searchBoxRef.current` が `null` の側は通らない（分岐の網羅の数には入らない）。聞き手は候補のリストが開いている間、つまり検索の箱を描いた後にだけ付くため。確認: 未
- `src/app/api/auth/confirm/route.ts:105` `GET` の入口の判断 `error || !data?.session || !data?.user` の `!data?.user` の `data` が `null` の側は通らない。直前の `!data?.session` が `data` が `null` の時に真になって先に抜けるため。確認: 済み
- `src/app/api/auth/confirm/route.ts:149` `GET` のセッションの保存に失敗した時の監査の `data.user?.email` の `user` が無い側は通らない。105 行の確かめを通った後なので `user` がある。確認: 済み
- `src/app/api/auth/confirm/route.ts:152` `GET` のセッションの保存に失敗した時の監査の `data.user?.id` の `user` が無い側は通らない。理由は 149 行と同じ。確認: 済み
- `src/app/api/auth/confirm/route.ts:179` `GET` の成功の監査の `data.user?.email` の `user` が無い側は通らない。理由は 149 行と同じ。確認: 済み
- `src/app/api/auth/confirm/route.ts:181` `GET` の成功の監査の `data.user?.id` の `user` が無い側は通らない。理由は 149 行と同じ。確認: 済み
- `src/app/api/auth/otp/verify/route.ts:93` `POST` の入口の判断 `verifyError || !data?.session || !data?.user` の `!data?.user` の `data` が `null` の側は通らない。直前の `!data?.session` が `data` が `null` の時に真になって先に抜けるため。確認: 済み
- `src/app/api/auth/register/route.ts:205` `POST` の `data.user?.id` の `user` が無い側（セッションの保存が結果を返さなかった時の監査）は通らない。手前の `if (!data.user)` で先に返るため。確認: 済み
- `src/app/api/auth/register/route.ts:225` `POST` の `data.user?.id` の `user` が無い側（セッションの保存が例外を投げた時の監査）は通らない。理由は 205 行と同じ。確認: 済み
- `src/app/api/auth/register/route.ts:231` `POST` の `data.user?.id` の `user` が無い側（成功の監査）は通らない。理由は 205 行と同じ。確認: 済み
- `src/app/auth/password-reset/page.tsx:234` `PasswordResetPage` の `handleResend` の先頭の `siteKey && !turnstileToken` が真の側は通らない。再送のボタンが同じ描画の値（`disabled={loading || (!!siteKey && !turnstileToken)}`）で押せなくなっており、この関数に入る時点で常に偽のため。確認: 済み
- `src/app/auth/verified/page.tsx:187` `VerifiedPage` の effect の `authBody?.user?.role` の `authBody?.` が `null` の側、三項の真側の `authBody?.` が `null` の側と `user?.` が `undefined` の側（3分岐）は通らない。直前の `authBody?.authenticated === true` を通った後なので `authBody` は `null` でなく、真側に入るには `role` を持つ `user` が要るため。確認: 済み
- `src/app/auth/verified/page.tsx:188` `VerifiedPage` の effect の `authBody?.user?.mfaVerified` の `authBody?.` が `null` の側は通らない。理由は 187 行と同じ。確認: 済み
- `src/app/login/verify/VerifyOtpClient.tsx:192` `VerifyOtpClient` の `resolvePostLoginPath` の `body?.redirectTo` の `body` が `null` の側は通らない。直前の `body === null` で `/auth/verified` を返した後なので `body` は `null` でない。確認: 済み
- `src/components/AuthResultScreen.tsx:114` `AuthResultScreen` の effect の `titleRef.current?.focus()` の `current` が `null` の側は通らない。見出しは条件なしで描かれ、描いた後に走る effect の時点で ref が入っているため。確認: 済み
- `src/components/AuthTabs.tsx:45` `AuthTabs` の `switchTab` の `TABS.find(...)?.path` の見つからない側は通らない。引数の型が `TABS` の key だけのため。確認: 済み
- `src/components/AuthTabs.tsx:56` `AuthTabs` の `handleTabKeyDown` の `tabRefs.current[next]?.focus()` の ref が無い側は通らない。2つのタブは常に描かれ、ref が入っているため。確認: 済み
- `src/components/Header.tsx:126` `Header` の `isActiveMenuItem` の `href === "/"` の真の側は通らない。呼ぶのはナビの項目・`/loading`・`/admin` だけで `/` が無いため（使われていないコード）。確認: 済み
- `src/components/Header.tsx:411` `Header` の `LoginModal` の引数の `open={loginOpen && !isLoggedIn}` の右側は通らない。`setLoginOpen(true)` の呼び出しがどこにも無く、`loginOpen` は初めの値 `false` のままのため（使われていないコード）。確認: 済み
- `src/features/auth/return-intent/return-path.ts:114` `validateReturnPath` のデコード後の長さの判断 `decoded.length > RETURN_PATH_MAX_LENGTH` の真の側は通らない。`decodeURIComponent` の結果は元の値より長くならず、元の値は直前で 512 字以内と確かめ済みのため。確認: 未
- `src/features/auth/return-intent/return-path.ts:129` `validateReturnPath` の `url.origin !== origin` の真の側は通らない。元の値は「`/` で始まり 2 文字目が `/` でも `\` でもない」と確かめ済みで、空白・制御文字も無いので、`new URL(値, origin)` は必ず同じ origin になるため。確認: 未
- `src/features/auth/return-intent/return-path.ts:130` `validateReturnPath` の `url.username || url.password` の真の側は通らない。基準の origin は `new URL(...).origin` で作り直すので資格情報を持たず、相対の値の解釈でも付かないため。確認: 未
- `src/features/auth/return-intent/return-path.ts:136` `validateReturnPath` の `new URL(out, origin).origin !== origin` の真の側は通らない。直前で `out` が `//` と `/\` で始まらないと確かめ済みで、`/` で始まる道筋の解釈は同じ origin になるため。確認: 未
- `src/app/admin/look/edit/[id]/page.tsx:88` `AdminLookEditPage` の `if (!initialValues)` の真の側（読み込みが終わったのに値も誤りも無い形）は通らない。成功時は必ず値を入れ、失敗時は必ず誤りを入れ、`isLoading` を外すのはその後（同じ描き直しにまとめられる）ため。確認: 未
- `src/app/api/admin/looks/[id]/route.ts:748` `PATCH` の catch の `error instanceof z.ZodError` の真の側（理由の文 `detail`）は通らない。本文の形は `safeParse` で確かめて 400 を直接返し、`request.json()` の失敗は `SyntaxError` で、`ZodError` を投げる部品がこの道に無いため。確認: 未
- `src/app/api/admin/looks/[id]/route.ts:750` 同じ分岐の `metadata`（`invalid_fields`）の側は通らない。理由は 748 行と同じ。確認: 未
- `src/features/look/components/PublicLookGrid.tsx:326` `PublicLookCatalog` の引数 `initialSeason` の既定値 `"ALL"` は通らない。唯一の呼び元 `PublicLookGrid` が `props.initialSeason ?? "ALL"` で必ず値を渡し、この関数は export されないため。確認: 未
- `src/features/look/components/PublicLookGrid.tsx:387` `renderSeasonFilter` の引数 `size` の既定値 `"3xs"` は通らない。呼び元2か所が `"xs"` と `"3xs"` を必ず渡すため。確認: 未
- `src/lib/look/public.ts:105` `normalizeLookSeasonSelection` の `lastValue ?? 'ALL'` の右側は通らない。0 件を直前で `ALL` として返すので、配列の最後の要素は必ずある。添え字の読みが `undefined` を含む型を満たすためだけの分岐。確認: 未
- `src/lib/look/server.ts:385` `hydrateLooks` の `signedImageUrlsMap.get(row.id) ?? []` の右側は通らない。全ての LOOK の行を `signedImageUrlsMap` に先に入れてから `map` するため。確認: 未
- `src/app/api/admin/revoke-user-sessions/route.ts:93` `POST` の `audit` の引数 `extra` の既定値 `= {}` は通らない。呼び出し5か所が全部 `{ resource_id: ... }` を渡し、この関数はファイルの中だけで使うため。確認: 未
- `src/app/api/admin/users/mfa/reset/route.ts:91` `POST` の `audit` の `metadata ? { metadata } : {}` の偽の側は通らない。呼び出し9か所が全部 `metadata` を渡し、この関数はファイルの中だけで使うため。確認: 未
- `src/app/api/auth/mfa/enroll-totp/route.ts:132` `POST` の未確認の要素を外した後の監査の `unenrollResult?.error` の `unenrollResult` が `null` の側は通らない。supabase-js の `mfa.unenroll` は `{ data, error }` の形を必ず返し、`null` を返さないため（型を満たすための `?.`）。確認: 未
