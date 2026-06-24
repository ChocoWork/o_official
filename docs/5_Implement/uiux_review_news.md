# NEWS（一覧）UI/UX レビュー

- 対象: [src/app/news/page.tsx](../../src/app/news/page.tsx) / 実体 [src/features/news/components/PublicNewsGrid.tsx](../../src/features/news/components/PublicNewsGrid.tsx)（catalog variant）
- 共通 Header/Footer は [uiux_review_home.md](./uiux_review_home.md) を参照
- レビュー基準: `implement-uiux` + ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| 未対応 | 未着手 |
| 対応中 | 一部対応・設計検討中 |
| 対応済 | 修正完了 |

---

## ペルソナ適合サマリー

NEWS は brand.md の「透明性（note/blog）」に相当し、**コアペルソナの信頼形成（思想・制作過程）に効く**。テキストリスト + スケルトン + 罫線ホバーの作りは端正。改善余地は**見出し不在・日付フォーマット・記事の入口情報量**。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| N-1 | catalog全体（[news/page.tsx:34-42](../../src/app/news/page.tsx#L34-L42)） | ページ見出し(h1)が無い（SectionTitleはhomeのみ）。現在地不明・h1欠如。視覚的階層/メンタルモデル | 「NEWS」見出し(h1)を一覧上部に追加 | High | 対応済 |
| N-2 | 記事タイトル要素（[PublicNewsGrid.tsx:346-351](../../src/features/news/components/PublicNewsGrid.tsx#L346-L351)） | 一覧の記事タイトルが `h4`。ページに h1〜h3 が無いため**見出し階層が飛ぶ**（WCAG 1.3.1 / 2.4.6） | h1（ページ）→ h2/h3（記事）の階層に修正 | Mid | 対応済 |
| N-3 | 日付（[PublicNewsGrid.tsx:334](../../src/features/news/components/PublicNewsGrid.tsx#L334)） | `published_date.replace(/-/g, '.')` の手動整形で、`<time datetime>` セマンティクスが無い。アクセシビリティ/SEO | `<time dateTime>` を使い、表示は据え置き | Low | 対応済 |
| N-4 | 記事カード（[PublicNewsGrid.tsx:315-363](../../src/features/news/components/PublicNewsGrid.tsx#L315-L363)） | サムネイル画像が無くテキストのみ。NEWSは制作過程/世界観の発信源で、視覚が無いと回遊が弱い。図と地/対比 | 任意でアイキャッチ画像列を追加（あるニュースのみ） | Mid | 対応済 |
| N-5 | カテゴリフィルタ（[PublicNewsGrid.tsx:475-490](../../src/features/news/components/PublicNewsGrid.tsx#L475-L490)） | LOOK同様、1項目フィルタのため専有サイドバーが空疎・左右非対称。整列/余白 | 上部の横タブ/セグメント化を検討 | Low | 対応済 |
| N-6 | 本文プレビュー（[PublicNewsGrid.tsx:353-361](../../src/features/news/components/PublicNewsGrid.tsx#L353-L361)） | `content` 生テキストを line-clamp。Markdown等の記法がそのまま出る懸念。可読性 | プレーン要約（抜粋/description）を別途用意して表示 | Low | 対応済 |
| N-7 | 罫線ホバー演出（[PublicNewsGrid.tsx:317-323](../../src/features/news/components/PublicNewsGrid.tsx#L317-L323)） | 4辺アニメ + delay-500 で全体 1s 級。Doherty/控えめ原則に対しやや過剰 | duration短縮 or 下線のみへ簡素化（ブランドの静けさ維持） | Low | 対応済 |

---

## 良い点（維持）

- **スケルトンローディング実装済み**（[PublicNewsGrid.tsx:393-407](../../src/features/news/components/PublicNewsGrid.tsx#L393-L407)）。CLS防止・Doherty 的に良い手本（ITEM一覧もこれに統一すべき）。
- 空/エラー/0件で文言を出し分け（状態設計が丁寧）。
- 日付+カテゴリTag+タイトル+抜粋の情報設計は端正でブランド適合。

---

## implement-uiux に「あえて従わない」判断

- **エラー文の赤（`text-red-500`）は許容**（[PublicNewsGrid.tsx:385](../../src/features/news/components/PublicNewsGrid.tsx#L385)）。モノクローム原則の例外として「重大失敗の最小限の赤」は可読性のため可。ただし多用しない。
- **サムネ無しのテキスト主体リスト（N-4）はエディトリアル表現として一定の妥当性**があり、必須ではない。世界観発信を強めたい場合のみ画像追加。

---

## 修正反映（2026-06-23）

- **N-1**: `news/page.tsx` に「NEWS」h1 を一覧上部へ追加。
- **N-2**: 記事タイトルを `h4` → variant連動（catalog=`h2`／home=`h3`）に変更。ページ h1（catalog）/ SectionTitle h2（home）からの階層飛びを解消。
- **N-3**: 日付を `<time dateTime={published_date}>` 化（表示は `.` 区切りのまま据え置き）。
- **N-4**: `image_url` を持つ記事のみ、sm+ で小サムネイル（next/image・object-cover）を右側に表示（任意・装飾 alt 空）。
- **N-5**: 上部横タブ化は見送り、**多カテゴリのサイドバーフィルタを現状維持**（ITEM/LOOK カタログと同一の、直近で継続的に調整済みのフィルタUI。NEWS は SEASON 1項目の LOOK と異なり複数カテゴリを持つためサイドバーが空疎になりにくく、単独でレイアウト変更すると横断的な一貫性を損なうため）。`あえて従わない` 判断として記録。
- **N-6**: プレビュー本文に `toPlainPreview()`（軽量 Markdown 除去）を適用し、記法のまま表示される懸念を解消。
- **N-7**: 4辺＋`delay-500` の約1秒アニメを、上下の横ライン（`duration-300`）のみへ簡素化。
- 実装: [src/features/news/components/PublicNewsGrid.tsx](../../src/features/news/components/PublicNewsGrid.tsx) / [src/app/news/page.tsx](../../src/app/news/page.tsx)。

---

## 総評（NEWS）

状態設計・スケルトンは良質。**見出し(h1)と階層（N-1/N-2）** を整え、信頼形成のために**サムネ/要約（N-4/N-6）** を足すと、透明性ページとしての訴求が上がる。
