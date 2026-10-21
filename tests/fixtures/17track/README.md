# 17TRACK v2.4 の共通の見本

## 概要

2026-10-21 の説明書 v2.4 からの写し。本物の返事・署名の鍵・課金・retrack は未確認

[設計書の付録](../../../docs/superpowers/specs/2026-10-21-delivery-status-design.md#付録-17track-のやり取りの形2026-10-21-に説明書から写した本物では未確認)に記載された形を、作り物の番号・文・場所で表した共通の見本です。実際のHTTP応答を採取したものではありません。

## 使い方

`v2.4.json` の `contract` は `17track-v2.4`。`responses` は登録・失敗・配送状況の12例、`webhooks` は更新・停止の2例です。単体試験と後続のE2E用fakeが同じファイルを読みます。

`description`・`location`・`sub_status_descr`・`tracking.providers[].events[]`・Webhookの `param`・`tag`・`track_info` は捨てるための試験用データです。時刻はoffset付きの `time_iso` を優先し、`time_utc` はUTCとして読みます。

署名試験には作り物の鍵だけを使います。本物の鍵・署名・本文・個人情報をこのフォルダに加えないでください。大文字・小文字だけを直してretrackした際の `-18019904` も、追跡中の登録成功として扱います。
