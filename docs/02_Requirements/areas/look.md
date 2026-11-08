# LOOK の要件

> 状態: 推定 | 確認日: 2026-11-07 | 対象: LOOK（一覧 `/look`・詳細 `/look/[id]`・ホームの LOOK の区画の部品・管理の LOOK） | 基準コミット: `973dc336`（作業ツリーに別の作業の未コミットの差分あり）

## 概要

LOOK の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）の LOOK にかかる行を丸ごと写し、上位の無い要件には新しい要求 `SR-LOOK-` を起こし、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-LOOK-` に書いた。セキュリティ要件は脅威の文書から別に足す。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 50 | 既存の `FREQ-` 48、新しい `SR-LOOK-001`〜`002` |
| 要件 | 81 | 既存の `FREQ-NN-REQ-NN` 67（うち廃止 1）、`FR-LOOK-ALL-001`〜`006`、`FR-LOOK-DETAIL-001`〜`007`、`FR-ADMIN-005` |
| 受け入れ条件 | 156 | 既存の `FREQ-NN-AC-NN` 129（うち廃止 3）、新しい `FR-…-AC-NN` 27 |
| 派生要件 | 13 | `DRV-LOOK-001`〜`013` |
| セキュリティ要件 | 23（受け入れ条件 45） | `SEC-LOOK-001`〜`023`、`SEC-LOOK-NNN-AC-NN`。上位は脅威の文書（`docs/05_Quality/security/threats/look.md`）の `THR-LOOK-001`〜`023` |

- 状態: 写した要求・要件・受け入れ条件のうち、根拠が元の行に書いてある物は「現行」。元の行に理由が無く根拠の「なぜ」を推定で補った物・コードと合わない行・後の行で中身が置き換わった行・新しく起こした項目・実装から読み取った項目は「推定」。後の行が「置換」「取り消し」と明記した物だけを「廃止」にした。どちらが正しいかは決めず、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せた
- 結論: 公開の LOOK を見る要求は元の文書に無かった（`SR-LOOK-001`・`002` を推定で起こした）。一覧のモバイルの左右の余白（FREQ-141）はコードと要件が合わず、E2E が赤。無い LOOK の頁の戻りのリンク（FR-LOOK-DETAIL-004・FREQ-178）は 2026-11-07 にコードへ戻した（`Back to Lookbook`、`/look` へ）。LOOK のカードの見た目の行（FREQ-127〜145）は後の行が前の行を置き換えた所が多く、元の行に置き換えの印が無い

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 写した元 | `docs/02_Requirements/requirements.md`（「要求と要件のトレーサビリティ」節の FREQ-11・12・17 の行、「1.6 ルック一覧ページ」「1.7 ルック詳細ページ」節の FR-LOOK-ALL-001〜006・FR-LOOK-DETAIL-001〜007、「1.16 管理画面」節の FR-ADMIN-005、「要求トレーサビリティ追記」の各節の行）。元の行は消していない |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md`、`docs/01_Planning/brand.md` |
| 対象のコード | `src/app/look/`、`src/app/api/admin/looks/`、`src/app/admin/look/create/page.tsx`・`edit/`・`types.ts`、`src/components/LookSection.tsx`、`src/features/look/`、`src/lib/look/`、`src/lib/storage/look-images.ts`（`src/app/admin/look/LookForm.tsx` は範囲外） |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない。E2E の赤は 2026-10-24 の全件の E2E の記録から） |
| 共有の ID | 複数の領域にまたがる ID は1つの領域だけが定義する。ほかの領域が持つ ID は定義せず、上位には `（範囲外）` の印で書く |

### 写した行と写さなかった行

写したのは、LOOK の範囲のコードがその一部を作っていて、持ち主が LOOK と決まった行。ITEM にまたがる行（FREQ-179・279・288・289）も丸ごと写した（ITEM の分の受け入れ条件は範囲の E2E が無い）。

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-119・126・146・185・274・275 | NEWS が `docs/02_Requirements/areas/news.md` で定義済み。LOOK の一覧・管理の窓口もこれらに従う |
| FREQ-316・327・515・519・540 | 316・327・515 は持ち主が AUTH。519・540 は別の作業が書き換え中で、今はどの領域も定義しない。LOOK の管理の窓口もこれらに従い、上位には `（範囲外）` で書く |
| NFR-SEO-002 | 全体の非機能要件（SSR・プリレンダで検索エンジンが読めるようにする）で、誰も定義しない。LOOK の頁は Server Component で HTML を返すが、無い LOOK を状態 200 で返す（ADR-0156）のは soft 404 になり合わないおそれがあるので、上位にもつながない（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節を参照） |
| FREQ-148 | 持ち主は HOME（ホームの LOOK の区画の件数と VIEW ALL）。部品の PublicLookGrid は LOOK の範囲 |
| FREQ-13・57 | 持ち主は STOCKIST。FREQ-57 は「LOOK/ITEM と統一」と書くだけ |
| FREQ-118・276・281 | 受け入れ条件が ITEM 一覧の話で、持ち主は無し（ITEM は範囲に無い） |
| FREQ-184・190・192・193・199・200・201 | 持ち主は SEARCH（検索の頁の LOOK のタブ・メタ） |
| FREQ-202・203・238・253・402 | 管理の左のナビ・ダッシュボード・会計・管理の背景の板（共有の部品）の話で、持ち主は無し |
| FR-HOME-002・004、FR-ABOUT-004・006、FR-SEARCH-001・003、FR-ITEM-DETAIL-012、FR-ADMIN-001 | ホーム・アバウト・検索・商品詳細・管理の共通の節の要件。設計の上位には `（範囲外）` の印で書ける |
| `FR-LOOK-ALL-007`〜`040`・`FR-LOOK-DETAIL-008`〜`018` | 要件としての定義が無い。E2E のファイル名と `describe` の名前にだけある番号（FREQ-337 の文が `FR-LOOK-ALL-007` を指すのも同じ） |

### E2E と受け入れ条件の対応

範囲の E2E（`e2e/FR-LOOK-*`）のテスト名の先頭に付けた受け入れ条件（2026-10-25 時点。`npm run validate-trace -- LOOK` の `missing-child` が正）。

| E2E のファイル | テスト名の先頭に付けた受け入れ条件 |
| --- | --- |
| FR-LOOK-ADMIN-001-look-tab-crud | FR-ADMIN-005-AC-01、FR-ADMIN-005-AC-02、FR-ADMIN-005-AC-03、FR-ADMIN-005-AC-04、FR-ADMIN-005-AC-05、FREQ-17-AC-01 |
| FR-LOOK-ALL-001-published-looks-grid | FR-LOOK-ALL-001-AC-01 |
| FR-LOOK-ALL-002-look-card-fields-and-navigation | FR-LOOK-ALL-002-AC-01 |
| FR-LOOK-ALL-003-look-list-render-capacity | FR-LOOK-ALL-003-AC-01 |
| FR-LOOK-ALL-004-home-look-section-and-cta | FR-LOOK-ALL-004-AC-01 |
| FR-LOOK-ALL-005-look-list-seo-metadata | FR-LOOK-ALL-005-AC-01 |
| FR-LOOK-ALL-006-look-filter-sort-wont | FREQ-51-AC-01、FREQ-51-AC-02 |
| FR-LOOK-ALL-007-related-item-spacing | FREQ-53-AC-02 |
| FR-LOOK-ALL-008-no-lookbook-heading | FREQ-50-AC-01 |
| FR-LOOK-ALL-009-filter-spacing-match-news | FREQ-52-AC-01 |
| FR-LOOK-ALL-010-related-item-proximity | FREQ-53-AC-01 |
| FR-LOOK-ALL-011-card-text-proximity | FREQ-54-AC-01 |
| FR-LOOK-ALL-012-grid-row-gap | FREQ-55-AC-01、FREQ-55-AC-02 |
| FR-LOOK-ALL-013-related-item-mobile-stack | FREQ-56-AC-01、FREQ-56-AC-02、FREQ-133-AC-01 |
| FR-LOOK-ALL-014-season-label-format | FREQ-138-AC-01、FREQ-127-AC-01 |
| FR-LOOK-ALL-015-card-overlay-desktop | FREQ-128-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-016-overlay-serif-gradient | FREQ-129-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-017-overlay-gradient-smooth | FREQ-130-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-018-hover-related-items | FREQ-131-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-019-hover-second-image | FREQ-132-AC-01、FREQ-132-AC-02 |
| FR-LOOK-ALL-020-desktop-hide-below-related-items | FREQ-133-AC-01、FREQ-133-AC-02 |
| FR-LOOK-ALL-021-overlay-text-alignment | FREQ-134-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-022-overlay-last-baseline | FREQ-135-AC-01、FREQ-128-AC-03 |
| FR-LOOK-ALL-023-desktop-image-no-margin | FREQ-136-AC-01、FREQ-139-AC-01 |
| FR-LOOK-ALL-024-equal-card-gaps | FREQ-137-AC-02 |
| FR-LOOK-ALL-025-card-info-panel | FREQ-138-AC-01、FREQ-138-AC-02、FREQ-138-AC-03、FREQ-138-AC-04、FREQ-138-AC-05 |
| FR-LOOK-ALL-026-panel-spacing-typography | FREQ-139-AC-01、FREQ-139-AC-05 |
| FR-LOOK-ALL-027-mobile-tablet-row-gap | FREQ-140-AC-01、FREQ-140-AC-02、FREQ-140-AC-04 |
| FR-LOOK-ALL-028-catalog-match-home-mobile | FREQ-141-AC-01、FREQ-141-AC-03、FREQ-141-AC-04 |
| FR-LOOK-ALL-029-card-gray-border | FREQ-142-AC-01、FREQ-142-AC-02、FREQ-142-AC-04 |
| FR-LOOK-ALL-030-season-label-emphasis | FREQ-143-AC-01 |
| FR-LOOK-ALL-031-related-item-match-item-card | FREQ-144-AC-01 |
| FR-LOOK-ALL-032-season-label-tracking-narrow | FREQ-145-AC-01 |
| FR-LOOK-ALL-033-overlay-item-underline-link | FREQ-150-AC-01、FREQ-150-AC-03、FREQ-150-AC-04 |
| FR-LOOK-ALL-034-panel-item-underline-link | FREQ-151-AC-01、FREQ-151-AC-04 |
| FR-LOOK-ALL-036-grid-columns-match-item | FREQ-277-AC-01、FREQ-277-AC-02、FREQ-277-AC-03 |
| FR-LOOK-ALL-037-card-scroll-reveal | FREQ-279-AC-01、FREQ-279-AC-05、FREQ-279-AC-02、FREQ-279-AC-04 |
| FR-LOOK-ALL-038-mobile-related-item-group-gap | FREQ-337-AC-01、FREQ-337-AC-02、FREQ-337-AC-03 |
| FR-LOOK-ALL-039-card-text-reveal-left-to-right | FREQ-338-AC-01、FREQ-338-AC-02、FREQ-338-AC-03 |
| FR-LOOK-ALL-040-reveal-initial-outside-card | FREQ-339-AC-01、FREQ-339-AC-02 |
| FR-LOOK-ALL-041-card-overlay-desktop-remaining | FREQ-128-AC-02、FREQ-128-AC-04、FREQ-129-AC-02、FREQ-129-AC-03、FREQ-130-AC-02、FREQ-131-AC-02、FREQ-131-AC-03、FREQ-134-AC-02、FREQ-150-AC-02 |
| FR-LOOK-ALL-042-season-label-and-hover-image-remaining | FREQ-127-AC-01、FREQ-127-AC-03、FREQ-127-AC-02、FREQ-143-AC-02、FREQ-143-AC-04、FREQ-145-AC-02、FREQ-132-AC-03 |
| FR-LOOK-ALL-043-card-info-panel-remaining | FREQ-139-AC-02、FREQ-139-AC-03、FREQ-139-AC-04、FREQ-142-AC-03、FREQ-144-AC-02、FREQ-144-AC-03、FREQ-144-AC-04、FREQ-151-AC-02、FREQ-151-AC-03 |
| FR-LOOK-ALL-044-list-behaviour-and-grid-remaining | FR-LOOK-ALL-001-AC-02、FR-LOOK-ALL-002-AC-02、FR-LOOK-ALL-004-AC-02、FR-LOOK-ALL-006-AC-01、FR-LOOK-ALL-006-AC-02、FREQ-140-AC-03、FREQ-141-AC-02、FREQ-279-AC-03 |
| FR-LOOK-DETAIL-001-look-detail-core-display | FR-LOOK-DETAIL-001-AC-01 |
| FR-LOOK-DETAIL-002-styling-items-links | FR-LOOK-DETAIL-002-AC-01 |
| FR-LOOK-DETAIL-003-prev-next-navigation | FR-LOOK-DETAIL-003-AC-01 |
| FR-LOOK-DETAIL-004-not-found-and-back-link | FR-LOOK-DETAIL-004-AC-02 |
| FR-LOOK-DETAIL-005-multi-image-gallery | FR-LOOK-DETAIL-005-AC-01 |
| FR-LOOK-DETAIL-006-metadata-backlink-aria | FR-LOOK-DETAIL-006-AC-01 |
| FR-LOOK-DETAIL-007-related-recommendations-wont | FR-LOOK-DETAIL-007-AC-01（skip。試験に数えない） |
| FR-LOOK-DETAIL-008-related-items-divider-unify | FREQ-176-AC-01 |
| FR-LOOK-DETAIL-009-related-item-preview-size | FREQ-177-AC-01 |
| FR-LOOK-DETAIL-010-remove-back-link | FREQ-178-AC-01、FREQ-178-AC-02 |
| FR-LOOK-DETAIL-011-image-gallery-match-item | FREQ-179-AC-01、FREQ-179-AC-02、FREQ-179-AC-03 |
| FR-LOOK-DETAIL-012-desktop-image-no-overlap | FREQ-180-AC-01、FREQ-179-AC-02 |
| FR-LOOK-DETAIL-013-bottom-nav-three-columns | FREQ-181-AC-01 |
| FR-LOOK-DETAIL-014-nav-icon-thin-svg | FREQ-182-AC-01 |
| FR-LOOK-DETAIL-015-nav-black-and-icon-size | FREQ-183-AC-01 |
| FR-LOOK-DETAIL-016-tablet-desktop-match-item | FREQ-288-AC-01、FREQ-288-AC-02、FREQ-288-AC-03 |
| FR-LOOK-DETAIL-017-mobile-fixed-bottom-nav | FREQ-343-AC-01、FREQ-343-AC-02、FREQ-343-AC-03、FREQ-343-AC-04、FREQ-343-AC-05 |
| FR-LOOK-DETAIL-018-no-horizontal-overflow | FREQ-344-AC-01、FREQ-344-AC-03 |
| FR-LOOK-DETAIL-019-detail-content-and-links-remaining | FR-LOOK-DETAIL-001-AC-02、FR-LOOK-DETAIL-002-AC-02、FR-LOOK-DETAIL-003-AC-02、FR-LOOK-DETAIL-004-AC-01、FR-LOOK-DETAIL-006-AC-02、FREQ-11-AC-01 |
| FR-LOOK-DETAIL-020-detail-layout-and-nav-remaining | FREQ-176-AC-02、FREQ-180-AC-02、FREQ-181-AC-02、FREQ-181-AC-03、FREQ-182-AC-02、FREQ-183-AC-02、FREQ-183-AC-03、FREQ-344-AC-02、FREQ-289-AC-01、FREQ-289-AC-02 |
| FR-LOOK-DETAIL-021-tablet-right-margin-match-item | FREQ-288-AC-04 |
| FR-LOOK-SEC-001-public-visibility | SEC-LOOK-001-AC-01、SEC-LOOK-001-AC-02、SEC-LOOK-006-AC-01、SEC-LOOK-006-AC-02、SEC-LOOK-006-AC-03、SEC-LOOK-007-AC-01、SEC-LOOK-008-AC-01、SEC-LOOK-009-AC-01、SEC-LOOK-016-AC-01、SEC-LOOK-017-AC-01 |
| FR-LOOK-SEC-002-postgrest-policies | SEC-LOOK-002-AC-01、SEC-LOOK-002-AC-02、SEC-LOOK-003-AC-01、SEC-LOOK-003-AC-02、SEC-LOOK-004-AC-01、SEC-LOOK-004-AC-02、SEC-LOOK-005-AC-01、SEC-LOOK-005-AC-02、SEC-LOOK-010-AC-02、SEC-LOOK-023-AC-01 |
| FR-LOOK-SEC-003-admin-api-authz | SEC-LOOK-019-AC-01、SEC-LOOK-019-AC-02、SEC-LOOK-019-AC-03、SEC-LOOK-019-AC-04、SEC-LOOK-019-AC-05、SEC-LOOK-018-AC-01、SEC-LOOK-018-AC-02、SEC-LOOK-016-AC-02、SEC-LOOK-016-AC-03、SEC-LOOK-011-AC-01 |
| FR-LOOK-SEC-004-admin-write-integrity | SEC-LOOK-012-AC-01、SEC-LOOK-012-AC-02、SEC-LOOK-012-AC-03、SEC-LOOK-013-AC-01、SEC-LOOK-013-AC-02、SEC-LOOK-014-AC-01、SEC-LOOK-014-AC-02、SEC-LOOK-020-AC-01、SEC-LOOK-020-AC-02、SEC-LOOK-015-AC-01 |
| FR-LOOK-SEC-005-global-faults | SEC-LOOK-009-AC-02、SEC-LOOK-021-AC-01、SEC-LOOK-022-AC-01、SEC-LOOK-022-AC-02 |

E2E が無い受け入れ条件（`missing-child` と同じ）: `FREQ-12-AC-01`（実装が無い）、`FREQ-137-AC-01`（`FR-LOOK-ALL-024` は desktop（lg 以上）だけ試して AC-02 を付けている。390・768px の縦横の同値は FREQ-140 で変わり、今の値は `FR-LOOK-ALL-027` が試す）、`FR-LOOK-DETAIL-007-AC-01`（WONT。`test.skip` は試験に数えず、`test-gaps.md` の「飛ばしている試験」に出る）、`SEC-LOOK-010-AC-01`。範囲外の E2E だけがある物: `FREQ-289-AC-01`・`02`（`FR-ITEM-DETAIL-041`）。`FREQ-277-AC-03` は範囲外の `FR-HOME-013` も試す。

- `FR-LOOK-ALL-035` は FREQ-274-AC-01・02（NEWS が持つ）を試す。390・768px でデスクトップのフィルターを出さないテストは対応が無い

## 要求

### SR-LOOK-001 訪問者が公開済みの LOOK を一覧で見比べ、シーズンで絞れる

| 属性 | 値 |
| --- | --- |
| 根拠 | シーズンごとの着こなし（LOOK）を一覧で見比べられれば、商品を組み合わせた時の美しさ（brand.md のコーディネートに合わせた形の提案）とコレクションの流れが伝わる。要求の表に公開の LOOK の一覧を見る要求が無い（FREQ-11 はどの画面か書かず、受け入れ条件は「関連コーディネート」）ので、FR-LOOK-ALL-001〜006 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」（ブランドアイデンティティを反映した商品体験）、`docs/01_Planning/brand.md` |

訪問者（エンドカスタマー）が、公開済みの LOOK をカードの格子で見比べ、シーズン（SS・AW）で絞り込めること。ホームの LOOK の区画からも一覧へ移れること。

### SR-LOOK-002 訪問者が LOOK を1件ずつ見て、使った商品と前後の LOOK へ移れる

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧で選んだ LOOK の画像・説明と使った商品を1つの頁で見られれば、着こなしからそのまま商品へ進める。前後の LOOK へ続けて移れれば、コレクションを順に見てもらえる。要求の表に当たる行が無いので、FR-LOOK-DETAIL-001〜007 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」（ブランドアイデンティティを反映した商品体験、閲覧からカートへの導線）、`docs/01_Planning/brand.md` |

訪問者が、公開済みの LOOK 1件のテーマ・シーズン・画像・説明文と紐づけた商品を見て、商品の頁・前後の LOOK・一覧へ移れること。

### FREQ-11 訪問者が商品を使ったコーディネートを見られる

| 属性 | 値 |
| --- | --- |
| 根拠 | 商品を1点ずつではなく着こなしとして見せ、商品どうしの組み合わせとブランドの世界観を伝えるため（stakeholder-requirements.md の要求の行）。受け入れ条件の「関連コーディネート」は WONT の推薦（FR-LOOK-DETAIL-007）とも読め、今の公開の LOOK の画面とどうつながるかが決まっていない（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-11 の行 |

要求の文: エンドカスタマー（User）が商品を用いたコーディネートを確認できること

### FREQ-12 訪問者がほかの利用者のコーディネートを見られる

| 属性 | 値 |
| --- | --- |
| 根拠 | 利用者どうしの着こなしを見せて着方の幅を伝える狙い（推定）。今のコードに利用者が着こなしを載せる仕組みは無く、実装されていない |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-12 の行 |

要求の文: エンドカスタマー（User）が他のユーザーのコーディネートを確認できること

### FREQ-17 管理画面で LOOK を登録・編集・削除する

| 属性 | 値 |
| --- | --- |
| 根拠 | 店長が開発の手を借りずにシーズンの LOOK を出し入れできるようにするため（stakeholder-requirements.md の要求の行、use-cases.md の管理の場面）（推定。この「なぜ」は元の行のどれにも書かれておらず、要求の文を繰り返すだけ） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-17 の行 |

要求の文: サイト管理者（Admin）がCMSを用いたLookの登録と編集と削除ができること

### FREQ-50 LOOK 一覧に見出し「LOOK BOOK」を出さない

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧に大きな見出しを置かず、フィルターと LOOK の画像だけで静かに見せたいというユーザーの依頼（NEWS の FREQ-31 と同じ向き）。UI/UX レビュー L-1 で足した h1 を打ち消した |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-50 の行 |

要求の文: LOOK 一覧ページ最上部の「LOOK BOOK」見出しを表示しないこと

### FREQ-51 LOOK 一覧のフィルターを NEWS 一覧と同じ置き場にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 一覧どうしでフィルターの場所が違うと行き来した時に迷うため、NEWS（PC は左のサイドバー、モバイル・タブレットは FILTER の引き出し）にそろえる |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-51 の行 |

要求の文: LOOK 一覧のフィルターを NEWS 一覧と同じ配置にすること

### FREQ-52 LOOK 一覧のフィルターの選択肢の間隔を NEWS にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | NEWS と LOOK で選択肢の詰まり方が違うと、同じサイトの中で別の部品に見えるため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-52 の行 |

要求の文: LOOK 一覧フィルターの選択肢同士の間隔を NEWS 一覧フィルターと揃えること

### FREQ-53 LOOK カードの関連商品どうしの間隔を詰める

| 属性 | 値 |
| --- | --- |
| 根拠 | 関連商品の行が離れていると別々の情報に見えるため、近接の原則で1つのまとまりに見せる |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-53 の行 |

要求の文: LOOK カードの関連商品同士の間隔を近接の原則で詰めること

### FREQ-54 LOOK カードの時期・名前・関連アイテムの縦の間隔を近接の原則で整える

| 属性 | 値 |
| --- | --- |
| 根拠 | 時期と名前は1つのまとまり、関連アイテムは別のまとまりと読めるよう、まとまりの中を狭く、まとまりの間を広くする |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-54 の行 |

要求の文: LOOK カードのコレクション時期・名前・関連アイテムの縦間隔を近接の原則で整えること

### FREQ-55 LOOK 一覧の格子のカードの行どうしの縦の間隔を広げる

| 属性 | 値 |
| --- | --- |
| 根拠 | 行どうしが近いと上下のカードの情報が混ざって見えるため、縦の間隔を横より広くして行を分ける。その後 FREQ-137 で縦横を同じにし、FREQ-140 で lg 未満だけ縦を広く戻したので、今は lg 以上で縦横が同じ（この行に置き換えの印は無い） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-55 の行 |

要求の文: LOOK 一覧グリッドのカード行どうしの縦方向の間隔を広げること

### FREQ-56 モバイルの LOOK カードで関連アイテムの名前と価格を縦に積む

| 属性 | 値 |
| --- | --- |
| 根拠 | 狭い幅で名前と価格を1行に並べると名前が折り返して読みにくいため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-56 の行 |

要求の文: LOOK カードの関連アイテムをモバイルでは商品名と価格を縦積みで表示すること

### FREQ-127 LOOK カードのシーズンの表記を「2026AW」の形にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 「2026 AW COLLECTION」は長く、画像に重ねる短い印として読みやすい形にしたいというユーザーの依頼。その後 FREQ-138 で lg 未満を「2026 AW」（空白あり）に戻したので、この形は lg 以上の画像の上の表記だけになった（この行に印は無い） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-127 の行 |

要求の文: ホーム LOOK セクションと LOOK 一覧ページの LOOK カードのシーズンラベルを「2026 AW COLLECTION」形式から「2026AW」形式に変更すること（COLLECTION を削除し、年とシーズンの間の空白もなくす）

### FREQ-128 PC だけ、シーズンとテーマをカードの画像の下部に白い文字で重ねる

| 属性 | 値 |
| --- | --- |
| 根拠 | PC の広い格子では画像を大きく見せ、文字を画像の上に重ねて雑誌のような見え方にするため（推定）。モバイル・タブレットは画像が小さいので文字を画像の下に置く |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

要求の文: PC サイズ（lg: 1024px 以上）の時だけ、LOOK カードのシーズンラベル（2026AW）とシーズンタイトル（テーマ名）をカード画像の下部に白文字で重ねて表示すること。モバイル・タブレットでは従来どおり画像の下にテキストを表示すること

### FREQ-129 PC のオーバーレイのテーマをセリフ体・大文字にし、画像の下部に黒のグラデーションを敷く

| 属性 | 値 |
| --- | --- |
| 根拠 | 白い文字が明るい画像の上でも読めるようにし、テーマをブランドの見出しの書体（セリフ体・大文字）で見せるため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-129 の行 |

要求の文: LOOK カードの PC オーバーレイ（FREQ-128）のシーズンタイトル（テーマ名）をセリフ体・大文字で表示し、白文字が見えるように画像下部を黒っぽくする（下から上へ透明になる黒グラデーションを敷く）こと

### FREQ-130 オーバーレイの黒のグラデーションを上端で滑らかに消す

| 属性 | 値 |
| --- | --- |
| 根拠 | 2点の直線のグラデーションでは影の上端に境目が見えるため、多段で少しずつ薄くして自然に消す |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-130 の行 |

要求の文: LOOK カード PC オーバーレイの黒グラデーション（FREQ-129）を、上端で影が滑らかに消えるようにすること（2点の直線的なグラデーションではなく、イージングを近似した多段ストップで減衰させる）

