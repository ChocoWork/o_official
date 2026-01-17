# Brand Guidelines (スケルトン)

## 目的
- 本ドキュメントは、本プロジェクトのデザイン基盤（ブランドコンセプト、ビジュアル、コピー、実装ルール）を定義します。
- フロントエンド実装者は必ず本ガイドラインに従ってください。
## 1. ブランド概要

- ブランド名: Le Fil des Heures
- ブランドコンテキスト: 「Le Fil des Heures（ル フィル デ ザール）」は、ミニマル×モードの交差から生まれるタイムレスな日常着を提供するコンテンポラリーブランドです。価格帯はミドル〜ミドルハイ（約¥20,000〜¥80,000）。本ドキュメントはEC上でブランド表現を一貫して担保するためのデザイン要件を定義します。
- ターゲット: 都市生活者を中心とした20代後半〜40代のファッション感度の高い男女（品質・デザインに対価を払う層）

注: 現在の実装（`src/app/layout.tsx`, `src/app/globals.css`）では Geist 系の Google Font が設定されています。ブランド仕様に合わせる場合は `Didot` のライセンス確認と配信方法（自己ホスト or フォント配信サービス）を決定してください。互換方針は「見出しにDidot、本文/UIは Inter / Noto Sans JP」を基本とします。

## 2. タイポグラフィ

- 見出しフォント: `Didot`（必須候補） — ロゴ・H1/H2に使用。ライセンス確認のうえ、サブセットをプリロードし `font-display: swap` を設定すること。
- 本文/UIフォント: `Inter`（英字） / `Noto Sans JP`（日本語）を基本スタックとする。フォールバックは `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`。
- フォントスタック例:

   - 見出し: "Didot", Georgia, 'Times New Roman', serif
   - 本文: Inter, 'Noto Sans JP', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif

- レスポンシブタイポスケール（推奨）:
   - H1: 2.25rem (36px)
   - H2: 1.75rem (28px)
   - H3: 1.25rem (20px)
   - Body: 1rem (16px)
   - Small: 0.875rem (14px)

- 行間: 見出し 1.05–1.15、本文 1.35–1.6（デスクトップ 1.4 推奨、モバイルはやや詰める）。

## 3. カラーパレット（コア）

- Primary: Absolute Black — `#000000` (ロゴ、主要見出し、主要CTAテキスト)
- Secondary: Graphite Grey — `#474747` (サブ見出し、補助テキスト、境界)
- Accent / Surface: Sand Beige — `#d5d0c9` (カード背景、セクション背景、限定アクセント)
- Neutral: Optical White — `#ffffff` (ページ背景、カードベース)

- 使用ルール:
   - 基本はモノクロ基調。Sand Beige は“温かみ”を出す箇所に限定して使用する。
   - 主要CTAはテキストを Absolute Black に統一し、背景で差別化する（例: `bg-white` / `bg-sand-50` のような薄い面で差をつける）。

- コントラスト（WCAG）:
   - 通常テキスト: 最低 4.5:1 (WCAG AA)
   - 大きなテキスト(≥18pt/≥14pt bold): 最低 3:1
   - UI コンポーネント（境界やアイコン等）も十分な識別性を保つこと（可能なら 3:1 を目安）

## 4. レイアウト / グリッド / スペーシング

- ブレークポイント: Tailwind のデフォルト（sm/md/lg/xl/2xl）を基準にする。
- グリッド: 12カラムがデフォルト。商品一覧は 4/3/2 列のレスポンシブ切替。
- スペーシングスケール（例）: 4, 8, 16, 24, 32, 48, 64（pxベース、Tailwind の spacing と整合）。

## 5. コンポーネント仕様（代表）

- Button
   - 主要バリエーション: `primary`(black text on neutral/bg), `secondary`(outlined/grey), `ghost`, `link`。
   - disabled と loading 状態を必須実装。
   - アクセシビリティ: フォーカスは明確なリング（3px 程度）を表示。

- Card
   - 背景は `neutral` または `sand` の薄バリエーション。角丸は `--radius` を参照（現状: 0.625rem）。

- Form
   - ラベル、プレースホルダー、エラーメッセージのコントラストを確保。エラーは `destructive` トークンを使用。

実装ヒント:
- `src/components/ui/button.tsx` の `variant` はそのまま使い、Tailwind トークンにマップする。例: `default` → `bg-neutral text-primary`。

