# シーケンス図・状態遷移図の実装照合レビュー

> 状態: 静的照合・文書検証完了 | 確認日: 2026-10-04 | コード基準: `bbb18761`と作業ツリーの返金補正

## 概要

[シーケンス設計](../../../04_DetailDesign/sequence/README.md)と[状態設計](../../../04_DetailDesign/states/README.md)の全15文書、および[詳細設計の入口](../../../04_DetailDesign/README.md)を対象に、実装の入口・呼出し元・最新RPCから逆引きして誤記と重要な記載漏れを確認する。対象は認証、購入、決済照合、Webhook、注文管理と、それらの4つの永続状態管理対象である。

図が構文検証を通ること、APIやテストへのリンクがあることだけを網羅性の根拠にしない。開始契機、認可、成功・失敗・部分成功、競合、再試行、状態変更の条件を照合する。この記録は確認時点の静的レビューであり、アプリ全機能の詳細設計や本番動作を網羅したという主張ではない。

## 粒度と網羅性の判断

- ファイルは機能単位、シーケンス図は開始契機・ユースケース単位を維持する。初期認証状態の照会はログイン操作とは独立した開始契機なので追加する。
- Webhook受付とworkerは別図、注文・draft・キュー・要対応記録は別状態図とする。メール、在庫、返金額、通知claimを注文statusへ混ぜない。
- 郵便番号や管理補助GET、同じ操作の細かい失敗は表・文章へまとめる。全関数・全入力フィールドの図示を網羅性の条件にしない。
- 注文の観測8分類×注文なし/7状態は決定表で補い、遷移図に存在しない「変更なし」「記録のみ」「拒否」も確認できるようにする。

