---
name: implement-uiux
description: 最強のUI/UXを構築するスキル。デザイン4原則・ゲシュタルト原則・UX法則・黄金比・アクセシビリティ・インタラクションデザインを網羅し、ユーザー中心の卓越したUIを実装する。
---

# /implement-uiux

認知心理学・視覚デザイン・インタラクション設計の全原則を統合した最強UI/UX実装スキル。ユーザーが「考えずに使える」インターフェースを構築する。

---

## 呼び出し方

```
/implement-uiux                          # タスク内容からUI/UX設計・実装を行う
/implement-uiux <component>              # 特定コンポーネントのUI/UXを最適化
/implement-uiux --audit                  # 既存UIをUI/UX原則で診断
/implement-uiux --spec                   # 実装前に設計仕様を作成してから進む
```

---

## このスキルを呼び出すべき状況

- コンポーネント・ページ・フローの新規実装
- 既存UIの改善・リファクタリング
- ユーザーが迷う・離脱する問題の解決
- アクセシビリティ対応（WCAG 2.2 AA/AAA）
- レスポンシブ・モバイル対応

---

## 実装前に必ず確認すること

### Step 0 — ユーザーとコンテキストの理解

実装する前に以下を把握する:

1. **誰が使うか** — 年齢層・デバイス・技術リテラシー・障害の有無
2. **何を達成したいか** — ユーザーのゴール（タスク完了・情報取得・購入）
3. **どこで使うか** — モバイル/デスクトップ比率・接続速度・使用環境
4. **成功の測定基準** — タスク完了率・エラー率・離脱率・滞在時間

これらが不明な場合は実装前にユーザーに質問する。

---

## Layer 1 — デザイン4原則（視覚的基盤）

fare.blue/2020/03/design-4rule/ の原則。すべてのレイアウトはこれを土台にする。

### 1. 近接（Proximity）

**関連する要素を物理的に近づけ、無関係な要素とは明確に離す。**

実装ルール:
- フォームのラベルと入力欄は 4–8px 以内に配置
- 関連するボタングループは 8px、無関係なセクションは 24–48px 以上離す
- カード内要素は外部要素より内部で密に
- `gap`・`margin` で関係性を空間で表現する

```css
/* 良い例 */
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-group { display: flex; flex-direction: column; gap: 16px; }
.form-section + .form-section { margin-top: 40px; }
```

### 2. 整列（Alignment）

**要素に見えないグリッドラインを持たせ、透明な秩序を作る。**

実装ルール:
- 8px グリッドシステムを基準にすべてのサイズ・間隔を設定
- テキストは基本的に左揃え（RTL言語を除く）
- 中央揃えは見出し・CTA・ヒーローセクションのみに限定
- アイコンとテキストは垂直中央揃え（`align-items: center`）
- コンテンツ幅は最大 `max-w-prose`（65ch 程度）に抑える

### 3. 反復（Repetition）

**同じ種類の要素は同じビジュアルルールで一貫して表現する。**

実装ルール:
- ボタンのスタイルは variant 3種以内（primary / secondary / ghost）
- 同一カテゴリのアイコンはサイズ・スタイルを統一（16px or 20px or 24px）
- カードコンポーネントは全ページで同一パターン
- フォント使用は最大 3 書体まで（見出し・本文・コード）
- カラーパレットは Design Token として一元管理

### 4. 対比（Contrast）

**情報に優先度をつけ、重要度をビジュアルで即座に伝える。**

実装ルール:
- 1つのビュー内でフォントサイズのコントラスト比を最低 1.5:1 確保
- プライマリCTAは視覚的に突出させる（色・サイズ・余白）
- 背景と本文テキストのコントラスト比: 最低 4.5:1（WCAG AA）
- 大見出しと本文のサイズ差: 最低 2 段階（例: 32px vs 16px）
- 強調はボールドか色のどちらか一方を選ぶ（両方使わない）

---

## Layer 2 — ゲシュタルト原則（知覚心理学）

脳が無意識にパターンを認識する仕組みを活用する。

### 1. 類同の法則（Similarity）
形・色・サイズが似ている要素は同じグループとして認識される。
- 同カテゴリのCTAは同色に統一
- ナビゲーションリンクは同フォントサイズ・色
- エラー状態は常に赤・警告は黄・成功は緑

### 2. 近接の法則（Proximity）
→ Layer 1「近接」と同一。距離で関係性を伝える。

### 3. 共通運命の法則（Common Fate）
同じ方向に動く要素は仲間として認識される。
- カルーセルは要素を一緒に横スライドさせる
- ホバー時に関連要素をまとめてアニメーション
- スクロール連動エフェクトは意味的に関連する要素のみに適用

### 4. 閉合の法則（Closure）
欠けた情報を脳が補完する。
- 進捗バーで「残り」を暗示させる
- リストの一部を隠して「続きあり」を示唆（スクロール促進）
- 部分的に見えるカードで右にスクロール可能と示す

### 5. 連続の法則（Continuity）
滑らかな流れを持つ要素は一連として認識される。
- ステッパー（Step 1 → 2 → 3）は矢印または線でつなぐ
- タイムラインは縦線で連続性を表現
- コンテンツの読み進め方向（F字・Z字）に沿って配置

### 6. 図と地の法則（Figure-Ground）
前景と背景を無意識に区別する。
- モーダル背景にスクリム（半透明オーバーレイ）を使用
- カードに `box-shadow` または背景色差で浮き上がりを表現
- 重要要素を「浮かせ」、補助情報を「沈める」

### 7. 対称性の法則（Symmetry）
対称な配置は安定感と信頼感を生む。
- ランディングページのHeroは中央揃えで対称に
- ダッシュボードのカードグリッドは均等配置
- ナビゲーションの左右バランスを保つ

---

## Layer 3 — UX法則（行動科学）

ユーザーの意思決定・操作行動を科学的に最適化する。

