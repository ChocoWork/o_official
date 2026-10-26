# ADR-0354 `/privacy` の誤りの画面は案内だけを出し、方針の本文も誤りの文も出さない

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/privacy/error.tsx` | 基準コミット: `16df4479`

## 概要

追跡の設定を読めず `/privacy` の描画が失敗した時の受け皿として、`src/app/privacy/error.tsx` を足す。窓口の案内（時間を置いて開き直す、メール、お問い合わせフォーム）だけを出し、方針の本文・委託の一覧・誤りの文は出さない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 対応する ID | SEC-PRIVACY-005、SEC-PRIVACY-008、SEC-PRIVACY-009、THR-PRIVACY-004 |
| 対象のコード | `src/app/privacy/error.tsx` |
| 関連文書 | [PRIVACY の要件](../../02_Requirements/areas/privacy.md)、[ADR-0350](ADR-0350-privacy-request-time-render-fail-closed.md) |
| 試験 | `tests/unit/app/privacy/privacy-error.test.tsx`、`e2e/FR-PRIVACY-009-tracking-setting-read-failure.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/privacy.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体のテストを流した。E2E は流していない。HTTP 状態は未実測） |

## 判断

### ADR-0354 `/privacy` の誤りの画面は案内だけを出し、方針の本文も誤りの文も出さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-005、SEC-PRIVACY-008、SEC-PRIVACY-009 |
| 根拠 | 設定を読めない時に一文を黙って出し分けると、誤った方針を公表し続ける（ADR-0350）。一方、頁が全く読めないと本人が窓口へ辿り着けない（SEC-PRIVACY-009）。向きが逆の二つを、方針の本文は出さずに窓口の案内だけを出すことで両立させる |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`（R18） |

#### 背景

- 設定を読めないと頁は例外で終わり、`error.tsx` が無いので既定の誤りの頁になっていた。窓口の案内は何も出なかった
- 同梱の Next.js の文書によれば、HTTP 状態が 200 に決まるのは Suspense の代わりの表示（`loading.tsx` など）が出て流し始めた後。この頁には `loading.tsx` も `<Suspense>` も無いので、誤りの画面を足しても 500 のままの見込み（未実測）

#### 決定

- `src/app/privacy/error.tsx`（Client Component）を足す。props は `error` と `retry`（`src/app/checkout/error.tsx` と同じ）
- 出すのは、h1「プライバシーポリシーを表示できません」（「Privacy Policy」を含めない）、時間を置いて試す案内、`privacy@lefildesheures.com`、`/contact` へのお問い合わせフォームのリンク、`retry` を呼ぶボタンだけ
- 方針の本文・委託の一覧・17TRACK の字・`error.message`・`stack` は画面にも記録にも出さない。記録は `{ digest }` だけ
- `loading.tsx` と頁の中の `<Suspense>` は足さない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 設定を読めない時に、一文を足さない方針の本文を出す | 追跡がオンなのに 17TRACK の一文が抜けた方針を公表しうる。ADR-0350 と食い違う |
| 既定の誤りの頁のままにする | 窓口の案内が何も出ない |
| `loading.tsx` を足して案内を先に出す | 流し始めた後の誤りになり、HTTP 状態が 200 になりうる。誤りの画面の確かめも崩れる |

#### 結果

- 良くなること: 設定を読めない間も、本人が窓口へ辿り着ける。誤りの文が画面に出ない
- 悪くなること: 誤りの画面を足しても HTTP 状態が 500 のままかは未実測。ずれたら E2E `FR-PRIVACY-005-AC-01`・`008-AC-01`・`009-AC-01` の期待と、この文書を直す
- 見直す条件: 公表の方針の本文を別の道で常に出せるようにする時

## 未確認事項

- 誤りの画面の HTTP 状態が 500 のままか（E2E で確かめる）
- 本番で、誤りの画面が中の事情を伏せるか
