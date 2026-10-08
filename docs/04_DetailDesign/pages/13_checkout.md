# 1.13 チェックアウトページ（CHECKOUT）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.13 チェックアウトページ（CHECKOUT）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

2026-10（グループ F）から、支払いは最終確認画面の「注文する」で行う。入力画面に Stripe の部品を置かず、「確認へ進む」でサーバーが決済の画面を作る。詳しくは「最終確認画面と「注文する」（FREQ-417〜421）」の節。

2026-10-08（グループ C）から、ログイン客の注文の持ち主は、「確認へ進む」と「注文する」でサーバーが確かめた会員だけにする。ログインの状態が変わった時は、「注文する」を断って入力画面に戻し、案内を出す。詳しくは「ログインの状態の確かめと注文の持ち主（FREQ-426・427）」の節。

## 現行実装の確認事項（2026-10-02）

- 現行の [`src/app/checkout/page.tsx`](../../../src/app/checkout/page.tsx) は、Stripe の部品を置かない入力画面から「確認へ進む」で [`create-session`](../../../src/app/api/checkout/create-session/route.ts) を呼び、[最終確認画面（FinalConfirmationStep）](../../../src/app/checkout/_components/FinalConfirmationStep.tsx)へ進む。`CheckoutProvider` と `PaymentElement` は、この最終確認画面に置く（グループ F、2026-10-07）。決済後の注文照合は [注文・決済状態図](../states/order-payment.md) と [システム構成](../../03_BasicDesign/architecture/system-overview.md) を参照する。詳しくは下の「最終確認画面と「注文する」（FREQ-417〜421）」の節。
- この文書の表と後続説明には、固定の決済手段、旧在庫列、過去の画面遷移について作成時点の記述が残る。下の「済」は現在の実装状況を保証しない。該当要件を変更するときはコードとテストに照らして個別に改訂する。

## 最終確認画面と「注文する」（FREQ-417〜421）

[グループ F 設計書](../../superpowers/specs/2026-10-07-checkout-place-order-payment-design.md)と[実装計画](../../superpowers/plans/2026-10-07-checkout-place-order-payment.md)の決め事を、実装の形でまとめる。

```mermaid
flowchart TD
    Cart["カート<br/>明細ごとのお届けの目安"] --> Input["入力画面<br/>お客様情報・配送先・割引コード"]
    Input -->|確認へ進む| Create["create-session<br/>下書き・決済の画面（30分）・割引<br/>ほかの決済の画面を閉じる"]
    Create --> Final["最終確認画面「注文内容の最終確認」<br/>特定商取引法の項目・お支払い方法"]
    Final -->|変更| Input
    Final -->|注文する| Accept["place-order<br/>受け付け（注文・在庫の確保）"]
    Accept -->|在庫・価格の変化、買えない商品| Cart
    Accept -->|0円| Input
    Accept -->|時間切れ| Create
    Accept --> Pay["Stripe の confirm"] --> Done["complete<br/>入金済み・入金待ち・メール"]
```

| 項目 | 決まり |
|---|---|
| 決済の画面を作る時点 | 「確認へ進む」。uiModeはcustomのみ（既定custom）、hostedは廃止して400。配送先7項目（メールアドレス・氏名・郵便番号・都道府県・市区町村・番地・電話番号）が正規化後に空なら400 shipping_incompleteで断る。ページを開いた時には作らない。要求の版は 3（グループ C。版2はグループ F）、指紋に配送先・割引コード・買い手を含める。同じ入力と同じ買い手なら残り15分以上の決済の画面を使い回す |
| 前の決済の画面 | 同じ Cookie の、24時間以内の作成中・受け付け済みの下書きの画面を閉じる。受け付け済みなら照合関数で放棄の扱いにして在庫を戻す。作成中の下書きは退役させる |
| 割引コード | 「適用」で `/api/checkout/promotion-code` が確かめる。決済の画面には「確認へ進む」でサーバーが `discounts` で付ける。`allow_promotion_codes` は使わない。最終確認画面では変えられない |
| お届けの目安 | `preview_checkout_fulfillment`（受付 RPC と同じ規則。同じバリアントは数量を合わせて比べる）。カート・最終確認画面に出す。在庫の数は出さない |
| 受け付け | `/api/checkout/place-order`。持ち主・モード・新しい下書きの有無・残り10分以上を確かめ、受付 RPC に「在庫ありと見せたバリアント」を渡す。受付RPCの前に本人の別の完了済み決済の画面を探し、別IDなら409 payment_doneとそのIDで完了へ進んで「ご注文は確定しています」を出す（同じIDなら従来どおり）。配列ありの受付RPCは下書きのsource_cart_idがNULLでなければ本人のカート行の残存を求め、無ければcart_changed（NULL引数の照合器は検証しない）。価格の変化は `price_changed`、在庫ありから受注生産への変化は `stock_changed` で、拒否時は注文も在庫の確保も作らない。残り10分未満は失効・照合を呼ばず、監査ログを残して409 `session_expired`。前の画面は作り直しの `closeOtherCheckoutSessions`（D5）か30分の時間切れで閉じ、通知・見回りで在庫を戻す。作り直しの「確認へ進む」自体が買えない商品・金額の食い違いなどで断られたときは閉じる処理まで進まないため、30分の時間切れと Stripe の知らせ・見回りで閉じる。別の画面の `payment_done`・`cart_changed`（受付済み画面の押し直しを含む）・`superseded` はこの画面を閉じ、失効成功時に照合して、受付済みなら放棄・在庫返却を行い、理由記号とIDを監査ログに残す。後始末の失敗はログに残し409を変えない |
| 入り直し | `/api/checkout/resume`。最終確認画面と完了画面の URL は `/checkout?session_id=…`。支払い済みなら完了の処理、開いていれば最終確認画面、ほかは入力画面。IDを送った400 session_not_found / 403 forbiddenは画面がunavailableとして扱い、URLを/checkoutに戻す。常設のLiveMessage（politeness=status、checkout-resume-notice）を2列の外に置き、「このブラウザではご注文の状態を表示できません。お支払いがお済みの場合は、ご注文確認のメールをお送りしています。」と案内する。注文番号・支払い成否は出さない |
| 支払いの試みの記録 | `sessionStorage` の `checkout:payment-attempt`。戻ったときに「支払った直後」と「後からの入り直し」を分け、未払いなら支払いが完了しなかった案内を出す |
| カートへの案内 | `sessionStorage` の `checkout:cart-notice`。カート画面が1回だけ読んで消す。cart_changedもmessageとして保存し、「カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。」を出す |
| 入力画面の保存（FREQ-366） | 住所の入力フォームを出していて「この配送先を保存する」が ON のときは、「確認へ進む」の最初（決済の画面を作る前）にプロフィール・住所帳へ保存する。失敗したときは進まず、入力画面に案内を出す。お金は動かない |
| 最終確認画面の案内 | PayPay の取りやめ・決済の画面の作り直し・別の画面で進んでいる・完了の処理の失敗の案内は、2列の外の一番上（全幅。`data-testid="checkout-final-notice"`）に出す。画面が狭いと ORDER SUMMARY が先に並ぶので、列の中に置くと上へ動かしても見えない |
| 決済の画面の作り直し | 受け付けが `session_expired`（時間切れ・残り10分未満）で断られたら、「確認へ進む」と同じ処理で作り直し、案内「時間がたったため、お支払い情報をもう一度入力してください」を出す。応答を待つ間は、最終確認画面の「変更」「戻る」「注文する」を押せない |
| 完了画面（入り直し） | 見出し「ご注文は確定しています」に、注文番号とご注文の状態だけを出す（注文日は出さない。後日に開くことがあり、今日の日付がずれる）。ログイン客には注文の詳細への案内を付ける。支払いの試みの記録がある通常の完了画面は、見出し「Thank you for your order」と注文日を出す |
| カート画面（FREQ-417） | 明細ごとに「在庫あり・3〜7営業日で発送」か「受注生産・数週間〜2か月以上」を出す（`GET /api/cart` の `fulfillment`）。「注文する」が `stock_changed` で断られた後は、画面の上に案内と変わった商品の名前・色・サイズを並べ、その行に「在庫あり → 受注生産」の印を付ける（数量を減らして在庫に収まった行の印は外す） |
| 割引コードの記憶（FREQ-423） | 適用成功・最終確認内容の取り込みで、このタブの `sessionStorage` の `checkout:promotion-code` に `{ code }` を覚える。入力画面を開き直した入口が `none`・`unavailable` ならサーバーで確かめ直し、使えれば割引を表示し、使えなければ欄にコードを入れて理由を出す。削除・注文完了処理成功・再確認の拒否（422 の理由つきの断り）で記録を消す。通信の失敗・429・5xx など一時的な失敗では記録を残し、欄にコードと失敗の文を出す |
| 作り直しの購入不可（FREQ-424） | create-session は非公開の商品も名前で「以下の商品は現在購入できません: …」と409 `out_of_stock` を返す（行がない商品は `商品 {id}`）。時間切れの作り直し中なら入力画面へ戻さず、サーバーの文をカートの案内に保存してカートへ移る。通常の確認は入力画面に文を出してボタンを無効にする |
| 価格変更と解決まで残す案内（FREQ-425） | 「確認へ進む」の409 `checkout_amount_mismatch` ではカートと金額を読み直し、「価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。」とボタンの上に出し、更新済み金額で押し直せる。割引コードを適用中なら確かめ直して目安の金額を新しくし、断られたら割引を外して欄にコードと理由を出す。やり直せない案内と無効状態は配送先の「新規」・保存済みの選択や入力の変更で消さない |

検証は[購入・決済照合シーケンス](../sequence/checkout-payment.md)の「関連テスト」に挙げたテストと、`e2e/FR-CART-022-delivery-estimate-and-stock-notice.spec.ts`（カートの目安と案内）。

## ログインの状態の確かめと注文の持ち主（FREQ-426・427）

[グループ C 設計書](../../superpowers/specs/2026-10-08-order-owner-binding-design.md)と[実装計画](../../superpowers/plans/2026-10-08-order-owner-binding.md)の決め事を、画面の側からまとめる。サーバーは「確認へ進む」と「注文する」でログインを確かめ、下書きに記録した買い手と同じ時だけ、注文の持ち主を書く（[購入・決済照合シーケンス](../sequence/checkout-payment.md)）。画面は、ログインの状態が変わったことを案内し、お客様にやり直してもらう。

```mermaid
flowchart TD
    Final["最終確認画面"] -->|注文する| Place["place-order<br/>ログインを確かめ、下書きの買い手と比べる"]
    Place -->|同じ| Pay["支払いへ<br/>持ち主は受け付けで書かれる"]
    Place -->|違う login_changed| Input["入力画面に戻し、案内を出す<br/>ログインの状態とカートを読み直す"]
    Place -->|403 forbidden<br/>ログインでカートの印が新しくなった| Input
    Place -->|401 auth_expired| Refresh["印を新しくして1回だけ送り直す"]
    Refresh -->|新しくできた refreshed| Place
    Refresh -->|失効 expired| Input
    Refresh -->|一時的な失敗 unavailable<br/>最終確認画面に残り、押し直せる| Final
    Input -->|確認へ進むを押し直す| Create["create-session<br/>今のログインで下書きを取り直す"]
```