### FREQ-131 PC でカードに乗るとシーズンとテーマを消し、関連アイテムの名前と価格に入れ替える

| 属性 | 値 |
| --- | --- |
| 根拠 | PC はカードの下に関連アイテムを出さない（FREQ-133）ので、ホバーした時に使った商品と価格が分かるようにするため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-131 の行 |

要求の文: LOOK カードの PC オーバーレイ（FREQ-128）をホバーした時、シーズンラベル（2026AW 等）とシーズンタイトル（テーマ名）が消え、代わりに関連アイテム名とその価格が表示されること（関連アイテムがない LOOK はシーズン・テーマの表示を維持する）

### FREQ-132 カードに乗った時の画像の拡大をやめ、2枚目の画像があれば出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 拡大の動きは落ち着いた見せ方に合わず、2枚目の画像に替えれば着こなしの別の角度を見せられるため（推定） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-132 の行 |

要求の文: LOOK カードのホバー時の画像ズーム（scale）動作を削除し、代わりに 2 枚目の画像があればホバーでその画像を表示すること。2 枚目の画像がなければ画像に関しては何も起こらないこと

### FREQ-133 PC ではカードの下に関連アイテムの名前・価格の並びを出さない

| 属性 | 値 |
| --- | --- |
| 根拠 | PC はホバーでオーバーレイに関連アイテムを出す（FREQ-131）ので、同じ情報を2か所に出さないため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-133 の行 |

要求の文: ホバーで関連アイテムがオーバーレイに表示される PC サイズ（lg: 1024px 以上）では、LOOK カード下部の関連アイテム名・価格のリストを表示しないこと（モバイル・タブレットでは従来どおり表示する）

### FREQ-134 オーバーレイのホバーの前後で文字の位置をそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 入れ替えの時に文字の位置が動くと、切り替わりが乱れて見えるため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-134 の行 |

要求の文: LOOK カード PC オーバーレイのホバー前（シーズン・シーズンタイトル）とホバー後（関連アイテム・価格）の文字位置を揃え、切替時に見た目がきれいになるようにすること

### FREQ-135 オーバーレイの最後の関連アイテムとテーマの文字の下のラインをそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 箱の下端をそろえても、文字の大きさの差で文字の下のラインがずれて見えるため、ベースラインでそろえる |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-135 の行 |

要求の文: LOOK カード PC オーバーレイで、一番下にある関連アイテムの文字の下のラインと、シーズンタイトル（テーマ名）の文字の下のラインが揃うこと（ボックスの下端ではなく文字のベースラインで揃える）

### FREQ-136 PC では画像の下の margin を無くす

| 属性 | 値 |
| --- | --- |
| 根拠 | PC は画像の下の文字をオーバーレイに置き換えたので、画像の下の余白が要らなくなったため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-136 の行 |

要求の文: LOOK カードの PC サイズ（lg: 1024px 以上）では、画像下のキャプションがオーバーレイ表示に置き換わるため、画像コンテナの下マージン（mb）をなくすこと（モバイル・タブレットは従来どおり mb を維持する）

### FREQ-137 カードの間の縦と横の空間を同じにする

| 属性 | 値 |
| --- | --- |
| 根拠 | xl 以上で横の gap だけ広がり、縦横がそろわずに見えたため。その後 FREQ-140 で lg 未満だけ縦を広くしたので、「どの幅でも同じ」は lg 以上だけになった |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-137 の行 |

要求の文: HOME の LOOK セクションと LOOK 一覧ページで、カード間の縦の空間と横の空間を同じにすること（xl 以上で横 gap だけ広がり縦横が不揃いに見える問題の解消）

### FREQ-138 モバイル・タブレットの LOOK カードを画像の下の情報パネルの形にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 小さい画面では画像の上に文字を重ねると読みにくいため、参考の画像の形（シーズン・セリフ体のテーマ・罫線・関連アイテムと価格）を画像の下に縦に並べる |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

要求の文: HOME の LOOK セクションと LOOK 一覧ページの LOOK カードを、モバイル・タブレット（lg: 1024px 未満）に限り参考画像のデザイン（画像の下に「シーズンラベル『2026 AW』／セリフ体・大文字のテーマ名／罫線／関連アイテム名+右寄せ価格のリスト」を縦に並べた情報パネル）にすること。PC（lg 以上）は従来どおり画像上オーバーレイ表示（FREQ-128〜136）を維持する。lg 未満のシーズンラベルは年とシーズンの間に半角スペースを入れる形式に変更（lg 以上のオーバーレイは FREQ-127 の空白なし形式を維持）

### FREQ-139 情報パネル（lg 未満）の余白と文字の大きさをデザインの4原則で整える

| 属性 | 値 |
| --- | --- |
| 根拠 | テーマと関連アイテムの文字の比が 1.35:1 で階層が弱く、画像とパネルの間隔もサイトの間隔の並び（フィボナッチ系）から外れていたため。文字の比は 2026-11-07 に今の画面（モバイル約 1.13）に直した。E2E FR-LOOK-ALL-026 は 2026-10-24 の全件の E2E で赤だった（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節を参照） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

要求の文: LOOK カード情報パネル（lg 未満）の余白と文字サイズを、デザイン4原則（近接・整列・反復・対比）に基づき調整すること。対比: タイトルと関連アイテム文字のサイズ比が 1.35:1 で階層が弱いため φ 比（1.618:1）へ拡大。反復・整列: 画像とパネルの間隔 12px/16px をサイトのフィボナッチ系リズム（罫線余白 8/13 と同系列）の 13px/21px に統一（FREQ-136-AC-02 の 12px/16px を置換。lg 以上の mb 0 は維持）。近接: シーズン↔タイトルの密接（2px）とグループ間（罫線余白 8px/13px）の対称は維持

### FREQ-140 lg 未満だけカードの間の縦の間隔を広げる

| 属性 | 値 |
| --- | --- |
| 根拠 | lg 未満は画像の下に情報パネルが付くので、縦が詰まると上のカードのパネルと下のカードの画像がつながって見えるため。間隔はカードの中の一番大きい余白の φ² 倍にする |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

要求の文: HOME の LOOK セクションと /look 一覧で、モバイル・タブレット（lg 未満）のみ LOOK カード間の縦の間隔（row-gap）を広げ、カード（画像+情報パネル）同士を明確に分離すること。行間はカード内最大余白（画像↔パネル 13px/21px）の φ² 倍のフィボナッチ値とする。横の間隔（column-gap）と lg 以上の縦横同値（FREQ-137）は変更しない（FREQ-137-AC-01 の「全ビューポートで同値」は lg 以上のみに縮小。FREQ-55 の「行間 > 列間」は lg 未満に限定して復活）

### FREQ-141 /look 一覧の lg 未満の見た目をホームの LOOK の区画にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | ホームと一覧で同じカードの余白と列の間隔が違うと、行き来した時に別の画面に見えるため。モバイルの左右の余白は 2026-11-07 に今の画面（0）に直した。E2E FR-LOOK-ALL-028 のモバイルは 2026-10-24 の全件の E2E で赤だった（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節を参照） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

要求の文: /look 一覧ページのモバイル・タブレット（lg 未満）の見た目を、ホームページの LOOK セクションと揃えること。①モバイルで画像が画面端まで密着していた（px-0）左右余白を、ホームの section-space と同値（モバイル 13px・sm 16px・md 21px）にする（2026-11-07 改定: モバイルは今の画面の 0 を正とし、sm 16px・md 21px だけホームと同値）。②タブレットの列間 32px（md:gap-8）をホームと同じ 24px（sm:gap-6）にする（FREQ-140-AC-02 の「一覧 32px」を 24px に置換）。lg 以上は変更しない

### FREQ-142 lg 未満だけ LOOK カード全体をグレーの枠線で囲む

| 属性 | 値 |
| --- | --- |
| 根拠 | lg 未満は画像と情報パネルが縦に続くので、どこまでが1枚のカードか分かるように囲むため。参考画像の VIEW LOOK などは足さない |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

要求の文: HOME の LOOK セクションと /look 一覧の LOOK カードに、モバイル・タブレット（lg: 1024px 未満）のみカード全体（画像+情報パネル）を囲むグレーの枠線を付けること。参考画像にある未実装要素（VIEW LOOK リンク等）は追加せず、枠線のみ追加する。PC（lg 以上）は枠線なしの従来表示を維持する

### FREQ-143 モバイル・タブレットのシーズンの表記を濃く・太く・字間を広くする

| 属性 | 値 |
| --- | --- |
| 根拠 | 小さい画面でシーズンの表記が薄く細いと目に入らないため、見本に合わせて存在感を出す。字間を広げる分は FREQ-145 で取り消した |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

要求の文: HOME の LOOK セクションと /look 一覧の LOOK カードで、mobile / tablet に表示されるシーズン表記（例: 2028 AW）を、添付見本のように文字色をより黒く・字を太く・字間を広げて視認性と存在感を高めること。ただし「/01」などの番号要素は追加しないこと

### FREQ-144 モバイル・タブレットの関連 ITEM の名前と価格を ITEM カードの見た目にそろえる

| 属性 | 値 |
| --- | --- |
| 根拠 | 同じ商品が LOOK のカードと ITEM のカードで違う文字で出ると別の物に見えるため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

要求の文: HOME の LOOK セクションと /look 一覧の LOOK カードで、mobile / tablet に表示される関連 ITEM の商品名・価格の文字を、ITEM カード（ItemCardInfo）に表示されている見た目に揃えること

### FREQ-145 モバイル・タブレットのシーズンの表記の字間を詰める

| 属性 | 値 |
| --- | --- |
| 根拠 | FREQ-143 で広げた字間が広すぎて読みにくかったため、色と太さはそのままで字間だけを詰める |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-145 の行 |

要求の文: mobile / tablet のシーズンタイトル（例: 2028 AW）の字間が広すぎるため狭めること（FREQ-143-REQ-03 の字間拡大を取り消し、詰め気味に整える。色をより黒く・字を太くする FREQ-143-REQ-01/02 は維持）

### FREQ-150 PC のオーバーレイの関連 ITEM に下線の動きを付け、押すと ITEM の頁へ移る

| 属性 | 値 |
| --- | --- |
| 根拠 | ホバーで出た関連 ITEM からその商品へすぐ移れるようにし、ヘッダーのメニューと同じ下線の動きで押せると分からせるため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

要求の文: ホームの LOOK セクションと /look 一覧の PC（lg: 1024px 以上）で、カードホバー時にオーバーレイ表示される関連 ITEM にカーソルを重ねると、メニューと同じ左から右への下線アニメーションが表示され、クリックするとその ITEM のページへ遷移できること

### FREQ-151 lg 未満の情報パネルの関連 ITEM に下線の動きを付け、押すと ITEM の頁へ移る

| 属性 | 値 |
| --- | --- |
| 根拠 | FREQ-150 と同じく、パネルの関連 ITEM から商品へ移れると分からせ、PC と同じ手応えにするため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

要求の文: ホームの LOOK セクションと /look 一覧のモバイル・タブレット（lg: 1024px 未満）で、カード下の情報パネルに表示される関連 ITEM にカーソルを重ねると、メニューと同じ左から右への下線アニメーションが表示され、クリックするとその ITEM のページへ遷移できること

### FREQ-176 詳細の関連アイテムの並びの上下の外枠の線を区切り線と同じにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 外枠の線だけが濃く太く見え、並びの中の区切り線とそろっていなかったため（反復の原則） |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-176 の行 |

要求の文: LOOK詳細ページの関連アイテムリストの上下の外枠線を、アイテム間の区切り線と同じ太さ・色に統一すること（外枠線が濃く太く見える問題の解消）

### FREQ-177 詳細の関連アイテムのサムネイルを少し大きくする

| 属性 | 値 |
| --- | --- |
| 根拠 | サムネイルが小さく、着こなしで使った商品の見分けが付きにくかったため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-177 の行 |

要求の文: LOOK詳細ページの関連アイテムのサムネイル画像をもう少し大きくすること

### FREQ-178 詳細の通常の表示から「Back to Lookbook」のリンクを外す

| 属性 | 値 |
| --- | --- |
| 根拠 | 通常の表示には下のナビ（LOOK LIST）に一覧への入口があり、上の戻りのリンクと重なるため（推定）。無い LOOK の表示の戻りのリンクは唯一の戻り道として残すと決め、2026-11-07 にコードへ戻した（7月の改修で消えていた） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-178 の行 |

要求の文: LOOK詳細ページの通常表示から「Back to Lookbook」リンクを削除すること（Look not found ページの戻りリンクは唯一の復帰導線のため維持。通常表示の Back リンク表示を前提とした FR-LOOK-DETAIL-006 の受け付け基準を置き換え）

### FREQ-179 詳細の画像の見せ方をモバイル・タブレット・PC とも ITEM 詳細と同じにする

| 属性 | 値 |
| --- | --- |
| 根拠 | ITEM と LOOK の詳細で画像の触り方が違うと、行き来した時に戸惑うため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

要求の文: LOOK詳細ページの画像部分のモバイル・タブレット・PC画面の仕様を、ITEM詳細ページと同様にすること（従来の「メイン画像 + 下部横並びサムネイル」全画面幅共通の方式を置換。FR-LOOK-DETAIL-005 のサムネイル検証は desktop のみに変更）

### FREQ-180 詳細の PC でメインの画像が右の文字の列にかぶらないようにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 画面幅によってメイン画像が右のテキスト列にかぶる問題を解消するため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-180 の行 |

要求の文: LOOK詳細ページの PC 表示（lg以上）で、画面幅によってメイン画像が右のテキスト列にかぶる問題を、画像の縦横比（2/3）と左右列の比率を保ったままレスポンシブに解消すること

### FREQ-181 詳細の前後のナビを「PREV LOOK / LOOK LIST / NEXT LOOK」の3列にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 前後の LOOK と一覧への入口を1か所にまとめ、参考のデザインのように並べて分かりやすくするため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-181 の行 |

要求の文: LOOK詳細ページの PREV/NEXT 部分を、参考デザインのような「PREV LOOK / LOOK LIST / NEXT LOOK」の3カラムフッターナビ（各カラムはラベル上・アイコン下の中央揃え、カラム間に縦の区切り線）に変更すること（従来の「PREV/NEXT + テーマ名」左右配置を置換）

### FREQ-182 3列のナビのアイコンをにじまない細い線で描く

| 属性 | 値 |
| --- | --- |
| 根拠 | アイコンのフォントは描く時ににじみ、線も太かったため、インラインの SVG に替えて細い線にする |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-182 の行 |

要求の文: LOOK詳細ページの3カラムナビ（PREV LOOK / LOOK LIST / NEXT LOOK）のアイコンがにじまないようにし、細い線で描画すること（FREQ-181 のアイコンをアイコンフォントで描く指定を本要件で置換）

### FREQ-183 3列のナビの色・アイコンの大きさ・ラベルの字間を参考のデザインに合わせる

| 属性 | 値 |
| --- | --- |
| 根拠 | 灰色の文字では弱く、アイコンも小さく、ラベルの字間が列ごとにそろっていなかったため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

要求の文: LOOK詳細ページの3カラムナビ（PREV LOOK / LOOK LIST / NEXT LOOK）の配色・アイコンサイズ・ラベル字間を参考デザインに合わせること（FREQ-181 のラベル色 #474747・hover 黒・tracking 指定と、FREQ-182 のアイコンサイズ `var(--lk-size-6xl)` を本要件で置換）

### FREQ-277 /look とホームの LOOK の格子の列数を ITEM と同じ区切りにする

| 属性 | 値 |
| --- | --- |
| 根拠 | ITEM と LOOK で列が切り替わる幅が違うと、行き来した時にカードの大きさがそろわないため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

要求の文: /look 一覧とホームの LOOK セクションのグリッド列数を ITEM（FREQ-276）と同じブレークポイントの組み合わせに揃えること

### FREQ-279 ITEM と LOOK のカードを画面に入った物から順にリビールで見せる

| 属性 | 値 |
| --- | --- |
| 根拠 | 画面に入った物から順に現れる動きで、静かで丁寧な見せ方（hyke.jp と同じ考え方）にするため。ITEM の分は範囲外（ITEM の領域は範囲に無い） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

要求の文: ITEM / LOOK のカードを、画面に入ったものから順に hyke.jp と同じ考え方でリビール表示すること

### FREQ-288 詳細のタブレット・PC の画像の大きさ・インジケータ・情報の列の幅を ITEM 詳細と同じにする

| 属性 | 値 |
| --- | --- |
| 根拠 | FREQ-179 の後も ITEM 詳細と細かい大きさがずれていたため、同じ部品と式にそろえる |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

要求の文: LOOK詳細ページのタブレット（md: 768〜1023px）とPC（lg以上）の画像サイズ・複数枚時のセグメント線インジケータ・右側情報列の幅を、ITEM詳細ページと同じ仕様にすること

### FREQ-289 PC で画面の縦が狭い時、インジケータと画面の下端の間に余白を入れる

| 属性 | 値 |
| --- | --- |
| 根拠 | 縦の狭い PC でインジケータが画面の下端すれすれに出て見落としやすかったため、タブレットと同じ余白にする。ITEM 詳細の分（AC-01）は範囲外の E2E が確かめる |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-289 の行 |

要求の文: PC（lg以上）で画面の縦が狭いとき、複数画像を示すセグメント線インジケータが画面下端すれすれに出るのをやめ、タブレット表示と同じようにインジケータと画面下端の間に余白を入れること

### FREQ-337 モバイルの LOOK カードで関連アイテムどうしの間隔を広げる

| 属性 | 値 |
| --- | --- |
| 根拠 | 名前と価格を縦に積むと、どこからどこまでが1つの商品か分かりにくいため、商品の中より商品の間を広くする（近接の原則） |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-337 の行 |

要求の文: モバイル（sm 未満）の LOOK カードで関連アイテムが 2 件以上並ぶとき、「商品名+価格」がひとつのまとまりとして読めるよう、アイテム同士の間隔を広げること

### FREQ-338 LOOK カードのリビールで文字も画像と同じ左から右の向きで出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 画像は左から右、文字は下からと向きが違うと動きがばらばらに見えるため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-338 の行 |

要求の文: LOOK カードのスクロール連動リビールで、文字も画像と同じ左→右の向きで現れること

### FREQ-339 LOOK カードのリビールの前に情報パネルの文字を覗かせない

| 属性 | 値 |
| --- | --- |
| 根拠 | マスクの側に余白があると、退いた文字が余白の分だけカードの中に残って見えていたため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-339 の行 |

要求の文: LOOK カードのリビール前（初期位置）に、情報パネルの文字がカード内に覗かないこと

### FREQ-343 詳細のモバイルで3項目を画面の下に固定した BottomNavigation で出す

| 属性 | 値 |
| --- | --- |
| 根拠 | ITEM 詳細のモバイルの固定のフッターと同じく、どこまでスクロールしても前後と一覧へ移れるようにするため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

要求の文: LOOK詳細ページのモバイルサイズで「PREV LOOK / LOOK LIST / NEXT LOOK」を UI の BottomNavigation として画面下に固定すること（ITEM詳細ページのモバイル固定フッターと同じ体験。FREQ-181 / FREQ-182 / FREQ-183 の各 AC のうち mobile（390px）に関する部分を本要件で置換する）

### FREQ-344 詳細で横のスクロールを起こさない

| 属性 | 値 |
| --- | --- |
| 根拠 | モバイルのカルーセルが main の余白を 4px 越えて打ち消し、横のスクロールバーが出て、固定のナビの下も欠けていたため |
| 状態 | 現行 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-344 の行 |

要求の文: LOOK詳細ページで横スクロールが発生しないようにすること（モバイルの画像カルーセルが `main` の左右パディングを 4px 超過して打ち消しており、横スクロールバーが viewport 下端に出て固定ボトムナビの下部も欠けていた）

## 要件

### 要求の表から写した要件

文は `requirements.md` の要件の欄のまま。元の表に優先度は無い。「今のコード」は 2026-10-24 にコードを読んで分かったこと。

### FREQ-11-REQ-01 コーディネートを見る機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-11 |
| 根拠 | FREQ-11 を「機能が動くこと」に置き換えた元の表の書き方のまま。どの画面の何を指すかは書かれていない。公開の LOOK の画面の細かい形は SR-LOOK-001・002 の下の要件が持つ（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-11 の行 |

コーディネート確認機能が正常に動作すること

### FREQ-12-REQ-01 ほかの利用者のコーディネートを見る機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-12 |
| 根拠 | FREQ-12 を「機能が動くこと」に置き換えた元の表の書き方のまま |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-12 の行 |

他ユーザーのコーディネート確認機能が正常に動作すること

今のコード（推定）: 利用者が着こなしを載せる仕組みも、それを見せる画面も無い。

### FREQ-17-REQ-01 LOOK の管理の機能が動く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-17 |
| 根拠 | FREQ-17 の登録・編集・削除を、管理の機能が動くことに置き換えた（元の表の書き方のまま。細かい形は FR-ADMIN-005 が持つ） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-17 の行 |

Look管理機能が正常に動作すること

### FREQ-50-REQ-01 一覧から「LOOK BOOK」の h1 を外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-50 |
| 根拠 | FREQ-50 の「出さない」を、隠すのではなく見出しの要素そのものを置かない形に決めた（読み上げにも残さないため） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-50 の行 |

LOOK 一覧ページのページ最上部に表示していた「LOOK BOOK」見出し（h1）を削除すること

今のコード（推定）: `/look` に h1 は1つも無い（PublicLookGrid の一覧の形に見出しが無い）。

### FREQ-51-REQ-01 SEASON のフィルターを横並びのタブから左のサイドバーと FILTER の引き出しに替える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-51 |
| 根拠 | 横並びのタブは NEWS・ITEM の一覧と違う部品で、サイドバーと引き出しにすれば同じ形で置けるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-51 の行 |

LOOK 一覧の SEASON フィルターを、横並びタブから NEWS 同様の配置（PC は左サイドバー、モバイル・タブレットは FILTER ボタンで開く drawer）に変更すること

### FREQ-52-REQ-01 .filter-sections で包み、選択肢の間隔の式と大きさを NEWS と同じにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-52 |
| 根拠 | 間隔を NEWS と同じ包みと式から出せば、NEWS を直した時に LOOK も一緒にそろうため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-52 の行 |

LOOK 一覧の SEASON フィルターを NEWS と同じく .filter-sections で包み、選択肢同士の間隔（option-list の gap）を NEWS と共通の式（--ui-font-size × 0.5）にし、PC は size 3xs・drawer は size xs と一致させること

### FREQ-53-REQ-01 関連商品のリンクの上下の padding を外し、行の間隔を gap だけで決める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-53 |
| 根拠 | padding と gap の二重の余白をやめ、間隔を1か所（φ 比の gap）で決めて行どうしを近づけるため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-53 の行 |

関連商品リンクに付与していた上下 padding（py-1.25 sm:py-1.5）を撤廃し、行間を .look-related-items の gap（φ 比率）のみで決定して関連商品同士を一群として近接させること

今のコード（推定）: sm 未満（名前と価格を縦に積む幅）の商品の間の間隔は、FREQ-337 で φ 倍以上に広げた。

### FREQ-54-REQ-01 「時期↔名前」の間隔を「名前↔関連アイテム」より狭くする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-54 |
| 根拠 | FREQ-54 の近接の原則を、2つの間隔の大小の決まりに落とした |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-54 の行 |

コレクション時期（◯◯ COLLECTION）と名前を同一グループとして近接させ、別グループの関連アイテムとの間隔を広げること。すなわち「時期↔名前」の間隔を「名前↔関連アイテム」の間隔より狭くすること

今のコード（推定）: 文の「◯◯ COLLECTION」の表記は FREQ-127 で無くなった（間隔の決まりはそのまま）。今は時期と名前の間を詰め、名前と関連アイテムの間に罫線を置く（FREQ-138）。

### FREQ-55-REQ-01 一覧の格子の row-gap を column-gap より広くし、幅に応じて段階的に広げる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-55 |
| 根拠 | FREQ-55 の行の分け方を、縦の gap を横より広くする形に決めた。lg 以上は FREQ-137 で縦横を同じにしたので、今は lg 未満だけに当たる（FREQ-140） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-55 の行 |

LOOK 一覧（catalog）のグリッドで縦方向の gap（row-gap）を横方向の gap（column-gap）より広げ、カード行どうしを明確に分離すること。モバイルを優先しタブレット・PC でも段階的に拡張すること

### FREQ-56-REQ-01 モバイルは名前と価格を2行に積み、タブレット・PC は1行の両端に並べる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-56 |
| 根拠 | 名前の折り返しを避けたいのはモバイルだけで、広い幅では1行の方が短く読めるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-56 の行 |

モバイル幅では関連アイテムの商品名と価格を上下2行（縦積み）で表示し、商品名の折り返しを避けること。タブレット・PC では従来どおり商品名と価格を同一行（左右両端）で表示すること

今のコード（推定）: PC はカードの下に関連アイテムを出さない（FREQ-133）ので、1行に並べるのはタブレットだけ。

### FREQ-127-REQ-01 シーズンの表記を年とシーズンを空白なしでつないだ形にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-127 |
| 根拠 | FREQ-127 の「2026AW」の形を、表記を組み立てる式で決めた。今は lg 以上のオーバーレイの表記だけに当たる（lg 未満は FREQ-138 で空白ありに戻した） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-127 の行 |

LookCard（`src/features/look/components/PublicLookGrid.tsx`）のシーズンラベルを `formatLookSeason`（`{year} {type}`）＋" COLLECTION" ではなく `{seasonYear}{seasonType}` 連結（空白なし）で表示すること

### FREQ-128-REQ-01 画像の中に PC だけのオーバーレイを置き、画像の下の文字を PC で隠す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-128 |
| 根拠 | 同じ情報を PC では画像の上、モバイル・タブレットでは画像の下に1つずつ出し、二重に出さないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

LookCard の画像コンテナ内に `data-testid="look-card-overlay"` のオーバーレイ（`hidden lg:block`・白文字・シーズンラベル `--lk-size-3xs`・テーマ `--lk-size-2xl`）を画像下部（bottom 配置）に追加し、画像下の従来テキスト（`data-testid="look-card-caption"`）は `lg:hidden` で PC 非表示にすること

### FREQ-129-REQ-01 テーマを font-display・uppercase にし、オーバーレイに下から透明になる黒のグラデーションを敷く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-129 |
| 根拠 | 書体と影の付け方を部品の指定で決めた。2点のグラデーション（from-black/60 to-transparent）の指定は FREQ-130 の多段に置き換わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-129 の行 |

