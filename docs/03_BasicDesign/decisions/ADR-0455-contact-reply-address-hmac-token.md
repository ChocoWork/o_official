# ADR-0455 問い合わせの返信の宛先はスレッドごとの HMAC の印で結び、設定が無ければ Reply-To を付けずに送る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/lib/contact/reply-address.ts`、`src/app/api/admin/contact/[id]/reply/route.ts` | 基準コミット: `4facf63b`

## 概要

管理の返信のメールの Reply-To は `reply+{問い合わせの id}.{印}@{受信のドメイン}` の形にし、印は秘密の鍵で問い合わせの id から作る HMAC-SHA256 の先頭 16 字にする。受け取った宛先は、印を作り直して一定の時間で比べる。受信のドメインか秘密の鍵の設定が無い時は、Reply-To を付けずにメールを送る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | SEC-ADMIN-017、FREQ-24-REQ-01（範囲外）、FR-CONTACT-013（範囲外）、FREQ-25-REQ-01 |
| 対象のコード | `src/lib/contact/reply-address.ts`、`src/app/api/admin/contact/[id]/reply/route.ts` |
| 使う側（範囲外） | 公開の問い合わせの送信と受信の取り込み（`src/app/api/contact/`） |
| 関連文書 | `docs/superpowers/plans/legacy-contact-feature-remaining-tasks.md`、`docs/02_Requirements/requirements.md`（FR-CONTACT-013） |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0455 問い合わせの返信の宛先はスレッドごとの HMAC の印で結び、設定が無ければ Reply-To を付けずに送る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ADMIN-017、FREQ-24-REQ-01（範囲外）、FR-CONTACT-013（範囲外）、FREQ-25-REQ-01 |
| 根拠 | お客様がメールで返信すると、そのままスレッドに取り込みたい。宛先に問い合わせの id だけを入れると、id を知るか当てた第三者が他人のスレッドに書き込める。秘密の鍵の印を添えれば宛先を推測できなくなる。受信の設定が整う前でも、返信のメールそのものは送れるようにする |
| 状態 | 推定 |
| 出どころ | `src/lib/contact/reply-address.ts` のコメント、`docs/superpowers/plans/legacy-contact-feature-remaining-tasks.md`、git `ea1c0f2a`（2026-07-05） |

#### 背景

- 受信のメールの取り込みは、本番の宛先が要るので開店の準備まで止まっている（`legacy-contact-feature-remaining-tasks.md`）
- 返信のメールは、受信の設定が無くても送れる必要がある

#### 決定

- 宛先の形は `reply+{id}.{印}@{CONTACT_INBOUND_DOMAIN}`。印は `CONTACT_REPLY_SECRET` を鍵にした id の HMAC-SHA256 を base64url にした先頭 16 字（`reply-address.ts`）
- 受け取った宛先は、id が UUID の形か、印が合うかを、長さを比べてから一定の時間の比較で確かめる
- 受信のドメインか秘密の鍵が無ければ宛先を作らず、呼ぶ側は Reply-To を付けずに送る（`reply/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 宛先に問い合わせの id だけを入れる | id を知る・当てるだけで他人のスレッドに書き込める（`reply-address.ts`） |
| 印を DB に持ち、宛先ごとに引く | 推定。秘密の鍵から作り直せるので表が要らない（判断の記録は無い） |
| 設定が無い時は返信のメールを送らない | 受信の設定が整うまで、管理の返信のメールが届かなくなる（`legacy-contact-feature-remaining-tasks.md`） |

#### 結果

- 良くなること: 宛先から他人のスレッドを推測できない。受信の設定が無くても返信のメールは届く
- 悪くなること: 印は 16 字で、秘密の鍵を変えると古い宛先への返信は全部取り込めなくなる。印に期限は無い
- 見直す条件: 秘密の鍵を入れ替える時、受信の取り込みを本番で有効にする時（開店の準備）

## 未確認事項

- 本番の `CONTACT_INBOUND_DOMAIN`・`CONTACT_REPLY_SECRET` の設定（本番アプリは未デプロイ）
- 印の長さ 16 字を選んだ記録