| 場面 | 画面の動き |
|---|---|
| 「注文する」が `login_changed` で断られた（「確認へ進む」の時とログインの状態が違う） | 入力画面に戻し（URL は `/checkout`）、ボタンの上に「ログインの状態が変わりました。もう一度「確認へ進む」を押してください。」を出す（`data-testid="checkout-session-error"`。押し直せる）。ログインの状態（`refreshAuthState`）とカートを読み直す。会員になっていれば、プロフィールと保存済みの配送先を読み直し、入力欄（氏名・フリガナ・電話・メール・住所）をその会員の内容で置き換える（前の人の入力を残さない。設計書 C7）。置き換えの扱いは下の「入力欄の置き換えの決まり」。ゲストなら今の入力を残し、メールを入力できる形にして、前の会員の保存済みの配送先の一覧と選択、「この配送先を保存する」のチェックを外す。お金は動いていない |
| 「注文する」が 403 `forbidden`（決済の画面がこのカートのものでない。ログインでカートの印が新しくなった時など） | `login_changed` と同じ扱い（同じ案内を出して入力画面へ戻し、ログインの状態とカートと入力欄を読み直す）。[checkout-api.ts](../../../src/app/checkout/_lib/checkout-api.ts) の `placeOrder` が、この403を `login_changed` の断りに読み替える。ほかの403（CSRF の守りなど）は読み替えず、一般の失敗の案内を最終確認画面に出す。サーバーは印の合わない要求で他人の決済の画面を閉じさせないため、この403では決済の画面を閉じない（30分の時間切れで閉じる）。画面からも閉じない。お金は動いていない |
| 「確認へ進む」が 409 `login_changed`（支払い済みの決済の画面の買い手が今の買い手と違う） | 入力画面のまま、サーバーの同じ文を出す。ログインの状態とカートを読み直し、上と同じく入力欄を合わせる。押し直せる |
| 開いたままログインの状態が変わった（ヘッダーのログインなど。ログインの確認が済んだ後に、ゲストから会員になった） | 上と同じく、その会員のプロフィールと保存済みの配送先で入力欄を置き換える。開いた直後のログインの確認では置き換えない（入り直しで戻した配送先を崩さない）。ログインは、ヘッダーのログインでもカートの印（`session_id` の Cookie）を新しくするので、ゲストで入れたカートは引き継がれず、ログインの後のカートは空になる（カートの持ち主の設計書 2026-09-06 の範囲。未実装）。商品はログインの後にもう一度カートへ入れる |
| 401 `auth_expired`（create-session・place-order・resume） | `refreshSessionOnce`（[client-fetch.ts](../../../src/lib/client-fetch.ts)）でログインの印を新しくして、同じ要求を1回だけ送り直す（[checkout-api.ts](../../../src/app/checkout/_lib/checkout-api.ts)）。入口は何かを変える前に確かめるので、送り直しても二重にならない |
| 印を新しくできなかった（ログアウト済み・更新の印が無効。`refreshSessionOnce` が `expired`） | 「確認へ進む」: 「ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。」を出す（自動でゲストとして進めない。押し直せる）。「注文する」: `login_changed` と同じ扱いで入力画面へ戻す。入り直し: 入力画面（`none`）。更新の入口がログインの Cookie を消すので、次に押し直すとゲストとして進む。ログインの状態とカートを読み直すのは「確認へ進む」と「注文する」だけで、入り直しは読み直さない（入力画面から始めるだけ） |
| 印の更新が一時的に失敗した（429・5xx・通信の失敗・待ち時間中。`refreshSessionOnce` が `unavailable`） | ゲストの形に落とさない。「確認へ進む」は「決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。」、「注文する」は「ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。」（最終確認画面に残る）、入り直しは入力画面。ログインの状態は読み直さない。押し直せる |
| 503（ログインを確かめられない） | 今の失敗の案内を出す。「確認へ進む」は「決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。」、「注文する」は「ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。」。押し直せる。ゲスト扱いにしない |

入力欄の置き換えの決まり（[page.tsx](../../../src/app/checkout/page.tsx) の `loadMemberForm("replace")`）:

- 読み直したプロフィールのメールが、今の入力欄のメールと整えた上で同じ（NFKC・前後の空白・小文字）なら、同じ会員のままなので置き換えない。その会員が直した入力と、読み込み済みの保存済みの配送先を消さない。
- 読み直したのが別の会員なら、入力欄9項目（プロフィールが空の欄は空）・保存済みの配送先・選択を置き換え、「この配送先を保存する」のチェック・お客様情報の編集中の状態・お客様情報の保存の失敗の文・郵便番号の補完の予約も外す。
- プロフィールが取れなかった時（ゲストは 401、ほかは 500・503・通信の失敗）は、入力欄は今のまま残す。前の会員の保存済みの配送先の一覧・選択、「この配送先を保存する」のチェック、お客様情報の保存の失敗の文は外す（前の会員の住所帳を別の会員やゲストの画面に混ぜない）。
- 読み込みには世代を付ける。読み込みを始めるたびに世代を1つ進め、終わった時に最後に始めた読み込みでなければ当てない。読み込みの間に最終確認画面へ進んだ（確認の内容を入力欄へ取り込んだ）時と、読み直した結果がゲストと分かった時も当てない。

注文履歴（`GET /api/orders`）は `user_id` で引くので、「注文する」の受け付けで持ち主が書かれた注文は、完了画面に戻らなくても本人の履歴に出る（FREQ-426）。ゲストと、「注文する」を通らない支払いの注文は持ち主が空で、メール確認済みのログインの時に同じメールの注文としてまとめる。「確認へ進む」の後にログインの状態が変わった時は、「注文する」が断られて注文は作られない（FREQ-427）。断られる経路は2つあり、E2E で別々に確かめる。AC-01 はゲストで「確認へ進む」の後に別のタブでログインする形で、カートの印が新しくなるのでサーバーは 403 `forbidden` で断る。AC-02 は会員で「確認へ進む」の後にログインの Cookie（`sb-access-token`・`sb-refresh-token`・`sb-csrf-token`）だけを外す形（失効・別の端末からのログアウト）で、カートの印が残るのでサーバーは買い手を比べて 409 `login_changed` で断る。検証は `e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`（3つの画面幅）。

## 機能要件対応表

| 要件ID          | 要件内容                                                                                                                     | 実装ID            | 実装対象ファイル                                                                           | 実装概要                                                                                                                | 実装ステータス |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------- |
| FR-CHECKOUT-001 | チェックアウトは Stripe の `CheckoutProvider` と `PaymentElement` を使用しカード・PayPay・コンビニ決済を提供する             | IMPL-CHECKOUT-001 | `src/app/checkout/page.tsx`, `src/app/api/checkout/route.ts`                               | `CheckoutProvider` + `PaymentElement` を実装。paymentMethodTypes でカード・PayPay・コンビニを設定                       | 済             |
| FR-CHECKOUT-002 | クレジットカード情報の入力・保持は Stripe Elements に委譲しサーバサイドはカード番号を一切保存しない                          | IMPL-CHECKOUT-002 | `src/app/checkout/page.tsx`                                                                | Stripe Elements ホスト型 UI を使用、PCI DSS 準拠。自サーバへのカードデータ送信なし                                      | 済             |
| FR-CHECKOUT-003 | 注文サマリーに小計・税・送料・合計を明示する                                                                                 | IMPL-CHECKOUT-003 | `src/app/checkout/page.tsx`                                                                | 小計・消費税（10%）・配送料・合計を表示                                                                                 | 済             |
| FR-CHECKOUT-004 | 住所入力フォームの各フィールドにバリデーションメッセージと `aria-describedby` を実装しユーザーが誤入力を確認できるようにする | IMPL-CHECKOUT-004 | `src/app/checkout/page.tsx`, `src/components/ui/TextField.tsx`                             | フィールド別バリデーション、`errorText`、`aria-describedby`、`aria-invalid` を実装                                      | 済             |
| FR-CHECKOUT-005 | 郵便番号入力に自動補完機能を実装し `GET /api/checkout/postal-code` で住所を取得してフォームに反映する                        | IMPL-CHECKOUT-005 | `src/app/checkout/page.tsx`, `src/app/api/checkout/postal-code/route.ts`                   | `useEffect` + `latestPostalLookupRef` でレース防止。郵便番号7桁入力で市区町村・都道府県を自動補完                       | 済             |
| FR-CHECKOUT-006 | 決済完了時に確認メールを送信し画面に完了メッセージを表示する                                                                 | IMPL-CHECKOUT-006 | `src/app/checkout/page.tsx`                                                                | `onComplete` コールバックで「確認メールをお送りしました」テキストを表示。実際のメール送信は Webhook 側で処理            | 済             |
| FR-CHECKOUT-007 | 決済確定前に在庫チェックを行い枯渇時はエラーメッセージと代替案を表示する                                                     | IMPL-CHECKOUT-007 | `src/app/api/checkout/create-session/route.ts`, `src/app/checkout/page.tsx`                | `stock_quantity` を参照した在庫チェックを追加し、409 と在庫切れメッセージを返却・表示                                   | 済             |
| FR-CHECKOUT-008 | 決済エラー発生時は明確なメッセージと再試行導線を表示する                                                                     | IMPL-CHECKOUT-008 | `src/app/checkout/page.tsx`                                                                | `checkoutError` の表示に加え、「再試行する」ボタンで決済セッション再作成を実装                                          | 済             |
| FR-CHECKOUT-009 | Stripe Webhook の冪等性を実装しネットワーク障害や再送による二重注文を防ぐ                                                    | IMPL-CHECKOUT-009 | `src/app/checkout/page.tsx`, `src/app/api/webhook/stripe/route.ts`                         | クライアント側 `processedCallback` とサーバ側の署名検証済みイベントの原子的enqueueとworkerのlease処理、および `payment_intent_id` 重複防止を実装 | 済             |
| FR-CHECKOUT-010 | 郵便番号 API に `postal_code_cache` テーブルを利用しキャッシュ済みの住所は外部 API を再呼び出しせず返す                      | IMPL-CHECKOUT-010 | `src/app/api/checkout/postal-code/route.ts`, `migrations/024_create_postal_code_cache.sql` | `postal_code_cache` テーブルへの SELECT + キャッシュミス時に外部 API 問い合わせ後に INSERT                              | 済             |
| FR-CHECKOUT-012 | ログイン済みユーザーの配送情報入力は account に保存済みのプロフィール・配送情報を既定値として表示する                        | IMPL-CHECKOUT-012 | `src/app/checkout/page.tsx`, `e2e/FR-CHECKOUT-012-account-profile-defaults.spec.ts`        | `/api/profile` を読み込み、メールアドレス・氏名・電話番号・住所を checkout 配送フォームの初期値へ反映する               | 済             |
| FR-CHECKOUT-011 | 消費税の自動計算と詳細な税率表示（WONT）                                                                                     | —                 | —                                                                                          | 現フェーズ対象外                                                                                                        | 未             |

---

## 実装タスク管理 (CHECKOUT-01)

**タスクID**: CHECKOUT-01
**ステータス**: 一部未実装「況」あり
**元ファイル**: `docs/tasks/04_checkout_ticket.md`

### Stripe 実装チェックリスト

| 要件ID          | 要件内容                                                       | 実装ID                    | 実装対象ファイル                                                                                                                                                             | 実装概要                                                                                                                                                                 | 実装ステータス |
| --------------- | -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| CHECKOUT-01-001 | Stripe セッション作成実装                                      | IMPL-CHECKOUT-SESSION-01  | `src/app/api/checkout/route.ts`                                                                                                                                              | Stripe セッション作成実装済み                                                                                                                                            | 済             |
| CHECKOUT-01-002 | Payment Element + PaymentIntent 初期化 API                     | IMPL-CHECKOUT-PI-01       | `src/app/api/checkout/route.ts`                                                                                                                                              | PaymentIntent 初期化 API 実装済み                                                                                                                                        | 済             |
| CHECKOUT-01-003 | `POST /api/checkout/complete`（Stripe Checkout Session のみ）  | IMPL-CHECKOUT-COMPLETE-01 | `src/app/api/checkout/complete/route.ts`                                                                                                                                     | `checkoutSessionId` と `draft_id` を必須化し、公開 complete API では Stripe セッション検証後にのみ注文確定する                                                           | 済             |
| CHECKOUT-01-004 | Webhook 受信と署名検証                                         | IMPL-CHECKOUT-WEBHOOK-01  | `src/app/api/webhook/stripe/route.ts`                                                                                                                                      | Stripe 署名検証付き Webhook 実装済み                                                                                                                                     | 済             |
| CHECKOUT-01-005 | 注文確定ロジック（orders/order_items 保存、カートクリア） | IMPL-CHECKOUT-ORDER-01 | `src/app/api/checkout/create-session/route.ts`, `src/app/api/checkout/complete/route.ts`, `src/lib/stripe/webhook-processor.ts`, `src/lib/stripe/checkout-payment-reconciler.ts`, `supabase/migrations/20260927100300_place_order_from_checkout_draft.sql` | create-session 時点で immutable な checkout draft を保存し、complete / webhook は照合関数（`reconcileCheckoutPayment`）を通る。受付 RPC `place_order_from_checkout_draft` が draft スナップショットからのみ注文を作り、`mark_order_paid`・`mark_order_awaiting_payment` が入金済み・入金待ちにしてカートを空にする | 済 |
| CHECKOUT-01-006 | 郵便番号住所自動補完（同一オリジン API + `postal_code_cache`） | IMPL-CHECKOUT-POSTAL-01   | `src/app/api/checkout/postal-code/route.ts`                                                                                                                                  | キャッシュ付き郵便番号補完実装済み                                                                                                                                       | 済             |
| CHECKOUT-01-007 | Payment Element Accordion UI + Appearance API                  | IMPL-CHECKOUT-UI-01       | `src/app/checkout/page.tsx`                                                                                                                                                  | Accordion UI + Appearance API 実装済み                                                                                                                                   | 済             |
| CHECKOUT-01-008 | Checkout Sessions API（custom UI モード）                      | IMPL-CHECKOUT-SESSION-02  | `src/app/api/checkout/route.ts`                                                                                                                                              | custom UI モード実装済み                                                                                                                                                 | 済             |
| CHECKOUT-01-009 | `metadata`（注文ID/カートID）を Stripe セッションに付与        | IMPL-CHECKOUT-META-01     | `src/app/api/checkout/route.ts`                                                                                                                                              | metadata 付与実装済み                                                                                                                                                    | 済             |
| CHECKOUT-01-010 | Dynamic Payment Methods（Stripe 最適表示）                     | IMPL-CHECKOUT-DPM-01      | `src/app/api/checkout/route.ts`                                                                                                                                              | 未実装                                                                                                                                                                   | 未             |
| CHECKOUT-01-011 | Stripe SDK バージョン確認・アップデート                        | IMPL-CHECKOUT-SDK-01      | `package.json`                                                                                                                                                               | 未確認                                                                                                                                                                   | 未             |
| CHECKOUT-01-012 | Payment Element の iframe 非埋め込み確認                       | IMPL-CHECKOUT-IFRAME-01   | `src/app/checkout/page.tsx`                                                                                                                                                  | 未確認                                                                                                                                                                   | 未             |
| CHECKOUT-01-013 | Dashboard 支払い方法確認・Payment Method Rules                 | —                         | Stripe Dashboard 設定                                                                                                                                                        | 未確認                                                                                                                                                                   | 未             |

