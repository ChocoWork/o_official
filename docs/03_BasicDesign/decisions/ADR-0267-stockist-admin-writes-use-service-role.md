# ADR-0267 管理の取扱店の書き込みは、認可の後に service role で行う

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` | 基準コミット: `85571ab8`

## 概要

管理の取扱店の窓口の書き込み（POST・PUT・PATCH・DELETE）は、`authorizeAdminPermission`・回数の制限・CSRF の確かめを通した後に service role の client で行う。読み（GET の2つ）は今までどおり利用者の JWT の client で RLS に通す。ADR-0258 のうち書き込みの部分をこの判断が置き換える。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-003、SEC-STOCKIST-006、SEC-STOCKIST-008 |
| 対象のコード | `src/app/api/admin/stockists/route.ts`（POST）、`src/app/api/admin/stockists/[id]/route.ts`（PUT・PATCH・DELETE） |
| 関連文書 | `docs/03_BasicDesign/decisions/ADR-0258-stockist-admin-db-user-session-client.md`、`docs/03_BasicDesign/decisions/ADR-0451-admin-misc-service-role-after-authorization.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/STOCKIST.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合テストを流して確かめた。本物の DB への書き込みは流していない） |

## 判断

### ADR-0267 管理の取扱店の書き込みは、認可の後に service role で行う

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-003、SEC-STOCKIST-006、SEC-STOCKIST-008 |
| 根拠 | 管理だけが書く表から anon・authenticated の書き込みの権限を外す（SEC-STOCKIST-003 の AC-02・AC-03、SEC-STOCKIST-008、後続の移行）と、利用者の JWT で書く窓口は全部 42501 で止まる。窓口が先に権限・aal2・session の生存・回数の制限・CSRF を確かめている（SEC-STOCKIST-006）ので、書き込みの client を service role にそろえても、守りが窓口の1段になるだけで弱くならない。DB に直接 aal1 の JWT で書ける道は、権限そのものを外して塞ぐ |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（2026-10-26）、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の P2 |

#### 背景

- ADR-0258 は、窓口の認可に欠陥が入っても DB の RLS で拒めるよう、6つの窓口を利用者の JWT の client で動かすと決めた
- RLS の判定（`has_permission`）は ACL だけを見て aal2 と session の生存を見ず、anon・authenticated に表の全権限が付いたままで、権限を持つ人の aal1 の JWT で PostgREST を直接叩くと、窓口の回数の制限・CSRF・監査・aal2 を通らずに書ける（SEC-STOCKIST-003 を満たさない）
- 同じ管理の窓口でも `looks`・`look_items`・`item_color_presets` は、認可の後に service role で書いている（ADR-0451 と同じ形）。取扱店の窓口だけが利用者の JWT で書いていた

#### 決定

- POST・PUT・PATCH・DELETE は、認可（`admin.stockists.manage`）・変更の枠の回数の制限・CSRF の token の確かめ・本文の検証を終えた後で `createServiceRoleClient()` を1回だけ作り、表の書き込みに使う
- GET（一覧・1件）は変えない。`createClient(request)` で RLS に通す
- 応答の形・監査・404（変えた行が 0 行）・500 の意味は変えない
- RLS の書き込み方針（`admin.stockists.manage` の insert・update・delete）は消さずに残す。権限を外した後は働かない二重の守りで、権限を戻す時の保険になる

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 利用者の JWT の client で書き続け、authenticated の書き込み権限だけ付け直す | 権限を持つ人の aal1 の JWT で、窓口の回数の制限・CSRF・監査・aal2 を通らずに書ける道が残る |
| 書き込みの関数（SECURITY DEFINER）を作って利用者の JWT で呼ぶ | 窓口の数だけ関数と権限の管理が増え、他の管理の窓口（ADR-0451）の形と揃わない |

#### 結果

- 良くなること: 表の書き込みから anon・authenticated の権限を外せる（後続の移行）。管理の書き込みの client が他の領域とそろう
- 悪くなること: 窓口の認可が書き込みの唯一の守りになる。`authorizeAdminPermission` の位置（本文の検証より前）を変えない。権限の無い人・aal2 でない人・session が失効した人は、必ず表より前に 401・403・503 で止まる
- 変わる挙動: 変えた行が 0 行になるのは「その id の店が無い」場合だけになる（以前は RLS が隠した行も 0 行になり、aal2 でない session の書き込みは 403 でなく 404 になりえた）
- 波 5 で `has_permission` に aal2 を入れても、効くのは読みの方針（GET と DB の直接の読み）だけで、書き込みの窓口の守りは変わらない
- ADR-0258 は読みの判断として現行のまま残す

## 未確認事項

- 本物の Supabase への書き込みは流していない（結合テストは Supabase の client を差し替えて確かめた）。DB の確かめは後続の移行を当てた後の DB 結合テストで行う
