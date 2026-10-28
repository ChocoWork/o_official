# ADR-0268 認可で断った取扱店の要求は、操作者が分かる物だけ監査に残し、操作者ごとに 10 分 20 行で止める

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/lib/auth/admin-rbac.ts`、`src/lib/auth/audit-authz-denial.ts`、`src/lib/audit.ts`、`src/app/api/admin/stockists/` | 基準コミット: `ea393ce4`

## 概要

管理の取扱店の窓口が認可で断った要求のうち、断られた人が分かる物（権限不足の 403・aal1 の 403・失効した session の 401）を、監査の記録に失敗の 1 行として残す。同じ操作者は 600 秒に 20 行まで、21 回目にまとめの 1 行、以降は書かない。token の無い 401・失効を確認できない 503・内部の誤りの 500 は残さない。2026-10-28（波 4）に決めた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-021 |
| 対象のコード | `src/lib/auth/admin-rbac.ts`（`denial`）、`src/lib/auth/audit-authz-denial.ts`（`auditAuthzDenial`）、`src/lib/audit.ts`（`maskAuditEvent` の制御文字の除去）、`src/app/api/admin/stockists/route.ts`・`[id]/route.ts`・`access/route.ts` |
| 関連文書 | `docs/superpowers/plans/2026-10-28-wave4-client-ip-audit-admin-ui.md`（Task 7・8）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md`（Q22、controller の裁定） |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-28 の作業ツリー |

## 判断

### ADR-0268 認可で断った取扱店の要求は、操作者が分かる物だけ監査に残し、操作者ごとに 10 分 20 行で止める

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-021 |
| 根拠 | 権限の無い人や aal1 の session による管理の窓口の探りを、後から追えるようにするため。全拒否を自動で監査に残す案は、未ログインの連打で監査の表が洪水になるので採らない（設計 R11-4）。全体の NFR-SEC-005・011（監査ログ）を認可の失敗に当てはめた |
| 状態 | 現行 |
| 出どころ | 波 4 の決定（Q22 を推奨で進める）、controller の裁定（計画の裁定 6） |

#### 背景

- 認可で断った時は `console.warn` を出すだけで、監査の記録を書かなかった（THR-STOCKIST-021）
- 共有の `authorizeAdminPermission` の結果は `ok` しか窓口に渡さず、拒否の理由と操作者が分からなかった

#### 決定

- `admin-rbac.ts` は、操作者が分かる 3 つの拒否に限り、結果に任意の `denial`（操作者の id・メール・役割・要った権限・理由 `permission`・`mfa`・`session`）を付ける。token の無い 401・失効を確認できない 503・内部の誤りの 500 には付けない
- 取扱店の窓口は、認可の拒否の枝で `auditAuthzDenial(authz, { request, action, resource: 'stockists' })` を呼んでから応答を返す。`denial` が無ければ部品の中で何もしない
- 洪水の防止は操作者ごと。操作者の id を subject に 600 秒の区切りで数え、20 以下なら失敗の 1 行（`detail` は `Forbidden: <権限> (<理由>)`、`metadata` は権限・理由・役割）、21 なら `denied_burst` のまとめの 1 行、22 以上と数えの失敗は何も書かない
- `maskAuditEvent` が `detail` と `metadata` の文字列の制御文字（Cc・Cf）を空白に替える（記録の行を読み違えさせないため）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 全部の拒否（token の無い 401 を含む）を監査に残す | 操作者が分からない要求は何度でも送れ、監査の表が洪水になる。送り元の枠で量を抑える（ADR-0259）ほうが筋 |
| 全体で 10 分に N 行までの上限（設計の元の案） | ある操作者が自分で断られ続けるだけで、他の人の拒否の記録が 10 分消える。攻撃者が自分の拒否で他人の跡を消せる。E2E の「新しい利用者の拒否で行がちょうど 1 つ増える」も、他の試験の拒否の数に左右される |
| 窓口ごとに監査の呼び出しを書く | 6 つの窓口と `access` で書き方が揃わない。共有の部品にまとめる |
| 数えに失敗したら書く（開く側に倒す） | 監査の補助のために窓口の応答を変えたくないので、記録を諦める側に倒す |

#### 結果

- 良くなること: 操作者が分かる拒否は、後から監査で追える。別の操作者の拒否の記録は影響を受けない
- 悪くなること: 操作者が分からない探りは監査に残らない（送り元の枠とサーバーの記録に頼る）。`detail` の権限の符号は、`maskAuditEvent` が `a.b.c` の形を JWT と見て `[REDACTED_JWT]` に伏せるので読めず、権限の符号は `metadata.permission` で見る。取扱店の窓口以外の管理の窓口は、この部品をまだ呼んでいない
- 保存期間は法令対応の後回しに従う

## 未確認事項

- 他の管理の窓口（ADMIN など）にも同じ部品を広げるか
- `detail` が JWT 風の伏せ字になるのを直すか（権限の符号の書き方を変える）