## 6. 画像・写真の指針

- 撮影スタイル: 自然光・ニュートラルな背景で素材感を重視。モデルは自然なポーズ、過度な加工を避ける。
- 推奨アスペクト比:
   - 商品サムネイル: 1:1
   - 商品詳細メイン: 4:5 または 3:4
   - ヒーロー: 16:9
- ファイル形式: WebP 優先、fallback PNG/JPEG。最大幅での最適化と `next/image` の `priority`/`placeholder` を適切に使用。
- alt 文: 商品名 + 主要特徴（例: "ウール混コート - ベージュ、サイズM"）。

## 7. コピー（文章）トーン

- トーン: 控えめで洗練された語り口。専門用語は必要最低限、製品の品質とケアを丁寧に伝える。
- CTA 例: "今すぐ見る", "カートに追加"（簡潔で行動を促す）

## 8. アクセシビリティ

- 色コントラスト: 通常テキスト 4.5:1 を最小ラインとして検証。既存の `#000000` / `#ffffff` の組合せは基準を満たす。
- キーボード: すべてのインタラクティブ要素はキーボードで操作可能にすること。
- ARIA: 複雑なウィジェット（モーダル、ドロップダウンなど）は適切な ARIA 属性を付与する。

## 9. 実装ノート

- `tailwind.config.js` の推奨追加（抜粋）:

```js
// tailwind.config.js (抜粋)
module.exports = {
   theme: {
      extend: {
         colors: {
            primary: '#000000',
            secondary: '#474747',
            sand: {
               DEFAULT: '#d5d0c9',
               50: '#f7f6f4'
            },
            neutral: '#ffffff'
         },
         spacing: {
            18: '4.5rem'
         },
         borderRadius: {
            lg: '0.625rem'
         }
      }
   }
}
```

- design-tokens.json の例（最小）:

```json
{
   "colors": { "primary": "#000000", "secondary": "#474747", "sand": "#d5d0c9", "neutral": "#ffffff" },
   "font": { "heading": "Didot", "body": "Inter, Noto Sans JP" },
   "spacing": { "base": 8 }
}
```

- globals.css と Tailwind トークンの段階的移行:
   1. `:root` / `.dark` に定義された `--primary` 等を `tailwind.config.js` の該当トークンへマップするテーブルを作る。
   2. コンポーネントのクラス（例: `bg-card`）を段階的に `bg-neutral` 等の Tailwind トークンへ置換する。
   3. 夜間ダークテーマの振る舞いをデザイン担当と決める（Sand Beige はダークで使用しない等）。

## 10. アセット & リンク

- Figma プロジェクト: （デザイナー提供 URL を記載）
- ロゴ: `assets/logos/` に SVG を配置。カラーバリエーション（黒/白/単色）を用意。

## 11. 合意と変更フロー

- ガイドラインの改定はデザイン担当の承認が必要。トークンの破壊的変更は PR とミーティングで合意する。

## 12. 参考実装例

- `src/components/ui/` の実装を参照。コンポーネントはトークンに依存する薄いラッパーを目指す。

## 付録

- デザイナー連絡先: （記載）
- 変更履歴: このファイルの更新履歴を残すこと。


## 7. コピー（文章）トーン
- トーン：（例）親しみやすく、でも信頼感のある言い回し
- CTA の文例
- 禁止表現（差別的表現、誇大広告など）

## 8. アクセシビリティ
- 色コントラスト基準（AA/AAAの適用範囲）
- キーボード操作対応必須箇所
- ARIA の使用方針

## 9. 実装ノート
- `tailwind.config.js` に定義する推奨トークン（カラー・スペーシング・フォント）
- デザイントークンの JSON 例
- コンポーネント実装のベストプラクティス（サーバーコンポーネントとクライアントコンポーネントの分離）

## 10. アセット & リンク
- Figma プロジェクトリンク: (デザイナーから提供)
- ロゴ（SVG/PNG）置き場
- カラーパレットファイル

## 11. 合意と変更フロー
- ガイドラインの変更はデザイン担当の合意が必要
- 破壊的変更やトークン変更は事前にチーム承認を得る

## 12. 参考実装例
- `src/components/ui/` の実装例を参照

## 付録
- デザイナー連絡先・Figmaオーナー
- 変更履歴
