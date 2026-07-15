# UI/UX レビュー総括（Admin以外 全ページ）

- 対象: 一般顧客向け全ページ（Admin配下を除く）
- 基準: `implement-uiux`（デザイン4原則 / ゲシュタルト / UX法則 / 黄金比 / WCAG 2.2 AA / インタラクション）+ ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）
- 各ページの詳細は個別ファイル参照。**共通 Header/Footer の指摘は [uiux_review_home.md](./uiux_review_home.md)（C-1〜C-10）に集約**。

---

## ページ別レビュー一覧

| ページ | ファイル | High件数の主因 |
|---|---|---|
| HOME（+共通H/F） | [uiux_review_home.md](./uiux_review_home.md) | ヒーロー訴求不在/誤字/共通ナビ・SNS不具合 |
| ABOUT | [uiux_review_about.md](./uiux_review_about.md) | 差別化の言語化不在/締めCTA無し |
| ITEM 一覧 | [uiux_review_item.md](./uiux_review_item.md) | h1不在/0件時の回復導線無し |
| ITEM 詳細 | [uiux_review_item_id.md](./uiux_review_item_id.md) | 素材・ケア・受注情報の構造化不足 |
| LOOK 一覧 | [uiux_review_look.md](./uiux_review_look.md) | h1不在 |
| LOOK 詳細 | [uiux_review_look_id.md](./uiux_review_look_id.md) | breadcrumb不統一/空description |
| NEWS 一覧 | [uiux_review_news.md](./uiux_review_news.md) | h1不在/見出し階層 |
| NEWS 詳細 | [uiux_review_news_id.md](./uiux_review_news_id.md) | 本文表現力（良ベース） |
| STOCKIST | [uiux_review_stockist.md](./uiux_review_stockist.md) | h1不在/地図・電話リンク無し |
| CART | [uiux_review_cart.md](./uiux_review_cart.md) | ローディング演出/操作ターゲット小 |
| CHECKOUT | [uiux_review_checkout.md](./uiux_review_checkout.md) | ステップ表記/確定順序/空カードガード |
| WISHLIST | [uiux_review_wishlist.md](./uiux_review_wishlist.md) | 削除ボタンがタッチで不可視 |
| SEARCH | [uiux_review_search.md](./uiux_review_search.md) | 配色・角丸がブランド不一致 |
| LOGIN | [uiux_review_login.md](./uiux_review_login.md) | ページ枠/見出し不在 |
| ACCOUNT | [uiux_review_account.md](./uiux_review_account.md) | 履歴→詳細の導線欠落 |
| 注文詳細 | [uiux_review_account_orders_id.md](./uiux_review_account_orders_id.md) | UIから到達不能 |
| CONTACT | [uiux_review_contact.md](./uiux_review_contact.md) | エラー二重/モーダルfocus（良ベース） |
| TERMS | [uiux_review_terms.md](./uiux_review_terms.md) | 見出し階層/内容の正確性 |
| PRIVACY | [uiux_review_privacy.md](./uiux_review_privacy.md) | 見出し階層/プレースホルダ連絡先 |
| AUTH callback | [uiux_review_auth_callback.md](./uiux_review_auth_callback.md) | 失敗時の回復CTA |
| AUTH verified | [uiux_review_auth_verified.md](./uiux_review_auth_verified.md) | 青リンク等ブランド逸脱 |
| PASSWORD RESET | [uiux_review_auth_password_reset.md](./uiux_review_auth_password_reset.md) | パスワード入力体験 |
| /ui（内部） | [uiux_review_ui.md](./uiux_review_ui.md) | 本番露出（スコープ判断あり） |

---

## 実装進捗（2026-06-20）

レビュー後、以下を実装済み（各ページの「修正反映」節に詳細）。