### 依存関係

- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` は環境変数管理
- メール送信サービス: Webhook 側で SendGrid 実装（型紙未作成、要実装）

---

## 外部連携 実装タスク管理 (INTEG-01)

**タスクID**: INTEG-01
**ステータス**: 一部実装済み
**元ファイル**: `docs/tasks/09_integrations_ticket.md`

### チェックリスト

| 要件ID       | 要件内容                                                                     | 実装ID                 | 実装対象ファイル                                | 実装概要                       | 実装ステータス |
| ------------ | ---------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------- | ------------------------------ | -------------- |
| INTEG-01-001 | Stripe 統合 + Webhook 署名検証                                               | IMPL-INTEG-STRIPE-01   | `src/app/api/webhook/stripe/route.ts`         | Stripe 統合 + 署名検証実装済み | 済             |
| INTEG-01-002 | 管理画面 ORDER 向け Stripe Refund API（`POST /api/admin/orders/:id/refund`） | IMPL-INTEG-REFUND-01   | `src/app/api/admin/orders/[id]/refund/route.ts` | 返金 API 実装済み              | 済             |
| INTEG-01-003 | SendGrid テンプレート連携                                                    | IMPL-INTEG-EMAIL-01    | `src/features/notifications/services/email.ts`  | 未実装                         | 未             |
| INTEG-01-004 | 配送 API 初期連携（ラベル発行・追跡）                                        | IMPL-INTEG-SHIPPING-01 | `src/features/shipping/`                        | 未実装                         | 未             |

### 実装ノート

- 各種シークレットは `.env.local` で管理。本番は Vercel Environment Variables に設定
- Webhook の冪等性: クライアント側 `processedCallback` フラグに加え、サーバ側で `stripe_webhook_events` への原子的enqueueとworkerのlease処理、および `payment_intent_id` の重複注文防止を実装

---

## データモデル（CHECKOUT-DATA）

```sql
-- 注文テーブル（本番の定義。2026-09-20 時点）
orders (
  id                        uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                text                NOT NULL,                      -- ゲストの注文をセッションで引く
  user_id                   uuid                NULL REFERENCES profiles(user_id) ON DELETE SET NULL,  -- ゲスト注文は NULL
  payment_intent_id         text                NOT NULL UNIQUE,               -- 同じ支払いで注文を二重に作らせない
  checkout_session_id       text                NULL,
  status                    public.order_status NOT NULL DEFAULT 'pending',    -- 列挙型: pending / paid / failed / cancelled / shipped
  subtotal_amount           integer             NOT NULL CHECK (subtotal_amount >= 0),
  shipping_amount           integer             NOT NULL DEFAULT 500 CHECK (shipping_amount >= 0),
  discount_amount           integer             NOT NULL DEFAULT 0,
  total_amount              integer             NOT NULL CHECK (total_amount > 0),  -- JPY 整数（最小単位）
  currency                  text                NOT NULL DEFAULT 'jpy',
  refunded_amount           integer             NOT NULL DEFAULT 0 CHECK (refunded_amount BETWEEN 0 AND total_amount),
  refunded_at               timestamptz         NULL,
  payment_status_updated_at timestamptz         NULL,
  shipped_at                timestamptz         NULL,
  shipping_carrier          text                NULL CHECK (shipping_carrier IN ('yamato','sagawa','japanpost')),
  tracking_number           text                NULL CHECK (tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  shipping_email            text,                                              -- ここから下は配送先の写し
  shipping_full_name        text,
  shipping_postal_code      text,
  shipping_prefecture       text,
  shipping_city             text,
  shipping_address          text,
  shipping_building         text,
  shipping_phone            text,
  shipping_kana             text,                                              -- フリガナ（FREQ-384）
  created_at                timestamptz         NOT NULL DEFAULT now(),
  updated_at                timestamptz         NOT NULL DEFAULT now(),
  CHECK (shipped_at IS NOT NULL OR (shipping_carrier IS NULL AND tracking_number IS NULL))  -- 発送情報は発送日時とセット
)

-- 注文明細（注文時点の内容を写して固定する）
order_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id          bigint      NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  variant_id       bigint      NULL REFERENCES item_variants(id) ON DELETE RESTRICT,  -- バリアント在庫の移行用。アプリは未使用
  item_name        text        NOT NULL,
  item_price       integer     NOT NULL CHECK (item_price >= 0),
  item_image_url   text,
  color            text,
  size             text,
  quantity         integer     NOT NULL CHECK (quantity > 0),
  line_total       integer     NOT NULL CHECK (line_total >= 0),
  fulfillment_type text        NOT NULL DEFAULT 'stock' CHECK (fulfillment_type IN ('stock','backorder')),
  created_at       timestamptz NOT NULL DEFAULT now()
)
```

注文と明細には、法定保存のためのトリガーが付いている。削除は拒否され、金額・配送先・作成日時などは更新できない。状態などの更新は `order_revisions` に前後の内容が残る。

注文の持ち主（`user_id`）は、「注文する」の受け付けが、買い手を確かめた上で注文を作る処理の中で書く（グループ C）。ゲストの注文と、「注文する」を通らない支払いの注文は空で、メール確認済みのログインの時に同じメールの注文としてまとめる。一度付いた持ち主は別の会員へ付け替えられない（`ORDER_OWNER_IMMUTABLE`）。下書き（`checkout_drafts`）は、「確認へ進む」の時の買い手を `buyer_user_id`（uuid、空はゲスト、外部キーなし）に持ち、後から変えられない。

フリガナ（`shipping_kana`）は、checkout の入力を配送先の写し（`checkout_drafts.shipping_snapshot.kanaName`）に保存し、注文確定のときに注文へ写す（FREQ-384）。配送伝票の記入と、返品などのあとのやり取りに使う。送り状の必須項目ではない（ヤマトの B2クラウドが外部データに求める項目にフリガナは無い）ので、注文確定の必須検証（`findMissingShippingFields`）には入れない。フリガナの無い古い draft からでも注文は作れる。

> **注意**: 金額（`total_amount`）は必ずサーバ側で再計算して検証する。クライアント送信値は参照のみとして利用しない。

---

## Stripe Webhook 冪等性設計（CHECKOUT-WEBHOOK / FREQ-406）

### 処理フロー

```mermaid
flowchart TD
  A["POST /api/webhook/stripe"] --> S{"STRIPE_WEBHOOK_SECRETと<br/>STRIPE_SECRET_KEYがある"}
  S -- どちらか無い --> S1["500: Stripe再送"]
  S -- 両方ある --> B{"署名ヘッダーがあり、<br/>raw bodyの署名が正しい"}
  B -- 無い・不一致 --> C["400: 件数だけ数え、<br/>10分に5件で店へ知らせる"]
  B -- 正しい --> T{"13種のイベントか"}
  T -- 13種以外 --> T1["200: 保存しない"]
  T -- 13種 --> M{"鍵のモードと一致するか"}
  M -- 食い違う --> M1["200: 保存せず、<br/>モード違いを店へ知らせる"]
  M -- 鍵の頭が分からない --> M2["500: Stripe再送（最大3日）。<br/>保存せず、モード違いとして<br/>数えて店へ知らせる"]
  M -- 一致 --> D["原子的enqueue: stripe_webhook_events"]
  D -- DB障害 --> E["500: Stripe再送"]
  D -- 保存または一致する重複 --> F["200: 受信完了"]
  F --> F1["応答の後にafter()で<br/>workerを1回動かす"]
  F1 --> H["claim: SKIP LOCKEDと5分lease"]
  G["pg_cron: 毎分worker起動"] --> H
  H --> I["注文・会計・メール処理"]
  I -- 成功 --> J["claim token一致ならcompleted"]
  I -- 失敗・9回未満 --> K["failedと次回時刻（2^(n-1)分後）を保存"]
  K --> H
  I -- 9回目も失敗 --> L["dead: 取り出さず、店へまとめて知らせる"]
```

受信ルート（[route.ts](../../../src/app/api/webhook/stripe/route.ts)）は業務処理を待たない。応答は次のとおり。

| 条件 | 応答 | 保存 |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET`か`STRIPE_SECRET_KEY`が未設定 | 500（Stripeが再送する） | しない |
| 署名ヘッダーが無い・署名が合わない | 400。監査ログには1件ずつ書かず、件数だけを数え、10分に5件で店へ知らせる | しない |
| 13種（[一覧](../../../src/lib/stripe/handled-webhook-events.ts)）以外 | 200（`ignored`） | しない |
| 鍵のモードと食い違う（`sk_live_`・`rk_live_`は本番、`sk_test_`・`rk_test_`はテスト） | 200（`ignored`）。モード違いを店へ知らせる（1時間に1回まで） | しない |
| 鍵は設定されているが、頭が上の4つのどれでもない（引用符つきで貼った・`pk_`の鍵など） | 500（Stripeが最大3日再送する。200だと知らせが失われる）。ログに`[webhook] STRIPE_SECRET_KEY has an unknown prefix`を1行出し、モード違い（鍵のモードは不明）として数えて店へ知らせる（1時間に1回まで） | しない |
| 13種で、モードが合う | 200。応答の後に`after()`でworkerを1回動かす | する（同じIDの再送は1回だけ） |
| 保存の失敗 | 500（Stripeが再送する） | しない |

StripeのイベントIDを主キーに、署名検証済みのpayloadをservice-role専用RPCで永続化してから2xxを返す。同じIDの再送では種別・不変の`data`・`account`・`livemode`を照合して重複扱いにする。`pending_webhooks`など配信状況メタデータの差は許容し、不変部分の差は衝突として拒否する。保存が失敗したとき、設定が欠けているとき、鍵の頭が分からないときだけ5xxにしてStripe再送を受ける。

worker（[route.ts](../../../src/app/api/cron/process-stripe-webhooks/route.ts)）は`CRON_SECRET`で認証し、取り出せる知らせが無くなるか約45秒たつまで1件ずつ処理する（受け取り口も保存の後に`after()`で1回動かす）。DBのclaimは`FOR UPDATE SKIP LOCKED`、5分lease、claim tokenを使う。処理に失敗したイベントは原因の記号（`stripe_unavailable`など6つ）を残し、失敗した試行の回数をnとして2^(n-1)分後に再試行する。9回目の試行も失敗したら`dead`（退避）にして店へまとめて知らせる。leaseの切れた試行も1回の失敗として数える（`lease_expired`）。古いworkerは完了を確定できない。注文確定とメール送信は既存の冪等処理を維持する（グループ B 設計書 3-1〜3-4）。

`stripe_webhook_events`には`queued / processing / completed / failed / dead`、`attempt_count`、`next_attempt_at`、`claim_token`、`lease_expires_at`、`received_at`（受け取った時刻）、`dead_at`、`dead_notified_at`を保持する。このうち、`queued / processing / completed / failed`の状態と`next_attempt_at`・`claim_token`・`lease_expires_at`の列追加、権限制限は、[キューmigration](../../../supabase/migrations/20260925000303_add_stripe_webhook_queue.sql)として本番適用済み。`dead`の状態と`received_at`・`dead_at`・`dead_notified_at`の列は、[退避のmigration](../../../supabase/migrations/20261007030242_webhook_queue_dead_letter.sql)で足すもので、2026-10-07 に本番へ適用済み（台帳の version は 20261007030242）。Vaultを参照する起動ジョブは[スケジュールmigration](../../../supabase/pending/schedule_stripe_webhook_worker.sql)に保留する。本番ではworkerとCronの稼働を確認してから新しい受信ルートを公開する。

### ハンドラが失敗したときの扱い（FREQ-369）

| 失敗の種類 | 例 | 処理 |
| --- | --- | --- |
| 署名・保存の失敗 | 署名不一致、DB保存エラー | 受信ルートが400または500を返す |
| 入力が恒久的に使えない | `draft_id`が無い、支払IDが無い | 監査ログに残し、業務上の処理済みとする |
| 一時的な障害・DBエラー | 注文・返金・会計RPCがerrorを返した | workerが`failed`と次回時刻を保存し、再試行する |

Supabase clientの`{ error }`を見逃すと、入金済み注文を`pending`のまま完了扱いにしてしまう。業務ハンドラはエラーを例外へ変換する（照合関数の DB の操作は `src/lib/stripe/checkout-payment-reconciler-deps.ts`。接続・タイムアウトなどは一時的な失敗 `ReconcileTransientError`）。再試行で入金済みにする RPC（`mark_order_paid`）の更新が0件（先に別の経路が入金済みにした）なら、確認メールを重ねて送らずに読み直す。
### 同じ支払いの受付が並行したとき（FREQ-363）