### Hick's Law（ヒックの法則）
**選択肢が多いほど意思決定に時間がかかる。**

実装:
- ナビゲーション項目は 7±2 以内
- ドロップダウンの選択肢は 10 以内。超える場合は検索機能を追加
- 初期表示のCTAは1つに絞る（「今すぐ購入」と「詳しく見る」を並べない）
- オンボーディングは段階的に選択肢を提示（Progressive Disclosure）

### Fitts's Law（フィッツの法則）
**ターゲットが大きく近いほど素早く操作できる。**

実装:
- タッチターゲットの最小サイズ: **44×44px**（Apple HIG）/ **48×48dp**（Material）
- CTA ボタンは十分な padding（縦 12px 以上・横 24px 以上）
- 頻繁に使うアクションは親指が届く範囲（画面下部）に配置
- 画面端のナビゲーションは Edge Swipe に対応させる
- フォームの Submit ボタンは最後のフィールドの直下に配置

### Jakob's Law（ヤコブの法則）
**ユーザーは他サイトで慣れたパターンを期待する。**

実装:
- ロゴは左上（クリックでホームへ）
- 検索アイコンは右上
- ハンバーガーメニューはモバイルの右上
- カートアイコンはヘッダー右側
- パンくずリストはページ上部
- フッターに会社情報・利用規約・プライバシーポリシー

### Miller's Law（ミラーの法則）
**人が短期記憶に保持できる情報は 7±2 個。**

実装:
- リストは 7 項目以内。超える場合はカテゴリ分けまたはページネーション
- フォームは 1 画面に最大 5–7 フィールド
- ナビゲーションメニューは 7 項目以内
- テーブルカラムは 5–7 列以内

### Peak-End Rule（ピーク・エンドの法則）
**人は体験の「最高点」と「終了時点」で全体を評価する。**

実装:
- チェックアウト完了画面は特に丁寧に設計（成功アニメーション・次のステップ明示）
- エラー体験の直後に回復を助けるガイダンスを表示
- オンボーディングの最後のステップを「達成感」で終わらせる
- ローディング中のスケルトンスクリーンでストレスのピークを下げる

### Doherty Threshold（ドハティの閾値）
**応答時間が 400ms を超えるとユーザーは集中を失う。**

実装:
- 即座のフィードバック: ボタンクリック → **100ms 以内**に視覚変化
- ページ遷移: **300ms 以内**の Skeleton UI 表示
- API 応答が遅い場合: 即座に Optimistic UI を表示し、後で更新
- プログレスインジケーターは 400ms 以上かかる処理すべてに必須

---

## Layer 4 — 黄金比（Golden Ratio）による数学的プロポーション