オーバーレイのテーマ h3 を `font-display`（Didot/Georgia 系セリフ体）＋`uppercase` とし、オーバーレイコンテナに `bg-gradient-to-t from-black/60 to-transparent`（下端が黒く上に向かって透明）と十分な上余白（pt）を設定すること

### FREQ-130-REQ-01 グラデーションを5段の多段にし、上端を完全な透明にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-130 |
| 根拠 | イージングを段で近似すれば、影が上端に向けて自然に薄くなり境目が出ないため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-130 の行 |

オーバーレイの背景をイージング近似の多段ストップ linear-gradient（例: 0.55→0.38→0.2→0.08→0 の5段）とし、上端の色を完全な透明（alpha 0）にする。上余白（pt）も広げてフェード距離を確保すること

### FREQ-131-REQ-01 題のブロックと関連アイテムのブロックの不透明度をホバーで入れ替える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-131 |
| 根拠 | 2つのブロックを同じ場所に置いて不透明度だけを替えれば、位置を動かさずに入れ替えられるため。関連アイテムが無い LOOK は題を消さない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-131 の行 |

オーバーレイ内のシーズン・テーマブロック（`data-testid="look-card-overlay-title"`）に `group-hover:opacity-0`（関連アイテムがある場合のみ）、関連アイテムブロック（`data-testid="look-card-overlay-items"`：商品名＋価格の行）に `opacity-0 group-hover:opacity-100` を設定し、ホバーで opacity 遷移により入れ替えること

### FREQ-132-REQ-01 1枚目の拡大を外し、2枚目がある時だけホバー用の画像を重ねて替える

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-132 |
| 根拠 | 2枚目が無い LOOK にホバー用の画像を置くと何も替わらない要素が残るため、ある時だけ描く |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-132 の行 |

1 枚目の Image から `group-hover:scale-105` と transition-transform を削除する。`imageUrls[1]` が存在する場合のみ 2 枚目の Image（`data-testid="look-card-image-hover"`・`opacity-0 group-hover:opacity-100`）を重ねて描画し、ホバーでクロスフェード表示すること

### FREQ-133-REQ-01 カードの下の関連アイテムの並びを lg 以上で隠す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-133 |
| 根拠 | PC だけで隠せば、モバイル・タブレットは今までどおりカードの下で関連アイテムを読めるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-133 の行 |

カード下の関連アイテムリスト（`.look-related-items`）に `lg:hidden` を付与し、PC ではカード下に関連アイテム・価格を描画しないこと

### FREQ-134-REQ-01 2つのブロックを同じ格子のセルに重ね、下端でそろえる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-134 |
| 根拠 | absolute の配置では2つのブロックの位置がずれるため、同じセルに重ねる。下端でそろえる指定（self-end）は FREQ-135 で last baseline に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-134 の行 |

タイトルブロック（look-card-overlay-title）と関連アイテムブロック（look-card-overlay-items）を同一グリッドセル（`col-start-1 row-start-1`）に重ねて `self-end` で下端揃えにし、absolute 配置による位置ずれをなくすこと

### FREQ-135-REQ-01 2つのブロックの align-self を last baseline にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-135 |
| 根拠 | 最後の行のベースラインでそろえれば、文字の大きさの差による行の上下の余白のずれを吸収できるため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-135 の行 |

タイトルブロックと関連アイテムブロックの align-self を `last baseline` にし、フォントサイズ差による行ボックス余白（half-leading）のずれを吸収して最終行のベースラインを一致させること

### FREQ-136-REQ-01 画像の箱に lg:mb-0 を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-136 |
| 根拠 | lg 以上だけ余白を消せば、モバイル・タブレットの画像と文字の間の余白はそのまま残せるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-136 の行 |

LOOK カードの画像コンテナ（aspect-2/3 の div）に `lg:mb-0` を付与し、lg 以上では margin-bottom を 0 にすること

今のコード（推定）: モバイル・タブレットの余白は FREQ-139 で 13px・21px に替わった。

### FREQ-137-REQ-01 LOOK の格子の xl:gap-x-6 を xl:gap-6 にし、どの幅でも縦横を同じにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-137 |
| 根拠 | 横だけを広げる指定をやめて縦横を同じ値にした。「どの幅でも」は FREQ-140 で lg 以上だけになった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-137 の行 |

LOOK グリッド（HOME・一覧とも）の `xl:gap-x-6` を `xl:gap-6` に変更し、全ブレークポイントで row-gap と column-gap を同値にすること

### FREQ-138-REQ-01 画像の下の情報パネルにシーズン（空白あり）・セリフ体のテーマ・罫線・関連アイテムの行を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138 |
| 根拠 | 参考の画像の並びを、lg 未満だけに出す部品で作った。テーマの文字の大きさ（--lk-size-xl）は FREQ-139 で φ 倍の式に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

LookCard の画像下キャプション（lg 未満のみ表示）を、シーズンラベル `{seasonYear} {seasonType}`（例: 2026 AW）＋テーマ名 `font-display`（Didot/Georgia 系セリフ体）・`uppercase`（サイズ --lk-size-xl）とする。関連アイテムがある場合はテーマ名とリストの間に罫線（hr・border-black/10・lg:hidden）を敷き、各行は商品名（左）と価格（右端・右寄せ）で表示する（モバイルは折り返し回避のため縦積みを維持）。lg 以上のオーバーレイ・カード下リスト非表示・画像 mb-0 は従来仕様（FREQ-128〜136）のまま変更しないこと

### FREQ-139-REQ-01 パネルのテーマの文字を関連アイテムより大きくし（モバイル約 1.13 倍・タブレット 1.5 倍以上）、画像の下の margin をモバイル 13px・タブレット 21px にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139 |
| 根拠 | 対比（文字の大きさの階層）と反復（余白をサイトのフィボナッチの並びに）を、値で決めた。文字の比は 2026-11-07 にオーナーが今の画面（モバイル約 1.13）を正にして直した |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表）。2026-11-07 のオーナー決定（今の画面の値を正にする） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

LookCard のキャプション h3 の font-size を、640px 未満で `var(--lk-size-sm)`、640px 以上で `var(--lk-size-4xl)`（`PublicLookGrid.css`）とし、line-height を `var(--sqrt-phi)`（見出し用 1.272）とする。関連アイテム文字は `var(--lk-size-2xs)`。文字の比（タイトル ÷ アイテム）は、モバイルが約 1.13（`--lk-eighthstep` の2乗 ≒ 1.128）、タブレットが 1.5 倍以上（`--lk-eighthstep` の7乗 ≒ 1.52）。画像コンテナの margin-bottom をモバイル 13px・タブレット 21px（lg 以上は 0 のまま）とする

（2026-11-07 改定: 旧は font-size を `calc(var(--lk-size-2xs) * var(--phi))`（2xs の φ 倍）・比 1.5 倍以上とした。今の画面はモバイルの比が約 1.13 のため、オーナーが今の画面を正にした。）

今のコード: 画像の下の margin は 13px・21px（lg 以上は 0）。テーマの文字の大きさは `PublicLookGrid.css` で 640px 未満が `--lk-size-sm`、640px 以上が `--lk-size-4xl`。上の要件の文はこの値に直した（2026-11-07）。

### FREQ-140-REQ-01 row-gap をモバイル 34px・sm 以上 55px にし、lg 以上は縦横を同じに戻す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-140 |
| 根拠 | lg 未満の行の間をカードの中の余白より大きくして、カードどうしを分けるため。文の「一覧は md:gap-y-13.75 も維持」は FREQ-141 で外した |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

LOOK グリッド（HOME・一覧の両デフォルトクラス）の row-gap を、モバイル 34px（gap-y-8.5）・sm 以上 55px（sm:gap-y-13.75、一覧は md:gap-y-13.75 も維持）とし、lg 以上は従来どおり gap-4 / xl:gap-6（縦横同値）に戻すこと。column-gap は全ビューポートで従来値を維持すること

### FREQ-141-REQ-01 一覧の本文の列の左右の padding をモバイルで 0、タブレットでホームと同じにし、タブレットの列の間隔を 24px にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-141 |
| 根拠 | タブレットはホームの区画の余白と同じ値を一覧の列に持たせれば、2つの画面のカードの位置と大きさがそろうため。モバイルは画像を画面の端まで密着させる今の画面を、2026-11-07 にオーナーが正にした |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表）。2026-11-07 のオーナー決定（今の画面の値を正にする） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

look-content-column の水平 padding を `sm:px-4 md:px-5.25`（モバイルは 0。タブレット以上はホーム section-space の px と同値）とし、一覧グリッドの `md:gap-8 md:gap-y-13.75` を削除して sm:gap-6（24px）・sm:gap-y-13.75 を md 帯域にも適用すること。lg 以上の padding・gap は従来どおりとすること

今のコード: 本文の列（look-content-column）は `sm:px-4 md:px-5.25` だけで、モバイルの左右の余白は 0（画像が画面の端まで密着する）。列の間隔はホームと同じ（タブレット 24px）。

（2026-11-07 改定: 旧は `px-3.25 sm:px-4 md:px-5.25` で、モバイルも 13px（ホームと同値）とした。オーナーが今の画面（モバイル 0）を正にした。ホームの LOOK 区画のモバイルの左右 padding は 13px のまま。）

### FREQ-142-REQ-01 カードの外側に枠線を付け、画像は枠に付け、情報パネルだけ内側に余白を取る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-142 |
| 根拠 | 画像は枠いっぱいに見せ、文字だけを枠から離すと、写真を主役にしたまま読みやすくできるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

LookCard のルート要素に枠線（border border-black/10・lg:border-0）を付与し、画像は枠線に密着（水平余白 0）のまま、情報パネル側にのみ枠線との内側余白（px/pb: モバイル 13px・sm 以上 21px・lg 0）を設けること

### FREQ-143-REQ-01 シーズンの文字の色を黒 50% より濃くする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143 |
| 根拠 | 薄い灰色では目に入らないため、色を濃くして存在感を出す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet のシーズンラベルの文字色を、従来の黒 50%（text-black/50）より濃くすること

### FREQ-143-REQ-02 シーズンの文字を 400 より太くする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143 |
| 根拠 | 小さい文字でも読めるよう、太さで存在感を出す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet のシーズンラベルの font-weight を通常（400）より太くすること

### FREQ-143-REQ-03 シーズンの字間を 0.1em より広くする（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143 |
| 根拠 | 字間を広げて存在感を出す案だったが、広すぎて読みにくく、FREQ-145 で取り消した |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet のシーズンラベルの字間（letter-spacing）を従来の tracking-widest（0.1em）より広げること

### FREQ-143-REQ-04 シーズンの表記に番号を足さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143 |
| 根拠 | 見本にある「/01」などの番号は LOOK の情報として持っておらず、足すと意味の無い飾りになるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

シーズン表記に番号（/01 等）を追加しないこと

### FREQ-144-REQ-01 関連 ITEM の名前を ITEM カードと同じ書体・字間・太さ・色にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144 |
| 根拠 | ITEM カードの名前の見た目の値をそのまま使えば、2つのカードの同じ商品が同じに見えるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

関連 ITEM の商品名を ITEM カードの商品名と同じ書体（font-brand）・字間（tracking-tight）・太さ（400）・文字色（黒）にすること

### FREQ-144-REQ-02 価格を ITEM カードと同じ色・太さにし、「¥」とカンマ区切りで出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144 |
| 根拠 | 価格の書き方が ITEM カードと違うと別の値段に見えるため、色・太さ・通貨の書き方をそろえる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

関連 ITEM の価格を ITEM カードの価格と同じ文字色（黒）・太さ（400）で表示し、通貨表記も同じ「¥{カンマ区切り金額}」形式にすること

### FREQ-145-REQ-01 シーズンの字間を 0.1em より狭くする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-145 |
| 根拠 | FREQ-143-REQ-03 で広げた字間を取り消し、詰め気味にして読みやすくする |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-145 の行 |

シーズンタイトルの letter-spacing を、従来の tracking-widest（0.1em）より狭くすること

### FREQ-150-REQ-01 オーバーレイの関連 ITEM の行を role="link" にし、押すか Enter で /item/{id} へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150 |
| 根拠 | カード全体が LOOK の詳細へのリンク（a）なので、中に a を入れ子にできない。リンクの役を持たせた行から ITEM へ移し、カードのリンクへの伝わりを止める |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

オーバーレイの関連 ITEM 行をクリック可能要素（role="link"）とし、クリックまたは Enter キーで `/item/{id}` へ遷移すること（カード全体の /look リンクへのイベント伝播・既定遷移は止める）

今のコード（推定）: Enter のほかのキー（Space）では移らない。

### FREQ-150-REQ-02 関連 ITEM の行に乗ると白い下線が左から右へ出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150 |
| 根拠 | ヘッダーのメニューと同じ下線の動きを使えば、押せる物だとすぐ分かるため。画像の上なので白にする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

関連 ITEM 行のホバー時に、ヘッダーメニュー共通の underline-animation-left2right（transform-origin: left の scale-x 0→1 アニメーション）で白色の下線を表示し、非ホバー時は非表示（scale-x 0）とすること

### FREQ-151-REQ-01 情報パネルの関連 ITEM のリンクに乗ると黒い下線が左から右へ出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-151 |
| 根拠 | FREQ-150 と同じ下線の動きを、白い背景の上なので黒で出すため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

情報パネルの関連 ITEM リンク（look-related-item-text）のホバー時に、ヘッダーメニュー共通の underline-animation-left2right（transform-origin: left の scale-x 0→1 アニメーション・黒色）で下線を表示し、非ホバー時は非表示（scale-x 0）とすること

### FREQ-176-REQ-01 外枠の線を border-black/10 の 1px にし、1px の隙間を外す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-176 |
| 根拠 | 並びの区切り線と同じ色と太さにし、線を太く見せていた隙間も外して、全部の線を1つの見た目にするため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-176 の行 |

リストの外枠線を `border-black/20` から `border-black/10`（rgb(0 0 0 / 0.1)・1px）へ変更し、List showcase variant のアイテム間ボーダー（1px solid rgb(0 0 0 / 0.1)）と統一すること。あわせて外枠線を視覚的に太く見せていた `space-y-px` の 1px 隙間を撤去すること（反復）

### FREQ-177-REQ-01 List の見本の大きさに倍率の変数を入れ、LOOK 詳細で √φ 倍にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-177 |
| 根拠 | 共有の List の部品の既定の大きさは変えず、LOOK 詳細だけを黄金比の1段だけ大きくするため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-177 の行 |

List showcase variant のプレビューサイズ計算に倍率変数 `--list-preview-scale`（既定 1）を導入し、LOOK詳細ページの関連アイテムリストに `--list-preview-scale: var(--sqrt-phi)` を指定して、黄金比スケール1段階（×√φ ≈ 1.27倍）拡大すること（unit × φ³ → unit × φ³ × √φ）

### FREQ-178-REQ-01 通常の表示の上の「Back to Lookbook」のリンクを消し、無い LOOK の表示のリンクは残す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-178 |
| 根拠 | 通常の表示の戻り道は下のナビに任せ、無い LOOK の頁にだけ戻り道を残すと決めた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-178 の行 |

LOOK詳細ページ通常表示の上部にある `/look` への「Back to Lookbook」リンクとその外側ブロックを削除すること。Look not found 表示の「Back to Lookbook」リンクは変更しないこと

今のコード（推定）: 通常の表示にリンクは無い。無い LOOK の表示は見出し「Look not found」と、`/look` への「Back to Lookbook」のリンク（2026-11-07 に戻した）。

### FREQ-179-REQ-01 モバイルは端まで広げたスワイプのカルーセルにし、サムネイルを出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179 |
| 根拠 | 狭い画面ではサムネイルより指で送る方が速く、画像を端まで広げると写真を大きく見せられるため。負の margin の値（-mx-5）は FREQ-344 で -mx-4 に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

mobile（md未満）は main の px-5 を負マージンで相殺したフルブリードのスワイプカルーセル（snap-x・ピーク表示・スライド幅 calc(100vw-2.5rem)・gap 0.5）とし、サムネイルを表示しないこと

### FREQ-179-REQ-02 タブレットはスワイプのカルーセルに前送り・次送りのボタンを付ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179 |
| 根拠 | タブレットは指でもマウスでも使うので、送りのボタンも置くため。ボタンの位置（左下・右下）は FREQ-288 で画像の枠の縦の中央に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

tablet（md〜lg未満）はスワイプカルーセル（snap-x）とし、前の画像があるとき左下（left-5）に前送りボタン、次の画像があるとき右下（right-2）に次送りボタンを表示すること

### FREQ-179-REQ-03 PC は左にサムネイルの縦の列、右にメインの画像を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179 |
| 根拠 | PC は画面が広いので、全部の画像を一度に見せて選べるようにするため。メインの画像の高さの上限は FREQ-180・288・289 で替わり、今は min(48rem, 100svh-7rem) |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

desktop（lg以上）は左にサムネイル縦列（幅 w-16・aspect 2/3・選択中は ring-1 黒・非選択は opacity-50）、右にメイン画像（aspect 2/3・h min(48rem, 100svh-5rem)・object-contain）を表示すること

### FREQ-180-REQ-01 メインの画像の枠を幅基準にし、列の中に収める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-180 |
| 根拠 | 高さ基準の枠は画面の幅によって列からはみ出したため、幅を列に合わせる形にした。その後 FREQ-288 で高さ基準（2:3）と ITEM と同じ2列の格子に戻った |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-180 の行 |

メイン画像枠を高さ基準（h = min(48rem, 100svh-5rem)・幅は aspect から算出）から幅基準に変更し、幅は列内に収める（w-full + min-w-0）・高さは aspect 2/3 から従属・max-w は従来の高さ上限相当 calc(min(48rem,100svh-5rem)×2/3) とすること。グリッドの左右列比（lg:grid-cols-2）は変更しないこと

### FREQ-181-REQ-01 3等分の格子に前・一覧・次のリンクを置き、前後が無い時は薄い非リンクにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-181 |
| 根拠 | 3列を同じ幅にすると、前後が無い時も一覧の入口が真ん中から動かないため。アイコンのフォント・色・字間は FREQ-182・183 で、モバイルの形は FREQ-343 で替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-181 の行 |

3等分グリッド（grid-cols-3・divide-x 黒10%）で、左=前の LOOK へのリンク（PREV LOOK + 左矢印）、中央=/look へのリンク（LOOK LIST + グリッドアイコン ri-function-line）、右=次の LOOK へのリンク（NEXT LOOK + 右矢印）を配置する。ラベルは --lk-size-2xs・tracking-widest・#474747、hover で黒。前/次が無い場合は同レイアウトのまま opacity-30 の非リンク表示とし、テーマ名は表示しないこと

### FREQ-182-REQ-01 3つのアイコンを線幅1のインラインの SVG にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-182 |
| 根拠 | SVG はフォントのようににじまず、線幅を細くできるため。アイコンの大きさ（--lk-size-6xl）は FREQ-183 で --lk-size-7xl に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-182 の行 |

3アイコンを Remix Icon のアイコンフォント（`ri-arrow-left-line` / `ri-function-line` / `ri-arrow-right-line`）から、`viewBox="0 0 24 24"`・`fill=none`・`stroke=currentColor`・`stroke-width=1` のインライン SVG へ置換すること。フォントラスタライズを経由しないためエッジがにじまず、線幅を 24 グリッド上の 1（アイコンフォントの約半分）に細くできる。アイコンの表示サイズは従来と同じ `var(--lk-size-6xl)`（`width`/`height` を `1em` とし `font-size` で指定）を維持し、色・hover 挙動・レイアウトは変更しないこと

### FREQ-183-REQ-01 ラベルとアイコンを黒にし、乗った時に #474747 にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183 |
| 根拠 | 既定を黒にして存在感を出し、乗った時だけ灰色にして反応を返すため。前後が無い時も黒のまま薄くする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

ラベルとアイコンの既定色を Graphite Grey `#474747` から Absolute Black `#000000` へ変更し、hover 時は `#474747` へ変化させること（hover フィードバックを維持）。前/次が無い場合の非リンク表示も既定色を黒とし、opacity-30 による減光は維持すること

### FREQ-183-REQ-02 アイコンを --lk-size-7xl に大きくする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183 |
| 根拠 | 参考のデザインに合わせてアイコンを1段大きくするため。線幅などの描き方（FREQ-182）は変えない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

アイコンの表示サイズを `var(--lk-size-6xl)` から LiftKit スケールで1段上の `var(--lk-size-7xl)` へ拡大すること。線幅・viewBox・ストローク描画（FREQ-182）は変更しないこと

### FREQ-183-REQ-03 3列のラベルの字間を tracking-wider にそろえる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183 |
| 根拠 | 列やリンクの有無で字間がばらばらだったため、1つの値にそろえる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

3カラムのラベル字間を `tracking-wider`（0.05em）に統一すること（従来は前カラムのリンク時が字間指定なし、非リンク時が `tracking-widest` と不揃いだった）

### FREQ-277-REQ-01 列数を md 未満2・md〜2xl 未満3・2xl 以上4にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277 |
| 根拠 | ITEM の格子と同じ区切りの幅と列数にするため。一覧は lg でサイドバーが出てカードが狭くなるので、列を増やすのは 2xl だけにする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

LOOK グリッドの列数を 2 列（md 未満）/ 3 列（md〜2xl 未満）/ 4 列（2xl 以上）とし、ITEM グリッドと同じ帯域で切り替わること（※ FREQ-137 の gap、FREQ-140 の row-gap、FREQ-141 の左右余白は据え置き。列数のみ揃える）

### FREQ-277-REQ-02 どの幅でもカードの幅を極端に小さくしない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277 |
| 根拠 | 列を増やし過ぎて写真が小さくなると、LOOK を見せる意味が薄れるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

LOOK カードの幅がどのビューポート（390px〜1920px）でも極端に小さくならないこと

### FREQ-277-REQ-03 ホームの LOOK の数を 2xl 未満6件・2xl 以上8件にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277 |
| 根拠 | 列数（3列・4列）のちょうど2行分にして、最後の行が欠けないようにするため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

ホームの LOOK 表示数を列数に合わせ、2xl 未満 6 件 / 2xl 以上 8 件とすること

今のコード（推定）: ホームは8件を描き、2xl 未満は7件目からを隠す。

### FREQ-279-REQ-01 画像と文字を別々に見張り、画面に入ったら data-reveal を立て、外さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279 |
| 根拠 | カード全体ではなく要素ごとに見張れば、画面に入った物から順に出せるため。1度出した物を戻すと、スクロールのたびに動いて落ち着かない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

画像と文字をそれぞれ別に監視し、その要素自身がビューポートに入ったら（画像は読み込み完了後に）data-reveal="true" を立てること。一度立てたら解除しないこと

### FREQ-279-REQ-02 画像は白いカバーが右へ退いて左から右へ現れる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279 |
| 根拠 | 参考のサイトと同じ動きと時間・イージングにそろえるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

画像は白いカバーが右へ退くことで左から右へ現れること（duration 500ms / delay 500ms / cubic-bezier(0.08,0.5,0,1)）

### FREQ-279-REQ-03 文字はマスクの下からせり上がる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279 |
| 根拠 | 参考のサイトと同じく文字を下から出す決まりだったが、LOOK カードの文字は FREQ-338 で左から右へ横に出す形に替わった（ITEM カードは今も下から） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

文字はマスクの下から迫り上がること（translateY(105%) → 0、duration 500ms / delay 1000ms / 同イージング）

### FREQ-279-REQ-04 ホーム・/item・/look の全部に付ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279 |
| 根拠 | 同じカードを出す画面で動きが違うと、画面ごとにばらばらに見えるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

ホーム（/）と一覧ページ（/item, /look）の両方に適用すること

### FREQ-279-REQ-05 カードの上端だけが画面に入った時は、まだ外の文字を動かさない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279 |
| 根拠 | 画面の外で動きが終わると、利用者が文字の現れる所を見られないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

カード上端だけが画面に入った状態では、まだ画面外にある文字のモーションを開始しないこと

### FREQ-288-REQ-01 画像が複数の時、全部の幅で画像の下に枚数分の線のインジケータを出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288 |
| 根拠 | 何枚あって今どれを見ているかを、ITEM 詳細と同じ部品（CarouselSegmentIndicator）で示すため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

画像が複数あるとき、全ビューポートで画像下に枚数分のセグメント線インジケータを表示し、現在位置のみ黒くすること（ITEM と同じ CarouselSegmentIndicator を使う）

### FREQ-288-REQ-02 タブレットの送りのボタンを画像の枠の縦の中央に置き、大きさを枠の幅の 4.5% にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288 |
| 根拠 | ITEM 詳細と同じ部品（CarouselArrowButton）と式にして、2つの詳細の触り心地をそろえるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

タブレットの前後送りシェブロンを画像枠の縦方向中央に配置し、サイズを画像枠幅の 4.5%（clamp(1rem,4.5cqw,1.625rem)）で決めること（ITEM と同じ CarouselArrowButton）

### FREQ-288-REQ-03 PC のメインの画像の枠を高さ基準の 2:3 にし、md 以上を ITEM と同じ2列の格子にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288 |
| 根拠 | ITEM 詳細と同じ枠と列にすれば、画像の大きさと情報の列の幅が2つの詳細でそろうため。高さの上限の 100svh-5rem は FREQ-289 で 100svh-7rem に替わった |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

PC のメイン画像枠を高さ基準 min(48rem, 100svh-5rem) の 2:3 とし、md 以上のレイアウトを ITEM と同じ2列グリッド（情報列は minmax(18.125rem, 画像幅)）にすること

### FREQ-289-REQ-01 ITEM 詳細・LOOK 詳細の PC のメインの画像の枠の高さの上限を min(48rem, 100svh-7rem) にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-289 |
| 根拠 | 画像の枠を少し低くすれば、インジケータの下に md の帯と同じ余白が残るため |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-289 の行 |

ITEM 詳細・LOOK 詳細の lg 以上のメイン画像枠の高さ上限を min(48rem, calc(100svh-5rem)) から min(48rem, calc(100svh-7rem)) に変更し、md 帯と同じ余白量に揃えること（情報列の最大幅も同じ式に追従させる）

### FREQ-337-REQ-01 sm 未満で関連アイテムの間の余白を商品の中の余白の φ 倍以上にし、sm 以上は変えない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-337 |
| 根拠 | 商品の間の余白を商品の中より φ 倍以上広くすれば、名前と価格が1つのまとまりに見えるため。横に並ぶ sm 以上は今のままで読める |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-337 の行 |