注文は受付 RPC `place_order_from_checkout_draft` が作る。呼ぶのは照合関数（`reconcileCheckoutPayment`）だけで、注文の無い支払いを Stripe が入金済み・入金待ちと返したとき（受付の予備処理）に呼ぶ。注文の無い支払いを照合関数へ渡す経路は次の2つで、同じ Checkout Session について同時に走りうる。受付の後の入金済み・入金待ちへの更新（`mark_order_paid`・`mark_order_awaiting_payment`）も今の状態を条件にするので、状態の変化とメールは1回だけになる。

| 経路 | 呼び出し元 |
| --- | --- |
| 画面 | `POST /api/checkout/complete` |
| webhook | 決済系の6つのイベント（`src/lib/stripe/webhook-processor.ts` の `processStripeWebhookEvent`） |

受付 RPC の冪等性の確認は3段構えにする。

1. 下書きをロックする前に、同じ `checkout_session_id` の注文を確認する（再送の大半はここで返るのでロック待ちが起きない）
2. 下書きを `FOR UPDATE` でロックした直後に、もう一度確認する（先に走っていた受付がロック待ちの間にコミットした場合はここで返る）
3. 注文 INSERT の一意制約違反（`orders_checkout_session_id_key`）で既存の注文を返す（最後の防御）

> 注（2026-10-08）: ロック前に既存の注文を返すのは、`_shown_in_stock_variant_ids` が NULL の照合器だけ。画面からの押し直し（配列あり）は下書きをロックしてから判断し、既存の注文が `payment_in_progress` で本人のカート行が消えていれば `cart_changed` で断る。既存の注文が入金済み（`paid`）・入金待ち（`pending`）なら、カート行がなくてもその注文を返す。

2 が無いと、後から来た呼び出しはロック解放後の下書き（先発が受付済みにした後）を読み、`draft_not_found` を返す。照合関数はこれを「注文を作れない支払い」の要対応にし、支払い済みの客に誤った案内を送ることになる。Read Committed では SQL 文ごとに最新のコミット済みデータを読み、`FOR UPDATE` は待機後に最新の行を返すため。Stripe の注文確定ガイドも、同じ決済に対して確定処理が複数回・同時に呼ばれうることを前提に安全にするよう求めている。

検証は `tests/integration/db/place_order_from_checkout_draft.integration.test.ts` の「同じ Session で2回呼んでも注文は1件、在庫の確保も1回（二重送信・再読込）」と「同じ Session の受付が並行しても、後発はロックを待ってから先発の注文を返す」。ローカル Supabase（`npm run db:start`）に対して `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/place_order_from_checkout_draft` で、2つの接続を実際に競わせる。削除できない試験注文が残るため localhost 以外では動かない。

### 商品行のロック順（FREQ-364）

受付・入金済みにする処理・在庫の戻しは同じバリアントを触る。ロックを取る順が食い違うと、同時に走ったときデッドロックになり、Postgres が1秒後（`deadlock_timeout`）に片方を打ち切る。打ち切られた側は一時的な失敗（40P01）になり、完了 API なら 503 を返し、webhook なら worker が再試行する。

| 処理 | ロックの取り方 |
| --- | --- |
| 受付（`place_order_from_checkout_draft`） | 商品行を id の昇順で `FOR KEY SHARE`、続けてバリアントを id の昇順で `FOR UPDATE`。`FOR KEY SHARE` はカートの数量変更・商品の非公開とは衝突せず、削除とだけ衝突する（R-42） |
| 入金済みにする（`mark_order_paid`）・在庫を戻す（`release_stock_for_unpaid_order`） | 商品行はロックしない（FREQ-401）。バリアントを id の昇順で `FOR UPDATE` |

修正前のローカル DB での実測（同じ6商品、id 昇順は 42〜47）。

| 処理                     | 実際の順                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| 注文確定の在庫検証ループ | 45, 44, 42, 46, 43, 47（ハッシュ集約の出力順。商品の組み合わせごとに変わる） |
| 在庫復元の UPDATE        | その時点のテーブルの物理順（行を更新するたびに変わる）                       |

検証は次の1本で行う。

| テスト | 実行方法 |
| --- | --- |
| `tests/integration/db/item_lock_order.integration.test.ts` | ローカル Supabase に対して `DATABASE_URL=... npx jest tests/integration/db/item_lock_order`。k 番目の商品行を別セッションで塞ぎ、受付が k より小さい行だけをロック済みにしていることを全 k について確かめる（`FOR KEY SHARE` も `FOR UPDATE NOWAIT` とは衝突する）。在庫の戻しは全商品行を塞いでも待たずに終わる |

### 在庫の単位を色 × サイズにする 第1段（FREQ-398）

ブランドの前提は受注生産（`docs/01_Planning/brand.md`、法令ページ）。「在庫がある場合は3〜7営業日で発送。無い場合は一定数の注文がまとまった時点で製造」。つまり**在庫の有無は「買えるか」ではなく「納期」を分ける**。在庫の無い組み合わせも受注生産として受ける。

第1段は記録と引き当てだけを切り替える。客に見える変化は無い。

| やること                                                    | やらないこと                           |
| ----------------------------------------------------------- | -------------------------------------- |
| `order_items.variant_id` と `fulfillment_type` を正しく記録 | 店頭表示（第3段）                      |
| 在庫で賄える分を台帳へ `purchase` で引き当て                | 管理画面の在庫入力（第2段）            |
| 未入金の取り消しで `cancel` として戻す                      | `items.stock_quantity` の廃止（第3段） |

#### 引き当ての決め方

```mermaid
flowchart TD
    A[明細の色・サイズ] --> B{対応するバリアントがある}
    B -- ない --> D[backorder / variant_id は空]
    B -- ある --> C{有効かつ 在庫 >= 必要数}
    C -- いいえ --> D
    C -- はい --> E[stock / 台帳へ purchase を追記]
```

- 判定はバリアント単位で**合算**する。1つの注文で同じバリアントが複数明細に分かれることがある
- 在庫が足りなければ明細を分割せず全量 `backorder`。部分的に引き当てると、残りを待つ客に対して在庫だけ先に確保した状態になり、「まとまった時点で製造」の判断（`variant_backorder_summary`）も歪む
- 対応表の不足で支払い済みの注文を失わせない。バリアントが引けなければ `variant_id` は空のまま注文を作る

#### ロックの順序

items（id 昇順）→ item_variants（id 昇順）。注文確定と在庫戻しでそろえる。逆順で取る経路があるとデッドロックになる。引当区分は**ロックした後に読んだ在庫**で決める（先に読んで後でロックすると、その間に別の注文が引き当てる。OWASP ASVS V11.1.6）。

#### items.stock_quantity は残す

本番は全商品 NULL なので減算は実質無効。第3段で表示側をバリアントへ切り替えるときに外す。今外すと2系統の在庫が併存する期間が延びる。

#### 旧スキーマ向けのフォールバックを廃止

`orders.checkout_session_id` が無い時代のために、確定 RPC が失敗したらアプリ側で注文を組み立てる経路が残っていた。この列は既に本番にあり到達しないが、注文作成の二つ目の経路として残すと、上の引き当てを書かない注文ができる。読んでから書く在庫の減算も抱えていたため、経路ごと畳んで RPC 1本にした。旧スキーマのエラーでも注文は作らず 500 を返し、監査ログに残す。

### 在庫復元の遷移先（FREQ-383）

在庫を戻す RPC `release_stock_for_unpaid_order` は、注文 ID（`_order_id`）で引いた注文を、今の状態（`_expected_status`。支払い手続き中か入金待ち）を条件に `_next_status` へ移し、確保した分だけ在庫を戻す（R-41）。移せる先は `failed`・`abandoned`（支払い手続き中からだけ）・`cancelled`（実行者と取消の理由が必須）だけにする。行き先は省けない。それ以外の値と NULL は、行ロックを取る前に `INVALID_NEXT_STATUS`（SQLSTATE 22023 invalid_parameter_value）で失敗させる。

| 呼び出し元 | 渡す行き先 |
| --- | --- |
| 照合関数（払込票の期限切れ。PaymentIntent が `requires_payment_method`・`canceled`） | `failed` |
| 照合関数（決済画面の失効。Checkout Session が `expired`） | `abandoned` |
| 照合関数（管理画面の未入金の注文の取消） | `cancelled` |
| `resolve_payment_exception`（要対応の「注文を取り消して解決」） | `cancelled` |

以前はどの値でも通った。呼び出し側を誤ると次が起き、どれもエラーにならないので気づけなかった（修正前のローカル DB での実測。在庫 5 の商品を 2 個含む注文）。

| 渡した値           | 修正前の結果                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `pending`          | 注文は pending のまま在庫だけ 7 に戻る。呼ぶたびに在庫と注文の改訂履歴が増える |
| `paid` / `shipped` | 未入金の注文が入金済み・発送済みになり、在庫も 7 に戻る                        |

検査には `ASSERT` を使わない。`plpgsql.check_asserts` で無効にでき、PostgreSQL は通常のエラーに `RAISE` を使うよう定めているため。

検証は次の1本で行う。

| テスト | 実行方法 |
| --- | --- |
| `tests/integration/db/release_stock_by_order.integration.test.ts` | ローカル Supabase に対して `DATABASE_URL=... npx jest tests/integration/db/release_stock_by_order`。許可しない行き先（`pending`・`paid`・`shipped`・`payment_in_progress`・NULL）では注文も在庫も変わらないこと、入金待ちからは放棄にできないこと、取消には実行者と理由が要ること、確保した分だけ戻すことを確かめる |

### 決済セッション ID の書き戻し（FREQ-397）

Stripe セッションを作ったら、その ID を下書き（`checkout_drafts.checkout_session_id`）へ書き戻す。以前はこの更新の結果を見ておらず、失敗しても画面には成功に見えていた。

書けないと、支払い前の段階で次が起きる。

| 影響                                     | 理由                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 「注文する」も入り直しもできない（グループ F から） | `place-order` と `resume` は `checkout_session_id` で下書きと決済の画面の結び付きを確かめるため、書けていないと受け付けは `superseded`、入り直しは入力画面になる |
| 「確認へ進む」を押すたび Stripe セッションが増える | 再利用の判定が「`checkout_session_id` が入った下書き」を探すため、対象から外れる |

- まだ支払いは発生していないので、500 を返して作り直させる（`Failed to prepare checkout`）
- 理由は監査ログに残す（`Failed to store checkout session id on draft`）
- custom の書き込みを `storeCheckoutSessionIdOnDraft` に置く。hosted は廃止し、uiMode に hosted を送ると400で断る

### Checkout Session 作成の原子性と冪等性（FREQ-405）

`POST /api/checkout/create-session`は、Stripeを呼ぶ前に`claim_checkout_draft`で要求を1つの下書きへ収束させる。画面から来た値をそのまま冪等キーの意味にせず、次のサーバー算出値を固定順序でJSON化し、`v3:<sha256>`（グループ C 前は`v2:`、グループ F 前は`v1:`）のfingerprintを作る。

| fingerprintに含める値                          | 理由                                                  |
| ---------------------------------------------- | ----------------------------------------------------- |
| カート明細、サーバー算出の小計・税・送料・合計 | 同じ請求内容だけを再利用する                          |
| custom（既定。hostedは廃止し400）              | 決済画面の方式を要求の指紋に固定する                  |
| 許可リストで検証したorigin                     | claim引数と要求の指紋に含める既存の契約を保つ          |
| 配送先・割引コード（版2から）                  | 決済の画面を「確認へ進む」の時点の入力の写しにする。入力が変われば別の下書き・別の決済の画面にする |
| 買い手（版3から）                              | 「確認へ進む」の時にサーバーが確かめた会員の ID（ゲストは空）。買い手が違えば別の下書き・別の決済の画面にする（グループ C）。下書きの`buyer_user_id`にも記録する |
| 要求版                                         | Stripeの固定オプションを変えたときに旧Sessionと分ける |

申告支払方法はfingerprintに含めない。配送先と割引コードは版2（グループ F）から、買い手は版3（グループ C）から含める。決済の画面は「確認へ進む」の時点の入力の写しで、入力が変われば別の下書き・別の決済の画面になる。claimした下書きの値をStripe作成パラメータの正本にし、配送先を後から書き換える経路は無い（下の「配送先の書き込み順（FREQ-365）」）。

旧互換の再利用検索（`checkout_request_version`が未設定または`v0`の下書きの使い回し）は、グループ F で消した。旧版の決済の画面はブラウザから割引コードを付けられるので使い回さない。`v1`以降は動的支払方法を前提に、必ずfingerprint付きのclaim経路を使う。

```mermaid
sequenceDiagram
    participant C as checkout画面
    participant A as create-session
    participant D as Supabase
    participant S as Stripe

    C->>A: 同じcheckout要求を並行送信
    A->>D: claim_checkout_draft(fingerprint)
    D-->>A: 同じdraft ID
    A->>S: Session作成(draft ID由来の冪等キー)
    S-->>A: 同じCheckout Session
    A->>D: attach_checkout_session_to_draft(CAS)
    D-->>A: 同じIDは成功、異なるIDは0件
```

状態ごとの扱いは次のとおり。

