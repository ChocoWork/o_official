# デザインを決める文書です

## 概要

この文書は Le Fil des Heures の画面設計方針と UI コンポーネントの整理表をまとめる。特に About、ITEM 一覧、ITEM 詳細の各ページについて、実装に対応した要素とレイアウトの意図を明確にする。

## フォントサイズ

- フォントサイズは、基本的には以下のサイズから選ぶこと。さらに追加が必要であれば同様のルールで追加すること。
  --lk-size-md: clamp(0.875rem, 0.84rem + 0.14vw, 0.9375rem);
  --lk-size-sm: calc(var(--lk-size-md) / var(--lk-eighthstep));
  --lk-size-xs: calc(var(--lk-size-sm) / var(--lk-eighthstep));
  --lk-size-2xs: calc(var(--lk-size-xs) / var(--lk-eighthstep));
  --lk-size-3xs: calc(var(--lk-size-2xs) / var(--lk-eighthstep));
  --lk-size-4xs: calc(var(--lk-size-3xs) / var(--lk-eighthstep));
  --lk-size-5xs: calc(var(--lk-size-4xs) / var(--lk-eighthstep));
  --lk-size-6xs: calc(var(--lk-size-5xs) / var(--lk-eighthstep));
  --lk-size-7xs: calc(var(--lk-size-6xs) / var(--lk-eighthstep));
  --lk-size-lg: calc(var(--lk-size-md) * var(--lk-eighthstep));
  --lk-size-xl: calc(var(--lk-size-lg) * var(--lk-quarterstep));
  --lk-size-2xl: calc(var(--lk-size-xl) * var(--lk-quarterstep));
  --lk-size-3xl: calc(var(--lk-size-2xl) * var(--lk-quarterstep));
  --lk-size-4xl: calc(var(--lk-size-3xl) * var(--lk-quarterstep));

## デザインシステム・UI コンポーネント