| 区分 | 内容 | 状態 |
|---|---|---|
| ブランド言語化 | HOME ヒーロー直下に CONCEPT 節 / 誤字修正（H-1/H-2/H-7） | 対応済 |
| ブランド言語化 | ABOUT に Philosophy＋創業者の言葉＋Our Commitments＋締めCTA（A-1/A-2/A-3） | 対応済 |
| PDP構造化 | 素材（原産国）/縫製地域/ケア の構造化表示 + SS/AW（年廃止）。DBマイグレーション055を**本番適用済**（ID-1/ID-2） | 対応済 |
| 共通不具合 | ヘッダーアイコンのタップ領域(縦44px)＋aria-label（C-2/C-3） | 対応済 |
| 共通不具合 | SNSを実リンク化・一元管理（IG稼働、TikTok/X はURL未開設で非表示）（C-4/C-6/C-7） | 対応済 |
| 共通不具合 | 購入履歴→注文詳細リンク（AC-1）/ ウィッシュ削除のタッチ可視化（WL-1） | 対応済 |
| 決済 | PaymentElement がカードのみ→全手段表示に修正（要 Stripe ダッシュボード有効化） | 対応済 |
| 法務 | TERMS 決済手段/受注生産返品/日付/見出し（TM-1〜4）・PRIVACY 連絡集約/Cookie・Stripe/日付/見出し（PV-1〜5） | 対応済 |
| 法務 | 特定商取引法に基づく表記ページ /legal 新設＋フッターリンク（一部 ※要記入） | 対応済（要記入残） |

### デプロイ前の要対応（ユーザー作業）
- **Stripe ダッシュボード**で PayPay・コンビニ払いを有効化（未有効だとカードのみ表示）。
- **/legal の「※要記入」**（販売事業者名＝運営者氏名 / 運営統括責任者 / 発送日数）を実値で記入。所在地・電話は「請求時開示」運用で記載済み（方針変更可）。
- **SNS**: TikTok・X の URL を [src/lib/social.ts](../../src/lib/social.ts) に追記すると自動表示。
- **DBマイグレーション055**は本番（pjidrgofvaglnuuznnyj）へ適用済み。既存ITEMは新項目が空のため、管理画面から順次再入力で構造化表示に切替。

---

## ブランド適合の総評（ターゲットに刺さるか）

ブランドの世界観（**モノクローム / 余白 / Didot / 静謐**）の方向性は、コアペルソナ「中原玲央」および準ペルソナA/Cに**正しく刺さる方向**。一方で、購買を決める3つの「刺さる言葉」が UI に出ていない:

1. **「長く着られるデザイナー服」** → HOME/ABOUT/PDP で言語化が弱い（[H-1](./uiux_review_home.md) / [A-1](./uiux_review_about.md) / [ID-1](./uiux_review_item_id.md)）
2. **「天然繊維100%で洗える」** → PDPに構造化スペックが無い（[ID-1](./uiux_review_item_id.md) / [ID-2](./uiux_review_item_id.md)）
3. **「思想のある服」** → 制作過程・透明性の発信（NEWS/ABOUT）が手薄（[A-1](./uiux_review_about.md) / [ND-1](./uiux_review_news_id.md)）

> 世界観の“見た目”は出来ている。足りないのは**「思想・素材・受注生産」を言葉と情報設計で証明する**こと。これがコアペルソナの「信頼→購入」を完成させる最大のレバー。

---

## implement-uiux に「あえて従わない」共通判断（全ページ通底）

| # | スキルの一般指針 | 本ブランドの判断 | 理由 |
|---|---|---|---|
| 1 | 有彩色のセマンティックパレット（primary=青、success=緑、warning=黄、error=赤） | **採用しない**（赤のみ重大エラーで最小限許容） | Key Color は黒/グレー/白の3色。準ペルソナAは「色展開が派手」を買わない理由に挙げる。状態はアイコン+テキスト+太さ+罫線で表現 |
| 2 | 本文最小16px | **ラベル/キャプションの小型は維持**、ただし**意思決定情報（価格/在庫/フォームのラベル・エラー/法務本文/記事本文）は可読下限を担保** | editorial な小型タイポはブランド表現。だが可読性が必要な情報は部分的に底上げ（部分的逸脱） |
| 3 | primary CTA を色・サイズで突出 | **抑制を維持**。塗り(黒ベタ) vs 枠線/テキストの“質”で優先度表現。1画面1主役は遵守 | ラグジュアリーミニマルでは派手なCTAが世界観を損なう |
| 4 | 表現的なローディング/マイクロインタラクション | **静かなスケルトン中心**に。150–300msの控えめな演出 | 「静かで強い世界観」維持（例: CARTの全画面黒バー演出は過剰） |