sm 未満で商品名と価格を縦積みするとき、アイテム間の見た目の余白（矩形の隙間＋行送り）を同一アイテム内の「商品名↔価格」の余白の φ 倍以上にすること。sm 以上（商品名と価格が横並び 1 行）のアイテム間 gap は FR-LOOK-ALL-007 の φ 比率のまま変えないこと

### FREQ-338-REQ-01 情報パネルの文字をマスクの左の外から横に滑り込ませ、ITEM カードは下からのままにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-338 |
| 根拠 | 向きだけを替え、遅れ・時間・イージングは今のリビールと同じにすれば、画像と文字が同じ流れで出るため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-338 の行 |

LOOK カードの情報パネル（.reveal-rise）を .reveal-rise-x で横方向に切り替え、マスクの左外（translateX(-105%)）から定位置へ滑り込ませること。ディレイ・時間・イージングは既存のリビール（1.0s 遅延 / 0.5s / cubic-bezier(0.08,0.5,0,1)）と同値のままとし、ITEM カードの文字は従来どおり下から迫り上がること

### FREQ-339-REQ-01 情報パネルの余白をマスクではなく動く側（.reveal-rise）に持たせる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-339 |
| 根拠 | マスクは padding の内側までしか隠さないので、余白を動く側に移せば退いた文字が全部隠れるため。枠線からの距離（FREQ-142）は変えない |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-339 の行 |

情報パネルの水平・下余白（13px / sm 21px、lg は 0）をマスク（.reveal-mask）ではなく退避する側（.reveal-rise）に持たせること。マスクのクリップ範囲は padding box のため、マスク側に余白があると translateX(-105%) でも余白分だけ内側に残ってしまう。余白の見た目（枠線からの距離）は FREQ-142 のまま変えないこと

### FREQ-343-REQ-01 md 未満は3列のナビを隠し、3項目の BottomNavigation を画面の下に固定する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343 |
| 根拠 | ITEM 詳細のモバイルと同じ共有の部品で固定すれば、2つの詳細で同じ操作になるため。md 以上は今の見た目を変えない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

md 未満（768px 未満）では既存のインライン3カラムナビ（data-testid="look-detail-bottom-nav"）を非表示にし、代わりに `BottomNavigation`（fixed / appearance=filled / 3項目）を画面下端に固定表示すること。項目は左から PREV LOOK・LOOK LIST・NEXT LOOK とし、遷移先があるものはリンク（LOOK LIST は /look）、前後の LOOK が無い項目は操作できない非活性表示とすること。md 以上はインラインナビのみとし従来の見た目を変更しないこと

### FREQ-343-REQ-02 固定のナビがフッターの著作権・法務のリンクを覆わないよう、フッターに下の余白を足す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343 |
| 根拠 | 固定のナビの下にフッターの最後の行が隠れると、法務のリンクを押せなくなるため。固定のナビを出す頁でだけ足す |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

固定ナビはフッター末尾の著作権表示・法務リンクを覆わないこと。固定ナビを出しているページでのみフッターに固定ナビの高さぶんの下余白を足して押し上げること

### FREQ-343-REQ-03 固定のナビのラベルを --lk-size-7xs にする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343 |
| 根拠 | BottomNavigation の既定の大きさでは小さく読みにくいため、LiftKit の段で2つ大きくする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

固定ナビのラベル文字サイズは BottomNavigation 既定（`font / φ`）より LiftKit スケールで 2 段階（`--lk-eighthstep` 2 つ分）大きい `--lk-size-7xs` とすること

### FREQ-344-REQ-01 カルーセルの負の margin を main の余白と同じ -mx-4 にし、頁の横幅を画面に収める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-344 |
| 根拠 | 負の margin を main の余白と同じ値にすれば、端まで広げても画面からはみ出さないため。md 以上の画像の列の左へのはみ出し（FREQ-181 の系統）は意図した形なので変えない。今のコードは値が `-mx-4` でなく、main の余白に合わせた割合になっている（下の「今のコード」） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-344 の行 |

モバイルの画像カルーセルをフルブリード化する負マージンを `-mx-5`（20px）から `main` の左右パディングと同じ `-mx-4`（16px）に揃え、ページ全体の `scrollWidth` が `clientWidth` を超えないようにすること。md 以上の画像列が左側へ意図的にはみ出す挙動（FREQ-181 系）は変更しないこと

今のコード（推定）: 詳細の頁の main は `px-4` でなく `detail-page-main` の印を持ち、左右の余白は幅の 6.25%（768〜1023px だけは 20px。FREQ-288-AC-04）（`src/styles/detail-layout.css`、`src/contexts/Providers.tsx`）。md 未満のカルーセル（`detail-mobile-gallery`）の負の margin は `calc(-100% / 14)` で、中身の幅 87.5% に対する 6.25% と同じ（`detail-layout.css`、`src/features/look/components/LookImageGallery.tsx`）。16px の固定の値ではないが、負の margin を main の余白と同じにする考えは同じ

### LOOK 一覧・詳細・管理の要件

文は `requirements.md` の 1.6・1.7・1.16 のまま（「レビュー:」の注は写していない）。

### FR-LOOK-ALL-001 公開済みの LOOK をカードの格子で並べる

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | 公開した LOOK だけを一目で見比べられるようにするため（SR-LOOK-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-001 の項目 |

公開済みルックをカードグリッドで一覧表示する。

今のコード（推定）: 公開（published）の LOOK を作った日時の新しい順に全件取り（DRV-LOOK-001）、md 未満2列・md〜2xl 未満3列・2xl 以上4列の格子に並べる（FREQ-277）。

### FR-LOOK-ALL-002 カードにシーズン・テーマ・画像・関連商品名を出し、押すと詳細へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | 一覧で LOOK の時期と中身、使った商品の見当をつけてから詳細へ進めるようにするため（SR-LOOK-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-002 の項目 |

ルックカードはシーズンラベル・テーマタイトル・メインビジュアル・紐づけ商品名を表示し、クリックでルック詳細ページへ遷移できる。

今のコード（推定）: シーズンの表記は lg 未満が「2026 AW」、lg 以上は画像に重ねた「2026AW」（FREQ-127・138）。lg 以上の関連商品名はカードに乗った時だけ画像の上に出す（FREQ-131・133）。

### FR-LOOK-ALL-003 公開の LOOK を全部カタログで出し、ページングか無限スクロールで6件以上を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | LOOK が増えても全部にたどり着けるようにしつつ、一度に読み込む量を抑えるため（SR-LOOK-001）。今は全件を一度に出し、ページングも無限スクロールも無い（requirements.md のレビューの注も「未実装」） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | COULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-003 の項目 |

`/look` ページは全公開ルックをカタログ表示し、少なくともページングまたは無限スクロールで6件以上を表示する。

今のコード（推定）: 公開の LOOK を全件取り、全部の画像に署名して一度に出す。件数の上限は無い。

### FR-LOOK-ALL-004 ホームの LOOK の区画を一覧の部品の home の形で出し、一覧へ誘う

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | ホームで LOOK を少しだけ見せて一覧へ誘い、トップを長くし過ぎないため（SR-LOOK-001）。文の「最大6件」「VIEW LOOKBOOK ボタン」は FREQ-148・FREQ-126・FREQ-146（どれも範囲外）と FREQ-277 で中身が置き換わり、今の形と合わない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-004 の項目 |

HOME の LOOK セクション表示時は `PublicLookGrid variant="home"` を使用し、最大6件まで表示しつつ「VIEW LOOKBOOK」ボタンで詳細一覧に誘導する。

今のコード（推定）: ホームは公開の LOOK を8件描き、2xl 未満は6件・2xl 以上は8件を出す。一覧への入口は区画の下の VIEW ALL（読み上げの名前は VIEW ALL LOOKS）で、公開の総数がその幅の表示数より多い時だけ出す。

### FR-LOOK-ALL-005 一覧の title と description を決めて出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | 検索の結果や共有の時に、LOOK の一覧だと分かる題と説明を出すため（SR-LOOK-001。SEO の方針は NFR-SEO-003） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-005 の項目 |

LOOK一覧ページに `generateMetadata` を実装し、`title` / `description` などの SEO メタ情報を設定する。

今のコード（推定）: title は「LOOK BOOK | Le Fil des Heures」、OG の画像はサイトのメインの写真（`/mainphoto.png`）。

### FR-LOOK-ALL-006 シーズン（ALL・SS・AW）で絞り、PC は左のサイドバー、タブレット・モバイルは FILTER と引き出しに置く

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-001 |
| 根拠 | 春夏と秋冬で LOOK を分けて見たい人が絞れるようにし、置き場を NEWS・ITEM の一覧とそろえるため（SR-LOOK-001、FREQ-51） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.6 ルック一覧ページ（LOOK）」節の FR-LOOK-ALL-006 の項目 |

LOOK 一覧ページでシーズン（ALL / SS / AW）をフィルタでき、desktop では左サイドバー、tablet/mobile では FILTER ボタンと Drawer を表示する。

今のコード（推定）: 選べるのは1つだけで、URL の season に残す（DRV-LOOK-002）。年は見ず、SS か AW かだけで絞る。requirements.md のレビューの注が挙げる `PublicLookCatalogGrid.tsx`・`src/lib/look/look-view.ts` は無い。

### FR-LOOK-DETAIL-001 公開済みの LOOK の詳細にテーマ・シーズン・画像・説明文を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 着こなしの狙いを画像と言葉の両方で伝えるため（SR-LOOK-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-001 の項目 |

公開済みルックの詳細ページを表示し、テーマ・シーズンラベル・メインビジュアル・説明文を含める。

今のコード（推定）: シーズンは「2026 AW」、テーマは h1。説明文が空の時も空白1文字の段落を出す（UI/UX レビュー LD-2 の「節ごと隠す」と違う）。

### FR-LOOK-DETAIL-002 詳細に紐づけた商品（STYLING ITEMS）を並べ、各商品へのリンクを出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 着こなしで使った商品を、その場で商品の頁へつなぐため（SR-LOOK-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-002 の項目 |

ルック詳細ページには紐づけ商品（STYLING ITEMS）を一覧表示し、各商品への遷移リンクを提供する。

今のコード（推定）: 名前・分類・価格・画像を List（showcase）で並べ、公開中の商品だけを出す（DRV-LOOK-004）。0件の時は「紐づけ商品はありません」。E2E FR-LOOK-DETAIL-002 は 2026-10-24 の全件の E2E で1件赤（原因は未確認）。

### FR-LOOK-DETAIL-003 前後の LOOK へのリンクを出し、続けて見られるようにする

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 1件を見終えた人が一覧へ戻らずに次の LOOK を見られるようにするため（SR-LOOK-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-003 の項目 |

前後のルックへのナビゲーションリンクを表示し、連続して閲覧できるようにする。

今のコード（推定）: 前後は一覧と同じ並び（作った日時の新しい順）で決め、そのために公開の LOOK を全件取る。形は FREQ-181〜183（md 以上の3列）と FREQ-343（md 未満の固定のナビ）が決める。端では無い側を操作できない表示にする。

### FR-LOOK-DETAIL-004 無い LOOK の ID では知らせの文と /look への戻りのリンクを出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 消えた LOOK や打ち間違いの URL で来た人が行き止まりにならないようにするため（SR-LOOK-002）。FREQ-178 も戻りのリンクを残すと決めた。2026-11-07 にコードへ戻した（見出しの下に `/look` への「Back to Lookbook」） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-004 の項目 |

存在しないルック ID の場合はエラーメッセージと `/look` への戻るリンクを表示する。

今のコード（推定）: 公開でない・無い・数でない ID は全部、見出し「Look not found」だけを出す。戻りのリンクは無い。HTTP の状態は 200（DRV-LOOK-006）。E2E FR-LOOK-DETAIL-004 は 2026-10-24 の全件の E2E で赤。

### FR-LOOK-DETAIL-005 複数の画像をサムネイル付きのギャラリーかカルーセルで出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 1つの着こなしを複数の角度や寄りで見せるため（SR-LOOK-002） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-005 の項目 |

`currentLook.imageUrls` の複数画像をサムネイル付きギャラリーまたはカルーセルで表示する。

今のコード（推定）: 形は FREQ-179・288 で ITEM 詳細と同じにした。サムネイルは PC だけ（FREQ-179 が確かめを PC に限った）。requirements.md のレビューの注「1枚しか表示されない」は古い。

### FR-LOOK-DETAIL-006 詳細の title・description を出し、前後のリンクに aria-label を付ける

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 検索・共有で LOOK の名前が分かるようにし、読み上げで前後のリンクの行き先が分かるようにするため（SR-LOOK-002）。文の「Back to Lookbook のリンクを足す」は FREQ-178 が通常の表示から外すと決めて置き換えた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-006 の項目 |

`generateMetadata` を実装し、ページタイトルと description を設定する。また `Back to Lookbook` リンクと適切な `aria-label` を追加する。

今のコード（推定）: title は「<テーマ> | LOOK | Le Fil des Heures」、description は説明文（空ならテーマから作った文）、OG の画像は、署名できる画像が 1 枚以上ある LOOK だけ同一オリジンの `/look/<id>/og`（SEC-LOOK-006、ADR-0165。2026-10-28 から。以前は 1 枚目の署名つき URL）。前後のリンクの aria-label は「Previous look: <テーマ>」「Next look: <テーマ>」。requirements.md のレビューの注「generateMetadata なし」は古い。

### FR-LOOK-DETAIL-007 同じシーズン・関連のコーディネートを薦める節を足す（将来対応）

| 属性 | 値 |
| --- | --- |
| 上位 | SR-LOOK-002 |
| 根拠 | 次に見る LOOK を薦めて回遊を増やす案だが、今の段階では作らないと決めた（優先度 WONT、「将来対応」） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | WONT |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.7 ルック詳細ページ（LOOK DETAIL）」節の FR-LOOK-DETAIL-007 の項目 |

同シーズンや関連コーディネートの推薦セクションを追加する（将来対応）。

今のコード（推定）: 実装は無い。E2E は skip の1件だけ。

### FR-ADMIN-005 LOOK タブで LOOK の一覧・作成・編集・削除・商品の紐づけをする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-17 |
| 根拠 | 店長が管理画面の LOOK タブで LOOK の出し入れと使った商品のつなぎを済ませられるようにするため（FREQ-17 を管理画面の形に落とした）。元の文書に上位の記載は無く、FREQ-17 につないだのは中身が同じだから（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「コンテンツ管理」節の FR-ADMIN-005 の項目 |

LOOK タブでルックの一覧・作成・編集・削除・商品紐づけを管理する。

今のコード（推定）: 一覧（`src/components/LookSection.tsx`）は画像・公開の状態・シーズン・テーマと、公開・非公開の切り替え・編集・削除のボタンを出す（DRV-LOOK-008・011・012）。作成と編集は別の頁（`/admin/look/create`・`/admin/look/edit/[id]`）で、入力のフォーム（`LookForm.tsx`）は範囲外。紐づける商品は1つ以上が要る（DRV-LOOK-009）。LOOK タブは店長の役の時だけ出し（範囲外の `src/app/admin/page.tsx`）、「新規作成」は窓口の `meta.canManage`（権限）で `LookSection` が出し（0 件でも出す。2026-10-28、波 4）、窓口は権限（admin.looks.read・admin.looks.manage）で許す。`16_admin.md` の「編集モーダル」は今は別の頁。

## 受け入れ条件

### 要求の表から写した受け入れ条件

### FREQ-11-AC-01 コーディネートを見る時にエラーが出ず関連コーディネートが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-11-REQ-01 |
| 根拠 | FREQ-11-REQ-01 を、エラー無しで関連コーディネートが出ることで確かめる。何を「関連」とし、どの画面で見るかは書かれていない（未確認事項） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-11 の行 |

コーディネート確認でエラーが発生せず、関連コーディネートが表示されること

### FREQ-12-AC-01 ほかの利用者のコーディネートを見る時にエラーが出ず関連コーディネートが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-12-REQ-01 |
| 根拠 | FREQ-12-REQ-01 を、エラー無しでほかの利用者のコーディネートが出ることで確かめる。実装が無いので今は満たさない（推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-12 の行 |

他ユーザーのコーディネート確認でエラーが発生せず、関連コーディネートが表示されること

### FREQ-17-AC-01 LOOK の管理でエラーが出ず登録・編集・削除が終わる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-17-REQ-01 |
| 根拠 | FREQ-17-REQ-01 を、登録・編集・削除が最後まで終わることで確かめる。何を見て終わったとするかは書かれていない。具体の形は FR-ADMIN-005-AC-01〜05 に起こした |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求と要件のトレーサビリティ」節の FREQ-17 の行 |

Look管理でエラーが発生せず、登録・編集・削除が完了すること

### FREQ-50-AC-01 一覧に「LOOK BOOK」の見出しが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-50-REQ-01 |
| 根拠 | FREQ-50-REQ-01 の結果を、「一覧に「LOOK BOOK」の見出しが無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-50 の行 |

LOOK 一覧ページに「LOOK BOOK」という見出しテキストが表示されないこと

### FREQ-51-AC-01 PC で SEASON のフィルターが左のサイドバーにあり、横並びのタブが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-51-REQ-01 |
| 根拠 | FREQ-51-REQ-01 の結果を、「PC で SEASON のフィルターが左のサイドバーにあり、横並びのタブが無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-51 の行 |

デスクトップで LOOK 一覧の SEASON フィルターが左サイドバーに表示され、横並びタブが表示されないこと

### FREQ-51-AC-02 モバイル・タブレットで FILTER を押すと引き出しが開き、SEASON を替えられる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-51-REQ-01 |
| 根拠 | FREQ-51-REQ-01 の結果を、「モバイル・タブレットで FILTER を押すと引き出しが開き、SEASON を替えられる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-51 の行 |

モバイル・タブレットで FILTER ボタンを押すと drawer が開き、SEASON を切り替えられること

### FREQ-52-AC-01 PC で選択肢の並びの gap が NEWS と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-52-REQ-01 |
| 根拠 | FREQ-52-REQ-01 の結果を、「PC で選択肢の並びの gap が NEWS と一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-52 の行 |

デスクトップで LOOK 一覧の SEASON フィルター選択肢リストの gap が、NEWS 一覧フィルターの選択肢リストの gap と一致すること

### FREQ-53-AC-01 関連商品のリンクの上下の padding が 1px 以下になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-53-REQ-01 |
| 根拠 | FREQ-53-REQ-01 の結果を、「関連商品のリンクの上下の padding が 1px 以下になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-53 の行 |

LOOK カードの各関連商品リンクの上下 padding が 1px 以下であること

### FREQ-53-AC-02 関連商品どうしの縦の間隔が文字の大きさ÷φ に一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-53-REQ-01 |
| 根拠 | FREQ-53-REQ-01 の結果を、「関連商品どうしの縦の間隔が文字の大きさ÷φ に一致する」ことで画面の外から確かめる。sm 未満は FREQ-337 で商品の間を広げたので、今この値に当たるのは sm 以上だけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-53 の行 |

関連商品リンク同士の見た目の縦間隔が、各行のフォントサイズ ÷ φ（≒0.618em）に一致すること

### FREQ-54-AC-01 時期と名前の間隔が名前と最初の関連アイテムの間隔より狭い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-54-REQ-01 |
| 根拠 | FREQ-54-REQ-01 の結果を、「時期と名前の間隔が名前と最初の関連アイテムの間隔より狭い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-54 の行 |

LOOK カードでコレクション時期と名前の縦間隔が、名前と最初の関連アイテムの縦間隔より狭いこと

### FREQ-55-AC-01 mobile・tablet の幅で一覧の row-gap が column-gap より大きい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-55-REQ-01 |
| 根拠 | FREQ-55-REQ-01 の結果を、「mobile・tablet の幅で一覧の row-gap が column-gap より大きい」ことで画面の外から確かめる。1280px は FREQ-137・140 で縦横とも 24px になり、この条件と合わない。今当たるのは lg 未満だけなので、この AC の対象は mobile・tablet の2つの幅だけ（desktop は FREQ-140-AC-04 が縦横同値を決める） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-55 の行 |

mobile（390px）/ tablet（768px）で LOOK 一覧グリッドの row-gap が column-gap より大きいこと。desktop（lg 以上）は FREQ-140-AC-04 により縦横同値で、この AC の対象外

### FREQ-55-AC-02 モバイルで一覧の row-gap が 16px より大きい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-55-REQ-01 |
| 根拠 | FREQ-55-REQ-01 の結果を、「モバイルで一覧の row-gap が 16px より大きい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-55 の行 |

モバイルで LOOK 一覧グリッドの row-gap が従来値（16px）より大きいこと

### FREQ-56-AC-01 モバイルで関連アイテムの名前と価格が縦に積まれる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-56-REQ-01 |
| 根拠 | FREQ-56-REQ-01 の結果を、「モバイルで関連アイテムの名前と価格が縦に積まれる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-56 の行 |

モバイル幅で関連アイテムの商品名と価格が縦方向に積まれている（価格の上端が商品名の下端以上）こと

### FREQ-56-AC-02 タブレット・PC で関連アイテムの名前と価格が同じ行に並ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-56-REQ-01 |
| 根拠 | FREQ-56-REQ-01 の結果を、「タブレット・PC で関連アイテムの名前と価格が同じ行に並ぶ」ことで画面の外から確かめる。PC は FREQ-133 でカードの下に関連アイテムを出さなくなり、今確かめられるのはタブレットだけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（ITEM 一覧 見出し・パンくず・終端表示の廃止）」節の FREQ-56 の行 |

タブレット・PC 幅で関連アイテムの商品名と価格が同一行に並ぶ（縦方向に重なる）こと

### FREQ-127-AC-01 シーズンの表記が「2026AW」の形で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-127-REQ-01 |
| 根拠 | FREQ-127-REQ-01 の結果を、「シーズンの表記が「2026AW」の形で出る」ことで画面の外から確かめる。lg 未満は FREQ-138 で「2026 AW」に替わり、今この形は lg 以上のオーバーレイだけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-127 の行 |

LOOK カードのシーズンラベルが「{4桁年}{SS|AW}」形式（例: 2026AW）で表示されること

### FREQ-127-AC-02 シーズンの表記に「COLLECTION」が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-127-REQ-01 |
| 根拠 | FREQ-127-REQ-01 の結果を、「シーズンの表記に「COLLECTION」が無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-127 の行 |

シーズンラベルに「COLLECTION」の文字が表示されないこと

### FREQ-127-AC-03 シーズンの表記の年とシーズンの間に空白が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-127-REQ-01 |
| 根拠 | FREQ-127-REQ-01 の結果を、「シーズンの表記の年とシーズンの間に空白が無い」ことで画面の外から確かめる。lg 未満は FREQ-138 で空白ありに替わり、今この形は lg 以上のオーバーレイだけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-127 の行 |

シーズンラベルの年とシーズンの間に空白が表示されないこと

### FREQ-128-AC-01 PC で画像の下部にシーズンとテーマが白い文字で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-128-REQ-01 |
| 根拠 | FREQ-128-REQ-01 の結果を、「PC で画像の下部にシーズンとテーマが白い文字で出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

デスクトップ（1280px）で LOOK カード画像内下部にシーズンラベルとテーマ名が白文字（rgb(255,255,255)）で表示されること

### FREQ-128-AC-02 PC で画像の下の文字（look-card-caption）が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-128-REQ-01 |
| 根拠 | FREQ-128-REQ-01 の結果を、「PC で画像の下の文字（look-card-caption）が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

デスクトップ（1280px）で画像下の従来キャプション（look-card-caption）が表示されないこと

### FREQ-128-AC-03 モバイル・タブレットでオーバーレイが出ず、画像の下の文字が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-128-REQ-01 |
| 根拠 | FREQ-128-REQ-01 の結果を、「モバイル・タブレットでオーバーレイが出ず、画像の下の文字が出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

モバイル（390px）・タブレット（768px）ではオーバーレイ（look-card-overlay）が表示されず、画像下のキャプションが表示されること

### FREQ-128-AC-04 オーバーレイの文字が画像の下半分にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-128-REQ-01 |
| 根拠 | FREQ-128-REQ-01 の結果を、「オーバーレイの文字が画像の下半分にある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-128 の行 |

オーバーレイのテキストが画像の下半分（画像下部）に位置すること

### FREQ-129-AC-01 PC でオーバーレイのテーマがセリフ体で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-129-REQ-01 |
| 根拠 | FREQ-129-REQ-01 の結果を、「PC でオーバーレイのテーマがセリフ体で出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-129 の行 |

デスクトップ（1280px）でオーバーレイのテーマ名がセリフ体（font-family に Didot または Georgia を含む）で表示されること

### FREQ-129-AC-02 テーマが大文字で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-129-REQ-01 |
| 根拠 | FREQ-129-REQ-01 の結果を、「テーマが大文字で出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-129 の行 |

テーマ名が大文字（text-transform: uppercase）で表示されること

### FREQ-129-AC-03 オーバーレイの背景に下から上へ透明になる黒の linear-gradient がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-129-REQ-01 |
| 根拠 | FREQ-129-REQ-01 の結果を、「オーバーレイの背景に下から上へ透明になる黒の linear-gradient がある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-129 の行 |

オーバーレイの背景に下から上へ透明になる黒の linear-gradient が設定されていること

### FREQ-130-AC-01 グラデーションの色の段が4つ以上ある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-130-REQ-01 |
| 根拠 | FREQ-130-REQ-01 の結果を、「グラデーションの色の段が4つ以上ある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-130 の行 |

オーバーレイの linear-gradient が4つ以上のカラーストップを持つこと

### FREQ-130-AC-02 グラデーションの上端の色が完全な透明になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-130-REQ-01 |
| 根拠 | FREQ-130-REQ-01 の結果を、「グラデーションの上端の色が完全な透明になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-130 の行 |

グラデーションの上端側の色が完全な透明（alpha 0）であること

### FREQ-131-AC-01 PC で関連アイテムのあるカードに乗ると題のブロックの opacity が 0 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-131-REQ-01 |
| 根拠 | FREQ-131-REQ-01 の結果を、「PC で関連アイテムのあるカードに乗ると題のブロックの opacity が 0 になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-131 の行 |

デスクトップ（1280px）で関連アイテムを持つカードにホバーすると、シーズン・テーマブロックの opacity が 0 になること

### FREQ-131-AC-02 乗った時に関連アイテムのブロックの opacity が 1 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-131-REQ-01 |
| 根拠 | FREQ-131-REQ-01 の結果を、「乗った時に関連アイテムのブロックの opacity が 1 になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-131 の行 |

同ホバー時に関連アイテムブロック（商品名と価格）の opacity が 1 になること

