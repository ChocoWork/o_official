# 詳細設計の案内

> 状態: 文書索引 | 確認日: 2026-10-04

## 概要

詳細設計は、ページ、処理シーケンス、状態遷移、共通領域に分ける。既存のページ別設計は要件ID・実装IDの対応を保って移動した。ただし文中の「済」「未」などの実装状況は作成・更新時点の記録であり、全件を今回再検証したものではない。現行フローを確認した文書には、確認日・実装根拠・未確認範囲を明示する。

## ページ別設計

| 領域 | 文書 |
| --- | --- |
| ホーム・情報 | [HOME](pages/01_home.md)、[NEWS一覧](pages/02_news_list.md)、[NEWS詳細](pages/03_news_detail.md)、[ABOUT](pages/08_about.md)、[CONTACT](pages/09_contact.md)、[STOCKIST](pages/10_stockist.md) |
| 商品・購入 | [ITEM一覧](pages/04_item_list.md)、[ITEM詳細](pages/05_item_detail.md)、[LOOK一覧](pages/06_look_list.md)、[LOOK詳細](pages/07_look_detail.md)、[WISHLIST](pages/11_wishlist.md)、[CART](pages/12_cart.md)、[CHECKOUT](pages/13_checkout.md) |
| アカウント・管理 | [LOGIN](pages/14_login.md)、[ACCOUNT](pages/15_account.md)、[ADMIN](pages/16_admin.md) |
| その他 | [PRIVACY](pages/17_privacy.md)、[TERMS](pages/18_terms.md)、[SEARCH](pages/19_search.md) |

現行の全ルートは[画面一覧](../03_BasicDesign/ui/screen-list.md)を参照する。ページ別設計にない認証・管理下位ルートは、必要に応じて要件IDと実装根拠を確認して追加する。

## 処理と共通設計

- [シーケンス設計の案内](sequence/README.md)：機能別ファイル・シナリオ別の図。認証、購入、Webhook、注文管理を実装と照合した文書へ案内する。
- [状態設計の案内](states/README.md)：状態管理対象別の図。注文、購入下書き、Webhookキュー、決済の要対応を分ける。
- [従来の認証図のパス](sequence/01_auth_seq.md)：現行の認証シナリオへの案内。従来の未検証フローを現行設計として併記しない。
- [非機能・監視](shared/20_nonfunctional.md)、[デザインシステム](shared/21_design_system.md)、[インフラ・構成](shared/22_infrastructure.md)、[財務ドメイン](shared/finance.md)、[UI部品一覧](shared/component-inventory.md)：既存内容を移した資料。個々の実装状況は対象コードで再確認する。

## 更新時の形式

新規の詳細設計では、[文書の共通フォーマット](../README.md#共通フォーマット)に加え、対象ルート・対応要件ID、入出力、正常系と異常系、状態・永続化、認証認可、関連テストを記す。シーケンス図は参加者と失敗時の応答、状態遷移図は遷移条件と遷移を実行するコードを明記する。
