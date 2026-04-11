# Design System: Le Fil des Heures — Temporal Minimalism Interface

---

## 1. Overview & Creative North Star

### Creative North Star: "Time, Silence, and Structure"

このデザインシステムは、単なるEC UIではなく、  
**「時間の流れを纏う体験」**をデジタル上で再現することを目的とします。

Le Fil des Heures の本質は：

- 静けさ（Silence）
- 余白（Ma）
- 時間のレイヤー（Temporal Layering）
- 知性（Intellectual Minimalism）

---

### Core Design Principles

#### 1. Temporal Minimalism
要素は「少ない」のではなく、「必要なものだけが残っている状態」。

#### 2. Intentional Asymmetry
完全なグリッドではなく、**意図的なズレ**を許容  
→ 編集的・建築的な緊張感を生む

#### 3. Spatial Hierarchy over Decoration
装飾ではなく「空間構造」で意味を伝える

#### 4. Typography as Identity
フォントの階層がブランドそのものになる

---

## 2. Color System

### Palette

- **Primary:** #0A0A0A（Ink Black）
- **Secondary:** #3A3A3A（Graphite）
- **Tertiary:** #7A7A7A（Soft Gray）
- **Background:** #FFFFFF（Pure White）
- **Surface Warm:** #F4F1ED（Warm Paper）
- **Accent:** #D6D0C8（Aged Linen）

---

### Color Philosophy

- 基本は**白 × 黒 × グレー**
- ベージュは「時間の痕跡」として限定使用
- 色でなく**密度で差を作る**

---

### Accessibility Rules

- 最低コントラスト比：**4.5:1（WCAG AA）**
- 見出し：7:1 推奨
- ベージュ背景上のテキストは必ず濃色使用

---

### The "No Border" Rule

- 原則：**境界線禁止**
- 代替：
  - 背景差分
  - 余白（spacing）
  - タイポグラフィ