### FREQ-131-AC-03 乗っていない時は題が出て、関連アイテムのブロックの opacity が 0 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-131-REQ-01 |
| 根拠 | FREQ-131-REQ-01 の結果を、「乗っていない時は題が出て、関連アイテムのブロックの opacity が 0 になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-131 の行 |

非ホバー時はシーズン・テーマが表示され（opacity 1）、関連アイテムブロックは opacity 0 であること

### FREQ-132-AC-01 乗っても1枚目の画像が拡大されない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-132-REQ-01 |
| 根拠 | FREQ-132-REQ-01 の結果を、「乗っても1枚目の画像が拡大されない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-132 の行 |

ホバー時に 1 枚目の画像が拡大（scale）されないこと（transform が none のままであること）

### FREQ-132-AC-02 2枚目のあるカードに乗ると2枚目の画像の opacity が 1 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-132-REQ-01 |
| 根拠 | FREQ-132-REQ-01 の結果を、「2枚目のあるカードに乗ると2枚目の画像の opacity が 1 になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-132 の行 |

2 枚目の画像を持つカードでは、ホバー時に 2 枚目の画像（look-card-image-hover）の opacity が 1 になること

### FREQ-132-AC-03 2枚目の無いカードにホバー用の画像が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-132-REQ-01 |
| 根拠 | FREQ-132-REQ-01 の結果を、「2枚目の無いカードにホバー用の画像が無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-132 の行 |

2 枚目の画像を持たないカードには hover 用画像要素が描画されないこと

### FREQ-133-AC-01 PC でカードの下に関連アイテムの並びが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-133-REQ-01 |
| 根拠 | FREQ-133-REQ-01 の結果を、「PC でカードの下に関連アイテムの並びが出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-133 の行 |

デスクトップ（1280px）でカード下の関連アイテムリスト（.look-related-items）が表示されないこと

### FREQ-133-AC-02 モバイル・タブレットで関連アイテムのあるカードの下に並びが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-133-REQ-01 |
| 根拠 | FREQ-133-REQ-01 の結果を、「モバイル・タブレットで関連アイテムのあるカードの下に並びが出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-133 の行 |

モバイル（390px）・タブレット（768px）では関連アイテムを持つカードの下に関連アイテムリストが表示されること

### FREQ-134-AC-01 PC で2つのブロックの下端がほぼ一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-134-REQ-01 |
| 根拠 | FREQ-134-REQ-01 の結果を、「PC で2つのブロックの下端がほぼ一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-134 の行 |

デスクトップ（1280px）でタイトルブロックと関連アイテムブロックの下端（bottom）が概ね一致すること（誤差 5px 以内。文字ラインの厳密な揃えは FREQ-135）

### FREQ-134-AC-02 2つのブロックの左端が一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-134-REQ-01 |
| 根拠 | FREQ-134-REQ-01 の結果を、「2つのブロックの左端が一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-134 の行 |

両ブロックの左端（left）が一致すること（誤差 1px 以内）

### FREQ-135-AC-01 PC でテーマと最後の関連アイテムの文字の下端がそろう

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-135-REQ-01 |
| 根拠 | FREQ-135-REQ-01 の結果を、「PC でテーマと最後の関連アイテムの文字の下端がそろう」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-135 の行 |

デスクトップ（1280px）でテーマ名の文字矩形の下端と、最後の関連アイテム行の文字矩形の下端が揃うこと（フォントの descent 差を考慮し誤差 3px 以内）

### FREQ-136-AC-01 PC で画像の箱の margin-bottom が 0px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-136-REQ-01 |
| 根拠 | FREQ-136-REQ-01 の結果を、「PC で画像の箱の margin-bottom が 0px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-136 の行 |

デスクトップ（1280px）で LOOK カード画像コンテナの margin-bottom が 0px であること

### FREQ-136-AC-02 モバイル 12px・タブレット 16px の margin-bottom になる（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-136-REQ-01 |
| 根拠 | FREQ-139 が「FREQ-136-AC-02 の 12px/16px を置換」と書き、13px・21px（FREQ-139-AC-01）に置き換えた。今のコードもこの値ではない |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-136 の行 |

モバイル（390px）で margin-bottom が 12px（mb-3）、タブレット（768px）で 16px（sm:mb-4）であること

### FREQ-137-AC-01 各幅で HOME と一覧の格子の row-gap と column-gap が等しい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-137-REQ-01 |
| 根拠 | FREQ-137-REQ-01 の結果を、「各幅で HOME と一覧の格子の row-gap と column-gap が等しい」ことで画面の外から確かめる。FREQ-140 が「全ビューポートで同値」を lg 以上だけに縮めたので、390・768px は今は縦が広く、この形と合わない |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-137 の行 |

モバイル（390px）・タブレット（768px）・デスクトップ（1280px）の各ビューポートで、HOME の LOOK セクションと /look 一覧のグリッドの row-gap と column-gap が等しいこと

### FREQ-137-AC-02 PC（1280px）で縦横とも 24px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-137-REQ-01 |
| 根拠 | FREQ-137-REQ-01 の結果を、「PC（1280px）で縦横とも 24px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-137 の行 |

デスクトップ（1280px）では縦横とも 24px（gap-6）であること

### FREQ-138-AC-01 モバイル・タブレットでシーズンが「2026 AW」の形で画像の下に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138-REQ-01 |
| 根拠 | FREQ-138-REQ-01 の結果を、「モバイル・タブレットでシーズンが「2026 AW」の形で画像の下に出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

モバイル（390px）・タブレット（768px）で画像の下にシーズンラベルが「{4桁年} {SS|AW}」形式（空白あり・COLLECTION なし）で表示されること

### FREQ-138-AC-02 モバイル・タブレットでテーマがセリフ体・大文字で画像の下に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138-REQ-01 |
| 根拠 | FREQ-138-REQ-01 の結果を、「モバイル・タブレットでテーマがセリフ体・大文字で画像の下に出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

モバイル・タブレットでテーマ名がセリフ体（font-family に Didot または Georgia を含む）かつ大文字（text-transform: uppercase）で画像の下に表示されること

### FREQ-138-AC-03 関連アイテムのあるカードでテーマと並びの間に罫線が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138-REQ-01 |
| 根拠 | FREQ-138-REQ-01 の結果を、「関連アイテムのあるカードでテーマと並びの間に罫線が出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

モバイル・タブレットで関連アイテムを持つカードにテーマ名と関連アイテムリストの間の罫線（look-card-divider）が表示されること

### FREQ-138-AC-04 タブレットで関連アイテムの価格が右端に寄る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138-REQ-01 |
| 根拠 | FREQ-138-REQ-01 の結果を、「タブレットで関連アイテムの価格が右端に寄る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

タブレットで関連アイテム行の価格が右端に右寄せで表示されること

### FREQ-138-AC-05 PC ではオーバーレイが出て、画像の下の文字・罫線・並びが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-138-REQ-01 |
| 根拠 | FREQ-138-REQ-01 の結果を、「PC ではオーバーレイが出て、画像の下の文字・罫線・並びが出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-138 の行 |

デスクトップ（1280px）では従来どおり画像上のオーバーレイ（look-card-overlay）が表示され、画像下のキャプション・罫線・関連アイテムリストが表示されないこと

### FREQ-139-AC-01 画像の箱の margin-bottom がモバイル 13px・タブレット 21px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139-REQ-01 |
| 根拠 | FREQ-139-REQ-01 の結果を、「画像の箱の margin-bottom がモバイル 13px・タブレット 21px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

モバイル（390px）で画像コンテナの margin-bottom が 13px、タブレット（768px）で 21px であること

### FREQ-139-AC-02 モバイルでテーマの文字が関連アイテムの文字の約 1.13 倍、タブレットで 1.5 倍以上になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139-REQ-01 |
| 根拠 | FREQ-139-REQ-01 の結果を、文字の比で画面の外から確かめる。モバイルは `--lk-size-sm` ÷ `--lk-size-2xs` ＝ `--lk-eighthstep` の2乗 ≒ 1.128、タブレットは `--lk-size-4xl` ÷ `--lk-size-2xs` ＝ 同7乗 ≒ 1.52。2026-11-07 にオーナーが今の画面を正にして直した（旧: モバイル・タブレットとも 1.5 倍以上） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

モバイル（390px）でタイトルの font-size ÷ 関連アイテム文字の font-size が約 1.13（1.128 ± 0.02）、タブレット（768px）で 1.5 倍以上であること（検証した LOOK カードは、関連アイテムを持ち罫線が出るもの。ホームの LOOK 区画と /look の両方）

### FREQ-139-AC-03 シーズンとテーマの間隔がテーマと罫線の間隔より小さい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139-REQ-01 |
| 根拠 | FREQ-139-REQ-01 の結果を、「シーズンとテーマの間隔がテーマと罫線の間隔より小さい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

シーズンラベルとタイトルの縦間隔が、タイトルと罫線の縦間隔より小さいこと（近接）

### FREQ-139-AC-04 罫線の上と下の余白が等しい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139-REQ-01 |
| 根拠 | FREQ-139-REQ-01 の結果を、「罫線の上と下の余白が等しい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

罫線の上余白と下余白が等しいこと（整列・反復）

### FREQ-139-AC-05 PC では画像の下の文字が出ず、margin-bottom が 0 のままになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-139-REQ-01 |
| 根拠 | FREQ-139-REQ-01 の結果を、「PC では画像の下の文字が出ず、margin-bottom が 0 のままになる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-139 の行 |

デスクトップ（1280px）では画像下キャプションが表示されず、画像コンテナの margin-bottom が 0 のままであること

### FREQ-140-AC-01 モバイルで row-gap が 34px、column-gap が 16px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-140-REQ-01 |
| 根拠 | FREQ-140-REQ-01 の結果を、「モバイルで row-gap が 34px、column-gap が 16px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

モバイル（390px）で HOME の LOOK セクションと /look 一覧の row-gap が 34px、column-gap が従来の 16px であること

### FREQ-140-AC-02 タブレットで row-gap が 55px、column-gap が HOME 24px・一覧 32px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-140-REQ-01 |
| 根拠 | FREQ-140-REQ-01 の結果を、「タブレットで row-gap が 55px、column-gap が HOME 24px・一覧 32px になる」ことで画面の外から確かめる。一覧の 32px は FREQ-141 が 24px に置き換えた（「FREQ-140-AC-02 の一覧 32px を 24px に置換」） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

タブレット（768px）で row-gap が 55px、column-gap が従来値（HOME 24px・一覧 32px）であること

### FREQ-140-AC-03 モバイル・タブレットで row-gap が column-gap より大きい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-140-REQ-01 |
| 根拠 | FREQ-140-REQ-01 の結果を、「モバイル・タブレットで row-gap が column-gap より大きい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

モバイル・タブレットで row-gap が column-gap より大きいこと

### FREQ-140-AC-04 PC で row-gap と column-gap が等しく 24px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-140-REQ-01 |
| 根拠 | FREQ-140-REQ-01 の結果を、「PC で row-gap と column-gap が等しく 24px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-140 の行 |

デスクトップ（1280px）では従来どおり row-gap と column-gap が等しい（24px）こと

### FREQ-141-AC-01 モバイルで一覧の本文の列の左右の padding が 0 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-141-REQ-01 |
| 根拠 | FREQ-141-REQ-01 の結果を、「モバイルで一覧の本文の列の左右の padding が 0 になる」ことで画面の外から確かめる。2026-11-07 にオーナーが今の画面を正にして直した（旧: 13px。E2E FR-LOOK-ALL-028 のモバイルが 2026-10-24 の全件の E2E で赤だった） |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

モバイル（390px）で /look 一覧のコンテンツ列の左右 padding が 0 であること。ホーム LOOK セクションの左右 padding は 13px のままで、モバイルでは両者は同値ではない

### FREQ-141-AC-02 タブレットで一覧の column-gap が 24px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-141-REQ-01 |
| 根拠 | FREQ-141-REQ-01 の結果を、「タブレットで一覧の column-gap が 24px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

タブレット（768px）で /look 一覧の column-gap が 24px（ホーム LOOK セクションと同値）であること

### FREQ-141-AC-03 モバイル・タブレットで一覧とホームの row-gap・column-gap が一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-141-REQ-01 |
| 根拠 | FREQ-141-REQ-01 の結果を、「モバイル・タブレットで一覧とホームの row-gap・column-gap が一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

モバイル・タブレットで /look 一覧とホーム LOOK セクションの row-gap・column-gap が一致すること

### FREQ-141-AC-04 PC の一覧の gap と左の padding が今までどおりになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-141-REQ-01 |
| 根拠 | FREQ-141-REQ-01 の結果を、「PC の一覧の gap と左の padding が今までどおりになる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-141 の行 |

デスクトップ（1280px）の /look 一覧の gap（縦横 24px）と左 padding（lg:pl-8.5 系）が従来どおりであること

### FREQ-142-AC-01 モバイル・タブレットでカードに 1px のグレーの枠線が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-142-REQ-01 |
| 根拠 | FREQ-142-REQ-01 の結果を、「モバイル・タブレットでカードに 1px のグレーの枠線が出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

モバイル（390px）・タブレット（768px）で LOOK カードに 1px のグレー（rgba(0,0,0,0.1)）枠線が表示されること

### FREQ-142-AC-02 モバイル・タブレットで画像の左右の端が枠線の内側に付く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-142-REQ-01 |
| 根拠 | FREQ-142-REQ-01 の結果を、「モバイル・タブレットで画像の左右の端が枠線の内側に付く」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

モバイル・タブレットで画像の左右端がカード枠線の内側に密着している（水平余白 0）こと

### FREQ-142-AC-03 モバイル・タブレットで情報パネルの文字が枠線から離れる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-142-REQ-01 |
| 根拠 | FREQ-142-REQ-01 の結果を、「モバイル・タブレットで情報パネルの文字が枠線から離れる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

モバイル・タブレットで情報パネルの文字が枠線から水平方向に離れている（モバイル 13px・タブレット 21px の余白がある）こと

### FREQ-142-AC-04 PC でカードに枠線が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-142-REQ-01 |
| 根拠 | FREQ-142-REQ-01 の結果を、「PC でカードに枠線が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-142 の行 |

デスクトップ（1280px）では LOOK カードに枠線が表示されないこと

### FREQ-143-AC-01 モバイル・タブレットでシーズンの文字の不透明度が 0.5 より大きい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143-REQ-01 |
| 根拠 | FREQ-143-REQ-01 の結果を、「モバイル・タブレットでシーズンの文字の不透明度が 0.5 より大きい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet でシーズンラベルの文字色の不透明度が 0.5 より大きいこと（従来より濃いこと）

### FREQ-143-AC-02 モバイル・タブレットでシーズンの font-weight が 500 以上になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143-REQ-02 |
| 根拠 | FREQ-143-REQ-02 の結果を、「モバイル・タブレットでシーズンの font-weight が 500 以上になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet でシーズンラベルの font-weight が 500 以上であること

### FREQ-143-AC-03 モバイル・タブレットでシーズンの字間が 0.1em より広い（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143-REQ-03 |
| 根拠 | FREQ-143-REQ-03 を FREQ-145 で取り消したので、この確かめ方も使わない。今の字間は 0.1em より狭い（FREQ-145-AC-01） |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

mobile / tablet でシーズンラベルの letter-spacing が 0.1em 相当（フォントサイズの 10%）より広いこと

### FREQ-143-AC-04 シーズンが「2026 AW」の形のままで番号が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-143-REQ-04 |
| 根拠 | FREQ-143-REQ-04 の結果を、「シーズンが「2026 AW」の形のままで番号が無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-143 の行 |

シーズンラベルが「{4桁年} {SS|AW}」形式のままで、番号（数字/スラッシュ）が含まれないこと

### FREQ-144-AC-01 関連 ITEM の名前の書体・太さ・字間が ITEM カードと一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144-REQ-01 |
| 根拠 | FREQ-144-REQ-01 の結果を、「関連 ITEM の名前の書体・太さ・字間が ITEM カードと一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

mobile / tablet で関連 ITEM の商品名の font-family・font-weight・letter-spacing が ITEM カードの商品名（item-name）と一致すること

### FREQ-144-AC-02 関連 ITEM の価格の太さ・色が ITEM カードと一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144-REQ-02 |
| 根拠 | FREQ-144-REQ-02 の結果を、「関連 ITEM の価格の太さ・色が ITEM カードと一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

mobile / tablet で関連 ITEM の価格の font-weight・文字色が ITEM カードの価格（item-price）と一致すること

### FREQ-144-AC-03 関連 ITEM の価格が半角の「¥」で始まる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144-REQ-02 |
| 根拠 | FREQ-144-REQ-02 の結果を、「関連 ITEM の価格が半角の「¥」で始まる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

mobile / tablet で関連 ITEM の価格が半角「¥」で始まる表記であること

### FREQ-144-AC-04 関連 ITEM の名前・価格の文字が黒になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-144-REQ-01、FREQ-144-REQ-02 |
| 根拠 | FREQ-144-REQ-01、FREQ-144-REQ-02 の結果を、「関連 ITEM の名前・価格の文字が黒になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-144 の行 |

関連 ITEM の商品名・価格の文字色が黒（従来のグレー #474747 ではない）であること

### FREQ-145-AC-01 モバイル・タブレットでシーズンの字間が文字の大きさの 10% より狭い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-145-REQ-01 |
| 根拠 | FREQ-145-REQ-01 の結果を、「モバイル・タブレットでシーズンの字間が文字の大きさの 10% より狭い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-145 の行 |

mobile / tablet でシーズンタイトルの letter-spacing がフォントサイズの 10%（0.1em 相当）より狭いこと

### FREQ-145-AC-02 シーズンの濃さと太さの強調が残っている

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-145-REQ-01 |
| 根拠 | FREQ-145-REQ-01 の結果を、「シーズンの濃さと太さの強調が残っている」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-145 の行 |

色をより黒く・字を太くする強調（不透明度 0.5 超・font-weight 500 以上）は維持されていること

### FREQ-150-AC-01 PC で関連 ITEM の行に乗ると下線が左起点で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150-REQ-02 |
| 根拠 | FREQ-150-REQ-02 の結果を、「PC で関連 ITEM の行に乗ると下線が左起点で出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

デスクトップ（1280px）で、カードホバー中に関連 ITEM 行へカーソルを重ねると下線が左起点（transform-origin が left 端）で scale-x 1 になり表示されること

### FREQ-150-AC-02 PC で関連 ITEM の行に乗っていない時は下線が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150-REQ-02 |
| 根拠 | FREQ-150-REQ-02 の結果を、「PC で関連 ITEM の行に乗っていない時は下線が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

デスクトップで関連 ITEM 行にカーソルを重ねていないときは下線の scale-x が 0（非表示）であること

### FREQ-150-AC-03 PC で関連 ITEM の行を押すとその ITEM の頁へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150-REQ-01 |
| 根拠 | FREQ-150-REQ-01 の結果を、「PC で関連 ITEM の行を押すとその ITEM の頁へ移る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

デスクトップで関連 ITEM 行をクリックすると `/item/{id}` ページへ遷移すること（/look 詳細へは遷移しない）

### FREQ-150-AC-04 モバイル・タブレットではオーバーレイの関連 ITEM の行が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-150-REQ-01 |
| 根拠 | FREQ-150-REQ-01 の結果を、「モバイル・タブレットではオーバーレイの関連 ITEM の行が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-150 の行 |

mobile（390px）/ tablet（768px）ではオーバーレイの関連 ITEM 行が表示されないこと

### FREQ-151-AC-01 モバイル・タブレットで関連 ITEM のリンクに乗ると下線が左起点で出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-151-REQ-01 |
| 根拠 | FREQ-151-REQ-01 の結果を、「モバイル・タブレットで関連 ITEM のリンクに乗ると下線が左起点で出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

mobile（390px）/ tablet（768px）で、関連 ITEM リンクへカーソルを重ねると下線が左起点（transform-origin が left 端）で scale-x 1 になり表示されること

### FREQ-151-AC-02 モバイル・タブレットで関連 ITEM のリンクに乗っていない時は下線が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-151-REQ-01 |
| 根拠 | FREQ-151-REQ-01 の結果を、「モバイル・タブレットで関連 ITEM のリンクに乗っていない時は下線が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

mobile / tablet で関連 ITEM リンクにカーソルを重ねていないときは下線の scale-x が 0（非表示）であること

### FREQ-151-AC-03 モバイル・タブレットで関連 ITEM のリンクを押すとその ITEM の頁へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-151-REQ-01 |
| 根拠 | FREQ-151-REQ-01 の結果を、「モバイル・タブレットで関連 ITEM のリンクを押すとその ITEM の頁へ移る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

mobile / tablet で関連 ITEM リンクをクリックすると `/item/{id}` ページへ遷移すること

### FREQ-151-AC-04 PC では情報パネルの関連 ITEM のリンクが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-151-REQ-01 |
| 根拠 | FREQ-151-REQ-01 の結果を、「PC では情報パネルの関連 ITEM のリンクが出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-151 の行 |

desktop（1280px）では情報パネルの関連 ITEM リンクが表示されないこと（FREQ-150 のオーバーレイ表示を維持）

### FREQ-176-AC-01 3つの幅で並びの上端・下端の線の色が区切り線と同じになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-176-REQ-01 |
| 根拠 | FREQ-176-REQ-01 の結果を、「3つの幅で並びの上端・下端の線の色が区切り線と同じになる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-176 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、関連アイテムリストの上端・下端の線の色がアイテム間の区切り線と同じ rgba(0,0,0,0.1) であること

### FREQ-176-AC-02 3つの幅で上端・下端・区切りの全部の線が 1px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-176-REQ-01 |
| 根拠 | FREQ-176-REQ-01 の結果を、「3つの幅で上端・下端・区切りの全部の線が 1px になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-176 の行 |

同3画面幅で、上端・下端・アイテム間のすべての線の太さが 1px であること

### FREQ-177-AC-01 3つの幅で関連アイテムの見本の高さが文字の大きさ×φ³×√φ になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-177-REQ-01 |
| 根拠 | FREQ-177-REQ-01 の結果を、「3つの幅で関連アイテムの見本の高さが文字の大きさ×φ³×√φ になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-177 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、関連アイテムのプレビュー高さがリストのフォントサイズ × φ³ × √φ（約5.39倍）であること

### FREQ-178-AC-01 3つの幅で通常の表示に「Back to Lookbook」が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-178-REQ-01 |
| 根拠 | FREQ-178-REQ-01 の結果を、「3つの幅で通常の表示に「Back to Lookbook」が無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-178 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、LOOK詳細ページ通常表示に「Back to Lookbook」リンクが表示されないこと

### FREQ-178-AC-02 無い LOOK の URL では「Back to Lookbook」が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-178-REQ-01 |
| 根拠 | FREQ-178-REQ-01 の結果を、「無い LOOK の URL では「Back to Lookbook」が出る」ことで画面の外から確かめる。無い LOOK の表示の戻りのリンクは 2026-11-07 にコードへ戻した（2026-10-24 の全件の E2E で FR-LOOK-DETAIL-004・010 の該当のテストが赤だった原因） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-178 の行 |

存在しない LOOK の URL では引き続き「Back to Lookbook」リンクが表示されること

### FREQ-179-AC-01 モバイルでカルーセルが出て、サムネイルとメインの画像の枠が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179-REQ-01 |
| 根拠 | FREQ-179-REQ-01 の結果を、「モバイルでカルーセルが出て、サムネイルとメインの画像の枠が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

mobile（390px）でスワイプカルーセルが表示され、サムネイルボタンとメイン画像枠が表示されないこと

### FREQ-179-AC-02 タブレットでカルーセルが出て、次送りを押すと前送りが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179-REQ-02 |
| 根拠 | FREQ-179-REQ-02 の結果を、「タブレットでカルーセルが出て、次送りを押すと前送りが出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

tablet（768px）でカルーセルが表示され、複数画像時に次送りボタンが表示され、押すと前送りボタンが現れること

### FREQ-179-AC-03 PC でサムネイルの列とメインの画像が出て、サムネイルで画像が替わる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-179-REQ-03 |
| 根拠 | FREQ-179-REQ-03 の結果を、「PC でサムネイルの列とメインの画像が出て、サムネイルで画像が替わる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-179 の行 |

desktop（1280px）でサムネイル縦列とメイン画像が表示され、カルーセルが表示されないこと。サムネイル選択でメイン画像が切り替わること

### FREQ-180-AC-01 1024px と 1280px で画像の枠の右端が文字の列の左端と重ならない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-180-REQ-01 |
| 根拠 | FREQ-180-REQ-01 の結果を、「1024px と 1280px で画像の枠の右端が文字の列の左端と重ならない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-180 の行 |

1024px（iPad Pro 縦・lg 下限）と 1280px で、メイン画像枠の右端がテキスト列（見出し h1 を含む右列）の左端と重ならないこと

### FREQ-180-AC-02 1024px と 1280px で画像の枠の縦横比が 2/3 になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-180-REQ-01 |
| 根拠 | FREQ-180-REQ-01 の結果を、「1024px と 1280px で画像の枠の縦横比が 2/3 になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-180 の行 |

同2画面幅で、メイン画像枠の縦横比が 2/3（±2%）であること

### FREQ-181-AC-01 3つの幅で3つのラベルが出て、LOOK LIST が /look へのリンクになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-181-REQ-01 |
| 根拠 | FREQ-181-REQ-01 の結果を、「3つの幅で3つのラベルが出て、LOOK LIST が /look へのリンクになる」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-181 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で「PREV LOOK」「LOOK LIST」「NEXT LOOK」の3ラベルが表示され、LOOK LIST が /look へのリンクであること

### FREQ-181-AC-02 tablet・PC の2つの幅で中と右の列の左に 1px の縦の区切り線が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-181-REQ-01 |
| 根拠 | FREQ-181-REQ-01 の結果を、「tablet・PC の2つの幅で中と右の列の左に 1px の縦の区切り線が出る」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えたので、この AC の対象は tablet・PC の2つの幅だけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-181 の行 |

tablet（768px）/ desktop（1280px）で、中央・右カラムの左側に 1px の縦区切り線が表示されること

### FREQ-181-AC-03 ナビの中に LOOK のテーマ名が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-181-REQ-01 |
| 根拠 | FREQ-181-REQ-01 の結果を、「ナビの中に LOOK のテーマ名が出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-181 の行 |

ナビ内に LOOK のテーマ名が表示されないこと

### FREQ-182-AC-01 3つの幅で3つのアイコンが svg で、アイコンのフォントの要素が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-182-REQ-01 |
| 根拠 | FREQ-182-REQ-01 の結果を、「3つの幅で3つのアイコンが svg で、アイコンのフォントの要素が無い」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-182 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、ナビ内の3アイコンがいずれも `svg` 要素であり、`i.ri-*` のアイコンフォント要素が存在しないこと

