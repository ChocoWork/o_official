# UIコンポーネント一覧

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「UIコンポーネント一覧」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

この一覧は旧設計時点の分類である。現行の共通UI実装は [`src/components/ui/`](../../../src/components/ui/) にあり、表の各項目の存否・用途はコードで再確認する。

| ファイル名 | 対応カテゴリ |
| --- | --- |
| Accordion.tsx | アコーディオン |
| ActionSheet.tsx | アクションシート |
| Avatar.tsx | アバター |
| BannerAlert.tsx | バナー・アラート |
| BottomNavigation.tsx | ボトムナビゲーション |
| Button.tsx | ボタン |
| Card.tsx | カード |
| Carousel.tsx | カルーセル |
| Checkbox.tsx | チェックボックス |
| ColorPicker.tsx | カラーピッカー |
| DataTable.tsx | テーブル |
| DateTimePicker.tsx | 日付・時間選択 |
| Dialog.tsx | ダイアログ |
| Drawer.tsx | ドロワー |
| Dropdown.tsx | ドロップダウン |
| FloatingButton.tsx | フロートボタン |
| Graph.tsx | グラフ |
| List.tsx | リスト |
| MapView.tsx | マップ |
| MultiSelect.tsx | マルチセレクト |
| PageControl.tsx | ページコントロール |
| RadioButtonGroup.tsx | ラジオボタン |
| Rating.tsx | レーティング |
| SearchField.tsx | 検索フィールド |
| SheetLarge.tsx | シート(ラージ) |
| SheetMedium.tsx | シート(ミディアム) |
| SingleSelect.tsx | シングルセレクト |
| Slider.tsx | スライダー |
| Stats.tsx | スタッツ |
| StatusBadge.tsx | バッジ |
| Stepper.tsx | ステッパー |
| SwitchToggle.tsx | スイッチ・トグル |
| TabSegmentControl.tsx | タブ・セグメントコントロール |
| TagLabel.tsx | タグ・ラベル |
| TextAreaField.tsx | テキストフィールド |
| TextField.tsx | テキストフィールド |
| ToastSnackbar.tsx | トースト・スナックバー |
| Toolbar.tsx | ツールバー |
| Tooltip.tsx | ツールチップ |

**その他のファイル**

- InputChangeEvent.ts (ユーティリティ)
- OverlayShell.tsx (レイアウト/ユーティリティ)
- shared.ts (共通ロジック)

---

以上が `ui` コンポーネントの一覧とカテゴリマッピングです。