| Stripeの確認結果                       | 処理                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `open`                                 | 残り15分以上なら、customの最終確認画面の内容（`confirmation`。`client_secret`を含む）を同じ下書きから返す。hostedは廃止し、要求は400で断る。残り15分未満なら閉じて退役させ、作り直す |
| `complete`                             | 決済処理中を含む支払いの済んだ決済の画面なので409 `order_already_placed` を返し、新規Sessionを作らない（画面は注文の確定を仕上げる） |
| `expired`                              | 下書きID・セッションID・fingerprint・`created`をすべて照合して退役する。更新0件なら500で停止し、成功時だけ新しい下書きをclaimする |
| 取得失敗、`resource_missing`、未知状態 | 未入金と推定せず500を返し、新規Sessionを作らない                                              |

Stripe作成には`checkout-session:create:v3:<draft ID>:<expires_at>`（版3。グループ C 前は`v2`、グループ F 前は`v1`）を冪等キー、下書きIDを`client_reference_id`として渡す。`<expires_at>` は決済画面の失効時刻（UNIX 秒。作成から30分30秒後）で、`reserve_checkout_session_expiry` が下書きに保存し、15秒以内の再送には同じ値を返す（それより後は決め直す。FREQ-407）。同じキーのパラメータが変わらないよう、明細・metadata・メール・戻り先・失効時刻はすべてclaim済み下書きから組み立てる。Session IDの書き戻しは`attach_checkout_session_to_draft`で行い、未設定または同じIDだけを受け入れる。

別IDとのCAS競合が確定した場合は、後発Sessionが`open`と確認できたときだけ、Session IDを含む別の冪等キーで失効する。RPC通信エラーは書き込み結果が不明なのでSessionを失効せず、再送で同じStripe冪等キーと下書きを回収する。

DB変更は2段階で適用する。

1. `supabase/migrations/20260925000132_add_checkout_session_claim_rpcs.sql`で列・一意索引・service-role専用RPCを追加する。
2. 対応アプリの本番動作を確認した後、`supabase/pending/harden_checkout_session_claims.sql`で既存行を`v0`へ補完し、直接INSERTを剥奪する。

第1段階は本番適用済み。第2段階は対応アプリの本番動作を確認してから新しいversionで`supabase/migrations/`へ昇格する。関数は`SECURITY DEFINER`、空の`search_path`、完全修飾名を使い、`PUBLIC` / `anon` / `authenticated`から実行権限を剥奪する。

### 配送先の書き込み順（FREQ-365）

> グループ F で update-shipping を廃止した。配送先は「確認へ進む」で決済の画面と一緒に下書きへ書く（要求の指紋に含める）。

draft の配送先（`shipping_snapshot`）を書く経路は、`POST /api/checkout/create-session`（「確認へ進む」）の1つだけ。下書きを作る（`claim_checkout_draft`）ときに、入力された配送先を写して保存し、その後は書き換えない。配送先は要求の指紋に含めるので、入力が変われば別の下書き・別の決済の画面になる。古い下書きの配送先は変わらない。

以前は、画面からの同期（update-shipping。グループ F で廃止。入力が止まって0.5秒後のデバウンスと、「確認へ進む」押下時）と create-session の再利用経路の2つから書き換わった。そのため、版番号（`checkout_drafts.shipping_revision`）の照合つきの条件付き更新（版が違えば 409、版番号が無ければ 428）で、遅れて届いた古い内容が新しい内容を消すこと（lost update）と、支払いの後に別タブから上書きされること（R-31）を防いでいた。書き換える経路が無くなったので、どちらも起きない。`shipping_revision` の列と条件付き更新の SQL の形は DB に残るが、サーバーと画面は使わない。

最終確認画面に出した配送先と、注文に写す配送先は、どちらも同じ下書きの写しなので、確認の後に変わることは無い（OWASP ASVS V11.1.6 の TOCTOU）。

通常の流れは、入力画面の「確認へ進む」で配送先を検証・保存し、最終確認画面の「注文する」で place-order が支払いの前に注文を作る。以下の欠落監査は、受付を通らないまま完了した（入金済み・入金待ち）決済の画面を、共通照合器の `placeAndMark` が後から注文にする予備処理に限る。この予備処理では、注文を作る前に配送先の必須項目（メールアドレス・氏名・郵便番号・都道府県・市区町村・番地・電話番号）の欠落を確認する。欠けていても決済の画面は完了しており、入金済み・入金待ちの状態を照合する必要があるので注文は作り、欠けた項目を監査ログにエラーとして残す。注文一覧は`配送先要確認`を表示して発送操作を隠し、`admin_ship_paid_order`とDBトリガーも`shipped`への遷移を拒否する（ASVS V11.1.5 / V11.1.7）。根拠は[place-order](../../../src/app/api/checkout/place-order/route.ts)と[共通照合器](../../../src/lib/stripe/checkout-payment-reconciler.ts)。

| テスト                                                                      | 内容                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tests/unit/api/checkout/create-session-route.test.ts`                      | 配送先が違えば別の指紋（別の下書き）になること                  |
| `tests/unit/lib/stripe/checkout-payment-reconciler.test.ts` | 受付を通らないまま完了した（入金済み・入金待ち）決済の画面で注文が無い場合の予備処理で、配送先の欠落を監査ログ（`Checkout draft shipping snapshot is incomplete`）に残しつつ注文を作ること。通常の place-order で受付済みなら、完了 API・Webhook の照合はこの予備処理を通らない |
| `tests/integration/db/checkout_draft_shipping_revision.integration.test.ts` | 実 DB で古い書き込みが弾かれること、同時でも片方だけが勝つこと（今は書く経路が無い。列の条件付き更新の形の確認として残る） |

### 確定ボタンの有効・無効（FREQ-367）

> FREQ-418 により廃止。最終確認画面の「注文する」に同じ決まり（決済フォームの準備ができるまで押せない）を置いた。

| 状態                                                     | 確定ボタン                                                    | 表示                    |
| -------------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| 決済セッションを取得中                                   | 押せない                                                      | 確認へ進む（無効）      |
| 決済セッション未取得（失敗・再試行待ちを含む）           | 押せる（入力検証のフィードバックを返すため。FREQ-354-REQ-02） | 確認へ進む              |
| セッションは取得済みだが Stripe の決済フォームが初期化中 | 押せない                                                      | 決済フォームを準備中... |
| 決済フォームの初期化が完了                               | 押せる                                                        | 確認へ進む              |
| 決済処理中                                               | 押せない                                                      | 決済処理中...           |

押せる状態＝決済に進める状態に揃える。以前は初期化中でも押せてしまい、「決済フォームの初期化が完了していません」と表示されるだけで先に進めなかった。無効化した操作は理由が伝わらないと迷わせるので、表示を「準備中」に変えて理由を示す。押下時の初期化チェックは、UI から到達しなくなっても安全策として残す。

### 配送先の保存（FREQ-366）

「この配送先を保存する」は、住所の入力フォームと同じ条件でのみ表示し、同じ条件でのみ保存する。

| 状態                                      | 入力フォーム | 保存                                   |
| ----------------------------------------- | ------------ | -------------------------------------- |
| 保存済み住所が0件（初めて買うログイン客） | 出す         | チェック ON なら保存する               |
| 「新規」を選択                            | 出す         | チェック ON なら保存する               |
| 保存済み住所を選択                        | 出さない     | 保存しない（同じ住所の二重登録を防ぐ） |

表示と保存を別々の条件で書くと、保存済み住所が0件のときだけ「フォームは出るのに保存されない」ようにずれる。判定は `isEnteringNewAddress` の1か所にまとめる。

チェックが OFF のときは何も保存しない（OWASP ASVS 8.3.3 の opt-in 同意）。保存は「確認へ進む」の最初（決済の画面を作る前）に走るので、保存に失敗したときは最終確認画面へ進まずエラーを出す（お金が動く前に止まるため、二重課金にはならない）。検証は `e2e/FR-CHECKOUT-017-save-address-control.spec.ts` の「保存済み住所が0件でも配送先を保存する」。

### 確認画面の支払方法（FREQ-371）

> FREQ-418 により廃止。支払いの後の確認画面は無くなった。

確認画面は、決済フォーム（PaymentElement）の change イベントの `value.type` を丸めずに持ち、サーバが注文に記録するのと同じ変換を経て、注文詳細（`/api/orders/[id]`）と共通の `mapPaymentMethodLabel` で表示する。変換は `src/features/checkout/services/payment-method.service.ts` にまとめる。

| `value.type`                  | 注文に記録される値 | 表示             | API に送る値     |
| ----------------------------- | ------------------ | ---------------- | ---------------- |
| `card`                        | `stripe_card`      | クレジットカード | `stripe_card`    |
| `apple_pay` / `google_pay`    | `stripe_card`      | クレジットカード | `stripe_card`    |
| `paypay`                      | `stripe_paypay`    | PayPay           | `stripe_paypay`  |
| `konbini`                     | `stripe_konbini`   | コンビニ払い     | `stripe_konbini` |
| `link`                        | `link`             | Link             | 送らない         |
| `customer_balance`            | `customer_balance` | 銀行振込         | 送らない         |
| その他                        | 値のまま           | 値のまま         | 送らない         |
| 未選択（change イベントの前） | `stripe_card`      | クレジットカード | `stripe_card`    |

- 以前はカード・PayPay・コンビニ以外をすべて `stripe_card` に丸めていたため、Link や銀行振込で払っても確認画面に「カード決済」と表示され、注文詳細の表示と食い違っていた
- Apple Pay / Google Pay はカードで決済され、Stripe の PaymentMethod は `type: card`（ウォレットの種別は `card.wallet`）になるので、カードとして扱う
- create-session / complete の入力検証は3手段（`STRIPE_CHECKOUT_PAYMENT_METHODS`）だけを受け付ける。それ以外を送ると 400 になるので送らない。サーバはクライアントの申告を採用せず Stripe から決める（`resolvePaymentMethodFromSession`）ため、送らなくても記録は変わらない
- PayPay のようなリダイレクト型は確認画面を通らず、戻り先で注文を確定する

| テスト                                                      | 確認すること                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `tests/unit/features/checkout/payment-method-label.test.ts` | 各 `value.type` の表示名と、API に送る値が入力検証を通ること               |
| `e2e/FR-CHECKOUT-029-payment-method-label.spec.ts`（グループ F で削除） | 支払いの後の確認画面が無くなったため削除した（FREQ-371 は FREQ-418 により廃止） |

テストモードでは Link（登録済みの Link アカウントが要る）と銀行振込（ダッシュボードで無効）の確認画面まで E2E で進めないため、これらは単体テストで確かめる。

### 画面の部品の定義場所（FREQ-372）

> AC-03・04 は FREQ-418 により廃止（入力画面に決済フォームと配送先の同期が無い）。

checkout の部品は `CheckoutPageContent` の外（モジュールの最上位）で定義し、必要な値は props で渡す。画面の関数の中で定義すると、再描画のたびに別の部品として作り直され（React は部品の関数が変わると、その下の state と DOM を捨てて作り直す）、次のことが起きていた。

| 起きていたこと                                             | きっかけ                                     |
| ---------------------------------------------------------- | -------------------------------------------- |
| 入力中のプロモーションコードが消える                       | 氏名などほかの欄への入力、支払方法の切り替え |
| 「このプロモーションコードは無効です。」などの案内が消える | 同上                                         |
| 「確認へ進む」のキーボードフォーカスが外れる               | 配送先の同期の完了など、画面の再描画全般     |

| 部品                                   | 受け取る値                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PromoCodeField` / `StripeOrderTotals` | なし（`useCheckout()` から読む）                                                                                |
| `ConfirmPaymentButton`                 | `onConfirm`（押したときの処理。親の `handleConfirmPayment`）、`sessionLoading`、`confirming`、`hasClientSecret` |
| `OrderItems`                           | `cartItems`                                                                                                     |
| `CartTotals`                           | `subtotal` / `shipping` / `total`                                                                               |
| `AddressCard`                          | `address`（配送先フォームの値）                                                                                 |

- `useCheckout()` を使う部品は `CheckoutProvider` の内側で部品として描画する必要があるため、`renderAddressFields()` のような「JSX を返す関数の呼び出し」にはできない。モジュールの最上位の部品にする
- 再発防止に、lint ルール `react-hooks/static-components`（eslint-config-next の推奨設定）を有効に戻した。以前は `eslint.config.mjs` で無効化されていた
- lint は描画用の関数（`renderCheckoutSections()` など）の中での使用を検出しないため、「確認へ進む」のフォーカスは E2E で確かめる

| テスト                                               | 確認すること                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `e2e/FR-CHECKOUT-030-keep-input-on-rerender.spec.ts` | 入力中のコード・案内・フォーカスが、ほかの操作による再描画で消えないこと |

### プロモーションコード欄の見出し（FREQ-373）

見出し「プロモーションコード」の `label` の `htmlFor` と入力欄の `id` を一致させる（W3C H44）。id は `useId()` で作る。以前は見出しが入力欄に結びついておらず、入力欄の名前はプレースホルダ「コードを入力」で代用されていた（入力を始めると消えるので名前にならない）。