### FREQ-182-AC-02 tablet・PC の2つの幅でアイコンの線幅が1・塗りなし・線の色が文字の色になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-182-REQ-01 |
| 根拠 | FREQ-182-REQ-01 の結果を、「tablet・PC の2つの幅でアイコンの線幅が1・塗りなし・線の色が文字の色になる」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えたので、この AC の対象は tablet・PC の2つの幅だけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-182 の行 |

tablet（768px）/ desktop（1280px）で、各アイコンの `stroke-width` が 1・`fill` が none・`stroke` が親と同じ文字色（currentColor 由来）であること

### FREQ-182-AC-03 3つの幅でアイコンの大きさが --lk-size-6xl になる（廃止）

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-182-REQ-01 |
| 根拠 | FREQ-183 が「FREQ-182 のアイコンサイズ var(--lk-size-6xl) を本要件で置換」と書き、--lk-size-7xl（FREQ-183-AC-02）に置き換えた |
| 状態 | 廃止 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-182 の行 |

同3画面幅で、各アイコンの描画サイズが `var(--lk-size-6xl)` の算出値と一致し、幅と高さが等しいこと

### FREQ-183-AC-01 3つの幅でラベルとアイコンの色が rgb(0, 0, 0) になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183-REQ-01 |
| 根拠 | FREQ-183-REQ-01 の結果を、「3つの幅でラベルとアイコンの色が rgb(0, 0, 0) になる」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、3カラムのラベルとアイコンの算出色が `rgb(0, 0, 0)` であること

### FREQ-183-AC-02 tablet・PC の2つの幅でアイコンの大きさが --lk-size-7xl になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183-REQ-02 |
| 根拠 | FREQ-183-REQ-02 の結果を、「tablet・PC の2つの幅でアイコンの大きさが --lk-size-7xl になる」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えたので、この AC の対象は tablet・PC の2つの幅だけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

tablet（768px）/ desktop（1280px）で、各アイコンの描画サイズが `var(--lk-size-7xl)` の算出値と一致すること

### FREQ-183-AC-03 tablet・PC の2つの幅で3列のラベルの字間が同じになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-183-REQ-03 |
| 根拠 | FREQ-183-REQ-03 の結果を、「tablet・PC の2つの幅で3列のラベルの字間が同じになる」ことで画面の外から確かめる。390px の分は FREQ-343 が固定のナビに置き換えたので、この AC の対象は tablet・PC の2つの幅だけ |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-183 の行 |

tablet（768px）/ desktop（1280px）で、3カラムのラベルの算出 letter-spacing がすべて同一であること

### FREQ-277-AC-01 4つの幅で /look の列数が /item と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277-REQ-01 |
| 根拠 | FREQ-277-REQ-01 の結果を、「4つの幅で /look の列数が /item と一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）/ wide（1536px）で、/look のグリッド列数が /item のグリッド列数と一致すること

### FREQ-277-AC-02 4つの幅で LOOK カードの幅が 200px 以上になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277-REQ-02 |
| 根拠 | FREQ-277-REQ-02 の結果を、「4つの幅で LOOK カードの幅が 200px 以上になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

/look を 1024px / 1280px / 1536px / 1920px で表示したとき、LOOK カードの幅がいずれも 200px 以上であること

### FREQ-277-AC-03 ホームで 390・768・1280px は6件まで、1536px は8件までの LOOK が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-277-REQ-03 |
| 根拠 | FREQ-277-REQ-03 の結果を、「ホームで 390・768・1280px は6件まで、1536px は8件までの LOOK が出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-277 の行 |

ホームで mobile（390px）/ tablet（768px）/ desktop（1280px）は最大6件、wide（1536px）は最大8件の LOOK カードが表示されること

### FREQ-279-AC-01 初めに画面の外の画像の枠に data-reveal="true" が無く、スクロールすると付く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279-REQ-01 |
| 根拠 | FREQ-279-REQ-01 の結果を、「初めに画面の外の画像の枠に data-reveal="true" が無く、スクロールすると付く」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、初期表示では画面外にある画像枠に data-reveal="true" が付いておらず、そこまでスクロールすると true になること

### FREQ-279-AC-02 リビールの後の画像の枠の ::after の animation-name が reveal-cover-act になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279-REQ-02 |
| 根拠 | FREQ-279-REQ-02 の結果を、「リビールの後の画像の枠の ::after の animation-name が reveal-cover-act になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、リビール後の画像枠 ::after の animation-name が reveal-cover-act であること

### FREQ-279-AC-03 リビールの後の商品名・LOOK のテーマの transform が none になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279-REQ-03 |
| 根拠 | FREQ-279-REQ-03 の結果を、「リビールの後の商品名・LOOK のテーマの transform が none になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、リビール完了後の商品名・LOOK タイトルの transform が none になること

### FREQ-279-AC-04 /・/item・/look のカードに data-reveal-group と .reveal-cover がある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279-REQ-04 |
| 根拠 | FREQ-279-REQ-04 の結果を、「/・/item・/look のカードに data-reveal-group と .reveal-cover がある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、/、/item、/look のいずれでもカードに data-reveal-group 属性と .reveal-cover が存在すること

### FREQ-279-AC-05 カードの上端だけを見せて2秒待っても文字が出ず、文字まで進むと出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-279-REQ-05 |
| 根拠 | FREQ-279-REQ-05 の結果を、「カードの上端だけを見せて2秒待っても文字が出ず、文字まで進むと出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-279 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、カード上端のみが見える位置までスクロールして 2 秒待っても文字ブロック（.reveal-mask）の data-reveal が true にならず、文字までスクロールすると true になること

### FREQ-288-AC-01 3つの幅で画像の下に枚数分の線が出て、選んだ線だけに色が付く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288-REQ-01 |
| 根拠 | FREQ-288-REQ-01 の結果を、「3つの幅で画像の下に枚数分の線が出て、選んだ線だけに色が付く」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で画像下にセグメント線が画像枚数分表示され、選択中のセグメントだけが色付きであること

### FREQ-288-AC-02 タブレットで送りのボタンの上下の中心が画像の枠の中心と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288-REQ-02 |
| 根拠 | FREQ-288-REQ-02 の結果を、「タブレットで送りのボタンの上下の中心が画像の枠の中心と一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

tablet（768px）で前後ボタンの上下中心が画像枠の上下中心と一致すること

### FREQ-288-AC-03 PC で画像の枠が 2:3 で画面の縦に収まり、情報の列の幅が画像の幅と等しい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288-REQ-03 |
| 根拠 | FREQ-288-REQ-03 の結果を、「PC で画像の枠が 2:3 で画面の縦に収まり、情報の列の幅が画像の幅と等しい」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-288 の行 |

desktop（1280px）で画像枠の縦横比が 2:3 で高さが viewport 内に収まり、情報列の幅が画像の幅と等しいこと

### FREQ-288-AC-04 タブレットで画像と情報の列の間と、情報の列の右端から画面の右端までがどちらも 32px になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-288-REQ-03 |
| 根拠 | FREQ-288-REQ-03 は md 以上を ITEM と同じ2列の格子にする。ITEM 詳細はタブレットで2つの余白を 32px にする（FREQ-286-AC-02）ので、LOOK 詳細も同じ値になることで確かめる。2026-11-08 の実測では LOOK 詳細の右端だけが 57〜76px で、ITEM とずれていた |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | オーナーの判断（2026-11-08「そろえる」） |

tablet（768px・1023px）で、画像の枠の右端から情報の列の左端までと、情報の列の右端から画面の右端までが、どちらも 32px であること。mobile（390px）と desktop（1280px）では横スクロールが出ないこと

### FREQ-289-AC-01 1280×725 で ITEM 詳細のインジケータの下端が画面の下端から 12px 以上離れる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-289-REQ-01 |
| 根拠 | FREQ-289-REQ-01 の結果を、「1280×725 で ITEM 詳細のインジケータの下端が画面の下端から 12px 以上離れる」ことで画面の外から確かめる。ITEM 詳細は範囲外で、確かめる E2E（FR-ITEM-DETAIL-041）も範囲外 |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-289 の行 |

desktop（1280×725）で ITEM 詳細のセグメント線インジケータ下端が viewport 下端から 12px 以上離れていること

### FREQ-289-AC-02 1280×725 で LOOK 詳細のインジケータの下端が画面の下端から 12px 以上離れる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-289-REQ-01 |
| 根拠 | FREQ-289-REQ-01 の結果を、「1280×725 で LOOK 詳細のインジケータの下端が画面の下端から 12px 以上離れる」ことで画面の外から確かめる。確かめる E2E は範囲外の FR-ITEM-DETAIL-041 |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-289 の行 |

desktop（1280×725）で LOOK 詳細のセグメント線インジケータ下端が viewport 下端から 12px 以上離れていること

### FREQ-337-AC-01 モバイルで「価格↔次の名前」の余白が「名前↔価格」の 1.618 倍以上になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-337-REQ-01 |
| 根拠 | FREQ-337-REQ-01 の結果を、「モバイルで「価格↔次の名前」の余白が「名前↔価格」の 1.618 倍以上になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-337 の行 |

mobile（390px）で、関連アイテムが 2 件以上ある LOOK カードにおいて「価格↔次の商品名」の見た目の余白が「商品名↔価格」の余白の 1.618 倍以上であること

### FREQ-337-AC-02 タブレットで名前と価格が1行のままで、商品の間の余白が文字の 0.618 倍になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-337-REQ-01 |
| 根拠 | FREQ-337-REQ-01 の結果を、「タブレットで名前と価格が1行のままで、商品の間の余白が文字の 0.618 倍になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-337 の行 |

tablet（768px）で、商品名と価格が横並び 1 行のまま表示され、アイテム間の見た目の余白が文字サイズの 0.618 倍（±0.25px）であること

### FREQ-337-AC-03 PC でカードの下に関連アイテムの並びが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-337-REQ-01 |
| 根拠 | FREQ-337-REQ-01 の結果を、「PC でカードの下に関連アイテムの並びが出ない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-337 の行 |

desktop（1280px）で、カード下の関連アイテムリスト（.look-related-items）が表示されないこと

### FREQ-338-AC-01 リビールの前の LOOK カードの文字が横にだけ退いている

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-338-REQ-01 |
| 根拠 | FREQ-338-REQ-01 の結果を、「リビールの前の LOOK カードの文字が横にだけ退いている」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-338 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、リビール前の LOOK カードの .reveal-rise が横方向にのみ退避していること（translateX が負・translateY が 0）

### FREQ-338-AC-02 リビールの後の LOOK カードの文字の animation-name が reveal-rise-x-act になり定位置に戻る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-338-REQ-01 |
| 根拠 | FREQ-338-REQ-01 の結果を、「リビールの後の LOOK カードの文字の animation-name が reveal-rise-x-act になり定位置に戻る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-338 の行 |

同3ビューポートで、リビール後の LOOK カードの .reveal-rise の animation-name が reveal-rise-x-act になり、移動量が 0（定位置）に戻ること

### FREQ-338-AC-03 ITEM カードの文字の animation-name が reveal-rise-act のままになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-338-REQ-01 |
| 根拠 | FREQ-338-REQ-01 の結果を、「ITEM カードの文字の animation-name が reveal-rise-act のままになる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-338 の行 |

同3ビューポートで、ITEM カードの .reveal-rise の animation-name が reveal-rise-act のままであること

### FREQ-339-AC-01 リビールの前の文字の右端がカードの左端以下にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-339-REQ-01 |
| 根拠 | FREQ-339-REQ-01 の結果を、「リビールの前の文字の右端がカードの左端以下にある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-339 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で、リビール前の LOOK カードの.reveal-rise の右端がカードの左端以下（＝カード内に入っていない）であること

### FREQ-339-AC-02 リビールの後は文字がカードの中の定位置に戻る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-339-REQ-01 |
| 根拠 | FREQ-339-REQ-01 の結果を、「リビールの後は文字がカードの中の定位置に戻る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-339 の行 |

同3ビューポートで、リビール後は .reveal-rise がカード内の定位置に戻っていること

### FREQ-343-AC-01 モバイルで固定のナビが出て、下端が画面の下端に付いたまま動かない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343-REQ-01 |
| 根拠 | FREQ-343-REQ-01 の結果を、「モバイルで固定のナビが出て、下端が画面の下端に付いたまま動かない」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

mobile（390px）で固定ナビが表示され position が fixed かつ下端が viewport 下端に一致し、ページ最下部までスクロールしても位置が変わらないこと

### FREQ-343-AC-02 モバイルの固定のナビに3つのラベルが出て、LOOK LIST が /look へのリンクになる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343-REQ-01 |
| 根拠 | FREQ-343-REQ-01 の結果を、「モバイルの固定のナビに3つのラベルが出て、LOOK LIST が /look へのリンクになる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

mobile（390px）の固定ナビに「PREV LOOK」「LOOK LIST」「NEXT LOOK」が表示され、LOOK LIST が /look へのリンクであること

### FREQ-343-AC-03 モバイルは3列のナビが出ず、タブレット・PC は3列のナビだけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343-REQ-01 |
| 根拠 | FREQ-343-REQ-01 の結果を、「モバイルは3列のナビが出ず、タブレット・PC は3列のナビだけが出る」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

mobile（390px）ではインライン3カラムナビが表示されず、tablet（768px）/ desktop（1280px）では逆にインラインナビが表示され固定ナビが表示されないこと

### FREQ-343-AC-04 モバイルで最下部まで進むと法務の3つのリンクが固定のナビより上にある

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343-REQ-02 |
| 根拠 | FREQ-343-REQ-02 の結果を、「モバイルで最下部まで進むと法務の3つのリンクが固定のナビより上にある」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

mobile（390px）でページ最下部までスクロールしたとき、Privacy Policy / Terms of Service / Legal Notice の各リンクの下端が固定ナビの上端より上にあること

### FREQ-343-AC-05 モバイルで固定のナビのラベルの文字の大きさが --lk-size-7xs になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-343-REQ-03 |
| 根拠 | FREQ-343-REQ-03 の結果を、「モバイルで固定のナビのラベルの文字の大きさが --lk-size-7xs になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-343 の行 |

mobile（390px）で固定ナビの3ラベルの算出 font-size が `var(--lk-size-7xs)` の算出値と一致すること

### FREQ-344-AC-01 3つの幅で頁の scrollWidth が clientWidth 以下になる

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-344-REQ-01 |
| 根拠 | FREQ-344-REQ-01 の結果を、「3つの幅で頁の scrollWidth が clientWidth 以下になる」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-344 の行 |

mobile（390px）/ tablet（768px）/ desktop（1280px）で `document.documentElement.scrollWidth` が `clientWidth` 以下であること

### FREQ-344-AC-02 3つの幅で画面の右端を越える要素が無い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-344-REQ-01 |
| 根拠 | FREQ-344-REQ-01 の結果を、「3つの幅で画面の右端を越える要素が無い」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-344 の行 |

同3ビューポートで、viewport の右端を超えて配置される要素が存在しないこと

### FREQ-344-AC-03 モバイルで固定のナビの下端が画面の下端と一致する

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-344-REQ-01 |
| 根拠 | FREQ-344-REQ-01 の結果を、「モバイルで固定のナビの下端が画面の下端と一致する」ことで画面の外から確かめる |
| 状態 | 現行 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-344 の行 |

mobile（390px）で固定ボトムナビの下端が `document.documentElement.clientHeight` と一致すること（横スクロールバーに下部を削られないこと）

### 新しく起こした受け入れ条件

要件の文から、画面の外から確かめられる形に起こした。ユーザーの確認を受けていないので「推定」。

### FR-LOOK-ALL-001-AC-01 一覧に公開済みの LOOK がカードの格子で並ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-001 |
| 根拠 | FR-LOOK-ALL-001 の一覧の形を、公開済みの LOOK のカードが格子で出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-001） |

`/look` を開くと、公開済みの LOOK がカード（`data-testid="look-card"`）の格子で表示されること。

### FR-LOOK-ALL-001-AC-02 非公開の LOOK が一覧に出ない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-001 |
| 根拠 | FR-LOOK-ALL-001 の「公開済み」を、非公開の LOOK が混ざらないことで確かめる。今この性質を試すテストが無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-001） |

非公開（private）の LOOK があるとき、`/look` の一覧にその LOOK のテーマのカードが表示されないこと。

### FR-LOOK-ALL-002-AC-01 カードにシーズン・テーマ・画像・関連商品名が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-002 |
| 根拠 | FR-LOOK-ALL-002 の4つの項目が、カードに全部出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-002） |

モバイル（390px）で `/look` を開くと、関連商品を持つ LOOK のカードにシーズンの表記・テーマ・画像・関連商品の名前が表示されること。

### FR-LOOK-ALL-002-AC-02 カードを押すとその LOOK の詳細が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-002 |
| 根拠 | FR-LOOK-ALL-002 の遷移を、押したカードの LOOK の詳細に移ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-002） |

カードを押すと `/look/{id}` に移り、そのカードの LOOK のテーマが見出し（h1）に表示されること。

### FR-LOOK-ALL-003-AC-01 公開の LOOK が7件以上ある時に6件以上のカードが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-003 |
| 根拠 | FR-LOOK-ALL-003 の件数の下限を、件数の多い時に6件以上が出ることで確かめる。ページングか無限スクロールかは試さない（今はどちらも無い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-003） |

公開の LOOK が7件以上あるとき、`/look` に LOOK のカードが6件以上表示されること。

### FR-LOOK-ALL-004-AC-01 ホームに LOOK の区画があり、LOOK のカードが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-004 |
| 根拠 | FR-LOOK-ALL-004 のホームの区画を、区画と LOOK のカードが出ることで確かめる。件数は FREQ-277-AC-03 が確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-004） |

ホーム（`/`）に見出し「LOOK」の区画があり、公開済みの LOOK のカードが1件以上表示されること。

### FR-LOOK-ALL-004-AC-02 公開の LOOK が表示数より多い時、ホームの LOOK の区画から /look へ移れる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-004 |
| 根拠 | FR-LOOK-ALL-004 の「一覧に誘導する」を、区画の入口から一覧へ移れることで確かめる。入口を出す条件は今のコード（総数が表示数より多い時）に合わせた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-004） |

公開の LOOK がその幅の表示数（2xl 未満6件・2xl 以上8件）より多いとき、ホームの LOOK の区画に `/look` への入口が表示され、押すと `/look` に移ること。

### FR-LOOK-ALL-005-AC-01 一覧の title に LOOK を含み、description が空でない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-005、NFR-SEO-003（範囲外） |
| 根拠 | FR-LOOK-ALL-005 のメタ情報を、頁の title と description の中身で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-005） |

`/look` の title に「LOOK」を含み、meta の description が空でないこと。

### FR-LOOK-ALL-006-AC-01 SS を選ぶと SS の LOOK だけが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-006 |
| 根拠 | FR-LOOK-ALL-006 の絞り込みを、選んだシーズンの LOOK だけが残ることで確かめる。置き場（サイドバー・引き出し）は FREQ-51-AC-01・02 が確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-006） |

`/look` でシーズンの SS を選ぶと、表示される LOOK のカードのシーズンの表記が全部 SS になること。

### FR-LOOK-ALL-006-AC-02 ALL を選ぶと全部の LOOK が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-ALL-006 |
| 根拠 | FR-LOOK-ALL-006 の ALL を、絞る前と同じ数の LOOK に戻ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-ALL-006） |

SS か AW を選んだ後に ALL を選ぶと、公開済みの LOOK のカードが全部表示されること。

### FR-LOOK-DETAIL-001-AC-01 詳細にテーマの h1・シーズン・画像・説明文が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-001 |
| 根拠 | FR-LOOK-DETAIL-001 の4つの項目が、詳細に全部出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-001） |

公開済みの LOOK の `/look/{id}` を開くと、テーマの h1、シーズンの表記、画像、説明文が表示されること。

### FR-LOOK-DETAIL-001-AC-02 非公開の LOOK の詳細は中身を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-001 |
| 根拠 | FR-LOOK-DETAIL-001 の「公開済み」を、非公開の LOOK の中身が出ないことで確かめる。今この性質を試すテストが無い |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-001） |

非公開（private）の LOOK の `/look/{id}` を開くと、その LOOK のテーマ・画像・説明文が表示されず「Look not found」が表示されること。

### FR-LOOK-DETAIL-002-AC-01 紐づけた商品の名前と価格が並ぶ

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-002 |
| 根拠 | FR-LOOK-DETAIL-002 の一覧を、紐づけた商品の名前と価格が出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-002） |

関連商品を持つ LOOK の詳細に、紐づけた商品の名前と価格が並んで表示されること。

### FR-LOOK-DETAIL-002-AC-02 商品を押すとその商品の頁へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-002 |
| 根拠 | FR-LOOK-DETAIL-002 の遷移のリンクを、押した商品の頁に移ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-002） |

詳細の関連商品を押すと、その商品の `/item/{id}` に移ること。

### FR-LOOK-DETAIL-003-AC-01 前後の LOOK へのリンクが出て、押すとその LOOK へ移る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-003 |
| 根拠 | FR-LOOK-DETAIL-003 の前後のナビを、リンクから隣の LOOK に移れることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-003） |

前後の LOOK がある詳細に前後へのリンクが表示され、押すと一覧の並びで隣の LOOK の `/look/{id}` に移ること。

### FR-LOOK-DETAIL-003-AC-02 先頭の LOOK は前へ、末尾の LOOK は次へのリンクが無い

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-003 |
| 根拠 | FR-LOOK-DETAIL-003 の端の扱いを、無い側にリンクが無いことで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-003） |

一覧の先頭の LOOK の詳細では前への、末尾の LOOK の詳細では次へのリンクが無い（操作できない表示になる）こと。

### FR-LOOK-DETAIL-004-AC-01 無い ID の詳細に「Look not found」が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-004 |
| 根拠 | FR-LOOK-DETAIL-004 の知らせの文を、無い ID で開いた時の見出しで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-004） |

無い LOOK の ID の `/look/{id}` を開くと「Look not found」が表示されること。

### FR-LOOK-DETAIL-004-AC-02 無い ID の詳細に /look への戻りのリンクが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-004 |
| 根拠 | FR-LOOK-DETAIL-004 の戻りのリンクを、無い ID の頁から一覧へ移れることで確かめる。今のコードはリンクを持たず、E2E FR-LOOK-DETAIL-004 が赤 |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-004） |

無い LOOK の ID の `/look/{id}` に `/look` への戻りのリンクが表示され、押すと `/look` に移ること。

### FR-LOOK-DETAIL-005-AC-01 PC で複数の画像の LOOK にサムネイルが並び、選ぶとメインの画像が替わる

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-005 |
| 根拠 | FR-LOOK-DETAIL-005 のギャラリーを、PC のサムネイルでメインの画像を替えられることで確かめる（モバイル・タブレットの形は FREQ-179 が確かめる） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-005） |

PC（1280px）で画像が2枚以上の LOOK の詳細に画像の数のサムネイルが並び、2枚目のサムネイルを押すとメインの画像が2枚目に替わること。

### FR-LOOK-DETAIL-006-AC-01 詳細の title にテーマを含み、description が空でない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-006、NFR-SEO-003（範囲外） |
| 根拠 | FR-LOOK-DETAIL-006 のメタ情報を、頁の title と description の中身で確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-006） |

公開済みの LOOK の詳細の title にその LOOK のテーマを含み、meta の description が空でないこと。

### FR-LOOK-DETAIL-006-AC-02 前後のリンクに行き先のテーマを含む aria-label が付く

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-006 |
| 根拠 | FR-LOOK-DETAIL-006 の aria-label を、読み上げの名前に行き先が入っていることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-006） |

詳細の前後のリンクの aria-label に、行き先の LOOK のテーマが含まれること。

### FR-LOOK-DETAIL-007-AC-01 詳細に同じシーズンか関連のコーディネートを薦める節が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOOK-DETAIL-007 |
| 根拠 | 将来作る時の確かめ方として FR-LOOK-DETAIL-007 から起こした。今は作らない（WONT）ので満たさず、E2E は skip |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-LOOK-DETAIL-007） |

LOOK の詳細に、同じシーズンか関連のコーディネートの LOOK を薦める節が表示されること。

### FR-ADMIN-005-AC-01 LOOK タブに LOOK の一覧が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005 |
| 根拠 | FR-ADMIN-005 の一覧を、タブを開いた時に LOOK の行が出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-005） |

店長が管理画面の LOOK タブを開くと、登録済みの LOOK が画像・公開の状態・シーズン・テーマと一緒に一覧で表示されること。

### FR-ADMIN-005-AC-02 作った LOOK が一覧に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005 |
| 根拠 | FR-ADMIN-005 の作成を、保存した LOOK が一覧に増えることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-005） |

作成の頁で画像・シーズン・テーマ・紐づける商品を入れて保存すると、LOOK タブの一覧にその LOOK が表示されること。

### FR-ADMIN-005-AC-03 直した内容が一覧に出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005 |
| 根拠 | FR-ADMIN-005 の編集を、直したテーマが一覧に出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-005） |

編集の頁でテーマを直して保存すると、LOOK タブの一覧に直したテーマが表示されること。

### FR-ADMIN-005-AC-04 消した LOOK が一覧から消える

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005 |
| 根拠 | FR-ADMIN-005 の削除を、確かめて消した LOOK が一覧から無くなることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-005） |

LOOK タブで削除を押して確かめに同意すると、その LOOK が一覧から無くなること。

### FR-ADMIN-005-AC-05 紐づけた商品が公開の詳細の商品の並びに出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005 |
| 根拠 | FR-ADMIN-005 の商品の紐づけを、公開の詳細に紐づけた商品が出ることで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-ADMIN-005） |

公開の商品を紐づけて公開にした LOOK の `/look/{id}` に、その商品が関連商品として表示されること。

## セキュリティ要件