例：
NG: border: 1px solid #ddd
OK: bg-white → bg-[#F4F1ED]


---

## 3. Typography

### Font System

#### Display（思想・空気感）
- Didot / Playfair Display / Noto Serif JP

#### Body（機能・可読性）
- Inter / Helvetica Now / Noto Sans JP

---

### Scale

| Role | Size | Weight |
|------|------|--------|
| Display XL | 48–64px | Light |
| Display L | 36–48px | Regular |
| Heading | 24–32px | Medium |
| Body | 14–18px | Regular |
| Caption | 12px | Light |

---

### Typography Rules

- 行間：1.5〜1.8
- 文字間：やや広め（+2〜4%）
- 日本語：詰めすぎない

---

### Accessibility

- 最小フォントサイズ：**14px**
- 行間は必ず確保（可読性優先）
- ALL CAPS 使用時は letter-spacing 必須

---

## 4. Layout & Grid

### Grid System

- Desktop: 12 columns
- Tablet: 8 columns
- Mobile: 4 columns

---

### Spacing Scale
4px / 8px / 12px / 16px / 24px / 32px / 48px / 64px / 96px

---

### Responsive Rules

#### Mobile First（必須）

- すべての設計はモバイル起点
- PCは拡張として扱う

---

### Breakpoints

- sm: 640px
- md: 768px
- lg: 1024px
- xl: 1280px

---

### Layout Philosophy

- 中央寄せ禁止（必要な場合のみ）
- 左寄せベース
- 余白で呼吸させる

---

## 5. Elevation & Depth

### Layering System（超重要）

影ではなく「層」で表現

| Layer | Color |
|------|------|
| Base | #FFFFFF |
| Section | #F4F1ED |
| Card | #FFFFFF |
| Modal | rgba(255,255,255,0.8) |

---

### Glassmorphism（限定使用）
backdrop-filter: blur(12px);
background: rgba(255,255,255,0.7);


---

### Shadow Rule

- 基本：shadowなし
- 必要時：0 10px 30px rgba(0,0,0,0.05)


---

## 6. ブランドコンセプト

- **ブランド名**: Le Fil des Heures（ル フィル デ ザール）
- **コンセプト**: ミニマル×モードの交差から生まれるタイムレスな日常着。価格帯ミドル〜ミドルハイ（約 ¥20,000〜¥80,000）
- **ターゲット**: 都市生活者を中心とした 20 代後半〜40 代のファッション感度の高い男女（品質・デザインに対価を払う層）

---

## 7. コンポーネント仕様

### Button

| バリアント | 背景 | テキスト | 用途 |
|---|---|---|---|
| `primary` | `#000000` | `#ffffff` | 主要 CTA |
| `secondary` | 透明/白背景 + `#000000` ボーダー | `#000000` | サブアクション |
| `ghost` | 透明 | `#000000` | 第三優先 |
| `link` | 透明 | `#000000` アンダーライン | テキストリンク |

- `disabled` / `loading` 状態は必須実装
- フォーカスリング: 3px 程度の明確なアウトライン（WCAG AA 準拠）

### Card

- 背景: `neutral (#ffffff)` または `sand (#d5d0c9)` の薄バリエーション（`#f7f6f4`）
- 角丸: `--radius` を参照（現状 0.625rem）
- ボーダー: 原則なし（背景差分で区別）

### Form

- ラベル・プレースホルダー・エラーメッセージのコントラストを確保
- エラー状態: `destructive` トークン（赤系）を使用
- `aria-describedby` でエラーとフィールドを紐付け

---

## 8. 画像・写真ガイドライン

| 用途 | 推奨アスペクト比 | ファイル形式 |
|---|---|---|
| 商品サムネイル | 1:1 | WebP (fallback PNG) |
| 商品詳細メイン (PDP) | 4:5 または 3:4 | WebP (fallback PNG) |
| ヒーロー / バナー | 16:9 | WebP (fallback PNG) |

- `next/image` の `priority` / `placeholder` を適切に使用する
- `alt` テキスト形式: 「商品名 - カラー、サイズ」例: "ウール混コート - ベージュ、サイズM"
- 撮影スタイル: 自然光・ニュートラル背景、素材感重視、過度な加工禁止

---

## 9. マイクロインタラクション

- アニメーション時間: **150〜250ms**（控えめで軽快な動き）
- 推奨 easing: `ease-out` または `cubic-bezier(0.4, 0, 0.2, 1)`
- ホバー・フォーカス遷移には `transition` を必ず設定する
- `prefers-reduced-motion` を尊重し、動きを無効化できるようにする

---

## 10. Tailwind 設定例 & デザイントークン

### tailwind.config.js（推奨追加）

```js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary:   '#000000',
        secondary: '#474747',
        sand: {
          DEFAULT: '#d5d0c9',
          50:      '#f7f6f4'
        },
        neutral: '#ffffff'
      },
      fontFamily: {
        heading: ['Didot', 'Georgia', "'Times New Roman'", 'serif'],
        body: ['Inter', "'Noto Sans JP'", 'system-ui', '-apple-system', 'sans-serif']
      },
      spacing: { 18: '4.5rem' },
      borderRadius: { lg: '0.625rem' }
    }
  }
}
```

### design-tokens.json（最小構成）

```json
{
  "colors": {
    "primary":   "#000000",
    "secondary": "#474747",
    "sand":      "#d5d0c9",
    "neutral":   "#ffffff"
  },
  "font": {
    "heading": "Didot",
    "body":    "Inter, Noto Sans JP"
  },
  "spacing": { "base": 8 },
  "animation": { "duration": "200ms", "easing": "ease-out" }
}
```

> Tailwind トークン移行手順:
> 1. `:root` / `.dark` の CSS 変数を `tailwind.config.js` の対応トークンへマップする
> 2. コンポーネントクラスを段階的に Tailwind トークンへ置換する
> 3. ダークテーマの振る舞いはデザイン担当と合意する（Sand Beige はダークで使用しない等）

---

## 11. アクセシビリティ要件

- コントラスト比（WCAG AA）: 通常テキスト ≥ 4.5:1 / 大テキスト（≥18pt or ≥14pt bold） ≥ 3:1
- すべてのインタラクティブ要素はキーボード操作可能にする
- モーダル・ドロップダウン等の複合ウィジェットには適切な ARIA 属性を付与する
- フォーカス表示は必ず視覚的に明確にする
- `alt` テキストは全画像に必須（装飾画像は `alt=""`）

---

## 12. アセット & リンク

- Figma プロジェクト: （デザイナー提供 URL を記載）
- ロゴ: `assets/logos/` に SVG を配置（黒・白・単色バリエーション）
- フォント: Didot はライセンス確認のうえ自己ホストまたはフォント配信サービスで配信。`font-display: swap` を設定すること

> ガイドライン変更はデザイン担当の承認が必要。Tailwind トークンの破壊的変更は PR とミーティングで合意すること。

## 6. Components

### Buttons

#### Primary
- bg: black
- text: white
- hover: opacity 0.85

#### Secondary
- border: black
- bg: transparent
- hover: black bg

#### Accessibility
- 最小高さ：44px
- focus ring 必須

---

### Cards

- bg: white
- padding: 24px
- hover: subtle border shift

---

### Inputs

- height: 48px
- border: 1px solid rgba(0,0,0,0.2)

#### Focus State
- outline: 2px solid black;


---

### Navigation

- sticky header
- minimal
- active: underline animation

---

### Interaction Rules

- アニメーション：**150〜250ms**
- easing：ease-out
- 過剰アニメーション禁止

---

## 7. Accessibility（重要）

### 必須要件

- キーボード操作可能
- focus state 明示
- aria属性適切に付与
- altテキスト必須

---

### Motion Accessibility

- prefers-reduced-motion 対応

@media (prefers-reduced-motion: reduce) {
animation: none;
}


---

### Touch Targets

- 最小：44px × 44px

---

## 8. Performance

- LCP 2.5秒以内
- 画像：WebP / AVIF
- フォント：subset化
- JS最小化

---

## 9. Do / Don’t

### Do

- 余白で語る
- タイポグラフィを主役にする
- 非対称を恐れない

---

### Don’t

- 無意味な装飾
- 過剰な影
- UIキット感

---

## 10. Brand Expression

このUIは「売るためのUI」ではなく、

**思想を伝え、時間を感じさせ、静けさを体験させるUIである。**