- コードの適用後は入力欄が無いので、見出しは結びつけない（`htmlFor` を付けない）
- `TextField` は `label` を渡すと部品の中に見出しを描くが、ここでは見出しが入力欄と「適用」ボタンの上にまたがるので、外の `label` を `htmlFor` で結びつける
- 検証は `e2e/FR-CHECKOUT-031-promo-code-label.spec.ts`（欄の名前と、見出しを押したときのフォーカス）

### プロモーションコードを適用できなかった案内（FREQ-374）

適用できなかった理由（例: 「このプロモーションコードは無効です。」）を、表示と同時に読み上げ、入力欄に結びつける。

| 状態     | 案内の要素                                    | 入力欄                                                 |
| -------- | --------------------------------------------- | ------------------------------------------------------ |
| 案内なし | 空の `role="alert"`。`sr-only` で画面から外す | `aria-invalid` と `aria-describedby` を付けない        |
| 案内あり | 同じ要素に文言が入り、赤字で表示する          | `aria-invalid="true"`、`aria-describedby` で案内を指す |

- `role="alert"` の要素を文言ごと後から差し込むと、中身の変化とみなされず読み上げられないことがある（MDN alert role）。入れ物を最初から置き、中身だけを入れ替える。WAI-ARIA APG の Alert の例も同じ作り
- 空の要素をそのまま置くと、`.checkout-section` の `gap` で余白が1つ増える。空のあいだは `sr-only`（絶対配置で flex の並びから外れる）にする
- 同じコードを続けて適用しても、適用の開始で案内を空にしてから入れ直すので、毎回読み上げられる
- `TextField` の `errorText` は使わず、案内は入力欄と「適用」ボタンの下に全幅で出す。`errorText` だと案内が入力欄の列の中に入り、横並びのボタンが縦に伸びる。`TextField` 側の案内の入れ物（FREQ-375）は、この欄では空のまま（空の読み上げ領域は読み上げられない）
- 検証は `e2e/FR-CHECKOUT-032-promo-error-a11y.spec.ts`

### 確定時の欄ごとの誤りの読み上げ（FREQ-376）

空のまま「確認へ進む」を押すと、欄ごとの誤りが一度に最大8件出る（メール・氏名・フリガナ・郵便番号・都道府県・市区町村・番地・電話番号）。

| 案内                                                                                                                                        | 読み上げ                          | 理由                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| 欄ごとの誤り（`TextField` / `SingleSelect` の `errorText`。都道府県は `#prefecture-error`）                                                 | 割り込まない `aria-live="polite"` | 割り込む `role="alert"` だと8件が一斉に読み上げられる |
| お客様情報・配送先の保存の失敗（`customerError`、`profileSaveError`）、プロモーションコードの案内、決済の準備・注文の確定の失敗（FREQ-377） | `role="alert"`                    | 操作の結果として出る単発の案内                        |

- 先頭の誤りの欄（氏名）へフォーカスを移して知らせる（FREQ-354）。移った欄の名前と説明（誤りの文言）が読まれる
- 案内はすべて `LiveMessage` で出す（入れ物を最初から置き、中身だけを入れ替える。`21_design_system.md` 参照）
- 都道府県の欄は FREQ-379 で `SingleSelect` の `errorText` に移した。欄の説明（`aria-describedby`）と誤りの状態（`aria-invalid`）が付き、枠がエラー色になる。キーボードだけでも選べる
- 検証は `e2e/FR-UI-007-live-message.spec.ts`、`e2e/FR-UI-009-select-combobox.spec.ts`

### 決済まわりの失敗の案内（FREQ-377）

> FREQ-418 により入力画面の決済フォームと「再試行する」は廃止した。入力画面では「確認へ進む」の上、最終確認画面では案内の種類に応じた位置に出す。

| 案内                               | 置き場所                                                                     | 目印                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 決済の準備（create-session）の失敗 | 入力画面の「確認へ進む」の上。エラー ID は案内の後ろに、入れ物の外で出す。再試行可能なら「確認へ進む」をもう一度押す | `data-testid="checkout-session-error"` |
| 支払い後の完了処理の失敗（入力画面で処理した場合） | 入力画面（step 1）の先頭 | `data-testid="checkout-return-error"` |
| 最終確認画面の「注文する」の受付・支払いの失敗 | 最終確認画面の決済フォームの下、操作ボタンの上 | `data-testid="checkout-place-order-error"` |
| 最終確認画面の時間切れ・別タブの案内、完了処理の失敗 | 最終確認画面の先頭（2列の外） | `data-testid="checkout-final-notice"` |

- 以前は決済から戻って確定に失敗しても、案内が確認画面（step 2）の中にしか無く、画面にも出ていなかった
- 確認画面から「戻る」で入力画面に戻るときは、確認画面の案内を消す（入力画面の先頭に持ち越さない）
- 検証は `e2e/FR-UI-008-status-messages.spec.ts`（AC-01・AC-02）

### 割引が付いた注文の確定（FREQ-389）

> FREQ-420 により `allow_promotion_codes` は使わない。割引はサーバーが確かめたコードだけを、「確認へ進む」で `discounts` として付ける（「最終確認画面と「注文する」」の節）。下の金額の扱いは変わらない。

入力画面にはプロモーションコードの入力欄がある。以前の Stripe セッションは `allow_promotion_codes: true` で作っていた（custom / hosted の両方。FREQ-397）が、グループ F で廃止した。現在はcustomだけを受け付け（hostedは400）、サーバーが検証したコードだけを `discounts` で付ける。割引が付くと Stripe の `amount_total` は割引後、`total_details.amount_discount` が値引額になる。下書き（`checkout_drafts`）の合計は割引前のまま変えない。

| 時点 | `checkout_drafts.total_amount` | `checkout_drafts.discount_amount` | 注文（`orders`）の `total_amount` / `discount_amount` |
| --- | --- | --- | --- |
| 作成時 | 割引前の合計 | 0 | 注文なし |
| 受付 RPC の中（`place_order_from_checkout_draft`。注文の作成と同じトランザクション） | 割引前のまま（書き換えない） | Stripe の値引額を書き戻す | Stripe の割引後の額 / Stripe の値引額 |

受付 RPC は、下書きの「合計 + 割引額」と Stripe の「割引後の額 + 値引額」を、割引前どうしで比べる。食い違えば `amount_mismatch` で断る。割引後の額は Stripe の値が正で、下書きの合計を割引後に書き換えて合わせることはしない（R-26）。

- 金額の書き戻しは、受付 RPC の中の1か所だけで行う。完了 API・webhook・見回りは下書きの金額を書き戻さず、照合関数を呼ぶだけ
- 注文の作成と値引額の書き戻しは1つのトランザクションなので、片方だけ失敗しない。一時的な失敗（Stripe・DB。`ReconcileTransientError`）では、完了 API は 503 を返して監査ログ（`checkout.complete`）に残し、webhook は worker がイベントを `failed` にして再試行する
- 受付 RPC は Stripe の値引額を注文の `discount_amount` に、Stripe の割引後の額を `total_amount` に入れる。以前は 0 を直書きしていたため、注文詳細に値引額が出なかった

### 何度呼ばれてもそろう形にする（FREQ-394）

受付 RPC の金額検査は、下書きの `total_amount + discount_amount` と Stripe の `amount_total + amount_discount` を比べる。`total_amount` は割引前のままにし、受付 RPC が Stripe の値で `discount_amount` だけを書き戻す（上の FREQ-389）。割引後の合計へ書き換え済みの古い下書きも、この和で割引前の額にそろう。

確定は1つの注文につき何度でも走る。

| 2回目が走る場面                                | 起きること（対策前）                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| webhook が先に注文を作り、その後ブラウザが戻る | 注文はあるのに complete が 400 を返し、客の画面は失敗表示 |
| 注文確定が落ちて客が再試行する                 | 何度押しても 400。その注文は二度と確定できない            |

同じ Session で受付 RPC を再度呼んだ場合、金額検査より先に既存注文を返すため、書き戻し後も同じ注文に収束する。

- 比べるのは割引前どうし。`下書きの total_amount + 下書きの discount_amount` と `Stripe の amount_total + total_details.amount_discount`。今の下書き（割引前の合計と割引額0）も、割引後の合計と割引額の組を持つ古い下書きも、この和は割引前の額になる
- 照合関数は先に注文を引き、あれば受付 RPC を呼ばずにその注文の状態で決める。受付 RPC も同じ Session の注文があれば、下書きを書き換えずにその注文を返す
- 金額の食い違いは、受付 RPC が `amount_mismatch` で断り、注文を作らない。照合関数が要対応（`order_not_creatable`、詳細 `amount_mismatch`）として記録して店へ知らせ、完了 API は 409 を返す。不正な減額を通さないための検査であり、緩めていない

#### イベントの順序（FREQ-394）

Stripe はイベントの配信順を保証しない。照合関数はイベントの種類にも届いた順番にも頼らず、Stripe の現在値だけで決める（R-01・R-02）。`payment_intent.succeeded` のペイロードには値引額が無いので、PaymentIntent の ID しか持たないイベントでは、`checkout.sessions.list({ payment_intent })` で Checkout Session を引き、その割引後の額（`amount_total`）と値引額（`total_details.amount_discount`）で受付 RPC を呼ぶ。

- Session を引けない場合（Checkout 経由でない PaymentIntent、Stripe に無いものなど）は、注文が無ければ注文を作らず記録だけにする（監査ログ `checkout.payment.reconcile` に `ok:record_only:not_applicable` または `ok:record_only:stripe_object_missing`）。注文があれば要対応にする。金額の根拠を推測で埋めない
- Stripe の通信・5xx・回数制限は一時的な失敗として例外にし、webhook なら worker が再試行する
- 完了 API・webhook・見回りは同じ照合関数を通り、割引額の書き戻しは受付 RPC の1か所にしか無い。片方の経路だけが違う落ち方をすることはない

### 合計が 0 になる割引は受け付けない（FREQ-389）

Stripe 公式（無料の注文）に「無料注文のフルフィルメントを行うには、PaymentIntent イベントではなく、`checkout.session.completed` イベントを処理してください。**支払いのない完了済みの Checkout セッションでは PaymentIntent の関連付けが行われません**」とある。注文の冪等キーはグループ A で `orders.checkout_session_id`（`orders_checkout_session_id_key`）に移し、`orders.payment_intent_id` は空を許すようにしたので、PaymentIntent が無くても注文は一意にできる。それでも合計が 0 の注文は受け付けない（FREQ-389 の方針のまま。設計書 3-2 の判定表の「0円で完了」の行）。

- 完了 API は、`amount_total` が 0 のセッションでは照合関数を呼ばずに 400（`Zero-amount checkout is not supported`）を返し、監査ログ（`checkout.complete`）に `Zero-amount checkout session is not supported` と値引額を残す
- webhook の経路は照合関数を通る。Stripe の状態は `zero_amount_complete`（Session が `complete` かつ `no_payment_required`）で、注文が無ければ記録だけにし、監査ログ（`checkout.payment.reconcile`）に `ok:record_only:zero_amount` を残してイベントを処理済みにする。値引額は記録しない（Stripe の Checkout Session に残る）。文言は完了 API と違うが、「payment_intent が無い」とは区別できる（FREQ-397 の「同じ文言」は FREQ-409 で置き換えた）
- 「PaymentIntent が無い」で弾くと理由が読めないため、こちらを先に判定する
- 運用上は、合計が 0 になるクーポン（100%割引・合計以上の割引）を Stripe 側で作らない
- 受付 RPC（`place_order_from_checkout_draft`）も合計が 0 以下なら `zero_amount` で断る。0円の注文を受け付けるなら、この判定・完了 API の判定・判定表の「0円で完了」の行を変える

### 商品が引けないときの注文確定（FREQ-387）

管理画面の商品削除は実削除。注文の明細・在庫の記録・受付の済んでいない開いている決済（24時間以内の下書き）のある商品は、削除させずに理由付きの409を返し、非公開へ促す（FREQ-414。`item_delete_blockers`）。カートとそれより古い下書きは削除を止めないので、削除された商品を含む下書きは残りうる。削除された商品を含む draft で注文確定を呼ぶと、以前は次の順で落ちていた。

1. 商品を1件ずつ `SELECT ... INTO` で引く。行が無いので `item_status` は NULL、`FOUND` は false（PostgreSQL 公式の動作）
2. `item_status <> 'published'` は NULL との比較で NULL になり、条件が成立せず公開判定を素通りする
3. 注文明細の INSERT が外部キー違反（23503）で落ちる。支払いは済んでいるので、客には理由の分からない失敗が返る

いまは受付 RPC `place_order_from_checkout_draft` が商品を `LEFT JOIN` で引き、行が無い商品も非公開と同じ `item_unavailable` で断る（注文を作らない）。支払いの後なら照合関数が要対応（`order_not_creatable`、詳細 `item_unavailable`）として記録して店へ知らせ、お客様には受付を通らない支払いの案内を1回送る。完了 API は 409 を返す。検証は `tests/integration/db/place_order_from_checkout_draft.integration.test.ts` の「非公開の商品と存在しない商品は item_unavailable」。

