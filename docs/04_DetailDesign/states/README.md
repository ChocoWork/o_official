# 状態設計の案内と記載方針

> 状態: 現行ソースとの同期方針 | 確認日: 2026-10-04 | 対象: 注文・購入下書き・Webhook・要対応記録

## 概要

状態遷移図は、ある対象がどの状態を取り、どの契機・条件・処理で状態を変えるかを示す。[シーケンス図](../sequence/README.md)が扱う通信の順序と対応させるが、別の対象の状態値を1つの状態機械に混ぜない。

## 分割と粒度の決定

| 単位 | 採用するルール |
| --- | --- |
| ファイル・図 | 1つの状態管理対象を基本にする。`orders.status`、`checkout_drafts.status`、`stripe_webhook_events.processing_status`、要対応記録の解決状態を分ける |
| 状態値 | DBのenum・CHECK制約・型の実値を記す。永続化していない論理状態は、その判定式を明示する |
| 遷移 | 更新元と更新先、イベント、ガード条件、副作用、実行するコード/RPCを示す。長い条件は図にIDを付けて表で定義する |
| 独立した属性 | 在庫解放、返金額、メール通知済み、要確認フラグ等は状態値に加えず、属性・不変条件として説明する |
| Stripeの値 | 外部サービスの状態を列挙したローカルの観測分類は、DB注文状態と別の判定表にする。イベント名だけで注文を遷移させると記さない |
| 競合・再試行 | 条件付き更新、ロック、claim token、期限・再実行条件を記す。更新0件、同じ状態への更新、失敗を成功遷移として扱わない |
| 初期・終了 | 初期ノードは新規作成を示す。最終ノードは実装上終了していると確認できる場合に限る。返金再投影・再試行がある対象を安易に終端扱いしない |

「画面で完了表示」「draftのcompleted」「注文のpaid」「Webhookのcompleted」は、それぞれ違う対象の結果である。保存先と更新主体が異なるため別図にする。世界共通の固定枚数を仮定せず、この実装の状態管理境界に合わせて分割した。

## 状態図の索引

| 文書 | 保存先・対象 | 主な更新主体 |
| --- | --- | --- |
| [注文・決済](order-payment.md) | `orders.status`と独立属性 | 注文受付・照合・在庫解放・管理出荷・返金投影RPC |
| [購入下書き](checkout-draft.md) | `checkout_drafts.status`、Session作成claim | create-session・claim/retire・注文受付RPC・保持期間の清掃 |
| [Webhookキュー](stripe-webhook-queue.md) | `stripe_webhook_events.processing_status` | enqueue・claim・complete・fail RPC、Cron worker |
| [決済の要対応](payment-exception.md) | `payment_exceptions.resolved_at`等 | 検出upsert・通知claim・管理解決RPC |

## 共通フォーマット

各文書は「概要 → 範囲と根拠 → 状態定義 → 図 → 遷移条件表 → 独立属性・冪等性 → 関連テスト → 未確認事項」で記述する。図のラベルは `イベント [条件] / 処理` を基本とし、図と表の `ST-*` IDで長いガード・副作用を対応させる。IDは設計図の参照用であり、既存の要件IDを振り直すものではない。

根拠はTypeScriptの型だけで終えず、最新のmigrationの関数定義と実際の呼び出し元を確認する。RPCが提供する更新能力と、現行APIから呼べる操作を区別する。実データの存在や本番の制約適用は別途実測する。

## 採用した一次資料

- [OMG UML 2.5.1](https://www.omg.org/spec/UML/2.5.1)：状態機械の記法の基準。本書はMermaidによる実装説明であり、完全な形式モデルへの準拠宣言ではない。
- [Mermaid stateDiagram](https://mermaid.js.org/syntax/stateDiagram.html)：状態、遷移、初期・最終、複合状態のテキスト表現。
- [arc42 Runtime view](https://docs.arc42.org/section-6/)：重要な実行時の振る舞いと例外を選び、実際の構成要素に結び付ける。

## 未確認事項

最新migrationのファイルはDB側の設計根拠であり、本番適用の証跡ではない。本番の実データ、Stripeの現在値、Cron起動、排他処理の実行時競合は今回実行検証していない。