この選択は[C4 Dynamic diagram](https://c4model.com/diagrams/dynamic)のユースケース単位の相互作用、[arc42 Runtime view](https://docs.arc42.org/section-6/)の重要ユースケース・外部境界・例外の選択、[詳細シナリオの注意点](https://docs.arc42.org/tips/6-4/)を、この実装へ適用した判断である。世界共通の固定枚数・参加者数を定めたものではない。

## 照合基準

レビュー中の他作業による未コミット変更も、実際に読める現行コードとして照合した。コミットSHAだけから作業ツリーと同じ実装を再現したと判断しない。返金補正の基準ファイルは次のSHA-256で特定する。

| ファイル | SHA-256 |
| --- | --- |
| [判定](../../../../src/lib/stripe/checkout-payment-decision.ts) | `8c993bf9e324e5d9ce03099f758281f3a75da62b9f4f53fc536221e0fd1b7d2a` |
| [照合器](../../../../src/lib/stripe/checkout-payment-reconciler.ts) | `85a65b945f89bd1db7b720b031d3cfd9631c949dcb1b97e876985fa02348170b` |
| [依存・エラー変換](../../../../src/lib/stripe/checkout-payment-reconciler-deps.ts) | `e6055e9870f8e59199f74cfe80b83a14f435cb1be1d1890c0c7b00065520c958` |
| [返金同期](../../../../src/lib/stripe/order-refund-sync.ts) | `4e473ee4bd2279f1fb72dd0a354ee30f65abe5c82f32a4a0148f42d55df1b3e1` |

TypeScriptの型だけでなく、最新migrationの関数定義・呼出し元を照合した。旧RPCの廃止、pending SQLの未適用扱い、外部サービス内部の未確認範囲も確認対象とした。Graphifyは関連コードの案内に使い、SQLと実際の作業ツリーは直接読む。

## API入口と文書の対応

対象領域の35 HTTP handlerを、次の図または補足表へ対応させる。表のIDは文書内のシナリオIDであり、要件IDを置き換えない。補助照会は業務状態変更と区別する。

| HTTP入口 | 対応文書・シナリオ |
| --- | --- |
| POST `/api/auth/login` | [ログイン・MFA](../../../04_DetailDesign/sequence/auth-login-mfa.md) SQ-AUTH-LOGIN-PASSWORD |
| POST `/api/auth/otp/verify` | 同上 SQ-AUTH-LOGIN-OTP |
| POST `/api/auth/login/resend` | 同上 SQ-AUTH-LOGIN-RESEND |
| POST `/api/auth/login/cancel` | 同上 SQ-AUTH-LOGIN-CANCEL |
| GET `/api/auth/mfa/status` | 同上 SQ-AUTH-MFA-STATUSと認証完了画面の分岐 |
| POST `/api/auth/mfa/enroll-totp` | 同上 SQ-AUTH-MFA-ENROLL |
| POST `/api/auth/mfa/verify` | 同上 SQ-AUTH-MFA-VERIFY |
| POST `/api/auth/register` | [登録・確認](../../../04_DetailDesign/sequence/auth-registration.md) SQ-AUTH-REGISTER-PUBLIC/ADMIN |
| GET `/api/auth/confirm` | 同上 SQ-AUTH-REGISTER-CONFIRM |
| GET `/api/auth/oauth/start` | [OAuth](../../../04_DetailDesign/sequence/auth-oauth.md) SQ-AUTH-OAUTH-START |
| GET `/api/auth/oauth/callback` | 同上 SQ-AUTH-OAUTH-CALLBACK |
| POST `/api/auth/password-reset/request` | [再設定](../../../04_DetailDesign/sequence/auth-password-reset.md) SQ-AUTH-RESET-REQUEST |
| GET `/api/auth/password-reset/link` | 同上 SQ-AUTH-RESET-LINKの互換中継 |
| POST `/api/auth/password-reset/link` | 同上 SQ-AUTH-RESET-LINK |
| GET `/api/auth/password-reset/session` | 同上 SQ-AUTH-RESET-RESUME |
| POST `/api/auth/password-reset/confirm` | 同上 SQ-AUTH-RESET-CONFIRM |
| GET `/api/auth/me` | [セッション・認可](../../../04_DetailDesign/sequence/auth-session.md) 初期認証状態の照会 |
| POST `/api/auth/refresh` | 同上 SQ-AUTH-SESSION-REFRESH |
| POST `/api/auth/logout` | 同上 SQ-AUTH-SESSION-LOGOUT |
| POST `/api/checkout/create-session` | [購入・決済](../../../04_DetailDesign/sequence/checkout-payment.md) SQ-CHECKOUT-01 |
| POST `/api/checkout/update-shipping` | 同上 SQ-CHECKOUT-02 |
| POST `/api/checkout/complete` | 同上 SQ-CHECKOUT-03〜05 |
| GET `/api/checkout/postal-code` | 同上 郵便番号の補助照会表 |
| POST `/api/checkout/payment-intent` | 同上 互換・hosted表の廃止入口 |
| POST `/api/webhook/stripe` | [Webhook](../../../04_DetailDesign/sequence/stripe-webhooks.md) SQ-WEBHOOK-01 |
| POST `/api/cron/process-stripe-webhooks` | 同上 SQ-WEBHOOK-02 |
| POST `/api/cron/expire-pending-orders` | 同上 決済見回りの補足表 |
| GET `/api/cron/stripe-reconcile` | [注文管理](../../../04_DetailDesign/sequence/order-administration.md) 返金同期の別呼出し元 |
| GET `/api/admin/orders` | 同上 管理補助照会 |
| GET `/api/admin/order-attention` | 同上 管理補助照会・要対応と要確認の別軸 |
| GET `/api/admin/orders/[id]/status` | 同上 管理補助照会の操作案内 |
| POST `/api/admin/orders/[id]/status` | 同上 SQ-ADMIN-01/02 |
| POST `/api/admin/orders/[id]/refund` | 同上 SQ-ADMIN-03 |
| POST `/api/admin/orders/[id]/review` | 同上 要確認の補足表 |
| POST `/api/admin/payment-exceptions/[id]/resolve` | 同上 SQ-ADMIN-04/05 |

共通JWT検証・auth.sessions生存・ACL・AAL2はSQ-AUTH-API-AUTHZへ集約する。各管理操作のCSRFと追加ロール条件は個別文書で確認する。商品、問い合わせ、会計全体などの他APIは[API仕様](../../../03_BasicDesign/api/api-spec.md)と各詳細設計の対象であり、この35 handlerへ含めない。

## 状態管理対象の対応

| 管理対象 | 文書・確認した範囲 |
| --- | --- |
| `orders.status` | [注文・決済](../../../04_DetailDesign/states/order-payment.md)：7値、初期1辺と状態間15辺、ST-ORDER-01〜10。遅延入金、未入金取消、出荷、全額返金・再投影、拒否と更新0件を確認 |
| `checkout_drafts.status` | [購入下書き](../../../04_DetailDesign/states/checkout-draft.md)：created/completed/failed、ST-DRAFT-01〜04。作成claim、Session attach/retire、shipping revision、保持期間DELETEを別属性・操作として確認 |
| `stripe_webhook_events.processing_status` | [Webhookキュー](../../../04_DetailDesign/states/stripe-webhook-queue.md)：queued/processing/completed/failed、ST-QUEUE-01〜05。再claim、leaseとtoken所有、完了/失敗0件、次回時刻・上限のない再試行を確認 |
| `payment_exceptions.resolved_at` | [要対応](../../../04_DetailDesign/states/payment-exception.md)：Open/Resolvedの論理状態、ST-EXCEPTION-01〜03。再検出で解決を解除しない条件、取消付き解決、通知claim/releaseを独立属性として確認 |

## 修正した事項と根拠

| 発見事項 | 正しい記載・修正箇所 |
| --- | --- |
| 注文なしpaidの全額返金例外が未反映 | 全額返金ならrecord_only/refunded_before_order。一部返金なら作成後に投影。購入シーケンス・注文/draft状態へ反映 |
| none判定後の返金同期が欠落 | paid/shipped、paid snapshot、返金>0、PIありだけ同期。同期後statusを返し、cancelledならcomplete409。購入・Webhook・注文管理へ反映 |
| 全額返金時のメールと同期失敗が欠落 | paidメールを抑止。Stripe/DB一時障害と返金未収束はReconcileTransientError、その他は元の例外。成立済みRPCを巻き戻す保証をしない |
| 持続state_conflictと未収束の区別が不足 | 最終回state_conflictはneeds_action。最終回applied/lost_raceで追加読取りが必要ならnot_converged。観測分類の全組合せと先行PI/金額/draftガードも追記 |
| 初回me照会とMFA画面の分岐が不足 | 初期同期、503時の表示維持、未認証、一般利用者、既AAL2、status失敗時の画面処理を追加 |
| 再設定「最新1本」の保証が過大 | 旧token無効化とINSERTは別要求。UPDATE成功でも並列発行により複数未使用tokenを作り得る |
| 登録のCookie境界が不足 | 独自CookieとSSR SDK Cookieを区別。独自保存失敗の新500からSDK Cookieの未発行・取消を保証しない |
| 通知claimのrelease成功を保証 | release失敗やclaim後の停止では通知時刻が残り得る。Webhookキューのlease/tokenと通知claimを区別 |
| Refund会計の注文なし分岐が不足 | unmatchedで正常戻り、会計DB保存なし。注文投影skipと会計helper呼出し継続を区別 |
| 補助API・旧照合SHAが不足 | 郵便番号、管理補助GET、返金同期の別呼出し元を表で補い、照合基準を今回の作業ツリーへ更新 |

## 検証結果

| 確認 | 2026-10-04の結果 |
| --- | --- |
| `npm.cmd run validate-docs` | 終了0。152正本ファイル、198 Markdown、3192相対リンク、80 Mermaidを検査 |
| 対象文書の追加構造検査 | 索引・本記録を含む18ファイル、56表、9見出しアンカー、32シナリオID。重複ID・表列ずれ・不正アンカー0件 |
| Chromiumで対象図を描画 | 32シーケンス図・4状態図の全36図。描画失敗・空図0件。初期me、共通照合、入金更新、Webhook worker、注文とキュー状態を画像で確認 |
| `git diff --check -- docs/04_DetailDesign docs/05_Quality` | 終了0。LF/CRLF変換の通知はあるが空白エラーなし |
| レビュー中の実装変化 | `src/`と`supabase/migrations/`の追跡546ファイルのSHA-256を再比較し、変化0件 |
| 独立レビュー | 領域別レビューで確定した指摘を修正。追加の最終レビューは利用上限で途中終了し、未実施分のauth保存・残RPC・案内の読み合わせを主担当が引き継いだ。最終レビュー全件成功としては扱わない |

validatorは文書形式とリンク・構文の検査であり、内容の正しさは上のAPI対応・状態対象と実装の静的照合で確認した。対象範囲内で今回確認した誤記・重要な記載漏れは修正した。全12種類の設計文書への横断レビューは別の工程として継続する。

## 未確認事項

本番migration・ACL・Cron登録、実Stripe値、メール到達、Cookieの実ブラウザ交換、実DB競合は未確認。関連ユニット・結合・E2Eテストはこの文書レビューでは実行しない。レビューで記載した実装上の部分成功や保証の不足を、コード修正済みとして扱わない。