### 注文メールは1注文・1種類につき1通（FREQ-386）

入金待ち・入金済みのメールは、「画面からの complete」「webhook」「毎時の見回り」の3経路から送りうる。3経路とも同じ照合関数を通り、同じ注文を受け取る。送信済みの記録が無いと、次のことが起きる（下の表は FREQ-386 を直す前の動きで、当時の経路は complete・webhook・掃除ジョブ。掃除ジョブは今の見回りにあたる）。

| 場面                                     | 直す前                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| カードで webhook が先に注文を作る        | webhook は入金待ちのときしか送らず、complete は既存注文として何も送らずに返す。**0通**  |
| コンビニ・銀行振込で complete が先に作る | complete が送り、そのあと webhook が同じ入金待ちの注文を受け取ってもう一度送る。**2通** |
| 掃除ジョブが pending を paid に上げる    | 更新できた行数を見ずに送るため、webhook と重なると**2通**                               |

Stripe は「同じイベントを複数回受信する可能性」と「配信順は保証しない」を明記しているので、受け取り側で重複を排除する。これは OWASP ASVS V11.1.6（TOCTOU・競合）の対象でもある。

- 送る直前に `public.claim_order_email(order_id, kind)` で送信権を取り、取れた経路だけが送る。送信に失敗したら `public.release_order_email` で戻し、送信権を取り直せるようにする（今の照合関数は、送れなかったことを見ても送り直さない。確実に届ける仕組みはレビュー台帳のグループ D で扱う）
- `kind` は `awaiting_payment`・`paid`・`payment_expired`・`canceled` の4つ（`private.order_emails` の CHECK と `OrderEmailKind`）。コンビニは入金待ちの「お支払い待ち」（`awaiting_payment`）と、入金の確認の `paid` で2通届くのが正しい。払込票の期限切れで失敗にしたときは `payment_expired`（「お支払い期限切れのお知らせ」）、管理画面で取り消したときは `canceled`（「ご注文取消のお知らせ」。画面でお知らせを外せば送らない）を、それぞれ1通だけ送る
- 記録は `private.order_emails`（Data API から触れないスキーマ。Supabase のドキュメントが示す置き方）。関数は SECURITY DEFINER・`search_path = ''` で、実行できるのは service_role だけ
- 権利の確認そのものが失敗したときは、届かないより重複を選んで送り、監査ログ（`order.confirmation.mail` / `mail_claim_failed`）に残す
- 入金待ち・入金済みのメールは、入金済みにする RPC（`mark_order_paid`）か入金待ちにする RPC（`mark_order_awaiting_payment`）が状態を変えたときだけ、照合関数が送る。更新が0件（先に別の経路が動かした）なら、メールは送らずに Stripe と注文を読み直す。支払額が注文と合わないときは入金済みにして要対応にし、注文確認のメールは送らない（店が確かめてから連絡する）
- 注文 ID から注文行と明細を引いて本文を組み立てる処理は `sendOrderConfirmationEmailForOrderId`（`src/lib/orders/order-confirmation-email.ts`）に1つだけ置く。以前は webhook の2か所と掃除ジョブの計3か所が同じ列の並びと同じ組み立てを別々に持っていて、片方だけ直すと経路によって客に届く内容が食い違う状態だった
- 明細が引けないとき、および0件のときは送らない（空の注文内容を客に見せない）。呼び出し側は送れなくても注文の成否を変えず、現在の照合関数は後の経路で自動再送しない（R-34、グループ D）
- 検証は `tests/unit/lib/orders/order-confirmation-email.test.ts`、`tests/integration/db/order_email_claims.integration.test.ts`、各経路の単体テスト

#### 本文は注文行だけから作る（FREQ-396）

確定（complete）だけは下書きのスナップショットから本文を組み立てていた。値引額は注文行（`orders.discount_amount`）にしか無いため、割引が付いた注文のメールは**小計＋送料と合計が合わない**まま届いていた。注文詳細の画面は `-￥1,000` を出しているので、同じ注文について画面とメールで見え方が違っていた。

- 本文の組み立ては `sendOrderConfirmationEmailForOrderId` に一本化する。呼ぶのは照合関数のメール送信（`createReconcilerMailer`）だけで、注文 ID だけを渡す（`logLabel: '[reconcile]'`）。完了 API・webhook・見回りは、照合関数を通ってここに届く
- 値引がある注文では、送料の次に `割引: -￥1,000` を出す。0 のときは行ごと出さない
- 低レベルの `sendOrderConfirmationEmail` は直接呼ばない。`discountAmount` を必須の引数にしてあるので、新しい呼び出し側が割引を落とすと型で落ちる

| 行   | 出典                                               |
| ---- | -------------------------------------------------- |
| 小計 | `orders.subtotal_amount`                           |
| 送料 | `orders.shipping_amount`（0 なら「無料」）         |
| 割引 | `orders.discount_amount`（0 のときは行を出さない） |
| 合計 | `orders.total_amount`（割引後の実請求額）          |

### 直らない失敗のあとの「確認へ進む」（FREQ-385）

> FREQ-418 により「確認へ進む」は入力画面の通常の操作になった。入力画面に決済フォームや別の再試行ボタンは置かない。下のエラー保持と押せない理由の案内は引き続き適用する。

以前は、決済の準備が待っても直らない理由（在庫切れ、`retryable: false` の 422 など）で失敗したとき、決済フォームの代わりに「確認へ進む」を出していた。これを押すと、原因の案内が「決済フォームを準備しています。少し待ってから再度お試しください。」に置き換わる問題があった。現在も再試行できない失敗では、原因の案内を保ち、入力画面の「確認へ進む」を押せなくする。

- 再試行できない失敗のあいだ（`checkoutError` があり `sessionErrorRetryable` が false）は、「確認へ進む」を押せなくする
- 押せない理由が分かるよう、ボタンの `aria-describedby` で案内の要素（`id="checkout-session-error-message"`）を指す
- 案内は今まで通り読み上げ領域（`data-testid="checkout-session-error"`）に出す。在庫切れなら、カートを直してから進んでもらう
- 検証は `e2e/FR-CHECKOUT-034-session-error-keeps-message.spec.ts`（3ビューポート）

### 決済から戻ったときの確定は1回だけ（FREQ-378）

> グループ F から、戻りは入り直しの入口が支払い済みを返したときに確定を送る。完了の後も URL に決済の画面の ID を残す。

`/checkout?session_id=…` で開くと、effect が `/api/checkout/complete` を送る。送ったことを state（`processedCallback`）で覚えていたが、state は次の描画まで反映されない。カートの再描画で依存の `updateCartCount`（メモ化されていない）が先に変わった描画で effect が走り直し、3ms 差で2回送ることがあった（15回中4回。変更前のコードでも同じ率で再現）。

- 送った決済セッションを ref（`finalizedSessionIdRef`）で覚える。ref は即座に変わるので、走り直しても同じ決済セッションでは送らない
- 部品の作り直しではないことを、計測ログ（部品ごとの識別子）で確かめた
- サーバー側は、順番に来た重複には既存の注文を返す。同時に来た重複の扱いは、確認メールの重複と合わせて別の課題
- 検証は `e2e/FR-CHECKOUT-033-complete-once-on-return.spec.ts`（幅ごとに8回繰り返す）、`e2e/FR-CHECKOUT-005-006-009-checkout-postal-complete-idempotent.spec.ts`

---

## API 仕様（CHECKOUT-API）

| エンドポイント                 | メソッド | 概要                                    | 認証                | 主なレスポンス                |
| ------------------------------ | -------- | --------------------------------------- | ------------------- | ----------------------------- |
| `/api/checkout/create-session` | POST     | 「確認へ進む」で配送先7項目を求め（欠落は400 shipping_incomplete）、customのみの下書きと Stripe セッション（30分で失効）を作り、最終確認画面の内容を返す（hostedは400）。ログインを買い手として確かめて下書きに記録する（印が古ければ401 auth_expired、確かめられなければ503。支払い済みの画面の買い手が違えば409 login_changed） | 任意（ゲスト/会員） | `{ confirmation }` |
| `/api/checkout/complete`       | POST     | Webhook/サーバ確認後に注文を確定。ログインは確かめず、注文の持ち主には触れない（グループ C） | 任意                | `{ orderId, status }`         |
| `/api/checkout/promotion-code` | POST     | 割引コードの「適用」。サーバーが使えるかを確かめ、割引後の金額を返す | 任意（ゲスト/会員） | `{ code, subtotalAmount, shippingAmount, discountAmount, totalAmount }` |
| `/api/checkout/place-order`    | POST     | 「注文する」の受け付け。ログインを確かめ、決済の画面がこのカートのものでなければ403 forbiddenで断り（この画面は閉じない。ログインでカートの印が新しくなった時など。画面は login_changed と同じ扱い）、下書きの買い手と違えば決済の画面を閉じて409 login_changedで断る（401 auth_expired・503は何も変えず返す）。同じなら、注文を作る処理の中で持ち主を書く。別の完了済み画面ならpayment_doneでその注文へ進み（買い手が違う画面は返さない）、本人のカート行が消えていればcart_changedで断る（押し直しではpayment_in_progressの注文だけ）。注文を作り在庫を確保する。残り10分未満は閉じず409 session_expiredと記録。前の画面は作り直しのD5か30分の時間切れで閉じる。作り直しの「確認へ進む」自体が買えない商品・金額の食い違いなどで断られたときは閉じる処理まで進まないため、30分の時間切れと Stripe の知らせ・見回りで閉じる。別の画面のpayment_done・cart_changed（受付済みの押し直しを含む）・supersededではこの画面を閉じ、失効成功時に照合して、受付済みなら放棄・在庫返却し、理由とIDを記録する。後始末の失敗はログに残し応答を変えない | 任意（ゲスト/会員） | `{ orderId, orderStatus }` |
| `/api/checkout/resume`         | POST     | 決済の画面を開き直したときに、どこから続けるかを返す。ログインを確かめ、下書きの買い手が違えば none を返す（401 auth_expired・503は何も変えず返す） | 任意（ゲスト/会員） | `{ state: "none" }` ／ `{ state: "payment_done", checkoutSessionId }` ／ `{ state: "resume", confirmation }` |
| `/api/webhook/stripe`          | POST     | Stripe Webhook 受信・署名検証・冪等処理 | Stripe 署名         | `200` or `400`                |

> **決済成功率目標**: 99% 以上。支払失敗時は注文を `failed` ステータスに更新し、ユーザへ再試行導線を提示すること。

> **`/api/checkout/create-session` のレート制限**: IP 単位は「10秒10回」と「10分60回」の二段、セッション単位は 10 回/分（FREQ-362）。この API は呼ぶたびに Stripe を最低1回呼ぶ（再利用時は取得、新規は作成）。10秒の上限は一瞬の集中を抑え、時間枠の境目をまたいでも1つの IP から毎秒10回程度に収まるので、Stripe の上限（エンドポイントごとに毎秒25回）を超えない。10分の上限は1つの IP から続けて呼べる総量（1時間360回）を抑える。1つの長い時間枠だけで絞ると、共有 IP（携帯回線・社内）からの短い集中まで止めてしまうため二段にしている。セッション単位の上限は Cookie を捨てれば回避できるので、1つのブラウザでの誤操作の連打対策であり、IP 側を緩める根拠にしない。上限に達したら 429 で時間をおいて再試行するよう案内する文を返し、画面はそれをそのまま表示する。E2E はすべて 127.0.0.1 から呼ぶため、`scripts/e2e-server.mjs` が起動するサーバーだけ `E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER=30` で IP 単位の上限を引き上げる（`VERCEL=1` のとき無視、30 倍まで）。

---

## イベントスキーマ管理（INTEG-EVENT）

| バージョン | 方針                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `v1`       | 現行スキーマ。破壊的変更は禁止                                                                    |
| `v2` 以降  | 新バージョンを追加し、旧バージョンは deprecation スケジュールを公開後、十分な猶予期間を設けて廃止 |

- 後方互換性: 新フィールド追加は `v1` に許可（オプション）。型変更・フィールド削除は新バージョン必須。
- スキーマは OpenAPI / JSON Schema で管理し、CI で diff を自動検出する。

---

## API バージョニング方針（INTEG-APIVER）

- バージョンは URL パス（`/api/v1/items`）または `Accept: application/vnd.api+json;version=1` ヘッダーで明示する。
- 非互換変更は新バージョンとして追加し、旧バージョンは **最低 6 か月** の deprecation 期間を設けて廃止する。
- 廃止予定の API は `Deprecation` / `Sunset` レスポンスヘッダーで通知する。

---

## シークレットローテーション方針（INTEG-SECRETS）

| シークレット種別        | ローテーション周期 | 緊急時                    |
| ----------------------- | ------------------ | ------------------------- |
| `STRIPE_SECRET_KEY`     | 90 日              | 漏洩疑い発生後 1 時間以内 |
| `STRIPE_WEBHOOK_SECRET` | 90 日              | 漏洩疑い発生後 1 時間以内 |
| Supabase サービスキー   | 90 日              | 漏洩疑い発生後 1 時間以内 |

