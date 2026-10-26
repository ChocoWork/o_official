# ADR-0026 管理のニュースの書き込みは、認可の後に service role で行う

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` | 基準コミット: `85571ab8`

## 概要

管理のニュースの窓口の書き込み（POST・PUT・PATCH・DELETE）は、`authorizeAdminPermission` を通した後に service role の client で行う。読み（GET）は今までどおり利用者の JWT の client で RLS に通す。ADR-0005 のうち書き込みの部分をこの判断が置き換える。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-002、SEC-NEWS-015、SEC-NEWS-022 |
| 対象のコード | `src/app/api/admin/news/route.ts`（POST）、`src/app/api/admin/news/[id]/route.ts`（PUT・PATCH・DELETE） |
| 関連文書 | `docs/03_BasicDesign/decisions/ADR-0005-admin-db-user-session-client.md`、`docs/03_BasicDesign/decisions/ADR-0451-admin-misc-service-role-after-authorization.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/NEWS.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合テストを流して確かめた。本物の DB への書き込みは流していない） |

## 判断

### ADR-0026 管理のニュースの書き込みは、認可の後に service role で行う

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-002、SEC-NEWS-015、SEC-NEWS-022 |
| 根拠 | 管理だけが書く表から anon・authenticated の書き込みの権限を外す（SEC-NEWS-022、後続の移行）と、利用者の JWT で書く窓口は全部 42501 で止まる。窓口が先に権限・aal2・session の生存を確かめている（SEC-NEWS-015）ので、書き込みの client を service role にそろえても、守りが窓口の1段になるだけで弱くならない。DB に直接 aal1 の JWT で書ける道（SEC-NEWS-002 の AC-02）は、権限そのものを外して塞ぐ |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（2026-10-26）、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の P2 |

#### 背景

- ADR-0005 は、窓口の確かめが崩れても DB の RLS が権限の無い書き込みを断るよう、表の読み書きを利用者の JWT の client で行うと決めた
- RLS の判定（`has_permission`）は ACL だけを見て aal2 と session の生存を見ないので、DB の段の守りは窓口より弱い。しかも anon・authenticated に表の全権限が付いたままで、権限を持つ人の aal1 の JWT で PostgREST を直接叩くと書き換えができる（SEC-NEWS-002、SEC-NEWS-022）
- 同じ管理の窓口でも `looks`・`look_items`・`item_color_presets` は、認可の後に service role で書いている（ADR-0451 と同じ形）。ニュースの窓口だけが利用者の JWT で書いていた

#### 決定

- POST・PUT・PATCH・DELETE は、`authorizeAdminPermission('admin.news.manage', request)` を通した後、本文と入力の検証を終えてから `createServiceRoleClient()` を1回だけ作り、表の書き込みと置き場の書き込み・後始末の削除に同じ client を使う（以前は表が利用者の JWT、置き場が service role の2つだった）
- GET（一覧・1件）は変えない。表は `createClient(request)` で RLS に通し、置き場の署名だけ service role を使う
- 応答の形・監査・404（変えた行が 0 行）・500 の意味は変えない
- RLS の書き込み方針（`admin.news.manage` の insert・update・delete）は消さずに残す。権限を外した後は働かない二重の守りで、権限を戻す時の保険になる

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 利用者の JWT の client で書き続け、authenticated の書き込み権限だけ付け直す | 権限を持つ人の aal1 の JWT で、窓口の回数の制限・CSRF・監査・aal2 を通らずに書ける道（SEC-NEWS-002 の AC-02）が残る |
| 書き込みの関数（SECURITY DEFINER）を作って利用者の JWT で呼ぶ | 窓口の数だけ関数と権限の管理が増え、他の管理の窓口（ADR-0451）の形と揃わない |

#### 結果

- 良くなること: 表の書き込みから anon・authenticated の権限を外せる（後続の移行）。表と置き場の書き込みの client が1つにそろう
- 悪くなること: 窓口の認可が書き込みの唯一の守りになる。`authorizeAdminPermission` の位置（本文の検証より前）を変えない。権限の無い人・aal2 でない人・session が失効した人は、必ず表より前に 401・403・503 で止まる
- 変わる挙動: 変えた行が 0 行になるのは「その id の記事が無い」場合だけになる（以前は RLS が隠した行も 0 行になり、403 でなく 404 になった）
- 波 5 で `has_permission` に aal2 を入れても、効くのは読みの方針（GET と DB の直接の読み）だけで、書き込みの窓口の守りは変わらない
- ADR-0005 は読みの判断として現行のまま残す

## 未確認事項

- 本物の Supabase への書き込みは流していない（結合テストは Supabase の client を差し替えて確かめた）。DB の確かめは後続の移行を当てた後の DB 結合テストで行う