脅威 `THR-LOOK-001`〜`023`（`docs/05_Quality/security/threats/look.md`）の対策。今のコードが満たさない要件は、その要件の本文に「今のコードは満たさない」と1回だけ書く。ほかの文書は SEC の ID で指す。満たさない所の一覧は `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節。

### SEC-LOOK-001 公開の道は公開済みの LOOK だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-001 |
| 根拠 | 発表前のスタイリングを先に知られないため。DB の RLS とアプリの取り出しの絞りの2段で守り、片方が崩れても漏れないようにする（過去のレビューが「Fixed」とした形）。全体の NFR-SEC-005（範囲外。権限管理）を LOOK の公開の線引きに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

`/look`・`/look/<id>`・頁の情報（`og:image` を含む）・検索の `search_looks`・anon と一般会員の JWT での PostgREST の読み出しは、`status='published'` の LOOK だけを返す。今のコードは満たす（`src/lib/look/server.ts`、`supabase/migrations/20260901102912_remote_schema.sql`）。試すテストは無い。

#### SEC-LOOK-001-AC-01 anon と一般会員の直接の読み出しに非公開の LOOK が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-001 |
| 根拠 | RLS の段だけで守れているかを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に非公開の LOOK を1件入れ、anon の鍵と一般会員の JWT で `looks` を select し、`search_looks` を呼ぶ） |
| 出どころ | 実装から推定 |

非公開の LOOK を1件入れた状態で、anon と一般会員の JWT の select の結果と `search_looks` の結果に、その LOOK が含まれないこと。

#### SEC-LOOK-001-AC-02 公開の画面に非公開の LOOK が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-001 |
| 根拠 | アプリの取り出しの段で守れているかを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

非公開の LOOK の id で `/look/<id>` を開くと「Look not found」の画面が表示され、頁の題と `og:image` にその LOOK のテーマと画像が出ないこと。`/look` の一覧にその LOOK のテーマが表示されないこと。

### SEC-LOOK-002 LOOK の関連の公開の読み出しは、公開の商品の紐づきだけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-002 |
| 根拠 | 発売前の商品の存在と ID を、公開の LOOK を足場に知られないため。画面の表示の絞りだけでは、PostgREST の直接の読み出しが残る。全体の NFR-SEC-005（範囲外）を関連の表に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.1。`docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/security/security_review_look_id.md` |
| 優先度 | MUST |

anon と一般会員の `look_items` の読み出しの方針は、親の LOOK が公開であることに加えて、紐づく商品が公開であることを条件にする。2026-10-26 に移行 `sec_rls_predicates_and_constraints` で満たした（この移行を当てた DB でだけ満たす。管理の読みの枝 `has_permission('admin.looks.read')` は変えず、波 5 の aal2 で直す。DATA-LOOK-003）。

#### SEC-LOOK-002-AC-01 anon の直接の読み出しに非公開の商品の紐づきが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-002 |
| 根拠 | 過去のレビューが示した漏れの道そのものを閉じたかを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で公開の LOOK に非公開の商品を紐づけ、anon の鍵で `look_items` を select する） |
| 出どころ | 実装から推定 |

公開の LOOK に非公開の商品を1件紐づけた状態で、anon の select の結果にその商品の `item_id` が含まれないこと。

#### SEC-LOOK-002-AC-02 一般会員の直接の読み出しに非公開の商品の紐づきが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-002 |
| 根拠 | authenticated の方針（`admin.looks.read` か親の公開）にも同じ漏れがあるため |
| 状態 | 推定 |
| 確かめ方 | E2E（権限の無い一般会員の JWT で `look_items` を select する） |
| 出どころ | 実装から推定 |

AC-01 と同じ状態で、権限の無い一般会員の JWT の select の結果にその商品の `item_id` が含まれないこと。

### SEC-LOOK-003 DB でも LOOK の管理の権限を使う操作に2要素認証の済みを求める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-003 |
| 根拠 | パスワードだけで得た session で PostgREST を直接叩き、管理の窓口の aal2・回数の制限・画像の確かめ・監査を飛ばされないため。全体の NFR-SEC-008（範囲外。RBAC）と FREQ-540（範囲外。DB の ACL・session・2要素で管理の操作を守る）を LOOK の表に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1 |
| 優先度 | MUST |

`looks`・`look_items` の RLS のうち `admin.looks.read`・`admin.looks.manage` で許す方針は、JWT の `aal` が `aal2` で、session が生きている時だけ許す。読みの側（AC-01）は、波 5 の移行 M2（`has_permission` に aal2 と結び付いた生きた session を求める。SEC-AUTH-010-AC-03、ADR-0418）を当てた DB で満たす（2026-10-29 に E2E の `test.fail` を外した。M2 は 2026-10-29 に本番適用済み）。書き込みの側（AC-02）は、2026-10-26 から anon・authenticated に `looks`・`look_items` の INSERT・UPDATE・DELETE の権限が無い（SEC-LOOK-004、ADR-0414）ので、aal1 の JWT でも PostgREST から書けず満たす（この移行を当てた DB でだけ満たす）。

#### SEC-LOOK-003-AC-01 aal1 の session では非公開の LOOK を直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-003 |
| 根拠 | 2要素認証を済ませていない session で、非公開の LOOK の読み出しに届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.looks.read` を持つ試し用の利用者の aal1 の JWT で、手元の Supabase の `looks` を select する） |
| 出どころ | 実装から推定 |

`admin.looks.read` を持つ利用者の aal1 の JWT で select した時、非公開の LOOK が結果に含まれないこと。

#### SEC-LOOK-003-AC-02 aal1 の session では LOOK と関連を直接書き換え・消去できない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-003 |
| 根拠 | 改ざんと消去の道も、読み出しと同じく aal2 で閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.looks.manage` を持つ試し用の利用者の aal1 の JWT で、`looks`・`look_items` に insert・update・delete を送る） |
| 出どころ | 実装から推定 |

aal1 の JWT の insert・update・delete が、どれも行を変えずに終わること（権限の誤り `42501` で断られる。権限を外した後は0件の成功にならない）。

### SEC-LOOK-004 LOOK の表の権限を、使う操作だけに絞る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-004 |
| 根拠 | 守りを RLS の1段だけにしないため。TRUNCATE のように RLS の外にある操作は、権限でしか止められない。全体の NFR-SEC-006（範囲外。最小権限）を DB の権限に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3 |
| 優先度 | SHOULD |

`looks`・`look_items` の anon・authenticated の権限は SELECT だけにする（公開の読みの方針と、管理者の読みの方針が使う）。INSERT・UPDATE・DELETE・TRUNCATE・TRIGGER・REFERENCES・MAINTAIN は付けない。管理の書き込みは全部 service role の窓口で行う（ADR-0414）。以前の文は「管理の方針が使う INSERT・UPDATE・DELETE を残す」だったが、それでは SEC-LOOK-003-AC-02 の書き込みの穴が塞がらず、FREQ-540（範囲外。DB の ACL で管理の操作を守る）とも食い違うので、残さない。RLS の書き込み方針（`admin looks / look_items manage by permission ...`）は消さず、将来だれかが権限を戻した時の二重の守りとして残す。2026-10-26 に移行 `sec_grants_admin_tables` で満たした（この移行を当てた DB でだけ満たす。DATA-LOOK-003、ADR-0414）。

#### SEC-LOOK-004-AC-01 anon に LOOK の表の書き込みの権限が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-004 |
| 根拠 | 権限の段が RLS と独立に閉じているかを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で `has_table_privilege` を anon について問い合わせ、anon の鍵での書き込みが RLS の誤りではなく `42501` の「permission denied for table」で断られることも確かめる） |
| 出どころ | 実装から推定 |

anon について、`looks`・`look_items` の INSERT・UPDATE・DELETE・TRUNCATE の権限が、どれも false であること。

#### SEC-LOOK-004-AC-02 authenticated に LOOK の表の要らない権限が無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-004 |
| 根拠 | 会員の鍵でも、RLS の外の操作に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で `has_table_privilege` を authenticated について問い合わせる） |
| 出どころ | 実装から推定 |

authenticated について、`looks`・`look_items` の TRUNCATE・TRIGGER・REFERENCES の権限が、どれも false であること。

### SEC-LOOK-005 LOOK の画像の置き場は非公開で、その設定を移行で持つ

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-005 |
| 根拠 | 非公開の LOOK の画像を、公開の URL から開かせないため。設定が手元の見本だけにあると、本番と手元で食い違っても気づけない |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-18-look-detail-review.md` |
| 優先度 | MUST |

置き場 `look-images` は `public=false` とし、大きさの上限（5MB）と種類の上限（JPEG・PNG・WebP・GIF）を付け、`storage.objects` に読み書きの方針を作らない（service role と署名つき URL だけで扱う）。この定義を `supabase/migrations/` の移行に置く。2026-10-26 に移行 `sec_storage_buckets` で満たした（この移行を当てた DB でだけ満たす。本番の置き場は既にあるので `ON CONFLICT (id) DO UPDATE` で設定を合わせ、既にある 5MB 超のファイルは残り、新しい上げ物だけが断られる。`storage.objects` に置き場を名指しする方針は作らず、本番にあれば移行の自己検査が止める。DATA-LOOK-005、ADR-0164）。

#### SEC-LOOK-005-AC-01 移行だけを当てた DB で置き場が非公開になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-005 |
| 根拠 | 見本のデータに頼らず、移行の中に置き場の設定があることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の `storage.buckets` を読む。見本の SQL は `look-images` の行を `id`・`name`・`public` だけで足し、大きさと種類の上限を入れないので、上限と非公開は移行からしか来ない） |
| 出どころ | 実装から推定 |

`storage.buckets` の `look-images` の行があり、`public` が false、`file_size_limit` が 5MB、`allowed_mime_types` が4つの画像の種類であること。

#### SEC-LOOK-005-AC-02 公開の URL では LOOK の画像を開けない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-005 |
| 根拠 | 利用者の見える所で、公開の道が閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

LOOK の画像の道筋を `/storage/v1/object/public/look-images/<道筋>` で開くと、画像が返らない（4xx）こと。