- ローテーション手順: Secrets Manager に新バージョン登録 → CI/CD で新 Secret を取得 → ローリングデプロイ → Health Check 確認 → 旧 Secret 無効化 → 監査ログ記録。

---

## 新しい決済手段をダッシュボードで有効化するときの手順（CHECKOUT-DPM-OPS）

決済手段の動的化（FREQ-356）により、決済手段の追加は Stripe ダッシュボードの操作だけで反映される。時間差決済（コンビニ払い・銀行振込など、入金確定が即時でない方式）を有効化する場合は次を確認する。

1. その方式の入金確定が `checkout.session.async_payment_succeeded` で通知されるか（Stripe のドキュメントで「delayed notification」に分類されるか）を確認する
2. 支払期限を指定できる方式なら `payment_method_options` に設定する（コンビニは `expires_after_days` に `KONBINI_PAYMENT_DAYS`（7日。`src/lib/constants/konbini.ts`）を設定済み。/legal の表記も同じ定数を読む。FREQ-106・R-57）。指定できない方式は Checkout Session をアプリ側で強制終了できない場合があるため、失効・返金・長期保留の運用を決めてから有効化する。
3. その方式が Customer を要求するか確認する（`customer_creation: if_required` の既定で足りるか）
4. テストモードで「確定 → 支払い手続き中（`payment_in_progress`）の注文と在庫の確保 → 払込票の発行で入金待ち（Stripe の状態は `awaiting_payment`、注文の状態の値は `pending`）→ `async_payment_succeeded` で `paid` と入金確認のメール、または払込期限切れ（`async_payment_failed`）で `failed` と在庫の戻し・お支払い期限切れのお知らせ」を一巡させる。現状は Stripe の入金済み・入金待ちを照合した同じ呼び出し内で注文を作り状態を進める（グループ F の受付 API 適用後は支払い前に注文を受け付ける）。どの経路（Webhook・完了 API・見回り）でも、状態は照合関数が Stripe の現在値で決める
5. 返金の可否と手数料の扱いを確認する（返金非対応の方式がある）
6. 確認画面と注文詳細の表示名を確認する。`mapPaymentMethodLabel` に無い方式は Stripe の種別名（例: `alipay`）がそのまま表示されるので、必要なら表示名を追加する（FREQ-371）

Link を独立した支払手段として有効化する、または Express Checkout（Apple Pay / Google Pay などのボタン）を導入する場合は、`src/proxy.ts` の CSP に Stripe 公式ガイドの Link 用ディレクティブ（`frame-src` と `connect-src` に `https://link.com https://*.link.com`、`img-src` に `https://*.link.com`）を追加し、`e2e/FR-CHECKOUT-025-stripe-csp-guard.spec.ts` を実 Stripe で実行して外部リソースの CSP ブロックが0件であることを確認する（FREQ-359）。現状の Link はカード欄内の保存機能として `js.stripe.com` から配信されるため、追加は不要。

`e2e/FR-CHECKOUT-025-stripe-csp-guard.spec.ts` の PayPay の検証は、PayPay が選ばれたこと（決済フォームの項目の `aria-expanded="true"`）を確かめてから観測する（`e2e/checkout-test-utils.ts` の `selectPaymentMethod`）。以前は画面外の決済フォームを押して選べないまま観測しており、mobile と desktop では PayPay を選ばずに通っていた。

### 照合の見回りと環境変数（FREQ-407）

`POST /api/cron/expire-pending-orders` は照合の見回り。pg_cron が毎時0分（`0 * * * *`）に呼ぶ。pg_net は POST リクエストのみ発行できるため POST となる。

| 項目 | 内容 |
| --- | --- |
| 対象 | 決済画面を開いてから30分を超えた支払い手続き中（`payment_in_progress`）の注文と、入金待ち（`pending`）の注文 |
| 1回の上限 | 50件・45秒（`MAX_ORDERS_PER_RUN`・`TIME_BUDGET_MS`）。残りは次の回に回す |
| 決済画面の失効 | 支払い手続き中の注文のうち、開いてから30分を超えてまだ開いている Checkout Session を失効させる（`expireOpenCheckoutSession`）。支払いの前に注文を作る受付 API（グループ F）が入った後は、Webhook が届かなくても、放棄された決済の在庫は最長90分で戻る。今は注文を支払いの後に作るので、放棄された決済は在庫を押さえない |
| 判定 | 照合関数（`reconcileCheckoutPayment`）が Stripe の Session と PaymentIntent の現在値だけで決める。アプリ独自の日数で入金待ちを打ち切らない |
| 店への要対応メール | 送れていない分を1回20件まで送り直す（`listUnsentShopAlerts`） |

| 環境変数 | 用途 |
| --- | --- |
| `CRON_SECRET` | 見回りの呼び出しの認証に使う `Authorization: Bearer <CRON_SECRET>` の照合値。不一致は 401 |

`PENDING_ORDER_EXPIRY_DAYS` は廃止した。入金待ちは Stripe が払込票の期限切れを確定したときだけ失敗にするので、日数の下限（FREQ-388 の5日）も要らない。FREQ-388 は FREQ-407 で置き換えた。

Checkout Session が所有する PaymentIntent は直接 cancel しない。Stripe の状態ごとの行動は判定表（`src/lib/stripe/checkout-payment-decision.ts`。設計書 3-2）にだけ置き、注文と在庫は照合関数が今の状態を条件にした RPC（`mark_order_paid`・`mark_order_awaiting_payment`・`release_stock_for_unpaid_order`）で変える。

呼ぶ側（pg_net）と呼ばれる側（ルート）の時間の関係も合わせる。

| 場所                                                  | 値                              | 意味                                             |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `supabase/pending/schedule_expire_pending_orders.sql` | `timeout_milliseconds := 60000` | pg_net が応答を待つ上限                          |
| `src/app/api/cron/expire-pending-orders/route.ts`     | `maxDuration = 60`（秒）        | ルートの実行上限                                 |
| 同上                                                  | `TIME_BUDGET_MS = 45_000`       | ルートが自分で処理を打ち切り、監査ログを残す時刻 |

pg_net の待ち時間を短くすると、ルートがまだ働いている最中に呼ぶ側が諦める。`cron.job_run_details` と `net._http_response` にはタイムアウトだけが残り、運用からは「毎回失敗している」としか見えない（実際は片付いている）。`timeout_milliseconds` は `maxDuration` 以上にする。この関係は `tests/unit/migrations/schedule-expire-pending-orders.test.ts` が両方のファイルを読んで確かめる。

1回に処理する注文は最大50件とする。候補（開いてから30分を超えた支払い手続き中と、入金待ち）の件数から50件単位の範囲を求め、`created_at, id` の安定順序で時間ごとに範囲を巡回する（`resolveHourlyBatchOffset`）。これにより、払込期限まで残る入金待ちの注文が先頭50件を占めても、後続の注文を照合できる。count と一覧取得の間に状態が変わって選択範囲が空になった場合は、その実行だけ先頭範囲へ戻す。監査メタデータに `candidateCount` と `batchOffset` を残す。

### 認証失敗の記録と監視（FREQ-370）

`/api/cron/expire-pending-orders` は誰でも叩ける。認証の失敗は記録するが、1回ごとに監査ログの INSERT と外部アラート（`ALERT_AUDIT_URL`）を起こすと、未認証の要求だけでログとアラートを際限なく増やせる（OWASP Logging Cheat Sheet の「ログで資源を枯渇させない」、OWASP API4:2023）。

| 失敗の理由                             | 応答 | 記録先                                                                  |
| -------------------------------------- | ---- | ----------------------------------------------------------------------- |
| Authorization ヘッダが無い・一致しない | 401  | アプリのログだけ（ヘッダの値は出さない）                                |
| `CRON_SECRET` 未設定（設定ミス）       | 401  | アプリのログと監査ログ。監査ログは IP に依らない共通の枠で10分に1回まで |

「ジョブがそもそも呼ばれていない」「401 で失敗している」は、DB 側の記録で確認する。pg_net の応答は既定で6時間だけ `net._http_response` に残るので、見たい実行の時刻から6時間以内に見る（毎時0分に実行する）。

```sql
-- ジョブの実行結果（Vault の秘密が欠けていれば failed と理由が残る。FREQ-368）
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'expire-pending-orders')
order by start_time desc
limit 5;

-- 送信した HTTP 要求の応答（401 なら CRON_SECRET の不一致・未設定を疑う）
select id, status_code, error_msg, timed_out, created
from net._http_response
order by created desc
limit 20;
```

### pg_cron 登録

照合の見回りを毎時実行するための pg_cron + pg_net 登録 SQL は、本番の公開時まで `supabase/pending/schedule_expire_pending_orders.sql` に保留している（`supabase/migrations/` に置くと CI の `db push` が本番へ流すため。FREQ-380）。入れるときは新しい version で `supabase/migrations/` へ移す（[supabase/pending/README.md](../../../supabase/pending/README.md)）。

### 本番デプロイの前提条件（レビュー指摘 I8）

決済手段の動的化と在庫復元の機能を本番へ入れる際は、次の順序で確認・実施する。どれか1つでも欠けると、機能の一部または全部が「エラーは出ないが動いていない」状態になる。

1. **Stripe Webhook エンドポイントの購読イベントを確認する。** 受け取り口が保存する13種（一覧は[手順書](../../06_Operations/webhook-queue-operations.md)の4）が Stripe ダッシュボードのエンドポイント設定で有効になっていること。そのうち `checkout.session.completed` / `checkout.session.async_payment_succeeded` / `checkout.session.async_payment_failed` / `checkout.session.expired` / `payment_intent.succeeded` / `payment_intent.payment_failed` の6つは照合関数へ渡すイベント（`src/lib/stripe/webhook-processor.ts` の `processStripeWebhookEvent`）で、これが漏れていると webhook 側の照合は一切発火せず、毎時の見回りだけが注文と在庫を合わせる経路になる（サイレントな機能欠落）。
2. **`CRON_SECRET` を本番環境変数に設定し、Vault にも登録する。** 値は32文字以上のランダムな値にする（短いと全部の定期処理の入口が設定の誤りとして401で断る）。`supabase/pending/schedule_expire_pending_orders.sql`（pg_cron 登録マイグレーション。公開時に新しい version で適用する）は Vault に秘密が無くても適用できるが、秘密が揃うまでジョブは毎回失敗する（FREQ-368）。失敗は `cron.job_run_details` に status=failed と理由が残り、認証ヘッダの無い要求は送られない。適用後に次を確認する。

   ```sql
   select status, return_message, start_time
   from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'expire-pending-orders')
   order by start_time desc limit 5;
   ```

3. **在庫は色 × サイズ（`item_variants`）と在庫台帳（`stock_movements`）だけで動く。** バリアント在庫の6本（`20260919065336`〜`20260919065518`。FREQ-380）は 2026-09-19 に本番へ適用済み。`items.stock_quantity` は FREQ-401 で廃止し、受付（`place_order_from_checkout_draft`）と在庫の戻し（`release_stock_for_unpaid_order`）は在庫台帳だけを動かす。`order_items.item_id` は同じ適用で bigint になった（`items.id` と同じ型）。
4. **マイグレーションをアプリのデプロイより先に適用する。** 照合関数が呼ぶ RPC（`place_order_from_checkout_draft`・`mark_order_paid`・`mark_order_awaiting_payment`・`release_stock_for_unpaid_order`・`record_payment_exception` など）が無い状態でアプリをデプロイすると、決済系の webhook イベントはすべて worker で失敗して再試行になり、完了 API と見回りも失敗する。逆にする理由はないため、常に「マイグレーション適用 → アプリデプロイ」の順を守る。

### 在庫は色 × サイズだけ（FREQ-401）

`items.stock_quantity`（商品単位の在庫数）を廃止し、在庫の正を `item_variants` と在庫台帳（`stock_movements`）に一本化した。2系統が併存していると、どちらを見ているかで答えが変わる。

在庫の有無は「買えるか」ではなく「納期」を分ける（FREQ-400）。したがって在庫を理由にカートも注文も止めない。落としたのは「足りなければ断る」判定そのもの。

| 場面             | 以前                            | いま                                 |
| ---------------- | ------------------------------- | ------------------------------------ |
| カートに追加     | 合計が在庫を超えると 409        | 断らない（公開商品かどうかだけ見る） |
| カートの数量変更 | 在庫を超えると 409              | 断らない（同上）                     |
| 注文確定         | 在庫不足で `INSUFFICIENT_STOCK` | 断らない。引き当ては台帳だけ         |
| 未入金の取り消し | 商品行の在庫を戻す              | 台帳へ `cancel` を追記するだけ       |
| バリアント生成   | 旧在庫を台帳へ移す              | 移さない（在庫は台帳でだけ動く）     |

数量の上限はアプリ側（`MAX_CART_ITEM_QUANTITY`）とゲスト用関数の 1..20 で担保する。

**列を落とす前に関数を作り直す。** plpgsql の本体は依存関係として追跡されないため、参照が残っていても `DROP COLUMN` は成功し、実行時に初めて壊れる。同じマイグレーション（トランザクション）の中で、作り直し → 削除の順に並べる。