> 逆に**ブランドと無関係に必ず従うべき**項目（全ページ共通の品質前提）: タッチターゲット44px / label-input紐付け / alt / フォーカス可視化 / コントラスト下限 / 「原因+解決策」のエラー / 空状態に次アクション / 見出し階層（h1→h2→…）。

---

## 横断する重大テーマ（優先対応リスト）

### A. まず直すべき「機能不全・到達不能」（High）

| 項目 | 場所 | 参照 |
|---|---|---|
| ヘッダーアイコンのタップ領域が当たらない（`icon-flame` 誤字） | 全ページ共通 | [C-2](./uiux_review_home.md) |
| ヘッダーアイコンに aria-label 無し | 全ページ共通 | [C-3](./uiux_review_home.md) |
| ドロワー/フッターのSNSが機能しない（onClick無/`href="#"`） | 全ページ共通 | [C-4](./uiux_review_home.md) / [C-6](./uiux_review_home.md) |
| 購入履歴→注文詳細のリンク欠落（詳細が到達不能） | ACCOUNT / 注文詳細 | [AC-1](./uiux_review_account.md) / [OD-1](./uiux_review_account_orders_id.md) |
| ウィッシュリスト削除がタッチ端末で不可視 | WISHLIST | [WL-1](./uiux_review_wishlist.md) |
| 開発用 `/ui` が本番公開ナビに露出 | 共通 / /ui | [C-1](./uiux_review_home.md) / [UI-1](./uiux_review_ui.md) |

### B. 一覧ページ共通の「見出し(h1)不在」（High/Mid）

ITEM/LOOK/NEWS/STOCKIST の一覧は `SectionTitle` が home variant 専用のため**可視の h1 が無い**（現在地不明・WCAG・SEO不利）。
→ [I-1](./uiux_review_item.md) / [L-1](./uiux_review_look.md) / [N-1](./uiux_review_news.md) / [S-1](./uiux_review_stockist.md)

### C. ブランド適合（情報の言語化・配色統一）

- ブランド差別化の言語化: [H-1](./uiux_review_home.md) / [A-1](./uiux_review_about.md) / [ID-1](./uiux_review_item_id.md)
- HOME 誤字「普遂的」: [H-2](./uiux_review_home.md)
- 配色逸脱（青/緑/ベージュ/角丸）: [SR-1/SR-2](./uiux_review_search.md) / [VF-1](./uiux_review_auth_verified.md) / 各ページの green/red 系
- SNSチャネル: brand.md は TikTok/Instagram/note が核だが実装は IG/FB/X（TikTok欠落）: [C-7](./uiux_review_home.md)

### D. 空状態・エラー回復・確認の不足（Mid）

- 一覧0件時のリセット導線: [I-2](./uiux_review_item.md) / [L-4](./uiux_review_look.md)
- 破壊的操作の確認ダイアログ: [AC-3/AC-4](./uiux_review_account.md)
- 法務/規約の正確性（決済手段・受注生産の返品・日付・連絡先）: [TM-2〜TM-4](./uiux_review_terms.md) / [PV-2/PV-4](./uiux_review_privacy.md)

---

## 推奨対応順序

1. **機能不全（A）** — タップ領域/aria/死にリンク/到達不能/`/ui`露出（ユーザーが操作できない・壊れている）
2. **一覧h1（B）** — 4一覧ページに見出し追加（横断で一括対応可能）
3. **ブランド言語化（C）** — HOME/ABOUT/PDP に「素材・受注生産・洗える・思想」を表出＋誤字修正＋配色統一
4. **空状態/確認/法務正確性（D）** — 回復導線・確認ダイアログ・規約整合

---

## 注記

- 各ファイルのステータスは全て「未対応」（本レビュー時点）。修正実施時に各表の「修正ステータス」を更新する運用を想定。
- 本レビューは静的コード読解ベース。実機/スクリーンリーダー/各ブレークポイント実測での確認を別途推奨（特にコントラスト比とタッチターゲットは実測で最終判定）。