φ（ファイ）= **1.618** を比率の基準として、タイポグラフィ・余白・レイアウト・コンポーネントに一貫した「自然な調和」を与える。  
参考: [LiftKit – UI Framework based on the Golden Ratio](https://coliss.com/articles/build-websites/operation/work/ui-framework-based-on-the-golden-ratio.html)

### プロジェクトの黄金比変数定義（globals.css 準拠）

このプロジェクトでは LiftKit の変数体系を採用している。新規 CSS を書く際はこれらを参照・使用すること。

```css
:root {
  /* ── 基本比率 ── */
  --phi:      1.618;   /* 黄金比 φ */
  --sqrt-phi: 1.272;   /* √φ（見出し行間・コンパクトな行間に使用） */

  /* ── 補数（小数部分） ── */
  --lk-wholestep-dec:   0.618;  /* φ - 1     → padding比率に使用 */
  --sqrt-phi-dec:       0.272;  /* √φ - 1    → leading補正に使用 */
  --lk-quarterstep-dec: 0.128;  /* φ^(1/4)-1 */
  --lk-eighthstep-dec:  0.062;  /* φ^(1/8)-1 */

  /* ── スケールステップ ── */
  --lk-quarterstep: 1.128;  /* φ^(1/4) ≈ 1.128（4ステップで1φ） */
  --lk-eighthstep:  1.062;  /* φ^(1/8) ≈ 1.062（8ステップで1φ） */

  /* ── 8分ステップのべき乗（CSS calc用・事前計算） ── */
  --lk-eighthstep-2: calc(var(--lk-eighthstep) * var(--lk-eighthstep));
  --lk-eighthstep-3: calc(var(--lk-eighthstep) * var(--lk-eighthstep) * var(--lk-eighthstep));
  --lk-eighthstep-4: calc(var(--lk-eighthstep-2) * var(--lk-eighthstep-2));
  --lk-eighthstep-5: calc(var(--lk-eighthstep-2) * var(--lk-eighthstep-3));
  --lk-eighthstep-6: calc(var(--lk-eighthstep-3) * var(--lk-eighthstep-3));
  --lk-eighthstep-7: calc(var(--lk-eighthstep-3) * var(--lk-eighthstep-4));
  --lk-eighthstep-8: calc(var(--lk-eighthstep-4) * var(--lk-eighthstep-4));
  --lk-eighthstep-9: calc(var(--lk-eighthstep-4) * var(--lk-eighthstep-5));

  /* ── コントロール（ボタン・入力）の比率 ── */
  --control-pad-ratio:    calc(var(--sqrt-phi) / (var(--phi) * var(--phi)));
  /* √φ ÷ φ² ≈ 0.486  → padding-block に font-size × この値を掛ける */
  --control-height-ratio: calc(var(--sqrt-phi) + (var(--control-pad-ratio) * 2));
  /* 行間 + padding×2 = コントロールの高さ比率 */
}
```

### LiftKit タイポグラフィサイズスケール

`--lk-size-md` を中心に `--lk-eighthstep`（φ^1/8 ≈ 1.062）で上下に展開するスケール。  
**8ステップ = 1φ（1.618倍）** の細かい等比数列で、滑らかな視覚的差を作る。

```css
:root {
  /* 基準サイズ（流体スケーリング） */
  --lk-size-md: clamp(0.875rem, 0.84rem + 0.14vw, 0.9375rem);
  /* ≈ 14px〜15px。ルートフォントサイズ(1rem)に対する相対値として機能 */

  /* ── 縮小方向（md を eighthstep で割る） ── */
  --lk-size-sm:  calc(var(--lk-size-md) / var(--lk-eighthstep));    /* ≈ 13.1px */
  --lk-size-xs:  calc(var(--lk-size-md) / var(--lk-eighthstep-2));  /* ≈ 12.3px */
  --lk-size-2xs: calc(var(--lk-size-md) / var(--lk-eighthstep-3));  /* ≈ 11.6px */
  --lk-size-3xs: calc(var(--lk-size-md) / var(--lk-eighthstep-4));  /* ≈ 10.9px */
  --lk-size-4xs: calc(var(--lk-size-md) / var(--lk-eighthstep-5));  /* ≈ 10.3px */
  --lk-size-5xs: calc(var(--lk-size-md) / var(--lk-eighthstep-6));  /* ≈  9.7px */
  --lk-size-6xs: calc(var(--lk-size-md) / var(--lk-eighthstep-7));  /* ≈  9.1px */
  --lk-size-7xs: calc(var(--lk-size-md) / var(--lk-eighthstep-8));  /* ≈  8.6px */
  --lk-size-8xs: calc(var(--lk-size-md) / var(--lk-eighthstep-9));  /* ≈  8.1px */

  /* ── 拡大方向（md を eighthstep で掛ける） ── */
  --lk-size-lg:  calc(var(--lk-size-md) * var(--lk-eighthstep));    /* ≈ 15.9px */
  --lk-size-xl:  calc(var(--lk-size-md) * var(--lk-eighthstep-2));  /* ≈ 16.9px */
  --lk-size-2xl: calc(var(--lk-size-md) * var(--lk-eighthstep-3));  /* ≈ 17.9px */
  --lk-size-3xl: calc(var(--lk-size-md) * var(--lk-eighthstep-4));  /* ≈ 19.0px */
  --lk-size-4xl: calc(var(--lk-size-md) * var(--lk-eighthstep-5));  /* ≈ 20.2px */
  --lk-size-5xl: calc(var(--lk-size-md) * var(--lk-eighthstep-6));  /* ≈ 21.5px */
  --lk-size-6xl: calc(var(--lk-size-md) * var(--lk-eighthstep-7));  /* ≈ 22.8px */
  --lk-size-7xl: calc(var(--lk-size-md) * var(--lk-eighthstep-8));  /* ≈ 24.2px */
  --lk-size-8xl: calc(var(--lk-size-md) * var(--lk-eighthstep-9));  /* ≈ 25.7px */
}
```

**サイズスケールの使い分け（ミニマル・ファッションブランドの方針）:**

> ssstein / hyke のようなミニマル系では、ナビ・UIクロムは極小（xs 以下）・本文は sm–md・セクション見出しは xl 止まり。
> ヒーロー大見出し・コレクション名など表示サイズが 30px 超になるものは `clamp()` + `vw` ベースの流体タイポグラフィで別途定義し、このスケールには乗せない。

| 変数 | 近似値 | 用途 |
|------|--------|------|
| `--lk-size-8xs` | ≈ 8.1px | **使用しない**（可読限界以下） |
| `--lk-size-7xs` | ≈ 8.6px | **使用しない**（可読限界以下） |
| `--lk-size-6xs` | ≈ 9.1px | **使用しない** |
| `--lk-size-5xs` | ≈ 9.7px | **使用しない** |
| `--lk-size-4xs` | ≈10.3px | フッターコピーライト・免責表記（最小限の法的テキスト） |
| `--lk-size-3xs` | ≈10.9px | 商品コード・SKU・日付などメタ情報 |
| `--lk-size-2xs` | ≈11.6px | フッターリンク・タグラベル・価格補足・ブランドテーマ |
| `--lk-size-xs`  | ≈12.3px | ナビゲーションリンク（`letter-spacing` 広め推奨）・フッターカテゴリ見出し |
| `--lk-size-sm`  | ≈13.1px | 商品名・カードテキスト・ボタンラベル・フォームプレースホルダー |
| `--lk-size-md`  | ≈14–15px | **本文・ドロワーリンク（スケール基準）**・アコーディオン |
| `--lk-size-lg`  | ≈15.9px | セクションラベル・ストキストカードタイトル |
| `--lk-size-xl`  | ≈16.9px | ヘッダーロゴ・ページ内小見出し・アイコン |
| `--lk-size-2xl` | ≈17.9px | ソーシャルアイコン・セクション見出し（抑制された最大） |
| `--lk-size-3xl` | ≈19.0px | キャッチコピーのサブ文（用途あれば） |
| `--lk-size-4xl` | ≈20.2px | **使用しない**（ここより上は vw ベース流体タイポへ） |
| `--lk-size-5xl` | ≈21.5px | **使用しない** |
| `--lk-size-6xl` | ≈22.8px | **使用しない** |
| `--lk-size-7xl` | ≈24.2px | **使用しない** |
| `--lk-size-8xl` | ≈25.7px | **使用しない**（ヒーロー・コレクション名は vw で別途定義） |

### ユニットレス値（calc() の乗除算用）

CSS の `calc()` で乗算・除算を行う場合、右辺はユニットレス（単位なし数値）でなければならない。

```css
:root {
  --lk-size-sm-unitless:  calc(1 / var(--phi));                          /* ≈ 0.618 */
  --lk-size-xs-unitless:  calc(var(--lk-size-sm-unitless) / var(--phi)); /* ≈ 0.382 */
  --lk-size-2xs-unitless: calc(var(--lk-size-xs-unitless) / var(--phi)); /* ≈ 0.236 */
  --lk-size-lg-unitless:  calc(1 * var(--phi));                          /* ≈ 1.618 */
  --lk-size-xl-unitless:  calc(var(--lk-size-lg-unitless) * var(--phi)); /* ≈ 2.618 */
  --lk-size-2xl-unitless: calc(var(--lk-size-xl-unitless) * var(--phi)); /* ≈ 4.236 */
}

/* 使用例: */
.element {
  margin-top: calc(var(--lk-size-lg) * var(--lk-size-sm-unitless));
  /* = lk-size-lg × 0.618（黄金比で縮小した余白） */
}
```

### フィボナッチ数列による px 余白（固定値が必要な場合）

黄金比スケールの相対値が使えない場面（Tailwind クラスの直書き等）では、フィボナッチ数列の px 値を使う。

```
5, 8, 13, 21, 34, 55, 89, 144 px
```

プロジェクト内の実例（`header-position`・`section-space`）:
```css
/* 水平パディング：画面幅に応じてフィボナッチ値で拡大 */
px-[13px] sm:px-[16px] md:px-[21px] lg:px-[34px] xl:px-[55px]

/* 垂直パディング：セクションの上下余白 */
py-[34px] sm:py-[42px] md:py-[55px] lg:py-[89px]
```

### コントロール（ボタン・入力）の黄金比パディング

```css
/* --control-pad-ratio = √φ ÷ φ² ≈ 0.486 */
.btn, .input {
  padding-block:  calc(var(--font-size) * var(--control-pad-ratio));
  /* font-size × 0.486 → 縦パディング */
  line-height: var(--sqrt-phi);  /* 1.272（行間） */
  /* 合計高さ = font-size × --control-height-ratio */
}

/* プロジェクトの実装例（header-drawer-primary-link）: */
.header-drawer-primary-link {
  padding: calc(var(--lk-size-md) * var(--control-pad-ratio)) 0
           calc(var(--lk-size-md) * var(--control-pad-ratio))
           var(--header-drawer-content-indent);
  line-height: var(--sqrt-phi);
}
```

### 行の高さ

```css
/* 本文（広め）: φ そのまま */
body { line-height: 1.7; }  /* プロジェクトでは 1.7 を採用（φ≈1.618の近似） */

/* 関連アイテム・コンパクトテキスト: √φ */
.look-related-item-text { line-height: var(--sqrt-phi); }  /* 1.272 */

/* アコーディオン・ナビリンク */
.header-drawer-accordion [data-ui-accordion-trigger] { line-height: 1.4; }
```

### レイアウト分割（黄金比レクタングル）

画面・コンテナ幅を **38.2% : 61.8%** で分割すると自然な視覚的バランスが生まれる。

```css
.golden-layout {
  display: grid;
  grid-template-columns: 38.2fr 61.8fr;  /* サイドバー : メイン */
  gap: 34px;  /* フィボナッチ値 */
}
```

### 黄金比スパイラルの視覚的応用

- **画像のトリミング**: 主役の被写体を螺旋の中心に配置
- **ヒーローセクション**: テキストブロックを 61.8% 側、画像を 38.2% 側に
- **CTA配置**: 黄金分割点（縦横それぞれ 61.8% の交点）に最重要要素を置く
- **余白の非対称バランス**: 左 38.2% / 右 61.8% の余白差で視線誘導

### 光学補正（Optical Correction）

数学的に正確な中央配置でも、視覚的に「ずれて見える」ことがある。プロジェクトでは leading 補正を変数化して対応:

```css
:root {
  /* leading（行間の空白）を視覚的ギャップから差し引く補正 */
  --lk-look-related-items-leading-compensation: calc(
    var(--lk-size-xs) * var(--sqrt-phi-dec)
  );
  /* sqrt-phi-dec = 0.272 = √φ - 1 */

  --lk-look-related-items-visible-gap: calc(
    var(--lk-size-xs) * var(--lk-wholestep-dec)
  );
  /* wholestep-dec = 0.618 = φ - 1 */

  /* 実効ギャップ = 見た目のギャップ - leading補正 */
  --lk-look-related-items-stack-gap: max(
    0px,
    calc(
      var(--lk-look-related-items-visible-gap) -
        var(--lk-look-related-items-leading-compensation)
    )
  );
}

/* アイコンボタン: 視覚的重心を数学的中心より僅かに上へ */
.icon-btn svg {
  transform: translateY(-0.05em);
}
```

---

## Layer 5 — 視覚的階層（Visual Hierarchy）

ユーザーの視線を意図した順序で誘導する。

### タイポグラフィ

このプロジェクトでは **`--lk-size-*` 変数を使う**（固定 rem 値は使わない）。

```css
/* 使用例 */
.element { font-size: var(--lk-size-xl); }   /* ヘッダータイトル */
.element { font-size: var(--lk-size-2xs); }  /* 小ラベル・ナビリンク */
.element { font-size: var(--lk-size-xs); }   /* カード詳細テキスト */
```

サイズ選択の目安:
```
--lk-size-8xl  ≈ 25.7px  大見出し（H1相当）
--lk-size-5xl  ≈ 21.5px  中見出し（H2相当）
--lk-size-2xl  ≈ 17.9px  小見出し（H3相当）
--lk-size-xl   ≈ 16.9px  ヘッダータイトル・アイコン
--lk-size-lg   ≈ 15.9px  カードタイトル
--lk-size-md   ≈ 15px    標準UIテキスト（基準）
--lk-size-sm   ≈ 13.1px  補助テキスト
--lk-size-xs   ≈ 12.3px  カード詳細・フッターカテゴリ
--lk-size-2xs  ≈ 11.6px  ナビリンク・フッターリンク
--lk-size-4xs  ≈ 10.3px  法的表記・コピーライト
```

- 本文 `line-height`: `1.7`（globals.css の `body` に設定済み）
- コンパクトな行間: `var(--sqrt-phi)`（= 1.272）
- フォントウェイト: 見出し（`h1〜h5`）= 400 / 本文 = 通常
- 書体: 見出し `Didot, Georgia, serif` / 本文・UI `acumin-pro, sans-serif`

### カラーシステム

```css
:root {
  /* ブランドカラー */
  --color-primary:       hsl(220, 90%, 50%);
  --color-primary-hover: hsl(220, 90%, 42%);

  /* セマンティックカラー */
  --color-success: hsl(142, 72%, 29%);
  --color-warning: hsl(38,  92%, 50%);
  --color-error:   hsl(0,   72%, 51%);
  --color-info:    hsl(200, 89%, 48%);

  /* テキスト */
  --color-text-primary:   hsl(222, 47%, 11%);
  --color-text-secondary: hsl(215, 16%, 47%);
  --color-text-disabled:  hsl(214, 13%, 65%);

  /* 背景 */
  --color-bg-base:    hsl(0, 0%, 100%);
  --color-bg-surface: hsl(210, 40%, 98%);
  --color-bg-overlay: hsl(222, 47%, 11%, 0.5);
}
```

カラーの役割:
- プライマリ: 最重要CTA に 1 色のみ
- セカンダリ: 補助アクション
- アクセント: 強調・新機能バッジ（1 色のみ）
- ニュートラル: テキスト・ボーダー・背景
- セマンティック: 成功・警告・エラー・情報
- **状態や意味の伝達を色だけに依存しない**（テキスト・アイコンも組み合わせる）

### 余白（ホワイトスペース）

余白は「可読性と注意誘導のツール」。フィボナッチ数列（8, 13, 21, 34, 55, 89px）から選択することで調和が生まれる。

**プロジェクトの実装パターン（globals.css より）:**

```css
/* 水平パディング: 画面幅に応じてフィボナッチ値で拡大 */
/* header-position / section-space / section-space-about */
px-[13px] sm:px-[16px] md:px-[21px] lg:px-[34px] xl:px-[55px]

/* 垂直パディング: セクションの上下余白 */
/* section-space / section-space-about */
py-[34px] sm:py-[42px] md:py-[55px] lg:py-[89px]

/* ナビゲーション水平ギャップ */
/* header-nav-position */
lg:ml-[34px] xl:ml-[55px]
gap-[20px] xl:gap-[28px]
```

参照用スケール:
```
コンポーネント内 padding: var(--lk-size-xs)〜var(--lk-size-lg) で決定
要素間 gap:               8–13px（フィボナッチ）または var(--lk-size-sm) 系
コンポーネント間 margin:  21–34px
セクション間 padding:     34–89px（画面幅に応じてレスポンシブ）
```

---

## Layer 6 — アクセシビリティ（WCAG 2.2 AA 準拠）

アクセシビリティは追加機能ではなく設計の基盤。シフトレフト（設計段階で組み込む）が原則。

### WCAG の4原則

- **知覚可能（Perceivable）**: 代替テキスト・キャプション・色以外の手段
- **操作可能（Operable）**: キーボード操作・十分な操作時間・発作誘発なし
- **理解可能（Understandable）**: 読みやすい内容・予測可能な挙動・エラー回復
- **堅牢（Robust）**: role / name / value を正しく与え、支援技術で安定動作

### コントラスト比

```
本文テキスト (< 18pt):              最低 4.5:1
大テキスト (≥ 18pt / Bold ≥ 14pt): 最低 3:1
UI コンポーネント・グラフィック:    最低 3:1
```

### WCAG 2.2 の重要追加要件

- フォーカスインジケーターは明確に見え、sticky UI に隠れないこと
- ドラッグ操作には、キーボードまたはシングルポインター操作による代替手段があること
- インタラクティブ要素は最小ターゲットサイズを満たすこと
- 認証で記憶頼みのパズルや認知過負荷を課さないこと
- すでに取得している情報の再入力を不必要に求めないこと
- ヘルプは重要なフローで一貫して利用できること

### キーボードナビゲーション

```css
/* フォーカス可視化（デフォルトを消さない） */
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
```

```tsx
// フォーカストラップ（モーダル）
const trapFocus = (element: HTMLElement) => {
  const focusable = element.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  // Tab で最後の要素 → 最初に戻る
};

// モーダルを閉じた後にトリガーへフォーカスを戻す
const triggerRef = useRef<HTMLButtonElement>(null);
const [open, setOpen] = useState(false);
useEffect(() => {
  if (!open && triggerRef.current) triggerRef.current.focus();
}, [open]);
```

### セマンティックHTML（ネイティブファースト）

```html
<!-- NG: div で作ったボタン -->
<div class="btn" onclick="...">送信</div>

<!-- OK: ネイティブ要素 -->
<button type="submit">送信</button>

<!-- 見出し階層を守る -->
<h1>ページタイトル</h1>
  <h2>セクション</h2>
    <h3>サブセクション</h3>

<!-- ランドマーク -->
<header> <nav> <main> <aside> <footer>

<!-- フォームのラベル紐付け -->
<label for="email">メールアドレス</label>
<input id="email" type="email" autocomplete="email" aria-describedby="email-error" />
<span id="email-error" role="alert">有効なメールアドレスを入力してください</span>
```

### ARIA 属性の使い方

```tsx
// ローディング状態
<button aria-busy={isLoading} aria-disabled={isLoading}>
  {isLoading ? '送信中...' : '送信'}
</button>

// モーダル
<dialog role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <h2 id="modal-title">確認</h2>
</dialog>

// ライブリージョン（動的コンテンツ）
<div role="status" aria-live="polite">
  {successMessage}    {/* 穏やか: 読み終わってから通知 */}
</div>
<div role="alert" aria-live="assertive">
  {errorMessage}      {/* 緊急: 即座に割り込み通知 */}
</div>

// アイコンのみのボタン
<button aria-label="メニューを開く">
  <MenuIcon aria-hidden="true" />
</button>
```

### SPA・動的インターフェースのアクセシビリティ

```html
<!-- ルート変更告知 -->
<div aria-live="polite" aria-atomic="true" id="route-announcer" class="sr-only"></div>
<script>
  function announce(text) {
    const el = document.getElementById('route-announcer');
    el.textContent = '';
    // 一度空にしてから設定しないとスクリーンリーダーが変化を検知しない
    requestAnimationFrame(() => { el.textContent = text; });
  }
  // ルート変更時に announce(newPageTitle) を呼び出す
</script>
```

### 画像のalt属性

```html
<!-- 装飾画像 -->
<img src="decorative.png" alt="" />

<!-- 情報を持つ画像 -->
<img src="chart.png" alt="2024年売上グラフ：前年比120%増" />

<!-- リンク内の画像 -->
<a href="/home"><img src="logo.png" alt="会社名 - ホームへ" /></a>
```

### レスポンシブ対応とズーム

- 400% まで拡大しても二次元スクロールなしで読めること
- 画像化された文字は避ける
- 文字間隔の調整で情報が失われないこと

---

## Layer 7 — インタラクションデザイン

「操作した → 反応があった」の連鎖でユーザーの安心を作る。

### フィードバック設計

| アクション | フィードバック | タイミング |
|-----------|--------------|----------|
| ボタンクリック | 色変化 / スケール縮小 | < 100ms |
| フォーム送信 | ローディングスピナー → 成功/エラーメッセージ | 即座 |
| ホバー | 背景色変化 / アンダーライン | < 50ms |
| スクロール | スクロールバー / プログレスバー | リアルタイム |
| ファイルドロップ | ドロップゾーンのハイライト | ドラッグ開始時 |

### マイクロインタラクション

```css
/* ボタンの押下感 */
.btn:active {
  transform: scale(0.97);
  transition: transform 80ms ease;
}

/* ホバートランジション */
.btn {
  transition: background-color 150ms ease, box-shadow 150ms ease;
}

/* フォーカスリング */
.input:focus-visible {
  box-shadow: 0 0 0 3px hsl(220, 90%, 50%, 0.3);
  border-color: var(--color-primary);
  transition: box-shadow 100ms ease, border-color 100ms ease;
}
```

### アニメーション原則

- **目的のあるアニメーションのみ使う**（移行・フィードバック・誘導）
- **時間**: UI フィードバック 100–200ms / ページ遷移 200–400ms
- **イージング**: 要素の出現 `ease-out` / 消滅 `ease-in` / 状態変化 `ease-in-out`

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### アフォーダンス（操作可能性の明示）

```css
[role="button"], button, a { cursor: pointer; }

[disabled], [aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.5;
}

[draggable="true"] { cursor: grab; }
[draggable="true"]:active { cursor: grabbing; }
```

---

## Layer 8 — 認知負荷の最小化

ユーザーに「考えさせない」設計。

### Progressive Disclosure（段階的開示）

```tsx
// 良い例：基本→詳細の段階的開示
<BasicSettings />
<details>
  <summary>詳細設定</summary>
  <AdvancedSettings />
</details>
```

実装パターン:
- フォーム: 必須フィールドのみ初期表示 → オプションは「追加」で展開
- 設定: 基本/詳細タブで分離
- 長文: 「続きを読む」で折りたたみ
- ウィザード: 1画面1ステップに分割

### エラー防止と回復

```tsx
// 1. 入力制約（エラーを起こさせない）
<input type="tel" pattern="[0-9]{10,11}" inputMode="numeric" />

// 2. リアルタイムバリデーション（blur時）
const handleBlur = () => {
  if (!isValid(value)) setError('有効な電話番号を入力してください');
};

// 3. エラーメッセージは「何が問題か」「どう直すか」を明示
// NG: 「入力エラー」
// OK: 「メールアドレスに @ が含まれていません。例: user@example.com」

// 4. 破壊的操作は確認を求める
<ConfirmDialog
  title="削除の確認"
  description="この操作は取り消せません。本当に削除しますか？"
  confirmLabel="削除する"
  cancelLabel="キャンセル"
  destructive
/>
```

### フォーム設計

```tsx
<form>
  <div className="field">
    <label htmlFor="name">
      氏名 <span aria-hidden="true">*</span>
      <span className="sr-only">（必須）</span>
    </label>
    <input
      id="name"
      name="name"
      autoComplete="name"
      required
      aria-required="true"
      aria-describedby={error ? 'name-error' : undefined}
    />
    {error && (
      <span id="name-error" role="alert" className="error">
        {error}
      </span>
    )}
  </div>
</form>
```

フォーム設計のルール:
- ラベルは常に表示（プレースホルダーのみ NG）
- 必須/任意を明記
- エラーはフィールドの直下に表示
- `autocomplete` 属性で再入力を最小化（WCAG 2.2）
- ヘルプは一貫して利用できるようにする（WCAG 2.2）

---

## Layer 9 — モバイルファースト

モバイルから設計し、デスクトップに拡張する。

### ブレークポイント設計

```css
/* モバイルファースト（min-width で拡張） */
.container { padding: 16px; }

@media (min-width: 640px)  { .container { padding: 24px; } }
@media (min-width: 768px)  { .container { padding: 32px; max-width: 768px; } }
@media (min-width: 1024px) { .container { padding: 40px; max-width: 1024px; } }
@media (min-width: 1280px) { .container { max-width: 1280px; } }
```

### タッチ操作の最適化

```css
.touch-target {
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scroll-container {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
```

### 親指到達範囲（Thumb Zone）

```
画面を3ゾーンに分類:
┌────────────┐
│  困難ゾーン  │  ← 補助的操作のみ（戻るボタン等）
│  (上部20%)  │
├────────────┤
│  自然ゾーン  │  ← 頻繁な操作を配置
│  (中部50%)  │
├────────────┤
│  容易ゾーン  │  ← 最重要CTA（送信・次へ）
│  (下部30%)  │
└────────────┘
```

- 主要 CTA（送信・次へ・購入）: 画面下部固定 or 下部30%以内
- ボトムナビゲーション: 最重要 4–5 項目のみ
- ジェスチャー操作（ドラッグ等）には必ずシングルポインターの代替手段を提供

---

## Layer 10 — メンタルモデルとナビゲーション

ユーザーが「自分はどこにいるか」を常に把握できるようにする。

### ナビゲーション設計

```tsx
// パンくずリスト（3階層以上のページで必須）
<nav aria-label="パンくず">
  <ol>
    <li><a href="/">ホーム</a></li>
    <li><a href="/products">商品一覧</a></li>
    <li aria-current="page">商品詳細</li>
  </ol>
</nav>

// アクティブ状態の明示
<nav>
  <a href="/home" aria-current="page">ホーム</a>
  <a href="/products">商品</a>
</nav>
```

### 空の状態（Empty State）設計

```tsx
<EmptyState
  icon={<CartIcon />}
  title="カートが空です"
  description="気になる商品をカートに追加しましょう"
  action={<Button href="/products">商品を見る</Button>}
/>
```

### ローディング・非同期状態

```tsx
// スケルトンスクリーン（CLS を防ぐ）
const ProductCardSkeleton = () => (
  <div className="card animate-pulse">
    <div className="h-48 bg-gray-200 rounded" />
    <div className="mt-4 h-4 bg-gray-200 rounded w-3/4" />
    <div className="mt-2 h-4 bg-gray-200 rounded w-1/2" />
  </div>
);

// Optimistic UI
const handleLike = async () => {
  setLiked(true);
  try {
    await api.like(id);
  } catch {
    setLiked(false);
    showError('操作に失敗しました');
  }
};
```

---

## フレームワーク別アダプター

### React

```tsx
// モーダルを閉じた後にトリガーへフォーカスを戻す
const triggerRef = useRef<HTMLButtonElement>(null);
const [open, setOpen] = useState(false);
useEffect(() => {
  if (!open && triggerRef.current) triggerRef.current.focus();
}, [open]);

// ルート変更の告知（React Router v6）
const location = useLocation();
useEffect(() => {
  announce(document.title);
}, [location]);
```

### Angular

```ts
// サービス経由でルート変更を告知する
@Injectable({ providedIn: 'root' })
export class Announcer {
  private el = document.getElementById('route-announcer');
  say(text: string) { if (this.el) this.el.textContent = text; }
}
```

### Vue

```vue
<template>
  <div role="status" aria-live="polite" aria-atomic="true" ref="live"></div>
</template>
<script setup lang="ts">
const live = ref<HTMLElement | null>(null);
function announce(text: string) { if (live.value) live.value.textContent = text; }
</script>
```

---

## 実装手順

### Step 1 — 要件整理
```
1. ユーザーのゴールを1文で定義
2. 主要デバイスを確認（モバイル/デスクトップ比率）
3. アクセシビリティ要件を確認（WCAG 2.2 AA 最低ライン）
4. 既存デザインシステムを確認（カラー・タイポグラフィ）
```

### Step 2 — 構造設計
```
1. セマンティックHTMLの構造を決める
2. 情報階層（何が最も重要か）を定義
3. 状態パターンを列挙（デフォルト・ホバー・フォーカス・エラー・ローディング・空・成功）
4. レスポンシブブレークポイントを確認
5. 黄金比レイアウト分割を決める（38.2% / 61.8% の活用箇所）
```

### Step 3 — 実装
```
Layer 1:  レイアウト（近接・整列・反復・対比）
Layer 2:  ゲシュタルト原則の適用
Layer 3:  UX法則に基づく操作性最適化
Layer 4:  黄金比（φ=1.618）でプロポーションを設計
Layer 5:  視覚的階層（タイポ・カラー・余白）← Layer 4 のスケールを使用
Layer 6:  アクセシビリティ（ARIA・コントラスト・キーボード・WCAG 2.2）
Layer 7:  インタラクション・アニメーション
Layer 8:  エラー防止・認知負荷軽減
Layer 9:  モバイル最適化
Layer 10: ナビゲーション・状態管理
```

---

## 検証チェックリスト

### デザイナー向け

- [ ] 見出し構造・ランドマーク・情報階層を定義した
- [ ] フォーカススタイル・エラー状態・視覚的インジケーターを仕様化した
- [ ] 配色がコントラスト要件を満たし、色覚特性に配慮されている（色だけに依存しない）
- [ ] キャプション・文字起こし・モーション代替案を計画した
- [ ] ヘルプ・サポート導線を重要なフローに一貫して配置した
- [ ] 黄金比レイアウト分割（38.2% / 61.8%）を設計に反映した

### 開発者向け

**黄金比・プロポーション**
- [ ] フォントサイズに `--lk-size-*` 変数を使っているか（固定 rem 値を直書きしていないか）
- [ ] 余白・gap に Fibonacci px（13, 21, 34, 55, 89px）または `--lk-size-*` を使っているか
- [ ] ボタン・入力の縦パディングに `--control-pad-ratio` を使っているか
- [ ] 行間に `--sqrt-phi`（1.272）または `1.7`（body標準）を使っているか
- [ ] Tailwind の任意値クラス（`px-[N]`）を書く場合、Fibonacci 値から選んでいるか

**視覚**
- [ ] コントラスト比 4.5:1 以上（本文）/ 3:1 以上（大テキスト・UI）
- [ ] フォントサイズ最小 `--lk-size-md`（≈14–15px）
- [ ] 1画面でCTAは1つが主役か

**操作性**
- [ ] タッチターゲット最小 44×44px
- [ ] キーボードのみで全操作可能か
- [ ] フォーカスリングが常に表示されるか（`:focus-visible`）
- [ ] 全インタラクティブ要素に hover / focus / active 状態があるか
- [ ] ドラッグ操作に代替手段があるか（WCAG 2.2）

**フィードバック**
- [ ] 全ボタンクリックで 100ms 以内に視覚変化があるか
- [ ] ローディング中はインジケーターがあるか（400ms 超）
- [ ] エラーメッセージは「原因 + 解決策」で書かれているか
- [ ] 成功時にポジティブなフィードバックがあるか

**アクセシビリティ**
- [ ] セマンティック HTML 要素を使い、ネイティブコントロールを優先した
- [ ] 見出し階層（h1 → h2 → h3）が正しいか
- [ ] 全画像に適切な alt 属性があるか
- [ ] フォームの label が input に紐付いているか
- [ ] `autocomplete` 属性で再入力を最小化したか
- [ ] role="alert" で動的エラーをスクリーンリーダーに通知しているか
- [ ] `prefers-reduced-motion` に対応しているか
- [ ] モーダル・メニュー・動的更新・ルート変更時のフォーカスを管理した

**モバイル**
- [ ] モバイル（375px〜）で横スクロールが発生しないか
- [ ] 重要CTAが親指の届く範囲にあるか
- [ ] フォント・ボタンがタップしやすいサイズか

### QA向け

- [ ] キーボードだけで一通り操作し、フォーカス表示と順序が妥当か確認する
- [ ] 重要なフローでスクリーンリーダーのスモークテストを行う（NVDA / VoiceOver）
- [ ] 400% ズームと高コントラスト / forced-colors モードで確認する
- [ ] 自動検査ツールを実行し、ブロッカーがないことを確認する

---

## テスト・ツール

### 自動検査コマンド

```bash
# Axe CLI でローカルページを検査
npx @axe-core/cli http://localhost:3000 --exit

# pa11y で HTML レポートを生成
npx pa11y http://localhost:3000 --reporter html > a11y-report.html

# Lighthouse CI でアクセシビリティカテゴリのみ実行
npx lhci autorun --only-categories=accessibility
```

### CI 設定（GitHub Actions）

```yaml
name: a11y-checks
on: [push, pull_request]
jobs:
  axe-pa11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build --if-present
      - run: npx serve -s dist -l 3000 &
      - run: npx wait-on http://localhost:3000
      - run: npx @axe-core/cli http://localhost:3000 --exit
      - run: npx pa11y http://localhost:3000 --reporter ci
```

---

## --audit モード

既存のUIを診断する場合は、以下の観点でコードを分析する:

0. **黄金比違反**: `--lk-size-*` を使わず任意の rem/px 値を直書き、または余白が Fibonacci 数列外の値
1. **近接違反**: 関連要素が遠い、無関係要素が近い
2. **整列違反**: グリッドに沿っていない、中途半端な余白
3. **反復違反**: 同じ要素に異なるスタイルが混在
4. **対比不足**: CTAが目立っていない、情報の優先度が不明瞭
5. **コントラスト不足**: 4.5:1 未満のテキスト
6. **タッチターゲット不足**: 44px 未満のインタラクティブ要素
7. **アクセシビリティ欠如**: ラベルなし・alt なし・フォーカス不可・color only
8. **フィードバック欠如**: クリックに反応しない要素
9. **情報過多**: 1画面に詰め込みすぎ
10. **エラー処理不備**: エラーメッセージが曖昧・場所が遠い
11. **フォーカス管理不備**: モーダル閉時にフォーカスが迷子になる
12. **アニメーション不備**: `prefers-reduced-motion` 非対応

診断結果は「問題 → 原因（どの原則に違反） → 修正方法」の形式で報告する。

---

## PRレビューテンプレート

```md
アクセシビリティ・UI/UXレビュー:
- セマンティクス / role / name:        [OK/課題あり]
- キーボード操作とフォーカス:          [OK/課題あり]
- 告知（非同期 / ルート変更）:         [OK/課題あり]
- コントラスト / 視覚的フォーカス:     [OK/課題あり]
- フォーム / エラー / ヘルプ:          [OK/課題あり]
- 黄金比プロポーション / 余白スケール: [OK/課題あり]
- モバイルタッチターゲット:            [OK/課題あり]
対応内容: …
参照: WCAG 2.2 [該当達成基準]
```

---

## 差分レビューの観点

コードを提案・レビューする前に、以下を確認する:

1. **セマンティクスは妥当か** — 要素 / role / label に意味があるか
2. **キーボード操作は妥当か** — tab / shift+tab の順序、space / enter での起動が問題ないか
3. **フォーカス管理は適切か** — 初期フォーカス、必要なトラップ、フォーカス復帰ができているか
4. **告知は十分か** — 非同期結果やルート変更がライブリージョンで伝わるか
5. **視覚面に問題はないか** — コントラスト、フォーカス表示、モーション配慮ができているか
6. **エラーハンドリングは十分か** — インラインメッセージ、要約、プログラム上の関連付けがあるか

---

## 避けるべきアンチパターン

- アクセシブルな代替を用意せずにフォーカスアウトラインを消すこと
- ネイティブ要素で足りるのに、独自ウィジェットを作ること（`<div>` ボタン等）
- セマンティック HTML の方が適切なのに、ARIA を過剰に使うこと
- 重要な情報を hover のみ、または色だけに頼って伝えること
- すぐに止められないメディアの自動再生
- アクセシビリティ要件を後回しにして「あとで対応」とすること
- フォームにプレースホルダーしかなくラベルがないこと
- ドラッグ操作のみでキーボード代替手段を用意しないこと
- 認証で記憶頼みのパズルや認知過負荷を課すこと

---

## 運用ルール

- コードで回答する前に、キーボード操作経路・フォーカスの見え方・name/role/state・動的更新時の告知について簡易チェックを行う
- トレードオフがある場合は、多少冗長でもアクセシビリティに優れる選択肢を優先する
- アクセシビリティを下げる依頼（例: フォーカスアウトラインの削除）はそのまま受けず、代替案を提示する
- フレームワーク・デザイントークン・ルーティング等の前提が不明なときは、コード提案前に 1–2 個だけ確認質問をする
- コード編集には必ずテスト手順と検証手順を添える