### SEC-LOOK-006 非公開にした LOOK の画像の URL を、新しく出さず長く残さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-006 |
| 根拠 | 署名つき URL は取り消せないので、非公開にした後に画像が見える時間を期限で区切るしかない。頁や最適化のキャッシュが期限より長いと、期限の守りが崩れる |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/security/security_review_look_id.md` |
| 優先度 | MUST |

署名の期限は1時間以下とし、`/look`・`/look/<id>` の頁と画像の最適化のキャッシュは署名の期限より長く残さない。方針（`revalidate`・`dynamic`・`minimumCacheTTL`）を明示する。`og:image` には期限の切れる署名つき URL を入れない。2026-10-28 に満たした。署名の期限は 3600 秒（`look-images.ts`）、画像の最適化のキャッシュは `minimumCacheTTL: 3600`（`next.config.ts`）、頁は根の `layout.tsx` の `dynamic = 'force-dynamic'` で要求ごとに描く。`og:image` は署名を含まない同一オリジンの窓口 `GET /look/<id>/og`（API-LOOK-007。ADR-0165）にした。

#### SEC-LOOK-006-AC-01 非公開にした後に開いた頁に、その LOOK の画像の URL が出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-006 |
| 根拠 | 非公開にした時点から、新しい署名つき URL が配られないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase で公開の LOOK を開いた後に非公開にし、もう一度開く） |
| 出どころ | 実装から推定 |

LOOK を非公開にした後に `/look` と `/look/<id>` を開くと、頁の HTML（`og:image` を含む）にその LOOK の画像の道筋を含む URL が出ないこと。

#### SEC-LOOK-006-AC-02 詳細の頁の `og:image` が期限の切れる署名つき URL でない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-006 |
| 根拠 | 共有された頁の画像が1時間で切れることと、署名つき URL が SNS のクローラーに残ることを避けるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

公開の LOOK の `/look/<id>` の `og:image` の値に、署名つき URL の `token` の問い合わせが含まれないこと。

#### SEC-LOOK-006-AC-03 `og:image` の窓口が公開の LOOK の画像だけを短い共有キャッシュで返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-006 |
| 根拠 | `og:image` を署名つき URL にせず同一オリジンの窓口にした時に、公開の LOOK だけが画像を返し、非公開にした後は返さず、共有キャッシュに識別子が載らないことを確かめるため（ADR-0165） |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で公開の LOOK を開き、`og:image` の値の道を開いた後に非公開にして開き直す。応答の見出しだけを見るので幅に依らず 1 回） |
| 出どころ | 実装から推定。ユーザーの決定（Q10。推奨で進めた） |

公開の LOOK の `/look/<id>/og` を開くと、状態 200・`image/*`・`Cache-Control` が `public`・`max-age=300`・`s-maxage=300` を含み、`X-Content-Type-Options: nosniff` で、`Set-Cookie` が無いこと。LOOK を非公開にした後・存在しない id・数でない id は 404 になること。

### SEC-LOOK-007 署名の前に、画像の道筋を LOOK の画像の形に限る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-007 |
| 根拠 | service role の署名は RLS が効かないので、道筋の確かめが唯一の境界になる。DB の値が汚れても、置き場の別の物を配らないため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

署名する道筋は `looks/` の下の安全な文字（英数字で始まる英数字と `.`・`_`・`-` の階層）に限る。管理の窓口が作る形（日付の階層と uuid のファイル名）より広いのは、見本や古い行の `looks/e2e/look-1-1.png` のような道筋も署名できるようにするため。`..`・制御文字・空白・二重の `/` を含む値と、URL のホストが自分の Supabase（`NEXT_PUBLIC_SUPABASE_URL`、無ければ `SUPABASE_URL` の origin 1 つ）でない値や別のバケットの値は署名しない。素の道筋の先頭の `/` は 1 つだけ外して通す。2026-10-28 に満たした（共有の `parseOwnObjectPath`（DD-SEARCH-011）を `look-images.ts` の `signLookImageUrl` が署名の前に通す。ADR-0316）。

#### SEC-LOOK-007-AC-01 決まりの外の道筋は署名されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-007 |
| 根拠 | 汚れた道筋の署名つき URL が、公開の頁に出ないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で公開の LOOK の `image_urls` に `../other/x.png` と `other/x.png` を入れて開く） |
| 出どころ | 実装から推定 |

その LOOK の `/look/<id>` と `/look` の HTML に、`other/x.png` を指す署名つき URL が出ないこと。

### SEC-LOOK-008 署名や取り出しに失敗した時は、元の値でなく決まった代わりを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-008 |
| 根拠 | 失敗した時に守りが外れる（fail-open）と、置き場の道筋や外の URL が頁に出るため。全体の NFR-SEC-003（範囲外。入力検証）に照らした |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.5。`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

道筋にできない値・署名の失敗・関連の取り出しの失敗の時は、元の値を返さず、その画像を外すか代わりの画像（`/placeholder.png`）にし、失敗を記録する。2026-10-28 に、署名の側を満たした（`signLookImageUrl` は道筋にできない値と署名の失敗で `null` を返し、`signLookImageUrls` が結果から外す。記録は種類 `invalid_path`・`sign_failed` だけで、道筋・URL・Supabase の誤りの文を含めない。`look/server.ts` の一覧・詳細の `imageUrls` は署名した値だけで、生の `image_urls` で補わない）。画像が全部外れた LOOK は画像の無い表示になる。署名が例外を投げた時は従来どおり頁・窓口の失敗になる。

#### SEC-LOOK-008-AC-01 外の URL や署名できない値が画像の読み込み先にならない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-008 |
| 根拠 | 汚れた値が閲覧者の端末の読み込み先にならないことを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase で公開の LOOK の `image_urls` に外のサイトの URL を入れて開く） |
| 出どころ | 実装から推定 |

`/look` と `/look/<id>` の画像の `src` と `og:image` に、入れた外のサイトの URL が出ないこと。

### SEC-LOOK-009 公開の取り出しに件数の上限をかけ、表示に要る項目だけを返す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-009 |
| 根拠 | LOOK が増えても1回の表示の重さを一定に保ち、繰り返しの要求で DB と置き場の処理を使い切らせないため。全体の NFR-PERF-005・007（範囲外）にも照らした |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/security/security_review_look_id.md` |
| 優先度 | MUST |

一覧は件数の上限 100 を持ち、説明文を返さない。関連商品の価格・名前・画像は今のカードが出すので返す（Q11。2026-10-26 にユーザーが決めた）。詳細は対象の LOOK を1件で取り、前後の移動は前後の1件ずつだけを取る。直した（2026-10-26。`ADR-0159`）。シーズンの絞り込みは今の画面のまま（100 件を超えたら見直す）。

#### SEC-LOOK-009-AC-01 一覧の頁に、一覧で表示しない項目が含まれない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-009 |
| 根拠 | 端末へ渡す中身（HTML と React の受け渡しの中身）から、一覧で使わない説明文が外れたことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/look` の応答の中身（HTML と受け渡し）に、見本の LOOK の説明文の文字が含まれないこと。関連商品の価格はカードが出すので、含まれてよい。

#### SEC-LOOK-009-AC-02 上限を超える公開の LOOK があっても、一覧の1回の表示は上限まで

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-009 |
| 根拠 | 1回の表示で取る件数と署名の数に、上限が効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase に上限より多い公開の LOOK を入れる） |
| 出どころ | 実装から推定 |

`/look` を1回開いた時に表示される LOOK のカードの数が上限 100 以下であること。最も古い LOOK は一覧に並ばず、その詳細は開いて説明文が出て、1 つ新しい LOOK への PREV LOOK のリンクがあり NEXT LOOK は無効であること。

### SEC-LOOK-010 LOOK の検索の関数は件数を上限に丸め、使わない関数を閉じる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-010 |
| 根拠 | アプリを通らない RPC の直接の呼び出しでも、1回の処理の重さに上限をかけるため。使わない関数を開いたままにすると、守りの確かめの範囲が広がる |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4 |
| 優先度 | MUST |

`search_looks` は `limit_count` を上限（値は未定。`search_public_looks` は 20）に丸め、検索の文字の長さに上限を持つ。未使用（削除の判断待ち）の `search_public_looks` は anon・authenticated・PUBLIC から実行の権限を外すか消す。2026-10-26 に移行 `sec_search_functions` で満たした（`search_looks` は上限 8・検索語の先頭 100 字。`search_public_looks` は消さずに EXECUTE を外した。この移行を当てた DB でだけ満たす。DATA-SEARCH-001、ADR-0315）。

#### SEC-LOOK-010-AC-01 大きな件数を求めても上限までしか返らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-010 |
| 根拠 | 件数の丸めが DB の関数の中で効いていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に上限より多い公開の LOOK を入れ、anon の鍵で `search_looks` に `limit_count` 10000 を渡す） |
| 出どころ | 実装から推定 |

返る行の数が上限以下であること。

#### SEC-LOOK-010-AC-02 使わない検索の関数を anon が呼べない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-010 |
| 根拠 | 使わない関数の入口が閉じたことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（anon の鍵で `search_public_looks` を呼ぶ） |
| 出どころ | 実装から推定 |

anon の呼び出しが権限の誤りか、関数が無い誤りで断られること。

### SEC-LOOK-011 回数の制限の送り元は信頼できる値から取り、操作者の段を必ず持つ

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-011 |
| 根拠 | 送り元の見出しを偽るだけで制限を逃れられないようにするため。送り元の段が崩れても、操作者の段で止める。共有の `src/features/auth/middleware/rateLimit.ts`（範囲外）は 2026-10-28（波 4）に直した（送り元は `getClientIp` が Vercel の見出しだけから取る。ADR-0416） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4。`docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/security/security_review_look_id.md` |
| 優先度 | MUST |

送り元は信頼できる中継が付けた値からだけ取る。LOOK の管理の変更の窓口は、送り元の段に加えて操作者の段の制限を必ずかける。2026-10-28（波 4）に満たした。送り元は共有の `getClientIp` が Vercel の見出し（手元の E2E は固定の環境の `CLIENT_IP_HEADER` が信じる `x-real-ip`）だけから取り、`x-forwarded-for` は読まない。操作者の段は元から持つ。

#### SEC-LOOK-011-AC-01 送り元の見出しを変えても、同じ操作者の回数は止まる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-011 |
| 根拠 | 見出しを偽っても操作者の段が効くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.looks.manage` を持つ試し用の利用者の aal2 の session で、信頼する見出し `x-real-ip` を毎回変えて状態の変更を送る。固定の IP だと送り元の段が先に止めて意味が変わるので毎回変える） |
| 出どころ | 実装から推定 |

10分の中の31回目の状態の変更が 429 で断られ、LOOK の状態が変わらないこと。

### SEC-LOOK-012 管理の窓口に、大きさ・枚数・時間あたりの量の上限をかける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-012 |
| 根拠 | 置き場の容量と費用を守り、乗っ取られた session や誤った自動の操作の害を小さくするため。作成と更新を別々に数えると、上限が実際の2倍になる |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V12.1.1、V12.1.3。`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

1枚5MB、1回6枚・20MB、操作者ごとに1時間60MB（作成と更新を合わせて数える）を上限とし、数えが失敗した時は止める。一覧と1件の取得にも回数の制限をかける。今のコードは1時間の量を作成と更新で別々に数え、一覧と1件の取得に制限が無い。

#### SEC-LOOK-012-AC-01 5MB を超える画像は断られ、置き場に残らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-012 |
| 根拠 | 1枚の大きさの上限が書き込みの前に効くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で作成の窓口に送る） |
| 出どころ | 実装から推定 |

5MB を超える画像を1枚含む作成が 400 で断られ、置き場の `looks/` の下のオブジェクトの数が増えないこと。

#### SEC-LOOK-012-AC-02 7枚以上の画像は断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-012 |
| 根拠 | 1回の枚数の上限を確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

画像を7枚含む作成と更新が、どちらも 400 で断られること。

#### SEC-LOOK-012-AC-03 作成と更新を合わせた1時間の量で止まる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-012 |
| 根拠 | 作成と更新を行き来しても、1時間の量の上限を超えられないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

同じ操作者が1時間の中で作成に40MB、更新に30MB を送った時、合計が60MB を超えた要求が 429 で断られること。

### SEC-LOOK-013 画像の中身を確かめ、保存の名前と種類をサーバーが決める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-013 |
| 根拠 | 端末の申告とファイル名は送り手が自由に決められるので、そのまま信じると画像でない物や区切りを含む名前が置き場に入るため。全体の NFR-SEC-003（範囲外。入力検証）に照らした |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V12.2.1、V12.3.1 |
| 優先度 | MUST |

画像の種類は中身の先頭の印（JPEG・PNG・WebP・GIF）で確かめ、申告と食い違えば断る。保存の名前の拡張子と置き場への書き込みの種類は、確かめた種類から決め、送ったファイル名を使わない。直した（2026-10-26。管理の作成・更新の窓口。中身の確かめは置き場に書く前・1時間の量の枠を使う前に済ませ、保存名は `looks/<UTC の日付>/<uuid>.<検出した種類の拡張子>`）。

#### SEC-LOOK-013-AC-01 画像でない中身は、申告が画像でも断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-013 |
| 根拠 | 申告だけでなく中身を見ていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で、種類を `image/png` と申告した文字のファイルを作成の窓口に送る） |
| 出どころ | 実装から推定 |

作成が 400 で断られ、置き場にオブジェクトが増えないこと。

#### SEC-LOOK-013-AC-02 保存の道筋はファイル名に左右されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-013 |
| 根拠 | 送ったファイル名の区切りや拡張子が、保存の道筋に入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（名前を `a/b.html` にした PNG の画像で LOOK を作る） |
| 出どころ | 実装から推定 |

作った LOOK の `image_urls` の道筋が `looks/<日付>/<uuid>.png` の形で、`/` の数が2つで、`.html` を含まないこと。

### SEC-LOOK-014 消した・差し替えた LOOK の画像を置き場から消す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-014 |
| 根拠 | 消したはずの画像を残さず、置き場の容量をためないため。`docs/03_BasicDesign/api/api-spec.md` も削除で画像を消すと書く |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。実装から推定 |
| 優先度 | SHOULD |

削除の時はその LOOK の画像を、画像を差し替えた更新の時は古い画像を、作成・更新の途中の失敗の時は上げ終えた画像を、置き場から消す。直した（2026-10-26。管理の窓口）。順は「行を先に変える → 置き場を消す」で、消す前に道筋を1本ずつ「`looks/` の下の安全な文字だけ」で確かめる（`..`・外の URL・別の置き場・古い見本の道筋 `e2e/look-1-1.png` などは消さない側に倒れる。波 2 で見本は `looks/e2e/look-N-M.png` に移ったので、今の見本は消す対象に入る）。更新が失敗した時は、その要求で上げた新しい画像だけを消す（2026-10-26 から、行と関連が `admin_update_look` の1取引なので、関連の保存が失敗した時も行は戻り、新しい画像を消し古い画像は消さない。ADR-0163）。置き場の削除の失敗は記録（名前と符号だけ）と監査の `metadata`（`image_cleanup`・`orphaned_count`）に残すだけで、応答は変えない。

#### SEC-LOOK-014-AC-01 LOOK を消すと画像も置き場から消える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-014 |
| 根拠 | 削除の後に画像が残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で LOOK を作って消し、service role で置き場を見る） |
| 出どころ | 実装から推定 |

削除の後、その LOOK の `image_urls` の道筋のオブジェクトが置き場に無いこと。

#### SEC-LOOK-014-AC-02 画像を差し替えると古い画像が置き場から消える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-014 |
| 根拠 | 差し替えの後に古い画像が残らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

画像を差し替えた更新の後、前の `image_urls` の道筋のオブジェクトが置き場に無いこと。

### SEC-LOOK-015 LOOK と関連商品の書き換えを、1つのまとまりで行う

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-015 |
| 根拠 | 途中の失敗で、公開中の LOOK が関連商品0件や新旧の混ざった形で残らないようにするため |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。実装から推定 |
| 優先度 | SHOULD |

更新の「LOOK の行の更新・関連の全削除・関連の追加」は1つのトランザクション（DB の関数など）で行い、どれかが失敗したら全部を戻す。2026-10-26 に移行 `sec_rls_predicates_and_constraints` の DB の関数 `admin_update_look` で満たした（この移行を当てた DB で、窓口と同じ日に当てた時だけ満たす。関連の段の失敗は `LOOK_ITEMS_WRITE_FAILED` に印を付け直し、窓口は今までと同じ 500 `Failed to update linked items` を返す。API-LOOK-004、DATA-LOOK-002、ADR-0163）。

#### SEC-LOOK-015-AC-01 関連の追加が失敗しても、前の関連商品が残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-015 |
| 根拠 | 失敗した更新の後も、公開の頁が前の形のまま見えることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase で関連の追加が失敗する状態を作って更新を送る） |
| 出どころ | 実装から推定 |

更新が失敗の応答を返した後に `/look/<id>` を開くと、前のテーマと前の関連商品が表示されること。

### SEC-LOOK-016 入口の値を、決まった形で確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-016 |
| 根拠 | 形の合わない値を早く断り、誤りの返し方を揃えるため。全体の NFR-SEC-003（範囲外。入力検証）と NFR-SEC-007（範囲外。パラメータ化クエリ）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.1.3。`docs/05_Quality/reviews/security/security_review_look.md`、`docs/05_Quality/reviews/security/security_review_look_id.md` |
| 優先度 | SHOULD |

公開の詳細と管理の1件の窓口の `id` は正の整数として確かめ、合わなければ取り出しの前に断る。状態の変更の本文が JSON でない時は 400 を返す。紐づける商品の ID の重なりは除いてから数える。公開の詳細の `id` は直した（2026-10-26。`parseLookId`。形の合わない id は DB を呼ばずに見つからない扱い）。管理の1件の窓口の `id` と状態の変更の JSON の本文も直した（2026-10-26。権限と回数の確かめの後・DB に触れる前に `parseLookId` で確かめて 400 `Invalid look id`、監査には id の生の値でなく長さだけを残す。JSON が壊れた PATCH は 400 `Invalid request`）。商品 ID の重なりは今のコードは満たさない。

#### SEC-LOOK-016-AC-01 形の合わない id の詳細は「見つからない」になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-016 |
| 根拠 | 公開の入口で、形の合わない id を取り出しに渡さないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/look/abc`・`/look/1.5`・`/look/-1` を開くと、どれも「Look not found」の画面が表示されること。

#### SEC-LOOK-016-AC-02 管理の1件の窓口は数でない id を 400 で断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-016 |
| 根拠 | 管理の入口でも id の形を確かめていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で `/api/admin/looks/abc` に GET・PATCH・DELETE を送る） |
| 出どころ | 実装から推定 |

どの要求も 400 で断られること。

#### SEC-LOOK-016-AC-03 状態の変更の本文が JSON でないと 400 になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-016 |
| 根拠 | 作成・更新と同じく、形の誤りを 500 でなく 400 で返すことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/api/admin/looks/<id>` に JSON でない本文の PATCH を送ると 400 が返り、LOOK の状態が変わらないこと。

### SEC-LOOK-017 LOOK の文字はエスケープして出し、生の HTML を差し込まない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-017 |
| 根拠 | DB の文字を書き換えられても、閲覧者の端末でスクリプトを動かさないため。全体の NFR-SEC-003（範囲外。XSS・CSP）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V5.3.3。`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

テーマ・説明文・関連商品の名前は React の自動のエスケープで出し、生の HTML を差し込む書き方を LOOK の範囲で使わない。今のコードは満たす。試すテストは無い。

#### SEC-LOOK-017-AC-01 テーマと説明文のタグは文字として出る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-017 |
| 根拠 | エスケープが一覧・詳細・頁の題の全部で効くことを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase で公開の LOOK のテーマと説明文に `<script>` のタグと、画像の読み込みの誤りでスクリプトを動かす属性を入れる） |
| 出どころ | 実装から推定 |

`/look` と `/look/<id>` で、入れたタグが文字として表示され、スクリプトが動かない（ダイアログが出ず、頁に要素が増えない）こと。

### SEC-LOOK-018 管理の状態を変える要求は、送り元のオリジンを確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-018 |
| 根拠 | 他のサイトから管理者のブラウザに LOOK の変更を送らせないため。FREQ-327（範囲外）が決めた「Origin の確かめは proxy の1か所」に従う。全体の NFR-SEC-003（範囲外。CSRF）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.2.2 |
| 優先度 | MUST |

`/api/admin/looks*` の POST・PUT・PATCH・DELETE は、Origin（無ければ Referer）が許可のオリジンと合う時だけ通す。許可のオリジンは設定で持ち、要求の見出しから作らない。今のコードは確かめを持つが、設定が全く無い時に要求の見出しから比べる元を作る。本番のビルドは許可の一覧を明示させるため `APP_ALLOWED_ORIGINS` が無ければ落ちる（SEC-ABOUT-007-AC-02。2026-11-01）。

#### SEC-LOOK-018-AC-01 他のオリジンからの変更は 403 で断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-018 |
| 根拠 | 他のサイトからの要求を止めることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で、Origin を他のオリジンにした状態の変更と削除を送る） |
| 出どころ | 実装から推定 |

どの要求も 403 で断られ、LOOK が変わらないこと。

#### SEC-LOOK-018-AC-02 Origin も Referer も無い変更は 403 で断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-018 |
| 根拠 | 見出しを外した要求も止めることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

Origin と Referer を付けない状態の変更が 403 で断られ、LOOK の状態が変わらないこと。

### SEC-LOOK-019 管理の窓口は操作ごとの権限と2要素を確かめ、画面は権限で出し分ける

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-019 |
| 根拠 | 権限の無い人に LOOK を変えさせず、非公開の LOOK を見せないため。権限を役割ごとに切り替えられるようになったので、画面も役でなく権限で出す。全体の NFR-SEC-005・008（範囲外）と FREQ-316（範囲外。管理 API の認可を1つの道にまとめる）・FREQ-519（範囲外。役割ごとの操作の設定）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3、V4.3.1 |
| 優先度 | MUST |

管理の窓口の読み出しは `admin.looks.read`、変更は `admin.looks.manage` と `aal2` を求め、ログインが無ければ 401、足りなければ 403 を返す。管理の画面は `admin.looks.manage` の無い人に作成・編集・公開・削除の操作を出さない。今のコードはこれを満たす（2026-10-26 にカードの3つの操作、2026-10-28（波 4）に「新規作成」。`GET /api/admin/looks` が応答に `meta.canManage` を添え、`LookSection` が真の時だけ「新規作成」とカードのボタンを出す。`canManage` は `admin-rbac.ts` の認可の成功の結果が返す権限の集合から作り、認可は 1 回になった: ADR-0166。ADR-0161 の暫定を解いた）。

#### SEC-LOOK-019-AC-01 ログインしていない要求は 401 で断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 認証の無い要求が窓口の中に入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

session の無い状態で `/api/admin/looks` の GET・POST と `/api/admin/looks/<id>` の GET・PUT・PATCH・DELETE を送ると、どれも 401 が返ること。

#### SEC-LOOK-019-AC-02 2要素を済ませていない session は 403 で断られる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 窓口の aal2 の確かめを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.looks.manage` を持つ試し用の利用者の aal1 の session） |
| 出どころ | 実装から推定 |

aal1 の session の GET と状態の変更が、どちらも 403 で断られること。

#### SEC-LOOK-019-AC-03 権限ごとに、読み出しと変更が分かれる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 読み出しの権限だけで変更に届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（`admin.looks.read` だけを持つ役の aal2 の session） |
| 出どころ | 実装から推定 |

`/api/admin/looks` の GET が 200、`/api/admin/looks/<id>` の PATCH・DELETE が 403 になること。

#### SEC-LOOK-019-AC-04 変更の権限が無い人には、LOOK の操作のボタンが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 画面の出し分けが窓口の権限と揃っていることを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。`admin.looks.read` だけを持つ役の aal2 の session で管理の LOOK のタブを開く） |
| 出どころ | 実装から推定 |

LOOK の一覧は表示され、作成・編集・公開の切り替え・削除のボタンが表示されないこと。「新規作成」は 2026-10-28（波 4）から `LookSection` が `meta.canManage` で出すので、今のコードは満たす（E2E の印を外した）。カードの3つの操作だけは AC-05 で確かめる。

#### SEC-LOOK-019-AC-05 権限の無い人には、カードの公開の切り替え・編集・削除のボタンが出ない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 画面の出し分けが窓口の権限と揃っていることを、AC-04 から「新規作成」を除いて確かめる。AC-04 は頁全体を数え、別の部品のボタンでも赤になりうるので、こちらは一覧の区画の中だけを数える（「新規作成」は 2026-10-28 から一覧の区画の中の `LookSection` が出す） |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。`admin.looks.read` だけを持つ役の aal2 の session で管理の LOOK のタブを開き、LOOK の一覧の区画の中を数える） |
| 出どころ | 実装から推定 |

LOOK の一覧は表示され（テーマと状態の印が見える）、一覧の区画の中に「編集」「公開」「非公開」「削除」の名前のボタンとリンクが無いこと。

### SEC-LOOK-020 管理の変更は、成功も失敗も操作者と送り元とともに監査に残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-020 |
| 根拠 | 誰がいつ LOOK を公開・削除したかを後から追い、乗っ取られた session での変更を送り元から辿るため。全体の NFR-SEC-005・011（範囲外。監査ログ）に当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-18-look-review.md`、`docs/05_Quality/reviews/security/security_review_look.md` |
| 優先度 | MUST |

作成・更新・状態の変更・削除は、成功も失敗も、操作者・操作・対象・結果・送り元の IP・ブラウザの名乗りを監査に残す。2026-10-28（波 4）に満たした。`logAdminLookAudit` が共有の `getAuditRequestContext`（`getClientIp` の値。偽れる `x-forwarded-for` は読まない）を渡す。IP が取れない配置（Vercel の外で `CLIENT_IP_HEADER` が無い手元・単体）では `null` のまま保存する。以前は IP を残さないとしていた（ADR-0158）が、`ADR-0462` が置き換えた。保存期間と開示は法令対応の後回しに従う。

#### SEC-LOOK-020-AC-01 管理の変更ごとに監査の行が残る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-020 |
| 根拠 | 全部の変更の道で監査を呼んでいることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（aal2 の管理者の session で作成・更新・状態の変更・削除を1回ずつ送り、service role で監査の表を読む） |
| 出どころ | 実装から推定 |

監査の表に `resource` が `look` の行が4つ増え、それぞれに操作者の ID・操作の名前・結果が入っていること。

#### SEC-LOOK-020-AC-02 監査の行に送り元が入る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-020 |
| 根拠 | 送り元から変更を辿れることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

AC-01 の行の送り元の列が空でなく、要求に付けた信頼する見出し `x-real-ip` の値であること。同じ要求に偽の `x-forwarded-for` を付けても、その値は列に入らないこと。

### SEC-LOOK-021 応答と記録に、置き場や DB の内部の誤りの文言を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-021 |
| 根拠 | 置き場と DB の構成を外に知らせず、記録に要らない情報をためないため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | OWASP ASVS 4.0.3 V7.4.1 |
| 優先度 | SHOULD |

管理の窓口の誤りの応答は決まった文言だけを返す。記録には誤りの種類と符号だけを残し、例外や Supabase の error を丸ごと渡さない。管理の LOOK の窓口は直した（2026-10-26。置き場への書き込みの失敗は `Failed to upload image` ちょうど。`console.error` は `describeErrorForLog` で名前と符号だけ）。ただし回数の部品 `src/features/look/services/admin-rate-limit.ts` の `consumeAdminLookUploadQuota` の記録（`console.error` に error を丸ごと渡す）は、窓口の外のファイルなのでこの作業では直していない（残り。回す物）。

#### SEC-LOOK-021-AC-01 画像の書き込みの失敗は決まった文言で返る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-021 |
| 根拠 | 置き場の誤りの文言が応答に入らないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で置き場への書き込みが失敗する状態を作り、aal2 の管理者の session で作成を送る） |
| 出どころ | 実装から推定 |

応答が 500 で、`error` の値が決まった文言と一致し、置き場の返した誤りの文言を含まないこと。

### SEC-LOOK-022 取り出しの失敗を「0件」「見つからない」と分けて扱う

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-022 |
| 根拠 | 障害の間に LOOK が全部無いように見せず、運用者が障害に気づけるようにするため |
| 状態 | 推定 |
| 確かめ方 | E2E・単体テスト |
| 出どころ | ASVS 未対応付け。実装から推定 |
| 優先度 | SHOULD |

公開の一覧と詳細は、DB の取り出しの失敗を0件と分け、誤りの画面を出して記録する。公開の分は直した（2026-10-26。`LookFetchError` を投げ、`src/app/look/error.tsx` が誤りの画面を出し、記録は名前と符号だけ。前後の LOOK の取り出しだけは添え物なので失敗を握って無効の表示にする）。ホームの LOOK の区画は失敗しても空の配列でホーム全体を落とさない。管理の1件の取得は、行が無い時だけ 404、DB の失敗は 500 を返す。管理の分も直した（2026-10-26。`maybeSingle` で「無い」と「DB の失敗」を分け、1件の取得・更新・状態の変更・削除の存在確認の全部で同じにした。失敗は 500 `Failed to fetch look` で、記録は名前と符号だけ）。

#### SEC-LOOK-022-AC-01 DB の失敗の時、公開の一覧は「LOOK が無い」ではなく誤りの画面を出す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-022 |
| 根拠 | 障害と0件の見分けが、利用者の見える所で付くことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。手元の Supabase の `looks` の読み出しが失敗する状態を作る） |
| 出どころ | 実装から推定 |

`/look` を開くと誤りの画面が表示され、LOOK が0件の時の表示にならないこと。

#### SEC-LOOK-022-AC-02 管理の1件の取得は、DB の失敗を 404 にしない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-022 |
| 根拠 | 管理の画面で「無い」と「取れない」を分けるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

AC-01 と同じ状態で、aal2 の管理者の session の `/api/admin/looks/<id>` の GET が 500 を返すこと。

### SEC-LOOK-023 表の段で LOOK の長さと画像の道筋の形を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-LOOK-023 |
| 根拠 | 窓口を通らない PostgREST の直接の書き込みでも、上限の無い長さの文字や置き場の外を指す画像の道筋を表に入れさせないため。窓口の確かめ（DRV-LOOK-009）と同じ線を DB にも引く |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V5.1.4（当てはめは推定） |
| 優先度 | SHOULD |

`looks` に、`theme` は1〜200字・`theme_description` は4000字までの CHECK と、`image_urls` の要素が置き場の中の `looks/` の下の道筋（`looks/` に続く、英数字で始まる英数字・`.`・`_`・`-` の階層。`..`・`//`・先頭の `/`・`.` で始まる階層・URL は外れる。窓口の `isOwnLookImagePath` と同じ式）である CHECK を持たせる。上限の値は窓口の入力の形（`src/app/api/admin/looks/route.ts` の `createLookSchema`）とそろえる。2026-10-26 に移行 `sec_rls_predicates_and_constraints` で `NOT VALID` の CHECK として満たした（この移行を当てた DB でだけ満たす。既存の行は検査しないので、本番の旧い行の点検と `VALIDATE` は別の移行。DATA-LOOK-001、ADR-0162）。

#### SEC-LOOK-023-AC-01 長すぎるテーマと置き場の外の道筋を表が断る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-023 |
| 根拠 | 窓口を通らない書き込みでも、表の段で値が止まることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に service role で insert を送る） |
| 出どころ | 実装から推定 |

201字のテーマの insert と、`image_urls` に `other/x.png` を含む insert が、どちらも CHECK の違反で断られ、行が増えないこと。

## 派生要件

要件が求めていないのに今のコードがしている動き。根拠はコードがそうしている理由で、記録が無い物は推定。守り（回数の制限・監査・署名の失敗の扱い・権限）はセキュリティ要件で扱い、ここには書かない。

### DRV-LOOK-001 公開の LOOK を作った日時の新しい順に並べ、詳細の前後もこの並びで決める

| 属性 | 値 |
| --- | --- |
| 根拠 | 新しいシーズンの LOOK を先に見せるため（推定）。FR-LOOK-ALL-001・FR-LOOK-DETAIL-003 は並びを書いておらず、LOOK の表に公開日の列も無いので、作った日時で並べる |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/lib/look/server.ts` の公開の LOOK の取り出し） |

一覧・ホーム・詳細の前後・管理の一覧の全部が、作った日時（created_at）の新しい順。古い LOOK を後から先頭に出す手段は無い。

### DRV-LOOK-002 シーズンの絞り込みは1つだけを選び、URL の season に残す

| 属性 | 値 |
| --- | --- |
| 根拠 | 選択肢が ALL・SS・AW の3つで、SS と AW を両方選ぶと ALL と同じになるため1つに絞った（推定）。絞った状態を共有・保存・戻るで同じに戻せるよう URL に残す |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md` の FR-LOOK-ALL-006 のレビューの注（「MultiSelect で単一シーズンを切り替える」）、実装から推定 |

複数を選ぶ部品（MultiSelect）を使うが、最後に選んだ1つだけを残す。全部を外すと ALL。ALL の時は URL の season を消す。URL の値は前後の空白を除いて大文字にし、ALL・SS・AW 以外は ALL として扱う。年は見ず、SS か AW かだけで絞る（2026 SS と 2027 SS は一緒に出る）。

### DRV-LOOK-003 モバイル・タブレットの FILTER のバーをヘッダーの真下に付け、PC の左のフィルターをヘッダーの真下に留める

| 属性 | 値 |
| --- | --- |
| 根拠 | スクロールしても絞り込みにすぐ届くようにし、NEWS の一覧と同じ動きにするため（推定。NEWS は DRV-NEWS-002・003 に同じ動きを書いた） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/look/components/PublicLookGrid.tsx`） |

バーの位置はヘッダーの高さとずれの変数（`--site-header-offset`・`--site-header-height`）で決め、ヘッダーの隠れる動きに合わせて動く。初めの表示ではバーと同じ高さの見えない置き物で先頭のカードとの重なりを防ぐ。

### DRV-LOOK-004 一覧と詳細に出す関連商品は公開中の商品だけにする

| 属性 | 値 |
| --- | --- |
| 根拠 | 非公開の商品の名前・価格・頁へのリンクを訪問者に見せないため（推定）。関連商品が無い時に運用の言葉を出さないのは UI/UX レビュー L-7 の直し |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_look.md`（L-7）、実装から推定（`src/lib/look/server.ts`） |

紐づけの中で公開中でない商品は飛ばす。カードは関連商品が無いと罫線と並びを出さない。詳細は「紐づけ商品はありません」を出す。関連の取り出しに失敗した時は関連商品なしとして出す。

### DRV-LOOK-005 LOOK の画像を期限1時間の署名つき URL にして出す（公開の頁を含む）

| 属性 | 値 |
| --- | --- |
| 根拠 | 画像の置き場を非公開にした後も画面で画像を出すため、DB には置き場の中の道筋だけを持ち、出すたびに署名する（コードのコメントと非公開にした移行）。期限を1時間にした理由の記録は無い（推定） |
| 状態 | 推定 |
| 出どころ | `migrations/030_make_look_images_bucket_private.sql`、実装から推定（`src/lib/storage/look-images.ts`） |

一覧・ホーム・詳細・管理の一覧と1件の取り出しの全部で署名つき URL を出す（詳細の OG の画像は署名つき URL でなく、同一オリジンの `/look/<id>/og`。SEC-LOOK-006、ADR-0165。2026-10-28）。画像が無い LOOK は代わりの画像（`/placeholder.png`）を出す。道筋にできない値と署名の失敗では元の値を返さず、その画像を外す（SEC-LOOK-007・008。2026-10-28）。

### DRV-LOOK-006 無い LOOK の詳細は同じ URL で状態 200 の画面を返す

| 属性 | 値 |
| --- | --- |
| 根拠 | 404 の頁に飛ばさず、その場で知らせを出すため（推定）。画面の一覧は「同じルートに未存在表示」と書く |
| 状態 | 推定 |
| 出どころ | `docs/03_BasicDesign/ui/screen-list.md`、実装から推定（`src/app/look/[id]/page.tsx`） |

公開でない・無い・数でない ID は全部、見出し「Look not found」だけの画面を状態 200 で返す。title は「Look not found | Le Fil des Heures」、description は「指定されたルックは見つかりませんでした。」。

### DRV-LOOK-007 一覧の空の状態の文と、絞った結果0件の時の「すべて見る」

| 属性 | 値 |
| --- | --- |
| 根拠 | 何も出ない画面だと LOOK が無いのか壊れているのか分からないため、場合ごとに文を出し、絞り込みで0件の時は戻る手段を置く（UI/UX レビュー L-4 の直し） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_look.md`（L-4）、実装から推定 |

公開の LOOK が無い時は「公開中のLOOKがありません」（ホームの区画も同じ）。絞った結果が0件の時は「該当シーズンのLOOKがありません」と、ALL に戻す「すべて見る」のボタンを出す。取り出しに失敗した時も公開の LOOK が無い時と同じ文になる。

### DRV-LOOK-008 管理の LOOK タブの一覧で公開・非公開を切り替える

| 属性 | 値 |
| --- | --- |
| 根拠 | 作った LOOK を直さずに出し入れできるようにするため（推定）。FR-ADMIN-005 は状態の切り替えを挙げていない（ニュースの FR-ADMIN-003 は挙げる） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/components/LookSection.tsx`、`src/app/api/admin/looks/[id]/route.ts`） |

各カードの「公開」「非公開」のボタンで状態（published・private）だけを変え、一覧を取り直す。失敗した時は「ステータスの更新に失敗しました」を出す。

### DRV-LOOK-009 管理の入力の決まり

| 属性 | 値 |
| --- | --- |
| 根拠 | 壊れた値や大きすぎる画像で LOOK の表と画像の置き場が汚れないよう、窓口で形を決めて断るため（推定）。回数の制限と1時間の量の上限は守りなので SEC で扱う |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/api/admin/looks/route.ts`、`src/app/api/admin/looks/[id]/route.ts`、`src/features/look/services/admin-rate-limit.ts`） |

シーズンの年は 2000〜2100 の整数、シーズンは SS か AW、テーマは前後の空白を除いて1〜200字、説明は4000字まで、状態は private か published。紐づける商品は1つ以上で、全部が商品の表にあること（公開かどうかは見ない）。作る時は画像が1枚以上要る。画像は JPEG・PNG・WebP・GIF（送られた種類の申告と、中身の先頭の印の両方が合うこと。SEC-LOOK-013）で1枚 5MB まで、1回に6枚・合わせて 20MB まで。合わない時は 400 で断る。

### DRV-LOOK-010 直す時に画像を付ければ全部を差し替え、付けなければ元の画像のまま

| 属性 | 値 |
| --- | --- |
| 根拠 | フォームで画像を選び直した時だけ置き換え、文字だけを直す時に画像を上げ直さなくて済むようにするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/api/admin/looks/[id]/route.ts`） |

新しい画像を1枚でも付けると、前の画像の並びを全部捨てて新しい画像だけにする（足すのではない）。前の画像は、行を新しい並びに変えた後に置き場から消す（SEC-LOOK-014）。紐づけは全部消してから入れ直す。画像の保存の道筋は「looks/<日付>/<ランダムな ID>.<中身から検出した種類の拡張子>」。

### DRV-LOOK-011 削除の前に確かめ、LOOK の行を消し、その画像を置き場から消す

| 属性 | 値 |
| --- | --- |
| 根拠 | 押し間違いで LOOK を消さないため、消す前に確かめる（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/components/LookSection.tsx`、`src/app/api/admin/looks/[id]/route.ts`）。`docs/03_BasicDesign/api/api-spec.md` は「画像を削除」と書く（2026-10-26 から実装も消す） |

「このLOOKを削除してもよろしいですか？」で確かめ、LOOK の行を消して一覧を取り直す。行を消した後に、その LOOK の画像を置き場から消す（SEC-LOOK-014。自分の置き場の `looks/` の下の道筋だけ）。無い LOOK は 404。失敗した時は「LOOKの削除に失敗しました」を出す。

### DRV-LOOK-012 管理の一覧の並びと見せ方

| 属性 | 値 |
| --- | --- |
| 根拠 | 新しい LOOK を上に出し、状態と中身を一目で見て直しに入れるようにするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/components/LookSection.tsx`、`src/app/api/admin/looks/route.ts`） |

作った日時の新しい順の格子。各カードに1枚目の画像（無ければ代わりの画像）・状態のタグ（公開中・非公開）・シーズン・テーマと、公開の切り替え・編集・削除のボタンを出す。読み込み中は「読み込み中...」。0件の時と取り出しに失敗した時は同じ「LOOKがありません」を出す（失敗を0件と区別しない）。「新規作成」とカードの3つのボタンは、窓口の応答の `meta.canManage` が真の時だけ出す（SEC-LOOK-019-AC-04・AC-05。読み込み中・失敗・`meta` なし・偽は出さない。「新規作成」は 0 件でも出す）。窓口は変更のたびに権限をもう一度確かめる。

### DRV-LOOK-013 管理の作成と編集を別の頁にし、編集の頁は LOOK を取り出して初めの値を入れる

| 属性 | 値 |
| --- | --- |
| 根拠 | 作成と編集で同じ入力のフォームを使い回し、編集の時だけ今の値を入れて始められるようにするため（推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/admin/look/create/page.tsx`、`src/app/admin/look/edit/[id]/page.tsx`） |

`/admin/look/create` は空のフォームを出す。`/admin/look/edit/[id]` は1件を取り出し、読み込み中は「読み込み中...」、取り出しに失敗した時は「LOOKの取得に失敗しました」（窓口の文があればそれ）を出し、取れたら今の値と画像をフォームに渡す。2つの頁は画面で権限を確かめず、窓口が止める。

## 未確認事項

- 一覧のモバイルの左右の余白: FREQ-141-REQ-01 を 2026-11-07 に今のコード（0）に直した（決着）
- 情報パネルのテーマの文字の大きさ: FREQ-139-REQ-01 は 2026-11-07 に今の CSS の値に直した（決着）。E2E FR-LOOK-ALL-026 の赤は、文字の側が `.reveal-mask` に入って検索の道がずれたことと、モバイルの比の期待が 1.5 倍以上だったことが原因だった。FR-LOOK-ALL-029（4件）・FR-LOOK-DETAIL-002（1件）の赤は、どの条件で落ちるかを確かめていない
- 公開の LOOK を見る要求 `SR-LOOK-001`・`002` と、FR-ADMIN-005 を FREQ-17 につないだことの確認。FREQ-11 を SR の代わりに上位にするか（FREQ-11-AC-01 の「関連コーディネート」が何を指すか）
- FREQ-12（ほかの利用者のコーディネート）は実装が無い。残すか廃止にするか
- FR-LOOK-ALL-003（COULD）のページング・無限スクロールを作るか。今は全件を一度に出す
- 後の行が前の行を置き換えた所（FREQ-55・127・137・140・179〜183・288 など）は、元の行に置き換えの印が無い。この文書では「推定」にした。後の行が「置換」「取り消し」と明記した FREQ-136-AC-02・FREQ-143-REQ-03・AC-03・FREQ-182-AC-03 だけを「廃止」にしたが、ユーザーの確認は受けていない
- シーズンの絞り込みを1つにすること・年を見ないこと（DRV-LOOK-002）を要件として認めるか
- FREQ-17-AC-01・FREQ-11-AC-01 の「エラーが発生せず」を何で確かめるか。管理の LOOK を試す E2E は無い
- 本番の画像の置き場（`look-images`）の公開の設定は移行（`migrations/030_make_look_images_bucket_private.sql`）で非公開にしたが、本番の今の設定は確かめていない