| ルート | ページ | セクション | 要素 | フォントサイズ（現状） | フォントサイズ現状（--lk-size-xx） | フォントサイズ設計（--lk-size-xx） | 設計理由 | 実装ステータス |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| - | - | Header | ブランド名 | font-size: var(--lk-size-xl) | --lk-size-xl | --lk-size-xl | 反復: `.header-title` をPC/モバイルで共通化し、Playwright実測16.77px-17.97pxでブランド階層を一定化。対比: ナビより一段大きく主役を固定。 |  |
| - | - | Header | ナビゲーションメニュー（PC） | text-[11px] / xl:text-[12px] | --lk-size-2xs | --lk-size-2xs | 整列: 横並びナビを11px/12pxで揃え、Playwright実測12px（desktop）で列のリズムを維持。反復: 全メニュー同一クラス。 |  |
| - | - | Header | ナビゲーションメニュー（モバイル、タブレット） | font-size: var(--lk-size-sm) | --lk-size-sm | --lk-size-md | 近接: Drawer内リンク群を同サイズでまとめ視線移動を短縮。Playwright実測13.18px（390）/13.67px（768）で可読性を担保。 |  |
| - | - | Header | SNSリンク（モバイル、タブレット） | text-xl（アイコン） | --lk-size-2xl | --lk-size-2xl | 対比: ナビ文字より大きい20pxで行動要素を強調。整列: 同一サイズアイコンを横並びで反復し、Playwright実測20pxで一貫。 |  |
| - | - | Header | アイコン | text-[16px] / sm:text-[18px] / md:text-[18px] | --lk-size-xl | --lk-size-xl | 対比: 操作アイコンを本文より強く見せる。Playwright実測16px（390）/18px（768,1280）で段階差が明確。整列: 全アイコン同寸。 |  |
| `/` | ホーム | Hero | ブランド名 | text-[22px] / sm:text-[26px] / md:text-[28px] / lg:text-[32px] / xl:text-[34px] | --lk-size-4xl | --lk-size-4xl | 対比: ヒーロー主見出しを最大階層として固定。Playwright実測22px→28px→34pxで最上位の視覚優先度を維持。 | 完了 |
| `/` | ホーム | Search Preview | `SearchHomePreview` 検索クエリ即時プレビューカードと `VIEW ALL RESULTS` リンク | text-xs / text-sm / text-[11px] / text-lg | --lk-size-md | --lk-size-md | 反復: コンポーネント内で12/14/11/18pxを役割別に反復し、本文基準は14px。Playwright実測（12/14/11/18px）で情報の整列が成立。 | 完了 |
| `/` | ホーム | ITEMS | セクションタイトル | text-[18px] / sm:text-[20px] / md:text-[22px] / lg:text-[26px] | --lk-size-3xl | --lk-size-3xl | 反復: 全ホームセクション見出しを同スケールで統一。Playwright実測18px→22px→26pxで整列と章立ての一貫性を確保。 | 完了 |
| `/` | ホーム | ITEMS | 商品名 | text-[11px] / sm:text-[12px] / md:text-[13px] / lg:text-[14px] | --lk-size-2xs | --lk-size-2xs | 近接: 商品名と価格の差を1段に抑えカード内のまとまりを維持。Playwright実測11px→13px→14pxで可読性と密度を両立。 | 完了 |
| `/` | ホーム | ITEMS | 価格 | text-[10px] / sm:text-[11px] / md:text-[12px] / lg:text-[13px] | --lk-size-4xs | --lk-size-3xs | 対比: 商品名より1段小さく主従を明確化。Playwright実測10px→12px→13pxで情報の優先順位が安定。 | 完了 |
| `/` | ホーム | ITEMS | VIEW ALL ITEMS ボタン | Button size="xs" | --lk-size-xs | --lk-size-xs | 反復: CTAを`Button size=xs`でNEWS/LOOKと統一。Playwright実測12.41px→12.87px→13.30pxで操作ラベルの整列を維持。 | 完了 |
| `/` | ホーム | LOOK | セクションタイトル | text-[18px] / sm:text-[20px] / md:text-[22px] / lg:text-[26px] | --lk-size-3xl | --lk-size-3xl | 反復: ITEMS/NEWS/ABOUT/STOCKISTと同一見出しスケールを維持し、ページ全体の章構造を整列。Playwright実測18px→22px→26px。 | 完了 |
| `/` | ホーム | LOOK | シーズン＆シーズンテーマ名 | text-base | --lk-size-lg | --lk-size-lg | 対比: 見出しより下げつつ関連商品より上げる中位階層。Playwright実測16pxでLOOKカードの主情報として判読しやすい。 | 完了 |
| `/` | ホーム | LOOK | 関連商品 | text-xs | --lk-size-xs | --lk-size-xs | 近接: テーマ名直下に12pxで連結し、補助情報として統一。Playwright実測12pxで反復性を確認。 | 完了 |
| `/` | ホーム | LOOK | VIEW LOOKBOOK ボタン | Button size="xs" | --lk-size-xs | --lk-size-xs | 反復: ホーム内VIEW系CTAを同一サイズで整列。Playwright実測12.41px→13.30pxで他セクションボタンと一貫。 | 完了 |
| `/` | ホーム | NEWS | セクションタイトル | text-[18px] / sm:text-[20px] / md:text-[22px] / lg:text-[26px] | --lk-size-3xl | --lk-size-3xl | 反復: ホーム見出しの共通スケールを維持。Playwright実測18px→22px→26pxでセクション間の整列を担保。 | 完了 |
| `/` | ホーム | NEWS | 日付 | text-[9px] / sm:text-[10px] / md:text-[11px] / lg:text-[12px] | --lk-size-6xs | --lk-size-4xs | 対比: タイトル/本文より小さく補助メタとして整理。Playwright実測9px→11px→12pxでメタ情報の優先度が一定。 | 完了 |
| `/` | ホーム | NEWS | カテゴリ | TagLabel size="xs" / sm: size="sm" | --lk-size-6xs | --lk-size-5xs | 反復: TagLabelのsize切替でモバイルとsm+を運用。Playwright実測8.65px（xs）/9.53px-9.85px（sm）で日付行との近接を維持。 | 完了 |
| `/` | ホーム | NEWS | タイトル | text-[13px] / sm:text-[14px] / md:text-[15px] / lg:text-[16px] | --lk-size-sm | --lk-size-sm | 対比: 日付・カテゴリより上位、本文より上位の主見出し階層。Playwright実測13px→15px→16pxで見出し性を確保。 | 完了 |
| `/` | ホーム | NEWS | サマリー | text-[10px] / sm:text-[11px] / md:text-[12px] / lg:text-[13px] | --lk-size-4xs | --lk-size-2xs | 近接: タイトル直下の説明を一段小さく配置し情報塊を形成。Playwright実測10px→12px→13pxで階層差を維持。 | 完了 |
| `/` | ホーム | NEWS | `VIEW ALL NEWS` ボタン | Button size="xs" | --lk-size-xs | --lk-size-xs | 反復: ホーム内のVIEW系ボタンを共通サイズで揃え操作学習コストを下げる。Playwright実測12.41px→13.30px。 | 完了 |
| `/` | ホーム | ABOUT | セクションタイトル | text-[18px] / sm:text-[20px] / md:text-[22px] / lg:text-[26px] | --lk-size-3xl | --lk-size-3xl | 整列: 他ホームセクション見出しと同一レンジで章構造を統一。Playwright実測18px→22px→26px。 | 完了 |
| `/` | ホーム | ABOUT | メインテキスト | text-[11px] / sm:text-[12px] / md:text-[13px] / lg:text-[14px] | --lk-size-2xs | --lk-size-sm | 近接: 段落群を同サイズ反復で読み進めやすく整理。Playwright実測11px→13px→14pxで本文可読性を確保。 | 完了 |
| `/` | ホーム | ABOUT | サブタイトル | text-[10px] / sm:text-[11px] / md:text-[12px] / lg:text-[13px] | --lk-size-4xs | --lk-size-3xs | 対比: メイン本文より一段小さく情報ラベルとして機能。Playwright実測10px→12px→13pxで補助見出しの役割が明確。 | 完了 |
| `/` | ホーム | ABOUT | サブテキスト | text-[10px] / sm:text-[11px] / md:text-[12px] / lg:text-[13px] | --lk-size-4xs | --lk-size-2xs | 反復: サブタイトルと同レンジでカード群を整列し、近接した情報ペアとして認識しやすくする。Playwright実測10px→13px。 | 完了 |
| `/` | ホーム | STOCKIST | セクションタイトル | text-[18px] / sm:text-[20px] / md:text-[22px] / lg:text-[26px] | --lk-size-3xl | --lk-size-3xl | 反復: ホーム全セクション見出しの共通設計を維持。Playwright実測18px→22px→26pxで章の対比が安定。 | 完了 |
| `/` | ホーム | STOCKIST | 店舗名 | clamp(0.9375rem, 0.85rem + 0.43vw, 1.125rem) | --lk-size-lg | --lk-size-lg | 対比: 店舗名を詳細情報より上位に置くため中見出しサイズを採用。Playwright実測15.28px→16.90px→18pxで段階的に強調。 | 完了 |
| `/` | ホーム | STOCKIST | 住所 | clamp(0.75rem, 0.72rem + 0.14vw, 0.8125rem) | --lk-size-xs | --lk-size-xs | 近接: 住所/電話/営業時間/休日を同サイズで反復し情報群を一塊化。Playwright実測12.07px→12.60px→13pxで可読性を維持。 | 完了 |
| `/` | ホーム | STOCKIST | 電話番号 | clamp(0.75rem, 0.72rem + 0.14vw, 0.8125rem) | --lk-size-xs | --lk-size-xs | 反復: 住所行と同サイズで整列し、連絡情報の探索性を向上。Playwright実測12.07px→13pxで一致。 | 完了 |
| `/` | ホーム | STOCKIST | 営業時間 | clamp(0.75rem, 0.72rem + 0.14vw, 0.8125rem) | --lk-size-xs | --lk-size-xs | 反復: 詳細情報行を同一レンジに統一し、比較読みを容易化。Playwright実測12.07px→13px。 | 完了 |
| `/` | ホーム | STOCKIST | 休日 | clamp(0.75rem, 0.72rem + 0.14vw, 0.8125rem) | --lk-size-xs | --lk-size-xs | 整列: 詳細情報4行を同サイズで揃え、視線の上下移動を最小化。Playwright実測12.07px→13px。 | 完了 |
| - | - | Footer | ブランド名 | text-[16px] / sm:text-[17px] / md:text-[18px] / lg:text-[20px] | --lk-size-xl | --lk-size-xl | 対比: Footer内で最上位の識別子として他テキストより大きく設定。Playwright実測16px→18px→20pxでブランド視認性を維持。 |  |
| - | - | Footer | ブランドテーマ | text-[10px] / sm:text-[11px] | --lk-size-4xs | --lk-size-2xs | 近接: ブランド名直下に小サイズで配置し補助説明として連結。Playwright実測10px/11pxで主従関係が明確。 |  |
| - | - | Footer | ナビゲーションタイトル | text-[10px] / sm:text-[12px] / md:text-[13px] / lg:text-[14px] | --lk-size-3xs | --lk-size-xs | 整列: 各カラム見出しを同サイズ反復で統一。Playwright実測10px→13px→14pxでリンク群との対比を確保。 |  |
| - | - | Footer | ナビゲーションリンク | text-[10px] / sm:text-[11px] / md:text-[12px] / lg:text-[13px] | --lk-size-4xs | --lk-size-2xs | 反復: 全リンクを同レンジで揃え、カテゴリ横断の可読性を均質化。Playwright実測10px→12px→13px。 |  |
| - | - | Footer | コピーライト | text-[9px] / sm:text-[12px] | --lk-size-6xs | --lk-size-4xs | 対比: 最下層情報として最小級サイズを採用し主情報を邪魔しない。Playwright実測9px（390）/12px（768,1280）で役割分離。 |  |
| - | - | Footer | アイコン | text-xl | --lk-size-2xl | --lk-size-2xl | 対比: テキスト群より大きい20pxで行動導線を明確化。整列: 3アイコン同寸で反復し視覚ノイズを抑制。Playwright実測20px。 |  |
| `/about` | ABOUT | - | ページタイトル | h1 + style fontSize=--lk-size-4xl | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測では h1 も h2 も 16px で階層差が消えていたため、ページ起点は4xlまで上げて章の入口を明確にする。 | 完了 |
| `/about` | ABOUT | - | タイトル | h2 + style fontSize=--lk-size-3xl | --lk-size-3xl | --lk-size-3xl | 対比: セクション見出しも実測16pxのままだったので、ページタイトルより1段下の3xlへ揃えて本文との主従を作る。 | 完了 |
| `/about` | ABOUT | - | メインテキスト | p.about-main-text + style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 反復: `.about-main-text` は実測11px→13px→14pxで推移していたが、長文可読性を優先してsmへ寄せ、ホームABOUT本文とも整列させる。 | 完了 |
| `/item` | ITEMページ | - | 商品名 | font-brand + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 反復: 一覧カードの主情報はホームITEMSと同じ2xs帯で揃え、価格との差を1段に保って商品比較をしやすくする。 | 完了 |
| `/item` | ITEMページ | - | 価格 | style fontSize=--lk-size-3xs | --lk-size-3xs | --lk-size-3xs | 対比: 商品名より1段小さい3xsへ寄せると、価格を補助情報として後退させつつ11px台の可読性を確保できる。 | 完了 |
| `/item` | ITEMページ | - | SORT ボタン | text-[11px] + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 整列: SORT はカード名と同じ2xs帯に置くと、一覧上部のユーティリティ列が揃い視線移動が短くなる。 | 完了 |
| `/item` | ITEMページ | - | FILTER ボタン（モバイルとタブレットのみ） | Button size="compact" + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 対比: compact由来の極小文字は操作導線として弱いので、4xsまで上げてSORTや選択肢との読字密度を合わせる。 | 完了 |
| `/item` | ITEMページ | - | 閉じるための×ボタン（モバイルとタブレットのみ） | Button size="xl" + style fontSize=--lk-size-2xl | --lk-size-2xl | --lk-size-2xl | 対比: Drawerの終了操作は本文より強い2xlで固定し、モバイルでも閉じる位置を即認識できるようにする。 | 完了 |
| `/item` | ITEMページ | - | FILTER の親タイトル | Accordion size="xs" | --lk-size-xs | --lk-size-xs | 反復: フィルタ章見出しは選択肢より1段大きいxsに統一し、近接するチェック群のまとまりを明確化する。 | 完了 |
| `/item` | ITEMページ | - | FILTER の選択肢 | Checkbox size="xs" | --lk-size-2xs | --lk-size-2xs | 整列: 選択肢は2xsで反復すると、項目数が増えても縦リズムを崩さず一覧の密度と整合する。 | 完了 |
| `/item` | ITEMページ | - | APPLY ボタン | Button size="xs" | --lk-size-xs | --lk-size-xs | 対比: 実行ボタンは選択肢より1段上のxsにして、フィルタ操作の終点を明確に見せる。 | 完了 |
| `/item` | ITEMページ | - | RESET ボタン | Button size="xs" | --lk-size-xs | --lk-size-xs | 反復: APPLYとRESETを同じxsに揃え、フィルタ下部の操作系を一貫した階層として認識させる。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | パンくずリスト | text-xs + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 近接: パンくずは補助ナビとしてxsに抑え、商品名や購入導線より前に出ないようにする。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | 商品名 | h2 + style fontSize=--lk-size-3xl | --lk-size-3xl | --lk-size-3xl | 対比: Playwright実測では商品名も16px止まりなので、詳細ページの主役として3xlまで上げて画像・価格より先に読ませる。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | 選択肢タイトル（COLOR、SIZE、QUANTITY、PRODUCT DETAILS） | p + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 近接: 入力群直前のラベルは本文より1段小さいxsへ揃え、商品名を邪魔せず操作塊の見出しとして機能させる。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | 選択肢ボタン（COLOR、SIZE） | Button size="sm" | --lk-size-sm | --lk-size-sm | 反復: Button size=sm を維持すると数量入力や主CTAより一段下の操作階層が揃い、タップ領域も確保できる。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | 数量入力 | Stepper size="sm" (input style fontSize=--lk-size-xs / Button size="sm") | --lk-size-xs | --lk-size-xs | 整列: Stepper の数値は補助ラベルと同じxs帯に置き、前後ボタンとの密度を均質化する。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | 商品詳細テキスト | style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 近接: 商品理解に使う長文なので、実装の12px/14pxレンジをsmへ寄せて可読性を優先する。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | PRODUCT DETAILS テキスト | style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 反復: 商品説明と同じsmに揃えると、2つの本文ブロックを同じ読み方で処理でき情報探索が安定する。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | ADD TO CART ボタン | Button size="md" / sm (mobile footer + style fontSize=--lk-size-md) | --lk-size-md | --lk-size-md | 対比: 主CTAは本文・選択肢より上のmdへ置き、モバイルフッターのsmとの差も1段に収めて強さを維持する。 | 完了 |
| `/item/[id]` | ITEM詳細ページ | - | お気に入り登録 ボタン | Button size="md" / sm (mobile footer + style fontSize=--lk-size-md) | --lk-size-md | --lk-size-md | 整列: ADD TO CART と同じmd帯で揃え、詳細ページの主要アクション2つを同一階層として見せる。 | 完了 |
| `/look` | LOOKページ | - | シーズン＆シーズンテーマ名 | style fontSize=--lk-size-lg | --lk-size-lg | --lk-size-lg | 対比: Playwright実測16pxのカード見出しはホームLOOKの主情報と同じlg帯で十分なので、関連商品との差だけを明確に残す。 | 完了 |
| `/look` | LOOKページ | - | 関連商品 | style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 近接: 関連商品はカード見出し直下の補助情報なのでxsで反復し、一覧比較時のノイズを増やさない。 | 完了 |
| `/look` | LOOKページ | - | FILTER ボタン（モバイルとタブレットのみ） | Button size="compact" + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 対比: compactのままでは導線が弱いので、4xsへ上げてNEWS/ITEMのフィルタ導線と同じ読字強度へ揃える。 | 完了 |
| `/look` | LOOKページ | - | 閉じるための×ボタン（モバイルとタブレットのみ） | button style fontSize=--lk-size-2xl | --lk-size-2xl | --lk-size-2xl | 反復: Drawer の閉じる操作は2xlで統一し、一覧系ページの終了導線を共通の見え方にする。 | 完了 |
| `/look` | LOOKページ | - | FILTER の選択肢 | MultiSelect size="xs" + renderOptionLabel span fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 整列: MultiSelect xs の10pxは一段小さいため、設計上は4xsへ寄せて選択肢テキストの判読性を確保する。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | シーズン | p + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: シーズンは補助ラベルなので12px相当のxsに固定し、タイトルとの主従を安定させる。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | シーズンタイトル | h1 + style fontSize=--lk-size-3xl | --lk-size-3xl | --lk-size-3xl | 対比: Playwright実測16pxのh1では主題が弱いため、LOOK詳細の核として3xlまで持ち上げる。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | メインテキスト | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 近接: 説明本文は実測14pxで安定しており、写真と並置しても読みやすいmdが基準になる。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | STYLING ITEMS 見出し | h3 + style fontSize=--lk-size-lg | --lk-size-lg | --lk-size-lg | 対比: リスト開始を示す見出しは本文より1段大きいlgにし、下のアイテム列への切り替えを明確にする。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | 紐づけアイテム名 | List size="xs" + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: List showcase の titleSize と同じxsに揃え、商品一覧との認知を連続させる。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | 紐づけアイテムカテゴリ | List size="xs" + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 対比: カテゴリは商品名より1段下の4xsへ置き、補助ラベルとして後退させる。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | 紐づけアイテム価格 | List size="xs" + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 整列: 商品名と価格を同じxs帯に揃えると、左右配置でも比較読みしやすい。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | アクションラベル（PREV、NEXT） | p + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: PREV/NEXT は補助ラベルなのでxsで統一し、遷移先タイトルとの階層差を一定に保つ。 | 完了 |
| `/look/[id]` | LOOK詳細ページ | - | 前後のシーズンタイトル | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 対比: 遷移先のタイトルはラベルより1段大きいmdにして、クリック対象の内容理解を優先する。 | 完了 |
| `/news` | NEWSページ | - | 日付 | span + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 対比: タイトルや要約より一段小さい4xsへ寄せると、メタ情報としての位置づけが安定する。 | 完了 |
| `/news` | NEWSページ | - | カテゴリ  | TagLabel size="md" | --lk-size-5xs | --lk-size-5xs | 反復: TagLabel はホームNEWSと同じ5xs帯へ揃え、日付行の情報密度を横断的に統一する。 | 完了 |
| `/news` | NEWSページ | - | タイトル | h4 + style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 対比: 一覧記事の主情報は13px-16pxの実装をそのままsm帯へ整理し、日付や要約より上位に固定する。 | 完了 |
| `/news` | NEWSページ | - | サマリー | p + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 近接: タイトル直下の要約は1段小さい2xsへ寄せると、本文入口として読みやすくなる。 | 完了 |
| `/news` | NEWSページ | - | FILTER ボタン（モバイルとタブレットのみ） | Button size="compact" + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 整列: 一覧系フィルタ導線はITEM/LOOKと同じ4xsへ揃え、画面を跨いだ操作学習を統一する。 | 完了 |
| `/news` | NEWSページ | - | 閉じるための×ボタン（モバイルとタブレットのみ） | button + style fontSize=--lk-size-2xl | --lk-size-2xl | --lk-size-2xl | 反復: モバイルDrawerの終了導線は2xlで共通化し、認識コストを下げる。 | 完了 |
| `/news` | NEWSページ | - | FILTER の選択肢 | MultiSelect size="xs" + renderOptionLabel span fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 近接: 選択肢文字は4xsへ寄せると、短いカテゴリ名でも読み飛ばしが起きにくい。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | パンくずリスト | ol + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 整列: パンくずは11px-12px実装に合わせて2xsへ置き、本文より控えめなナビ情報として揃える。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | 日付 | span + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 反復: 日付もパンくずと同じ2xs帯へ寄せ、メタ情報列の見え方を統一する。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | カテゴリ | TagLabel size="md" | --lk-size-5xs | --lk-size-5xs | 対比: TagLabel size=sm は9px台なので5xsに整理し、日付とタイトルの中間階層に置く。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | タイトル | h1 + style fontSize=--lk-size-3xl | --lk-size-3xl | --lk-size-3xl | 対比: Playwright実測でh1が16pxに留まるため、記事主題は3xlへ上げて本文との階層差を取り戻す。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | メインテキスト | p + style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 近接: 本文は実測12px/14pxで推移しており、長文読解を優先するsmが最も安定する。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | アクションラベル（PREV、NEXT） | p + style fontSize=--lk-size-4xs | --lk-size-4xs | --lk-size-4xs | 対比: PREV/NEXT は補助ラベルなので4xsに抑え、隣接タイトルより一段控えめに見せる。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | 前後のニュースタイトル | p + style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 整列: ラベルより1段大きいsmに揃えると、遷移先識別を優先しつつ本文よりは抑えた階層になる。 | 完了 |
| `/news/[id]` | NEWS詳細ページ | - | VIEW ALL ボタン | Button size="sm" | --lk-size-sm | --lk-size-sm | 反復: 記事末尾の戻りCTAはButton size=smで十分なので、前後記事導線と競合しない強さに保つ。 | 完了 |
| `/stockist` | STOCKISTページ | - | セクションタイトル | 描画なし (`PublicStockistGrid variant="catalog"`) | - | - | 事実: `/stockist` は `PublicStockistGrid variant="catalog"` を使っており、この画面単体ではセクションタイトル要素を描画していないため設計対象外。 | 完了 |
| `/stockist` | STOCKISTページ | - | 店舗名 | h3.stockist-card-title + style fontSize=--lk-size-lg | --lk-size-lg | --lk-size-lg | 対比: Playwright実測15.28px→16.90px→18pxの店名は、詳細情報より上のlg帯で揃えるとカード見出しとして十分強い。 | 完了 |
| `/stockist` | STOCKISTページ | - | 住所 | p.stockist-card-text + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: 住所・電話・営業時間・休日は同じxsで統一し、店舗詳細4行を一塊として比較しやすくする。 | 完了 |
| `/stockist` | STOCKISTページ | - | 電話番号 | p.stockist-card-text + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: 住所行と同じxsに揃え、連絡情報を探すときの視線リズムを一定にする。 | 完了 |
| `/stockist` | STOCKISTページ | - | 営業時間 | p.stockist-card-text + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 整列: 店舗情報の各行を同サイズで揃え、上下比較のしやすさを優先する。 | 完了 |
| `/stockist` | STOCKISTページ | - | 休日 | p.stockist-card-text + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 整列: 営業時間行と同じxsに揃えることで、詳細情報ブロック全体の密度を均質化する。 | 完了 |
| `/contact` | CONTACTページ | - | ページタイトル | 未指定 (ブラウザデフォルト) | --lk-size-3xl | --lk-size-4xl | 対比: Playwright実測ではページタイトルも16pxに留まるため、トップレベルページ見出しとして4xlまで上げてフォームより先に認識させる。 | 完了 |
| `/contact` | CONTACTページ | - | ページ概要 | text-sm / lg:text-base | --lk-size-md | --lk-size-md | 近接: 実測14px→16pxの概要文はフォーム説明として十分なので、mdで本文可読性と縦密度の均衡を取る。 | 完了 |
| `/contact` | CONTACTページ | - | フォームラベル | text-xs | --lk-size-xs | --lk-size-xs | 反復: 各フィールドラベルはxsに統一し、入力値より一段控えめな補助情報として揃える。 | 完了 |
| `/contact` | CONTACTページ | - | フォーム | TextField size="md" / TextAreaField size="md" / SingleSelect size="md" (text-sm) | --lk-size-md | --lk-size-md | 整列: 主要フォーム部品はすべてmd基準なので、入力欄横断の視認性と入力体験を統一できる。 | 完了 |
| `/contact` | CONTACTページ | - | 送信ボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 対比: 送信CTAはラベル・入力欄より上のlgにして、完了導線を明快にする。 | 完了 |
| `/contact` | CONTACTページ | - | 送信完了メッセージ | text-sm | --lk-size-md | --lk-size-md | 反復: 完了メッセージは概要文・入力欄と同じmd帯に置き、状態変化だけを色や文言で伝える。 | 完了 |
| `/search` | 検索ページ | - | DISCOVER ラベル | p + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 反復: DISCOVER は補助ラベルなのでxsで十分であり、ページタイトルとの主従を明確に保てる。 | 完了 |
| `/search` | 検索ページ | - | ページタイトル | h1 + style fontSize=--lk-size-4xl | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測16pxのh1では DISCOVER や本文と差が薄かったため、検索ページの起点は4xlまで上げる。 | 完了 |
| `/search` | 検索ページ | - | ページ概要 | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 近接: 実測14pxの概要文は検索入力の直前に置く本文としてちょうど良く、mdが最も安定する。 | 完了 |
| `/search` | 検索ページ | - | 検索入力 | SearchField size="lg" + input style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 整列: SearchField は size=lg でも文字はtext-sm基準だったため、入力体験の基準を md に明示した。 | 完了 |
| `/search` | 検索ページ | - | サジェスト / 最近の検索ボタン | button + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 反復: 候補ボタンは入力欄と同じmd帯で揃え、検索開始前の選択肢を同一階層で見せる。 | 完了 |
| `/search` | 検索ページ | - | タブ | TabSegmentControl variant="tabs-standard" + itemStyle fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 整列: タブ見出しはtext-sm固定だったため、itemStyle で md を明示して検索結果の切替UIを安定させる。 | 完了 |
| `/search` | 検索ページ | - | エラーメッセージ / 検索中メッセージ | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 反復: 状態メッセージもmdに揃えると、入力欄周辺の補助情報が同じ読み方で処理できる。 | 完了 |
| `/search` | 検索ページ | - | START YOUR SEARCH 見出し | h2 + style fontSize=--lk-size-2xl | --lk-size-2xl | --lk-size-2xl | 対比: Playwright実測16pxのh2では本文との差が足りなかったため、ページタイトルより2段下の2xlで開始状態の見出しを立てる。 | 完了 |
| `/search` | 検索ページ | - | START YOUR SEARCH 本文 | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 近接: 導入本文は実測14pxで安定しており、検索入力直下の説明としてmdが読みやすい。 | 完了 |
| `/search` | 検索ページ | - | NO RESULTS 見出し | h2.font-display + style fontSize=--lk-size-3xl | --lk-size-3xl | --lk-size-3xl | 対比: 実測24pxの空状態見出しは強かったので、ページタイトルより1段下の3xlへ整理しつつ Popular Items よりは大きく保つ。 | 完了 |
| `/search` | 検索ページ | - | NO RESULTS 説明 | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 反復: 空状態の説明文は他の補助本文と同じmdに揃え、状態だけを文言で伝える。 | 完了 |
| `/search` | 検索ページ | - | POPULAR ITEMS 見出し | h3.font-display + style fontSize=--lk-size-xl | --lk-size-xl | --lk-size-xl | 整列: 実測18pxの見出しは結果セクション見出しと同じxlに揃え、並列セクションとして扱う。 | 完了 |
| `/search` | 検索ページ | - | 結果セクション見出し | SearchSection h2 / active tab label + style fontSize=--lk-size-xl | --lk-size-xl | --lk-size-xl | 反復: ITEM / LOOK / NEWS の各結果見出しは同じxlに統一し、タブ横断の章構造を揃える。 | 完了 |
| `/search` | 検索ページ | - | 結果件数ラベル | span + style fontSize=--lk-size-xs | --lk-size-xs | --lk-size-xs | 対比: 件数ラベルは見出しより一段控えたxsにして、数値だけを補助情報として見せる。 | 完了 |
| `/search` | 検索ページ | - | 結果カードメタ | span + style fontSize=--lk-size-2xs | --lk-size-2xs | --lk-size-2xs | 整列: メタ情報は11px実装を2xs帯へ置き換え、本文とタイトルの補助層として機能させる。 | 完了 |
| `/search` | 検索ページ | - | 結果カード本文 | p + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 近接: カード本文はmdに固定すると、一覧カードの可読性を保ちつつ検索結果の密度も維持できる。 | 完了 |
| `/search` | 検索ページ | - | HOME プレビューリンク | Link + style fontSize=--lk-size-md | --lk-size-md | --lk-size-md | 反復: 結果カード内のリンクは本文と同じmd帯で揃え、カード内で過度に浮かせない。 | 完了 |
| `/cart` | カートページ | - | 読み込みテキスト | text-sm | --lk-size-md | --lk-size-md | 反復: ローディング文は他ページの状態メッセージと同じmdに揃え、補助説明として統一する。 | 完了 |
| `/cart` | カートページ | - | 読み込みサブテキスト | text-xs | --lk-size-xs | --lk-size-xs | 対比: サブテキストは主メッセージより1段小さいxsで十分であり、状態説明の主従が崩れない。 | 完了 |
| `/cart` | カートページ | - | 空カートアイコン | style fontSize=var(--lk-size-5xl, calc(var(--lk-size-4xl) * var(--lk-quarterstep))) | --lk-size-5xl | --lk-size-5xl | 対比: まず 5xl を使い、未定義環境でも 4xl の次段へ解決できるようにして、視認性と保守性を両立する。 | 完了 |
| `/cart` | カートページ | - | 空カートテキスト | p + style fontSize=--lk-size-sm | --lk-size-sm | --lk-size-sm | 近接: 空状態文は補助説明としてsmに下げることで、ボタンとの階層差をつくりつつミニマルな余白感を維持する。 | 完了 |
| `/cart` | カートページ | - | CONTINUE SHOPPING ボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 反復: 空状態の主CTAは他フォーム送信ボタンと同じlgに揃え、学習コストを下げる。 | 完了 |
| `/cart` | カートページ | - | エラーメッセージ | text-sm | --lk-size-md | --lk-size-md | 整列: エラー文は本文系と同じmdに揃え、状態差は色と文言で表現する。 | 完了 |
| `/cart` | カートページ | - | 同期エラーバナー本文 | text-sm | --lk-size-md | --lk-size-md | 反復: バナー本文もmdに統一し、再同期ボタンとの差だけで主従を作る。 | 完了 |
| `/cart` | カートページ | - | 再同期 / 再試行ボタン | Button size="sm" | --lk-size-sm | --lk-size-sm | 対比: 補助操作は主CTAより1段下のsmに置き、重要度の差を保つ。 | 完了 |
| `/cart` | カートページ | - | 商品名 | text-lg | --lk-size-xl | --lk-size-lg | 近接: 商品名は価格と並ぶ主情報だが、Order Summary 見出しよりは下げたいのでlg帯で十分。 | 完了 |
| `/cart` | カートページ | - | カラー / サイズテキスト | text-sm | --lk-size-md | --lk-size-md | 反復: 商品メタはmdに揃え、数量やリンクなど同じ補助情報層を統一する。 | 完了 |
| `/cart` | カートページ | - | 商品価格 | text-lg | --lk-size-xl | --lk-size-lg | 整列: 商品名と価格を同じlg帯に揃えると、横並びでも比較しやすい。 | 完了 |
| `/cart` | カートページ | - | 数量コントロール | Stepper size="sm" / text-xs | --lk-size-xs | --lk-size-xs | 反復: Stepper の数値はxsで十分であり、商品メタより一段控えた密度にすると視線が散らない。 | 完了 |
| `/cart` | カートページ | - | 数量エラーテキスト | text-xs | --lk-size-xs | --lk-size-xs | 対比: エラー補足は数量コントロールと同じxsで十分で、色と位置で状態差を伝えられる。 | 完了 |
| `/cart` | カートページ | - | カート内リンク | text-sm | --lk-size-md | --lk-size-md | 反復: リンク文もmdに揃え、商品メタやバナー本文と同じ読み方で処理できるようにする。 | 完了 |
| `/cart` | カートページ | - | Order Summary 見出し | text-2xl | --lk-size-4xl | --lk-size-3xl | 対比: 実装24pxの見出しは強いので、3xlへ整理して商品名群より上、ページ最上位見出しより下の階層を作る。 | 完了 |
| `/cart` | カートページ | - | プロモーションコードラベル | text-xs | --lk-size-xs | --lk-size-xs | 反復: 補助ラベルはxsに統一し、フォーム入力や小計行と競合しないようにする。 | 完了 |
| `/cart` | カートページ | - | プロモーションコード入力 | TextField size="md" / text-sm | --lk-size-md | --lk-size-md | 整列: カート内フォームも他フォームと同じmdに揃え、入力体験を共通化する。 | 完了 |
| `/cart` | カートページ | - | 適用ボタン | Button size="md" | --lk-size-md | --lk-size-md | 対比: 適用ボタンは入力欄と同じmd帯で十分であり、購入CTAより一段下に保てる。 | 完了 |
| `/cart` | カートページ | - | プロモーションヘルプ | text-xs | --lk-size-xs | --lk-size-xs | 近接: 入力補助文はラベルと同じxsにまとめ、コード入力塊を読みやすくする。 | 完了 |
| `/cart` | カートページ | - | 小計ラベル | text-sm | --lk-size-md | --lk-size-md | 整列: 金額行のラベルはmdで揃え、合計行とのサイズ差だけで優先度を作る。 | 完了 |
| `/cart` | カートページ | - | 小計金額 | text-sm | --lk-size-md | --lk-size-md | 反復: 小計金額もラベルと同じmdにして、合計金額だけを上位に立てる。 | 完了 |
| `/cart` | カートページ | - | 合計ラベル | text-lg | --lk-size-xl | --lk-size-lg | 対比: 合計行は小計群より1段上のlgにして、チェックアウト判断の軸を作る。 | 完了 |
| `/cart` | カートページ | - | 合計金額 | text-2xl | --lk-size-4xl | --lk-size-3xl | 対比: 最重要数値は3xlにするとSummary見出しと並ぶ強さを持ちつつ、空状態アイコンほどは主張しない。 | 完了 |
| `/cart` | カートページ | - | 購入手続きへ進むボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 反復: カート最終CTAはフォーム送信と同じlgに統一し、購入導線の主操作として認識しやすくする。 | 完了 |
| `/cart` | カートページ | - | 付帯説明テキスト | text-xs | --lk-size-xs | --lk-size-xs | 近接: 支払い補足や注意書きはxsに抑え、合計やCTAを邪魔しない補助層に置く。 | 完了 |
| `/checkout` | チェックアウトページ | - | チェックアウト進行ステップ番号 | text-sm | --lk-size-md | --lk-size-md | 反復: ステップ番号はtext-sm基準なのでmdで統一し、各ステップ間の見え方を一定に保つ。 | 完了 |
| `/checkout` | チェックアウトページ | - | チェックアウト進行ステップラベル | text-xs sm:text-sm | --lk-size-xs | --lk-size-xs | 対比: ラベルは番号より一段控えたxsを基準にすると、進行インジケータの情報整理がしやすい。 | 完了 |
| `/checkout` | チェックアウトページ | - | 配送先 / 支払いフォーム | TextField size="md" / SingleSelect size="md" | --lk-size-md | --lk-size-md | 整列: 入力部品はすべてmd基準で揃えて、長いフォームでも読みと入力のリズムを崩さない。 | 完了 |
| `/checkout` | チェックアウトページ | - | 次へ / 戻る / 注文確定ボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 対比: 進行操作は主CTAなのでlgに固定し、補助ボタンとの差を保つ。 | 完了 |
| `/checkout` | チェックアウトページ | - | エラー再試行ボタン | Button size="sm" | --lk-size-sm | --lk-size-sm | 反復: 再試行は補助導線なのでsmに留め、注文確定CTAより前に出さない。 | 完了 |
| `/checkout` | チェックアウトページ | - | 支払いセクション見出し | text-lg font-semibold | --lk-size-xl | --lk-size-xl | 対比: 実測18px相当の見出しはフォーム本文より1段上のxlでちょうど良く、セクション切替を明確に示せる。 | 完了 |
| `/checkout` | チェックアウトページ | - | 支払い説明テキスト | text-sm | --lk-size-md | --lk-size-md | 近接: 決済説明文はフォーム本文と同じmdにし、長文でも読みやすく保つ。 | 完了 |
| `/checkout` | チェックアウトページ | - | 選択中の決済種類表示 | text-xs | --lk-size-xs | --lk-size-xs | 反復: 選択状態表示はxsで十分であり、支払い見出しとの主従が明快になる。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文内容の商品名・価格 | text-sm | --lk-size-md | --lk-size-md | 整列: サマリー内の商品情報はmdに揃え、フォーム本文と同じリズムで読めるようにする。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文内容の商品メタ | text-xs | --lk-size-xs | --lk-size-xs | 対比: 商品メタは名前・価格より1段小さいxsに抑えて補助情報として整理する。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文合計ラベル | text-lg | --lk-size-xl | --lk-size-lg | 対比: 合計ラベルは小計群より上のlgにして、最終確認の視点を集める。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文合計金額 | text-2xl | --lk-size-4xl | --lk-size-3xl | 対比: 最終金額は3xlに整理し、サマリー内で最大階層の数値として固定する。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文完了メッセージ | text-lg | --lk-size-xl | --lk-size-lg | 対比: 完了メッセージは本文より1段大きいlgで十分であり、番号や日付ラベルより優先して読ませる。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文完了サブテキスト | text-sm | --lk-size-md | --lk-size-md | 反復: 完了補足文は他の説明文と同じmdに揃え、状態変化のみを明確に伝える。 | 完了 |
| `/checkout` | チェックアウトページ | - | 注文番号 / 注文日ラベル | text-xs | --lk-size-xs | --lk-size-xs | 整列: 注文メタラベルはxsに統一し、完了メッセージや注文番号本体との差を保つ。 | 完了 |
| `/signup` | サインアップページ | - | ページ実装なし | 未実装 | - | - | 事実: `src/app/signup` にページ UI が未実装のため、現時点ではタイポグラフィ設計対象外。 |  |
| `/login` | ログインページ | - | Googleサインインボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 反復: 初回導線の主CTAなのでlgを維持し、メール認証ボタンと同じ階層で扱う。 | 完了 |
| `/login` | ログインページ | - | OR セパレータ | text-sm | --lk-size-md | --lk-size-md | 対比: OR は主導線の区切り役なので、ラベルや入力と同じmdで十分に読める。 | 完了 |
| `/login` | ログインページ | - | EMAIL ラベル | text-sm | --lk-size-md | --lk-size-md | 整列: メール認証フローのラベルはすべてmdに揃え、フォーム内の読み方を一定にする。 | 完了 |
| `/login` | ログインページ | - | メール入力 | text-sm | --lk-size-md | --lk-size-md | 反復: 入力欄文字はmd基準に揃え、他フォーム画面とも認知負荷を合わせる。 | 完了 |
| `/login` | ログインページ | - | 認証コードラベル | text-sm | --lk-size-md | --lk-size-md | 反復: EMAIL ラベルと同じmdに揃え、認証ステップ切替後もフォーム構造を保つ。 | 完了 |
| `/login` | ログインページ | - | 認証コード入力 | text-lg | --lk-size-xl | --lk-size-lg | 対比: 認証コードは誤入力防止のため通常入力より1段大きいlgが適切で、主CTAよりは控えめに保てる。 | 完了 |
| `/login` | ログインページ | - | 再送信リンク | text-xs | --lk-size-xs | --lk-size-xs | 近接: 再送信は補助操作なのでxsに抑え、コード入力や送信ボタンより前に出さない。 | 完了 |
| `/login` | ログインページ | - | 送信 / サインインボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 対比: 認証フローの完了操作は常にlgで揃え、Google導線と同じ強さを維持する。 | 完了 |
| `/login` | ログインページ | - | メールアドレスを変更ボタン | Button size="md" / text-sm | --lk-size-md | --lk-size-md | 整列: 補助操作はmdに留め、主CTAより1段下の操作階層として整理する。 | 完了 |
| `/login` | ログインページ | - | パスワードを忘れたリンク | text-sm | --lk-size-md | --lk-size-md | 反復: 補助リンク群はmdに揃え、認証フォーム周辺の導線密度を統一する。 | 完了 |
| `/login` | ログインページ | - | エラー / 成功メッセージ | text-sm | --lk-size-md | --lk-size-md | 整列: 状態メッセージはmdで統一し、差分は色と文言で伝える。 | 完了 |
| `/login` | ログインページ | - | 利用規約同意テキスト | text-xs | --lk-size-xs | --lk-size-xs | 対比: 法務補足はxsに抑え、入力導線やCTAより視覚優先度を下げる。 | 完了 |
| `/privacy` | プライバシーページ | - | ページタイトル | h2（ブラウザデフォルト） | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測では法務ページの h2 も16pxなので、ページ起点として4xlまで上げて本文と明確に分離する。 | 完了 |
| `/privacy` | プライバシーページ | - | セクション見出し | h5 + font-brand | --lk-size-xl | --lk-size-lg | 反復: 各条項見出しは本文より1段大きいlgに揃え、長い法務文書でも章切替を見失わないようにする。 | 完了 |
| `/privacy` | プライバシーページ | - | 本文テキスト | text-[#474747] | --lk-size-md | --lk-size-md | 近接: 法務本文は長文読解が前提なので、本文基準はmdにして読み疲れを抑える。 | 完了 |
| `/privacy` | プライバシーページ | - | 箇条書き | list-disc list-inside space-y-2 text-[#474747] | --lk-size-md | --lk-size-md | 整列: 本文と同じmdに揃えると、段落とリストを切り替えても読字リズムが崩れない。 | 完了 |
| `/privacy` | プライバシーページ | - | 施行日 / 改定日 | text-sm text-[#474747] | --lk-size-sm | --lk-size-sm | 対比: 日付は本文より一段小さいsmに抑え、文書メタとして後景化する。 | 完了 |
| `/terms` | 利用規約ページ | - | ページタイトル | h2（ブラウザデフォルト） | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測16pxのページ見出しでは法務文書の入口として弱いため、4xlで起点を明確化する。 | 完了 |
| `/terms` | 利用規約ページ | - | セクション見出し | h5 + font-brand | --lk-size-xl | --lk-size-lg | 反復: プライバシー文書と同じlgに揃え、法務ページ群の章階層を統一する。 | 完了 |
| `/terms` | 利用規約ページ | - | 本文テキスト | text-[#474747] | --lk-size-md | --lk-size-md | 近接: 条文本文は長文読解を優先し、md基準で安定した行間と可読性を確保する。 | 完了 |
| `/terms` | 利用規約ページ | - | 箇条書き | list-disc list-inside space-y-2 text-[#474747] | --lk-size-md | --lk-size-md | 整列: リストも本文と同じmdに揃え、段落と箇条書きの読み替えを滑らかにする。 | 完了 |
| `/terms` | 利用規約ページ | - | 制定日 / 最終改定日 | text-[#474747] | --lk-size-md | --lk-size-sm | 対比: 日付は本文より一段控えたsmにすると、文書末尾のメタ情報として扱いやすい。 | 完了 |
| `/ui` | UIページ | - |  |  |  | - | 事実: `/ui` は複数コンポーネントの見本ページで、単一要素へ集約したタイポトークンをこの行だけでは定義できない。 |  |
| `/wishlist` | ウィッシュリストページ | - | ページタイトル | h1（ブラウザデフォルト） | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測16pxのh1ではページ入口が弱いため、一覧ページと同様に4xlで起点を作る。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 読み込みテキスト | text-base tracking-widest | --lk-size-lg | --lk-size-lg | 反復: ローディングの主文は本文より1段上のlgで十分で、空状態文や件数表示より強く読ませられる。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | エラーメッセージ | text-sm text-red-500 | --lk-size-md | --lk-size-md | 整列: エラー文は他の状態メッセージと同じmdに揃え、差分は色で伝える。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 空状態テキスト | text-sm text-[#474747] | --lk-size-md | --lk-size-md | 近接: 空状態文は継続購入リンクの直前に置く説明なので、mdが最も読みやすい。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 継続購入リンク | text-sm text-black hover:text-[#474747] | --lk-size-md | --lk-size-md | 反復: 補助リンク群はmdに揃え、本文や件数表示との読み方を共通化する。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | アイテム件数 | text-sm text-[#474747] | --lk-size-md | --lk-size-md | 整列: 件数表示もmdに揃え、空状態文・リンクと同じ補助情報層に置く。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 商品カテゴリ | text-xs text-[#474747] tracking-wider | --lk-size-xs | --lk-size-xs | 対比: カテゴリは商品名より一段小さいxsで十分で、カード内の主従を保てる。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 商品名 | text-base text-black font-brand | --lk-size-sm | --lk-size-lg | 対比: 商品名は価格やカテゴリより上位なので、16px相当の実装をlg帯として整理する。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 価格 | text-sm text-black | --lk-size-md | --lk-size-md | 反復: 価格は説明やボタンと同じmdに揃え、商品名だけを上位に立てる。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | カートに追加ボタン | text-sm | --lk-size-md | --lk-size-md | 整列: リスト内の補助CTAはmdに留め、ページ全体の主CTAより強くしない。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 削除アイコン | text-xl | --lk-size-xl | --lk-size-2xl | 対比: 削除操作は文字より先に見つけたいので、2xlへ上げて可視性を確保する。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 削除済み商品テキスト | text-xs text-[#474747] | --lk-size-xs | --lk-size-xs | 反復: 削除済み状態の補足文もxsに揃え、通常カードとの差は文言で伝える。 | 完了 |
| `/wishlist` | ウィッシュリストページ | - | 削除済み商品名 | text-base text-black font-brand | --lk-size-sm | --lk-size-lg | 反復: 通常商品の商品名と同じlgに揃え、状態が変わってもカード内の主情報階層を維持する。 | 完了 |
| `/account` | マイアカウントページ | - | ページタイトル | h1（ブラウザデフォルト） | --lk-size-4xl | --lk-size-4xl | 対比: Playwright実測16pxのh1では入口が弱いため、会員ページの主見出しも4xlへ揃える。 | 完了 |
| `/account` | マイアカウントページ | - | ログイン案内 | text-lg text-[#474747] | --lk-size-lg | --lk-size-lg | 近接: ゲスト案内文はログイン導線の直前に置く中位説明なので、lgで十分に読ませる。 | 完了 |
| `/account` | マイアカウントページ | - | タブ | TabSegmentControl size="md" | --lk-size-md | --lk-size-md | 整列: 会員ページのタブ切替はtext-sm基準のmdで統一し、プロフィールと注文履歴を同階層で見せる。 | 完了 |
| `/account` | マイアカウントページ | - | ログアウトボタン | Button size="md" | --lk-size-md | --lk-size-md | 対比: 補助操作はmdに留め、保存ボタンやログイン導線より前に出さない。 | 完了 |
| `/account` | マイアカウントページ | - | ログアウトエラー | text-xs text-red-600 | --lk-size-xs | --lk-size-xs | 反復: 補助エラーはxsに統一し、フォーム本文やボタンとの主従を保つ。 | 完了 |
| `/account` | マイアカウントページ | プロフィール | ステータスメッセージ | text-sm | --lk-size-md | --lk-size-md | 反復: 状態メッセージはmdで揃え、保存前後の変化だけを文言で伝える。 | 完了 |
| `/account` | マイアカウントページ | プロフィール | 情報ラベル | text-xs tracking-wider | --lk-size-xs | --lk-size-xs | 整列: ラベルはxsに統一し、値より一段下の階層を維持する。 | 完了 |
| `/account` | マイアカウントページ | プロフィール | 情報値 | text-sm text-black | --lk-size-md | --lk-size-md | 対比: 値はラベルより上のmd帯に置き、編集対象をすぐ認識できるようにする。 | 完了 |
| `/account` | マイアカウントページ | プロフィール | 入力フィールド | TextField size="md" | --lk-size-md | --lk-size-md | 反復: 既存フォーム群と同じmdに統一し、編集UIの学習コストを下げる。 | 完了 |
| `/account` | マイアカウントページ | プロフィール | 保存ボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 対比: 保存CTAは補助操作より1段上のlgで固定し、操作終点を明確にする。 | 完了 |
| `/account` | マイアカウントページ | 配送情報 | ステータスメッセージ | text-sm | --lk-size-md | --lk-size-md | 反復: 配送情報側もプロフィールと同じmdで揃え、タブ跨ぎのUI一貫性を保つ。 | 完了 |
| `/account` | マイアカウントページ | 配送情報 | ラベル | text-xs tracking-wider | --lk-size-xs | --lk-size-xs | 整列: プロフィール欄と同じxsに揃え、フォームの意味づけを統一する。 | 完了 |
| `/account` | マイアカウントページ | 配送情報 | 値 | text-sm text-black | --lk-size-md | --lk-size-md | 対比: 値はラベルより一段上のmdで揃え、フォーム内の主情報として機能させる。 | 完了 |
| `/account` | マイアカウントページ | 配送情報 | 入力フィールド | TextField size="md" | --lk-size-md | --lk-size-md | 反復: 配送フォームもmd基準で統一し、プロフィール入力との切替コストを減らす。 | 完了 |
| `/account` | マイアカウントページ | 配送情報 | 保存ボタン | Button size="lg" | --lk-size-lg | --lk-size-lg | 反復: タブ内主CTAはlgで共通化し、ページ内の操作階層を安定させる。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 空状態見出し | text-base text-black mb-2 | --lk-size-lg | --lk-size-lg | 対比: 空状態見出しは補足文より1段上のlgにし、注文履歴セクションの主メッセージとして扱う。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 空状態サブテキスト | text-sm text-[#474747] | --lk-size-md | --lk-size-md | 近接: 空状態説明文はlg見出し直下の本文としてmdが読みやすい。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 注文番号 | text-lg text-black | --lk-size-lg | --lk-size-lg | 対比: 注文番号は履歴カードの主情報なのでlgを維持し、日付や商品名より先に認識させる。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 注文日 | text-sm text-[#474747] | --lk-size-md | --lk-size-md | 反復: 日付は補助メタとしてmdに揃え、商品名や詳細リンクと同階層に置く。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 商品名 | text-sm text-black | --lk-size-md | --lk-size-md | 整列: 履歴内の商品名はmdで揃え、注文番号だけを上位に立てる。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 商品詳細 | text-xs text-[#474747] | --lk-size-xs | --lk-size-xs | 対比: SKU や数量などの詳細はxsに抑え、商品名や合計より後景化する。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 合計金額 | text-xl text-black font-display | --lk-size-xl | --lk-size-xl | 対比: 金額は注文番号に次ぐ主要情報なので、xlで強さを保つ。 | 完了 |
| `/account` | マイアカウントページ | 購入履歴 | 注文詳細リンク | text-sm text-black underline underline-offset-4 | --lk-size-md | --lk-size-md | 反復: 詳細リンクは本文と同じmdに置き、装飾でクリック可能性だけを補う。 | 完了 |
| `/account/orders/[id]` | 注文詳細ページ | - |  |  |  | - | 事実: 実装上は h1、説明文、xsラベル、xl金額が併存しており、この1行だけでは単一トークンに集約できない。 |  |
| `/auth/callback` | 認証コールバックページ | - |  |  |  | - | 事実: Playwright実測では h1 が16px、本文が14pxで併存するため、ページ単位の単一トークンでは表現できない。 |  |
| `/auth/password-reset` | パスワードリセットページ | - |  |  |  | - | 事実: h1、md入力欄、lg/ md系ボタンが混在するフォームページのため、単一トークンに集約しない。 |  |
| `/auth/verified` | 認証完了ページ | - |  |  |  | - | 事実: 本文、xs補助文、mdボタン、select が混在する状態確認ページであり、この行は個別要素棚卸し前提。 |  |
| `/admin` | 管理トップページ | - |  |  |  | - | 事実: ダッシュボードは見出し・カード・リンクなど複数階層が混在しており、ページ単位で単一トークンを定義しない。 |  |
| `/admin/create-user` | ユーザー作成ページ | - |  |  |  | - | 事実: Playwright実測では h1 16px に加えて md入力欄・mdボタンがあり、ページ全体を1トークンへ集約できない。 |  |
| `/admin/item/create` | 商品作成ページ | - |  |  |  | - | 事実: ItemForm ベースで見出し、入力欄、補助文、プレビューが混在するため、別途要素単位の棚卸しが必要。 |  |
| `/admin/item/edit/[id]` | 商品編集ページ | - |  |  |  | - | 事実: 商品作成ページと同一フォーム構造で複数階層が混在するため、この行では単一トークンを定義しない。 |  |
| `/admin/look/create` | LOOK作成ページ | - |  |  |  | - | 事実: フォーム主導の管理画面で複数コンポーネントが混在し、ページ単位の1トークンに還元できない。 |  |
| `/admin/look/edit/[id]` | LOOK編集ページ | - |  |  |  | - | 事実: LOOK作成と同じ理由で、要素単位の棚卸しなしに単一トークン化できない。 |  |
| `/admin/news/create` | NEWS作成ページ | - |  |  |  | - | 事実: 管理フォームは入力・ラベル・補助文・プレビューが混在するため、この行は設計対象を個別行へ分解すべき。 |  |
| `/admin/news/edit/[id]` | NEWS編集ページ | - |  |  |  | - | 事実: NEWS作成と同構造で複数階層が混在するため、単一トークンは設定しない。 |  |
| `/admin/stockist/create` | STOCKIST作成ページ | - |  |  |  | - | 事実: 管理フォームのため見出し・入力・補助文が混在し、1行ではタイポグラフィを表現しきれない。 |  |
| `/admin/stockist/edit/[id]` | STOCKIST編集ページ | - |  |  |  | - | 事実: STOCKIST作成と同じ構造であり、個別要素の棚卸し前提で扱う。 |  |
