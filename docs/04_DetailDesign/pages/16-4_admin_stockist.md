# 1.16-4 管理画面の取扱店（ADMIN STOCKIST）詳細設計

> 状態: 推定 | 確認日: 2026-10-24 | 対象: 管理画面の STOCKIST タブの一覧、取扱店の作成と編集の画面、管理の取扱店の窓口、窓口の守りの部品（回数の制限・CSRF の token） | 基準コミット: `4facf63b`

## 概要

管理画面で取扱店を一覧・作成・編集・公開の切り替え・削除する部品と窓口、窓口が使う回数の制限と CSRF の token の確かめの部品を、詳細設計の項目（`DD-STOCKIST-030`〜`038`）で書く。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので全部「推定」にした。文書・要件とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節（TM-STOCKIST-NN）に載せた。

| ID | 題 | 単位 |
| --- | --- | --- |
| `DD-STOCKIST-030` | 管理の STOCKIST タブの一覧・公開の切り替え・削除 | `src/components/StockistSection.tsx` |
| `DD-STOCKIST-031` | 取扱店の作成・編集のフォーム | `src/app/admin/stockist/StockistForm.tsx` |
| `DD-STOCKIST-032` | 取扱店の作成のページ | `src/app/admin/stockist/create/page.tsx` |
| `DD-STOCKIST-033` | 取扱店の編集のページ | `src/app/admin/stockist/edit/[id]/page.tsx` |
| `DD-STOCKIST-034` | 管理の取扱店の一覧と作成の窓口 | `src/app/api/admin/stockists/route.ts` |
| `DD-STOCKIST-035` | 管理の取扱店1件の読み・更新・切り替え・削除の窓口 | `src/app/api/admin/stockists/[id]/route.ts` |
| `DD-STOCKIST-036` | CSRF の token の確かめと拒否の応答への変換 | `admin-security.ts` の `hasRotatedCsrfToken`・`requireAdminStockistCsrf`・`toCsrfDenyResponse` |
| `DD-STOCKIST-037` | 回した CSRF の token を Cookie に付け直す | `admin-security.ts` の `applyRotatedCsrfCookie` |
| `DD-STOCKIST-038` | 読みと変更の回数の制限（送り元と操作者の2本） | `admin-security.ts` の `enforceAdminStockistReadRateLimit`・`enforceAdminStockistMutationRateLimit` |

- 結論: 管理の画面は全部が利用者の端末で動く部品で、画面では権限を確かめない。守りは窓口（`DD-STOCKIST-034`・`035`）の `authorizeAdminPermission`（token・session・DB の ACL の権限・aal2）、回数の制限（`038`）、変更の CSRF の token（`036`）、共有の proxy の Origin の確かめと、利用者の JWT で通す DB の RLS に置く
- 作成の窓口は DB の必須の列 `type` を入れないので、表が今の写しの形なら作成はいつも 500 になる（推定）。存在しない店への PUT・PATCH・DELETE は 200 の成功として監査に残る
- 単体テストは窓口の守りの順を試す1本（`tests/unit/api/admin/stockists-security.test.ts`）だけ。分岐を全部通すのに要るテストを各項目の「テスト観点」に挙げた
- 番号は `DD-STOCKIST-030`〜`059` をこの頁で使う。今は `030`〜`038` を使い、`039` 以降は空けておく

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST のうち、管理の側の単位 |
| 上位の文書 | [STOCKIST の構造設計](../../03_BasicDesign/areas/stockist.md)（`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`API-`・`DATA-STOCKIST-`）、[STOCKIST の要件](../../02_Requirements/areas/stockist.md)（`FR-ADMIN-006`・`SEC-STOCKIST-`・`DRV-STOCKIST-`） |
| 対象のコード | 「実装の単位」の表の12単位 |
| 単位の無いファイル | `src/app/admin/stockist/types.ts`（型だけ） |
| 引き継いだ文書 | [1.16 管理画面（ADMIN）詳細設計](16_admin.md) の `IMPL-ADMIN-006`（機能要件対応表の FR-ADMIN-006 の行）と `IMPL-ADMIN-STOCKIST-01`（実装タスク管理の ADMIN-01-005 の行）。元の文書は別の作業が書き換え中なので変えていない |
| 関連文書 | [1.10 商品扱い店舗ページ](10_stockist.md)、`docs/03_BasicDesign/api/api-spec.md`（読むだけ） |
| 調べた時点 | 2026-10-24 の作業ツリー。コードは読んだだけで、動かしての確かめはしていない |

範囲外の共有部品は ID を持たないので、上位に書かず本文にファイルの道で書く。

| 共有部品 | 道 | ここでの使われ方 |
| --- | --- | --- |
| 管理の認可 | `src/lib/auth/admin-rbac.ts` の `authorizeAdminPermission` | 窓口ごとに token・session・DB の ACL の権限・aal2 を確かめる |
| CSRF の token の確かめ | `src/lib/csrfMiddleware.ts` の `requireCsrfOrDeny` | 変更の窓口で `x-csrf-token` を session の印と比べる |
| Origin の確かめ | `src/proxy.ts` | `/api` の変更の要求の Origin・Referer を窓口の前で照合する（ARC-STOCKIST-004） |
| 回数の制限 | `src/features/auth/middleware/rateLimit.ts` の `enforceRateLimit` | 送り元と操作者の数え。超えると 429、数えの DB が使えないと 503 |
| CSRF の Cookie | `src/lib/cookie.ts` の `csrfCookieName`・`cookieOptionsForCsrf` | 回した token を付け直す時の Cookie の名前と設定 |
| 監査 | `src/lib/audit.ts` の `logAudit` | 変更の成功・入力の誤り・DB の誤りを `audit_logs` に残す |
| Supabase の client | `src/lib/supabase/server.ts` の `createClient(request)` | 要求の JWT を付けた client で表を扱う |
| 書き換えの送り方 | `src/lib/client-fetch.ts` の `clientFetch` | 画面から窓口へ送る。変更に `x-csrf-token` を付ける |
| 管理画面の親 | `src/app/admin/page.tsx` | STOCKIST タブの「新規作成」のボタンと、一覧の部品の置き場 |
| 画面の部品 | `src/components/ui/`（`Button`・`Card`・`StatusBadge`・`SingleSelect`・`TextField`） | カード・札・ボタン・フォームの欄 |

```mermaid
graph LR
  AP["/admin の STOCKIST タブ（範囲外）"] --> SS["StockistSection（DD-STOCKIST-030）"]
  AP -->|新規作成| CP["create/page.tsx（DD-STOCKIST-032）"]
  SS -->|編集| EP["edit/[id]/page.tsx（DD-STOCKIST-033）"]
  CP --> SF["StockistForm（DD-STOCKIST-031）"]
  EP --> SF
  SS -->|GET・PATCH| R2["[id]/route.ts（DD-STOCKIST-035）"]
  SS -->|GET 一覧| R1["route.ts（DD-STOCKIST-034）"]
  SF -->|POST| R1
  SF -->|PUT| R2
  EP -->|GET 1件| R2
  R1 --> SEC["admin-security.ts（DD-STOCKIST-036〜038）"]
  R2 --> SEC
  R1 --> DB[("stockists<br/>RLS")]
  R2 --> DB
```

矢印は呼び出しと移り先。画面から窓口への矢印は全部 `clientFetch` を通り、変更の要求は窓口に届く前に共有の proxy が Origin を確かめる（図には入れていない）。監査の `audit_logs` への矢印も省いた。

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits`（2026-10-24 に実行）で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/components/StockistSection.tsx` | `<file>` | DD-STOCKIST-030 |
| `src/app/admin/stockist/StockistForm.tsx` | `<file>` | DD-STOCKIST-031 |
| `src/app/admin/stockist/create/page.tsx` | `<file>` | DD-STOCKIST-032 |
| `src/app/admin/stockist/edit/[id]/page.tsx` | `<file>` | DD-STOCKIST-033 |
| `src/app/api/admin/stockists/route.ts` | `<file>` | DD-STOCKIST-034 |
| `src/app/api/admin/stockists/[id]/route.ts` | `<file>` | DD-STOCKIST-035 |
| `src/features/stockist/services/admin-security.ts` | `hasRotatedCsrfToken` | DD-STOCKIST-036 |
| `src/features/stockist/services/admin-security.ts` | `requireAdminStockistCsrf` | DD-STOCKIST-036 |
| `src/features/stockist/services/admin-security.ts` | `toCsrfDenyResponse` | DD-STOCKIST-036 |
| `src/features/stockist/services/admin-security.ts` | `applyRotatedCsrfCookie` | DD-STOCKIST-037 |
| `src/features/stockist/services/admin-security.ts` | `enforceAdminStockistReadRateLimit` | DD-STOCKIST-038 |
| `src/features/stockist/services/admin-security.ts` | `enforceAdminStockistMutationRateLimit` | DD-STOCKIST-038 |

- 窓口のファイルは、中の方法（GET・POST など）が別々の契約でも、単位がファイルなので1つの `DD-` にまとめた。項目の本文で方法ごとに分けて書く
- 単位にならない物: `src/app/admin/stockist/types.ts`（型だけ）、`StockistForm.tsx` の `STOCKIST_STATUS_OPTIONS`（ファイルの単位に含む）、`[id]/route.ts` の `parseStockistId`（ファイルの単位に含む）、`admin-security.ts` の export しない `hasMockCsrfBody`（DD-STOCKIST-036 に含める）と `enforceStockistAdminRateLimit`（DD-STOCKIST-038 に含める）
- 公開の側の単位（`src/app/stockist/page.tsx`・`src/features/stockist/components/`・`services/public.ts`・`region.ts`）は [1.10 商品扱い店舗ページ](10_stockist.md) で扱う

## 管理の窓口に共通の動き

`DD-STOCKIST-034`・`035` の全部の方法が `authorizeAdminPermission(<権限>, request)` を呼び、`ok` でなければその応答をそのまま返す。`[id]` の窓口だけは、その前に道の id の形を確かめる（DD-STOCKIST-035）。

| 条件 | 応答 | 出どころ |
| --- | --- | --- |
| token の検証に失敗 | 401 `{error:'Unauthorized'}` | `src/lib/auth/admin-rbac.ts` |
| session の生存を確かめられない | 503 `{error:'Service temporarily unavailable'}`、`Retry-After: 30` | `admin-rbac.ts` |
| session が有効でない | 401 `{error:'Unauthorized'}` | `admin-rbac.ts` |
| DB の ACL に権限が無い | 403 `{error:'Forbidden', permission, role}` | `admin-rbac.ts` |
| `aal` が `aal2` でない | 403 `{error:'Forbidden', reason:'MFA required', permission, role}` | `admin-rbac.ts` |
| 認可の中の例外 | 500 `{error:'Internal server error'}` | `admin-rbac.ts` |

- 権限: 読む方法（GET）は `admin.stockists.read`、変える方法（POST・PUT・PATCH・DELETE）は `admin.stockists.manage`（DATA-STOCKIST-004）
- 順番: 認可 → 回数の制限（読みは読みの枠、変更は変更の枠。DD-STOCKIST-038）→ 変更だけ CSRF の token（DD-STOCKIST-036）→ 入力の確かめ → DB → 監査
- 監査: 変更の方法は `logAudit` を呼ぶ。`resource` は `stockists`、`ip` は見出し `x-forwarded-for` のカンマの前の部分（無ければ `null`）、`user_agent` は見出し `user-agent`（無ければ `null`）。GET は監査しない。送り元を信頼できる値から取ること・値を整えること（SEC-STOCKIST-012）は満たさない
- 送り元の見出しの読み: `x-forwarded-for` があれば分けた最初の切れを前後の空白を除いて使う。分けた結果は必ず1つ以上の切れを持つので、最初の切れが無い時の道は届かない（推定）
- 失敗の記録: DB の `error` と例外を `console.error` にそのまま渡す
- 応答に `Cache-Control` を付けない（SEC-STOCKIST-010 は満たさない）。全部の列を返す（SEC-STOCKIST-009 は満たさない）

## 詳細設計

### DD-STOCKIST-030 管理の STOCKIST タブの一覧・公開の切り替え・削除

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-STOCKIST-004、FLOW-STOCKIST-002、STATE-STOCKIST-001、ARC-STOCKIST-002 |
| 根拠 | 店長が非公開の店も含めた全部の店を状態の札つきで見て、その場で公開の切り替えと削除まで終えられるよう、一覧・切り替え・削除を1つの部品に置く（SCR-STOCKIST-004）。消した店は戻せないので、送る前に確かめの窓を挟む（STATE-STOCKIST-001）。編集は別の頁へ移す（FLOW-STOCKIST-002）。画面は利用者の端末で動くので守りを持たず、変更は窓口に送る（ARC-STOCKIST-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/StockistSection.tsx`）、`docs/04_DetailDesign/pages/16_admin.md` |
| 旧番号 | IMPL-ADMIN-006 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-006 の行（一覧・切り替え・削除の分） |

#### 対応要件

SCR-STOCKIST-004、FLOW-STOCKIST-002、STATE-STOCKIST-001、ARC-STOCKIST-002（その上は FR-ADMIN-006、FREQ-18-REQ-01、DRV-STOCKIST-014）

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | props なし。`GET /api/admin/stockists` の応答 `{data: 店の配列}`（DD-STOCKIST-034） |
| 出力 | 画面。`PATCH /api/admin/stockists/<id>` に JSON `{status}`、`DELETE /api/admin/stockists/<id>`（DD-STOCKIST-035） |

#### 正常フロー

1. 初めは「読み込み中...」を出し、描いた後に `clientFetch('/api/admin/stockists')` で一覧を取る（`StockistSection.tsx`）
2. 1件以上あれば、1列・640px 以上で2列・1280px 以上で3列の格子にカードを並べる。カード: 店舗名の h3、札（`published` は「公開中」の positive、ほかは「非公開」の warning）、区切り線、住所・電話・営業時間・定休日の4行（電話が空でも行を出す）、ボタン（公開中なら「非公開」、ほかは「公開」）・「編集」（`/admin/stockist/edit/<id>`）・「削除」。公開の店は背景を薄い緑にする
3. 切り替え: 今が `published` なら `private`、ほかは `published` を JSON で PATCH し、成功したら一覧を全部読み直す
4. 削除: `confirm('このSTOCKISTを削除してもよろしいですか？')` に同意した時だけ DELETE し、成功したら一覧を読み直す（DRV-STOCKIST-014）

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| 一覧の応答が OK でない | 例外にして catch で記録し、一覧は前のまま（初めは空）。「STOCKISTがありません」を出す（取得の失敗と0件を分けない） |
| 一覧の取り出しで例外（通信・JSON の解析） | 同上 |
| 応答に `data` が無い | 空の配列にする |
| PATCH が OK でない・例外 | 記録して `alert('ステータスの更新に失敗しました')`。読み直さない |
| 削除の確かめで取り消す | 何も送らない |
| DELETE が OK でない・例外 | 記録して `alert('STOCKISTの削除に失敗しました')`。読み直さない |
| 切り替え・削除の後の読み直しに失敗 | 読み直しの catch が握りつぶし、前の一覧のまま残る（変えたのに表示が変わらない、推定）。知らせの窓は出ない |

- 読み直しの間は「読み込み中...」に戻さない（`loading` を真に戻す所が無い）
- 行のアイコンに `aria-hidden` が無い

#### 状態・永続化

部品の state（`stockists`・`loading`）だけを持つ。保存は窓口が行い、部品は先に表示を変えない（成功の後に読み直す）。

#### 認証認可

部品は権限を確かめず、親（`src/app/admin/page.tsx`、範囲外）がタブの中身として描く。窓口が `admin.stockists.read`・`admin.stockists.manage` と aal2 を確かめる。読みの権限だけの人にも切り替えと削除のボタンが出て、押すと窓口の 403 で `alert` になる（推定）。`clientFetch` が変更に `x-csrf-token` を付ける。

#### テスト観点

（`tests/unit/components/stockist-section.test.tsx` の名前を想定。範囲のテストの型 `*stockist*` に合わせる。`clientFetch`・`confirm`・`alert` を差し替える）

- 取り出しの間は「読み込み中...」が出る
- 公開中の店と非公開の店で、札の文字・tone、ボタンの文字（「非公開」「公開」）、背景の class が変わる
- 応答が OK でない時は「STOCKISTがありません」が出て、`console.error` を呼ぶ
- `clientFetch` が例外を投げた時も「STOCKISTがありません」が出る
- 応答に `data` が無い時は「STOCKISTがありません」が出る
- 公開中の店の切り替えで `{status:'private'}`、非公開の店で `{status:'published'}` を PATCH し、成功で一覧を読み直す（`clientFetch` の呼び出しが2回目の GET を含む）
- PATCH が OK でない時と例外の時に「ステータスの更新に失敗しました」の `alert` が出る
- 削除の確かめを取り消すと DELETE を送らない
- 削除に同意すると DELETE を送り、成功で一覧を読み直す
- DELETE が OK でない時と例外の時に「STOCKISTの削除に失敗しました」の `alert` が出る
- 「編集」の行き先が `/admin/stockist/edit/<id>`

### DD-STOCKIST-031 取扱店の作成・編集のフォーム

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-STOCKIST-005、SCR-STOCKIST-006、FLOW-STOCKIST-002、STATE-STOCKIST-001 |
| 根拠 | 作成と編集で同じ欄・同じ確かめを使い、決まりを1つにするため、送り先と方法を受け取る1つのフォームにする（SCR-STOCKIST-005・006）。作ったばかりの店が確かめる前に公開されないよう、状態の初めを非公開にする（STATE-STOCKIST-001）。カードの5つの情報が欠けた店を送らないよう、前後の空白を除いて空の欄があれば送らない（SCR-STOCKIST-005）。保存できたら STOCKIST タブの一覧へ戻して結果を確かめられるようにする（FLOW-STOCKIST-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/stockist/StockistForm.tsx`） |
| 旧番号 | IMPL-ADMIN-STOCKIST-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-005 の行（画面の分） |

#### 対応要件

SCR-STOCKIST-005、SCR-STOCKIST-006、FLOW-STOCKIST-002、STATE-STOCKIST-001（その上は FR-ADMIN-006、DRV-STOCKIST-015、NFR-A11Y-005（範囲外））

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | `submitUrl`、`submitMethod`（`POST` か `PUT`）、`initialValues?`（6つの値）、`isLoading?`（初めは偽） |
| 出力 | 画面（公開状態の選択、店舗名・住所・電話番号・営業時間・定休日の欄、誤りか成功の文、送るボタン）。送り先に JSON `{name, address, phone, time, holiday, status}`。成功で `router.push('/admin?tab=STOCKIST')` |

#### 正常フロー

1. 欄の初めの値は `initialValues` の各値、無ければ空の文字。状態は無ければ `private`
2. `initialValues` が変わった時は、6つの値を全部入れ直す
3. 公開状態は `SingleSelect`（dropdown、ラベル「公開状態」、選択肢は「非公開」「公開」）の `onValueChange` で受ける
4. 送る時: 前の誤りと成功の文を消し、5つの欄の前後の空白を除く。全部が空でなければボタンを「保存中...」にして押せなくし、`clientFetch(submitUrl, {method: submitMethod, …})` で JSON を送る
5. 応答が OK なら、PUT は「STOCKISTを更新しました」、POST は「STOCKISTを保存しました」を出し、`/admin?tab=STOCKIST` へ移る
6. 終わったら、成功でも失敗でもボタンを戻す

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| 5つの欄のどれかが空か空白だけ | 「必須項目を入力してください」を出して送らない |
| 応答が OK でなく、本文に `error` がある | その文を赤で出す。移らない |
| 応答が OK でなく、本文が JSON でない・`error` が無い | 「STOCKISTの保存に失敗しました」 |
| 応答が OK で本文が JSON でない | 本文を読めなくても成功として扱う |
| 送る時の例外（通信の失敗） | 記録して「通信エラーが発生しました。時間をおいて再度お試しください」 |
| `isLoading` が真 | フォームの代わりに「読み込み中...」 |

- `isLoading` を渡す呼び元は無い（`create/page.tsx`、`edit/[id]/page.tsx`）ので、「読み込み中...」の道は今の画面からは通らない（推定）
- 種別（`type`）の欄は無い。画面の確かめは空かどうかだけで、長さの上限は窓口が見る
- キャンセル・戻るのボタンは無い

#### 状態・永続化

部品の state（6つの欄・`isSubmitting`・`submitError`・`submitSuccess`）だけを持つ。保存は窓口が行う。

#### 認証認可

部品は権限を確かめない。窓口（DD-STOCKIST-034・035）が `admin.stockists.manage` と aal2 を確かめ、`clientFetch` が `x-csrf-token` を付ける。誤りの文は窓口の `error` をそのまま出す（React の文字として出す）。

#### テスト観点

（`tests/unit/app/admin/stockist-form.test.tsx` の名前を想定。`next/navigation` の `useRouter` と `clientFetch` を差し替える）

- `initialValues` なしで、欄が空、公開状態が「非公開」、ボタンが「保存」
- `initialValues` ありで、6つの値が欄に入り、`submitMethod="PUT"` のボタンが「更新」
- 描いた後に `initialValues` を変えると欄が入れ替わる
- 公開状態を「公開」に変えて送ると、本文の `status` が `published`
- 5つの欄のそれぞれを空白だけにした時に「必須項目を入力してください」が出て、`clientFetch` を呼ばない（各欄で1つずつ）
- 送る本文が前後の空白を除いた値で、方法が `submitMethod`、見出しに `Content-Type: application/json`
- 送る間はボタンが「保存中...」で押せない
- POST の成功で「STOCKISTを保存しました」、PUT の成功で「STOCKISTを更新しました」、どちらも `push('/admin?tab=STOCKIST')`
- 応答が OK でなく `{error:'X'}` の時に `X`、本文が JSON でない時に「STOCKISTの保存に失敗しました」
- 応答が OK で本文が JSON でない時も成功の文と移動
- `clientFetch` が例外を投げた時に通信の誤りの文、ボタンが戻る
- `isLoading` を真で渡すと「読み込み中...」だけが出る

### DD-STOCKIST-032 取扱店の作成のページ

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-STOCKIST-005、FLOW-STOCKIST-002 |
| 根拠 | 作成は一覧とは別の頁にし、共通のフォームに作成の窓口と POST を渡すだけにして、作成と編集の決まりを1つにする（SCR-STOCKIST-005）。管理のタブの「新規作成」から入る（FLOW-STOCKIST-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/stockist/create/page.tsx`） |
| 旧番号 | IMPL-ADMIN-STOCKIST-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-005 の行（作成の頁の分） |

#### 対応要件

SCR-STOCKIST-005、FLOW-STOCKIST-002（その上は FR-ADMIN-006）

#### 入出力・フロー

入力なし。`StockistForm` に `submitUrl="/api/admin/stockists"`・`submitMethod="POST"` を渡して返す（`create/page.tsx`）。分岐は無い。

#### 状態・永続化

持たない。

#### 認証認可

頁の入口で権限を確かめない。殻は誰でも開け、送った時に窓口が断る（SEC-STOCKIST-019 は満たさないので上位にしない）。頁は `'use client'` で、サーバーの守りを置けない形。

#### テスト観点

（`StockistForm` を差し替える）

- フォームが `submitUrl="/api/admin/stockists"`・`submitMethod="POST"`・`initialValues` なしで描かれる

### DD-STOCKIST-033 取扱店の編集のページ

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-STOCKIST-006、FLOW-STOCKIST-002 |
| 根拠 | 作成と同じフォームを、今の値を入れた状態で開けるよう、URL の id で1件を取ってからフォームを描く（SCR-STOCKIST-006）。取れない時は同じ頁に誤りの文を出して留まる（FLOW-STOCKIST-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/stockist/edit/[id]/page.tsx`） |
| 旧番号 | IMPL-ADMIN-STOCKIST-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-005 の行（編集の頁の分） |

#### 対応要件

SCR-STOCKIST-006、FLOW-STOCKIST-002（その上は FR-ADMIN-006）

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | `useParams` の `id`。`GET /api/admin/stockists/<id>` の応答 `{data}`（DD-STOCKIST-035） |
| 出力 | 「読み込み中...」、誤りの文、または `StockistForm`（`submitUrl` は `/api/admin/stockists/<id>`、`submitMethod="PUT"`、`initialValues` は取れた6つの値） |

#### 正常フロー

1. 描いた後、`id` があれば `clientFetch('/api/admin/stockists/<id>')` で1件を取る
2. 応答が OK で `data` があれば、店舗名・住所・電話・営業時間・定休日・状態の6つを初めの値にする
3. 終わったら読み込み中を外し、フォームを描く

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| `useParams` が `null`・`id` が無い | 「STOCKIST IDの取得に失敗しました」を出す。取り出さない |
| 応答が OK でなく、本文に `error` がある | その文を赤で出す（例: 404 の `Stockist not found`、403 の `Forbidden`） |
| 応答が OK でなく、本文が JSON でない・`error` が無い | 「STOCKISTの取得に失敗しました」 |
| 応答が OK で `data` が無い・本文が JSON でない | 「STOCKISTの取得に失敗しました」 |
| 取り出しの例外 | 記録して「STOCKISTの取得に失敗しました」 |
| 読み込みが終わり、誤りも初めの値も無い | 何も描かない |

- 最後の「何も描かない」道は、応答が OK でなく本文の `error` が空の文字（`false`・`0` も同じ）の時に届く。`??` は空の文字を空とみなさないので `fetchError` が空になり、誤りの文を出す `if` を素通りして初めの値の無いまま描く。白い頁になる（推定。食い違いの候補）
- URL の id を確かめずに API の道に入れる。正の整数かを先に確かめること（SEC-STOCKIST-015）は満たさないので上位にしない。数でない id は窓口が 400 `Invalid stockist id` を返し、その文が出る

#### 状態・永続化

部品の state（`initialValues`・`isLoading`・`fetchError`）だけを持つ。

#### 認証認可

頁の入口で権限を確かめない（SEC-STOCKIST-019 は満たさない）。読みは窓口が `admin.stockists.read` と aal2 で守る。

#### テスト観点

（`next/navigation` の `useParams`・`clientFetch`・`StockistForm` を差し替える）

- 取り出しの間は「読み込み中...」
- `useParams` が `{}` と `null` の時に「STOCKIST IDの取得に失敗しました」、`clientFetch` を呼ばない
- 成功で `StockistForm` が `submitUrl="/api/admin/stockists/5"`・`submitMethod="PUT"`・6つの値の `initialValues` で描かれる（応答の `type`・`created_at` などは渡さない）
- 応答が OK でなく `{error:'Stockist not found'}` の時にその文、本文が JSON でない時に「STOCKISTの取得に失敗しました」
- 応答が OK で `data` が無い時と `data:null` の時に「STOCKISTの取得に失敗しました」
- `clientFetch` が例外を投げた時に「STOCKISTの取得に失敗しました」

### DD-STOCKIST-034 管理の取扱店の一覧と作成の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-STOCKIST-001、API-STOCKIST-002、ARC-STOCKIST-002、ARC-STOCKIST-004、DATA-STOCKIST-001、DATA-STOCKIST-002、DATA-STOCKIST-004、STATE-STOCKIST-001、SEC-STOCKIST-006 |
| 根拠 | 非公開を含む一覧と店の作成は、窓口で `admin.stockists.read`・`admin.stockists.manage` と aal2 を確かめ（SEC-STOCKIST-006、DATA-STOCKIST-004）、表の操作も利用者の JWT で RLS に通して、窓口の確かめが崩れても DB が断るようにする（ARC-STOCKIST-002、DATA-STOCKIST-002）。変更の送り元は、窓口に届く前に proxy の Origin の確かめが見る（ARC-STOCKIST-004）。表に長さの制約が無いので入口で6つの値の必須と上限を確かめ（API-STOCKIST-002、DATA-STOCKIST-001）、状態は2つの値に限る（STATE-STOCKIST-001）。一覧は id の順で全部を返す（API-STOCKIST-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/stockists/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |
| 旧番号 | IMPL-ADMIN-006、IMPL-ADMIN-STOCKIST-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-006 の行と、「実装タスク管理 (ADMIN-01)」の ADMIN-01-005 の行 |

#### 対応要件

API-STOCKIST-001、API-STOCKIST-002、ARC-STOCKIST-002、ARC-STOCKIST-004、DATA-STOCKIST-001・002・004、STATE-STOCKIST-001、SEC-STOCKIST-006

#### 入出力

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| `GET /api/admin/stockists` | なし | 200 `{data}`。全部の店を id の昇順、全部の列（`type`・`created_at`・`updated_at` を含む）。件数の上限とページ分けは無い |
| `POST /api/admin/stockists` | JSON。`name`（前後の空白を除いて1〜255字）・`address`（1〜500字）・`phone`（1〜50字）・`time`（1〜120字）・`holiday`（1〜120字）・`status`（`private`・`published`）。字の種類は確かめない | 201 `{success:true, id}` |

#### 正常フロー（GET）

1. `admin.stockists.read` で認可する（`route.ts`）
2. 読みの枠で回数を制限する（DD-STOCKIST-038）
3. `createClient(request)` で要求の JWT の client を作り、`stockists` を全部の列・id の昇順で読む
4. 200 `{data}` を返す

#### 正常フロー（POST）

1. `admin.stockists.manage` で認可する
2. 変更の枠で回数を制限する
3. CSRF の token を確かめ、拒否の応答があれば返す（DD-STOCKIST-036）
4. 監査の送り元とブラウザの名を見出しから取る
5. 本文を JSON で読み、zod で6つの値を確かめる（前後の空白は除いた値になる）
6. 要求の JWT の client で6つの値の1行を入れ、新しい `id` を返させる。`type` は入れない
7. 監査 `admin.stockists.create`（success、`resource_id` は新しい id の文字、`detail` は `Created stockist: <店舗名>`）を残す
8. 201 `{success:true, id}` を作り、回した CSRF の token があれば Cookie に付けて返す（DD-STOCKIST-037）

#### 異常フロー

| 方法 | 条件 | 応答と監査 |
| --- | --- | --- |
| 両方 | 認可に失敗 | 「管理の窓口に共通の動き」の 401・403・503・500 |
| 両方 | 回数の制限を超えた・数えの DB が使えない | 429 か 503（`Retry-After: 600`） |
| GET | 表の読み出しに失敗 | 500 `Failed to fetch stockists` |
| GET | 例外 | 500 `Internal server error` |
| POST | CSRF の token が無い・違う・確かめの DB の誤り | 403 `{error:'Forbidden', reason:'CSRF validation failed'}` か 500。監査なし |
| POST | 本文が JSON でない | 例外として 500 `Internal server error`（400 ではない）。監査なし |
| POST | 値の形が合わない（欄が無い・空白だけ・上限を超える・状態が2つの外） | 監査 `admin.stockists.create`（failure、`Validation failed`、`resource_id` なし）、400 `{error:'Invalid request', details}`（zod の `flatten()`。制約の中身が出る） |
| POST | 表への insert に失敗 | 監査 `admin.stockists.create`（error、`DB insert failed`）、500 `Failed to save stockist` |
| POST | 例外 | 500 `Internal server error` |

- 表 `stockists` は `type` を必須・既定値なしで持つ（DATA-STOCKIST-001）。表がこの形なら、insert は必ず DB の誤りになり 500 の道を通る（推定）
- 監査の書き込みが失敗しても、`logAudit` が握りつぶすので応答は変わらない（推定。共有の部品の動き）
- 監査の `detail` に店舗名をそのまま入れる（SEC-STOCKIST-012 は満たさない）。字の種類の許可（SEC-STOCKIST-011）・誤りの応答で制約を出さないこと（SEC-STOCKIST-014）は満たさないので上位にしない

#### 状態・永続化

POST は `stockists` に1行を足す（DATA-STOCKIST-001）。状態は送られた値をそのまま入れ、作成で `published` にもできる（STATE-STOCKIST-001）。監査は `audit_logs`。GET は何も変えない。回数の数えは共有の部品の表に増える。

#### 認証認可

GET は `admin.stockists.read`、POST は `admin.stockists.manage`、どちらも有効な session と aal2。表は利用者の JWT の client で RLS（DATA-STOCKIST-002）を通し、service role を使わない。CSRF は proxy の Origin の確かめ（ARC-STOCKIST-004）と窓口の token の確かめ。

#### テスト観点

（`tests/unit/api/admin/stockists-security.test.ts` に足すか、`tests/unit/api/admin/stockists-route.test.ts` の名前を想定。`authorizeAdminPermission`・`createClient`・`logAudit`・`admin-security` の関数を差し替える）

- GET・POST とも、認可が `ok:false` の時はその応答をそのまま返し、表に触らない。求める権限が GET は `admin.stockists.read`、POST は `admin.stockists.manage`
- GET・POST とも、回数の制限が応答を返した時はそれを返し、表に触らない。GET は読みの枠、POST は変更の枠を、`authz.userId` で呼ぶ（今ある GET の試験を引き継ぐ）
- GET の成功で `select('*')`・`order('id',{ascending:true})` を呼び、200 `{data}`
- GET で表の失敗の時に 500 `Failed to fetch stockists`、例外の時に 500 `Internal server error`
- POST で CSRF の確かめが拒否の応答を返した時に、それを返し、本文を読まない（今ある 403 の試験を引き継ぐ）
- POST で本文が JSON でない時に 500 `Internal server error`
- POST で値が1つでも形に合わない時（例: 店舗名が空白だけ・256字、電話が51字、状態が `draft`）に 400 `Invalid request` と `details`、監査 failure
- POST の insert の本文が前後の空白を除いた6つの値で、`type` を含まない
- POST で insert の失敗の時に監査 error と 500 `Failed to save stockist`
- POST の成功で監査 success（`resource_id` が新しい id の文字、`detail` に店舗名）と 201 `{success:true, id}`、`applyRotatedCsrfCookie` に応答と CSRF の結果を渡す（今ある Cookie の試験を引き継ぐ）
- 監査の `ip` が `x-forwarded-for: " 1.2.3.4 , 5.6.7.8"` の時に `1.2.3.4`、見出しが無い時に `null`。`user_agent` がある時はその値、無い時は `null`
- POST で認可の後に例外（例: `createClient` が投げる）の時に 500 `Internal server error`

### DD-STOCKIST-035 管理の取扱店1件の読み・更新・切り替え・削除の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-STOCKIST-003、API-STOCKIST-004、API-STOCKIST-005、API-STOCKIST-006、ARC-STOCKIST-002、ARC-STOCKIST-004、DATA-STOCKIST-001、DATA-STOCKIST-002、DATA-STOCKIST-004、STATE-STOCKIST-001、SEC-STOCKIST-006 |
| 根拠 | 編集の画面に非公開の店の中身を渡す読みと、店を変える3つの操作は、窓口で権限と aal2 を確かめ（SEC-STOCKIST-006、DATA-STOCKIST-004）、表も利用者の JWT で RLS に通す（ARC-STOCKIST-002、DATA-STOCKIST-002）。一覧のボタン1つで公開を切り替えられるよう、状態だけを変える PATCH を全体の更新（PUT）と分ける（API-STOCKIST-005、STATE-STOCKIST-001）。PUT は作成と同じ必須と上限を当てて決まりを1つにする（API-STOCKIST-004、DATA-STOCKIST-001）。削除は行を消して戻さない（API-STOCKIST-006）。道の id は正の整数だけを受け、DB へ変な値を渡さない（API-STOCKIST-003）。変更の送り元は、窓口に届く前に proxy の Origin の確かめが見る（ARC-STOCKIST-004） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/stockists/[id]/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |
| 旧番号 | IMPL-ADMIN-006、IMPL-ADMIN-STOCKIST-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-006 の行と、「実装タスク管理 (ADMIN-01)」の ADMIN-01-005 の行 |

#### 対応要件

API-STOCKIST-003〜006、ARC-STOCKIST-002、ARC-STOCKIST-004、DATA-STOCKIST-001・002・004、STATE-STOCKIST-001、SEC-STOCKIST-006

#### 入出力

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| `GET /api/admin/stockists/[id]` | 道の `id` | 200 `{data}`（全部の列） |
| `PUT /api/admin/stockists/[id]` | 道の `id`、JSON は作成と同じ6つの値で全部必須 | 200 `{success:true}` |
| `PATCH /api/admin/stockists/[id]` | 道の `id`、JSON `{status}`（`private`・`published`） | 200 `{success:true}` |
| `DELETE /api/admin/stockists/[id]` | 道の `id`。本文なし | 200 `{success:true}` |

#### 道の id の読み（`parseStockistId`）

`Number(id)` が整数で0より大きい時だけその数、ほかは `null`。`abc`・`0`・`-1`・`1.5`・空の文字は `null`。`Number` の決まりで、前後の空白付き（` 5 `）・`5.0`・`1e3`・`0x10` は数として通る（推定）。

#### 正常フロー（4つに共通）

1. 道の id を読み、`null` なら 400 `{error:'Invalid stockist id'}` を返す（GET・PUT・PATCH・DELETE の4つとも）。認可より前
2. 認可する。GET は `admin.stockists.read`、ほかは `admin.stockists.manage`
3. 回数を制限する。GET は読みの枠、ほかは変更の枠
4. 変更の3つは CSRF の token を確かめ、監査の送り元とブラウザの名を取る

#### 正常フロー（方法ごと）

- GET: `stockists` を全部の列で id に合う1行だけ読み（`.single()`）、200 `{data}`
- PUT: 本文を JSON で読み、6つの値を確かめ、id の行の6つの値を書き換える。監査 `admin.stockists.update`（success、`detail` は `Updated stockist: <店舗名>`）
- PATCH: 本文を JSON で読み、`status` を確かめ、id の行の `status` だけを書き換える。監査 `admin.stockists.patch`（success、`detail` は `Status changed to: <状態>`）
- DELETE: id の行を消す。監査 `admin.stockists.delete`（success、`detail` は `Deleted stockist id: <id>`）
- 変更の3つは、200 `{success:true}` を作り、回した CSRF の token があれば Cookie に付けて返す。監査の `resource_id` は id の文字

#### 異常フロー

| 方法 | 条件 | 応答と監査 |
| --- | --- | --- |
| 全部 | 道の id が正の整数でない | 400 `Invalid stockist id`（未ログインでも返る） |
| 全部 | 認可に失敗 | 「管理の窓口に共通の動き」の 401・403・503・500 |
| 全部 | 回数の制限を超えた・数えの DB が使えない | 429 か 503 |
| GET | 行が無い、または DB の誤り | どちらも 404 `Stockist not found` |
| PUT・PATCH・DELETE | CSRF の token が無い・違う・確かめの DB の誤り | 403 か 500。監査なし |
| PUT・PATCH | 本文が JSON でない | 例外として 500 `Internal server error`。監査なし |
| PUT | 値の形が合わない | 監査 `admin.stockists.update`（failure、`Validation failed`）、400 `{error:'Invalid request', details}` |
| PATCH | `status` が2つの外・無い | 監査 `admin.stockists.patch`（failure）、400 `{error:'Invalid request', details}` |
| PUT | 表の更新に失敗 | 監査 error（`DB update failed`）、500 `Failed to update stockist` |
| PATCH | 表の更新に失敗 | 監査 error（`DB update failed`）、500 `Failed to update status` |
| DELETE | 表の削除に失敗 | 監査 error（`DB delete failed`）、500 `Failed to delete stockist` |
| 全部 | 例外 | 500 `Internal server error` |

- 存在しない id への PUT・PATCH・DELETE は、DB が誤りを返さないので 200 と成功の監査になる（推定。SEC-STOCKIST-013 は満たさないので上位にしない）
- PUT・PATCH は前の状態を読まず、同じ状態への変更も成功として監査に残す（STATE-STOCKIST-001）
- 削除の監査に消した店の名前と住所は残らない
- SEC-STOCKIST-009〜012・014 は DD-STOCKIST-034 と同じく満たさない

#### 状態・永続化

PUT は6つの値を、PATCH は `status` を書き換え、`updated_at` は DB の引き金が今の時刻にする（DATA-STOCKIST-001）。DELETE は行を消す。監査は `audit_logs`。GET は何も変えない。

#### 認証認可

GET は `admin.stockists.read`、ほかは `admin.stockists.manage`、どれも有効な session と aal2。表は利用者の JWT の client で RLS（DATA-STOCKIST-002）を通す。CSRF は proxy の Origin の確かめ（ARC-STOCKIST-004）と窓口の token の確かめ。id の形の確かめが認可より前なので、ログインしていない要求にも 400 を返す（害は小さい、推定）。

#### テスト観点

（`tests/unit/api/admin/stockists-id-route.test.ts` の名前を想定。DD-STOCKIST-034 と同じ物を差し替える）

- 4つの方法で、id が `abc`・`0`・`-1`・`1.5` の時に 400 `Invalid stockist id`、認可を呼ばない
- 4つの方法で、認可が `ok:false` の時にその応答を返す。求める権限が GET は `admin.stockists.read`、ほかは `admin.stockists.manage`
- 4つの方法で、回数の制限が応答を返した時にそれを返す。GET は読みの枠、ほかは変更の枠。変更の3つでは CSRF を呼ばない（今ある PATCH の 429 の試験を引き継ぐ）
- 変更の3つで、CSRF の拒否の応答をそのまま返し、表に触らない
- GET の成功で `eq('id', <数>)`・`.single()` を呼び 200 `{data}`。`error` がある時と `data` が `null` の時に 404 `Stockist not found`
- PUT・PATCH で本文が JSON でない時に 500
- PUT で値が形に合わない時に監査 failure と 400、PATCH で `status:'draft'` の時に監査 failure と 400
- PUT の更新の本文が6つの値、PATCH が `{status}` だけ。どちらも `eq('id', <数>)`
- PUT・PATCH・DELETE で表の失敗の時に監査 error と、それぞれの 500 の文
- PUT・PATCH・DELETE の成功で監査 success（`resource_id` が id の文字、`detail` がそれぞれの形）と 200 `{success:true}`、`applyRotatedCsrfCookie` を呼ぶ
- 4つの方法で、`params` が例外を投げた時などに 500 `Internal server error`

### DD-STOCKIST-036 CSRF の token の確かめと拒否の応答への変換

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-STOCKIST-003 |
| 根拠 | 2026-04-18 のレビューの P1（CSRF の抜け）を、変更の4つの窓口で同じ形に直すため、確かめの呼び出しと結果の読み方を取扱店の守りの部品の1か所に置く（ARC-STOCKIST-003）。共有の確かめは拒否を `Response` で返すので、それをそのまま窓口の応答にする |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/features/stockist/services/admin-security.ts`）、`docs/05_Quality/reviews/code/2026-04-18-stockist-review.md` |

#### 対応要件

ARC-STOCKIST-003（その上は NFR-SEC-003（範囲外）、ADR-0260）

#### 入出力

| 関数 | 入力 | 出力 |
| --- | --- | --- |
| `requireAdminStockistCsrf` | なし | 共有の `requireCsrfOrDeny()` の結果（`Response`・回した token の形・`undefined`）をそのまま返す |
| `hasRotatedCsrfToken` | 任意の値 | 物で `null` でなく、`rotatedCsrfToken` の鍵を持てば真 |
| `toCsrfDenyResponse` | 確かめの結果 | 返すべき拒否の応答か `null` |

#### 正常フロー（`toCsrfDenyResponse`）

1. 値が偽（`undefined`・`null` など）か、回した token の形なら `null`（通す）
2. `Response` ならそのまま返す。今の共有の確かめが拒否で返すのはこの形（403 か 500）
3. 物で `status` と `_body` の鍵を持つ形（試験の作り物の形）なら、`_body` を JSON の本文、`status` を状態にした応答を作る。`headers` が `Headers` ならその全部を、ただの物ならその全部の組を応答の見出しに写す
4. どれでもない値は `null`（通す）

#### 異常フロー

関数自体は例外を投げない（`requireCsrfOrDeny` の中の例外は、共有の部品が 500 の `Response` に変える）。

- 分からない値を「通す」に倒すので、SEC-STOCKIST-004 の「判定できない時は拒む」はこの部品では満たさない。上位にしない
- 試験の作り物の形を受ける道は、共有の確かめがその形を作らないので、今の本番の道からは通らない（推定）
- `hasRotatedCsrfToken` の export は外から使われない（`docs/05_Quality/reports/unused-code.md` で参照なし）。同じファイルの `toCsrfDenyResponse`・`applyRotatedCsrfCookie` だけが使う。ほかの窓口は自分の写しを持つ

#### 状態・永続化

持たない。

#### 認証認可

確かめの中身（refresh の Cookie があれば `x-csrf-token` を session の印と比べ、Cookie が無ければ確かめない）は共有の `requireCsrfOrDeny`（`src/lib/csrfMiddleware.ts`）が持つ。

#### テスト観点

（`tests/unit/features/stockist/admin-security.test.ts` の名前を想定。`@/lib/csrfMiddleware` を差し替える）

- `requireAdminStockistCsrf` が `requireCsrfOrDeny` の結果（`undefined`・`Response`）をそのまま返す
- `hasRotatedCsrfToken` が `{rotatedCsrfToken:'t'}` で真、`null`・`'x'`・`{}` で偽
- `toCsrfDenyResponse` が `undefined`・`null` で `null`、`{rotatedCsrfToken:'t'}` で `null`
- `toCsrfDenyResponse` が `Response`（403）で同じ物を返す
- `toCsrfDenyResponse` が `{status:403, _body:{error:'Forbidden'}}` で 403 と同じ本文の応答を返す
- 同じ形に `headers: new Headers({'x-a':'1'})` と `headers: {'x-b':'2'}` を付けた時、それぞれの見出しが応答に写る
- `toCsrfDenyResponse` が `{status:403}`（`_body` なし）と `'x'` で `null`

### DD-STOCKIST-037 回した CSRF の token を Cookie に付け直す

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-STOCKIST-003 |
| 根拠 | 確かめの結果が回した token の形の時に、成功の応答で CSRF の Cookie を付け直し、画面が持つ token と session の印をそろえるため、変更の窓口の共通の後片付けを守りの部品に置く（ARC-STOCKIST-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/features/stockist/services/admin-security.ts`） |

#### 対応要件

ARC-STOCKIST-003（その上は ADR-0260）

#### 入出力・フロー

- 入力: 窓口の応答（`NextResponse`）と確かめの結果。出力なし（応答の Cookie を変える）
- 結果が回した token の形でなければ何もしない
- 回した token の形なら、名前 `csrfCookieName`、値に回した token、設定 `cookieOptionsForCsrf(0)` の Cookie を応答に付ける

#### 異常フロー

例外の道は無い。

- 共有の `requireCsrfOrDeny` はもう回した token の形を作らない（`src/lib/csrfMiddleware.ts`）ので、Cookie を付ける道は今の本番の道からは通らない（推定）

#### 状態・永続化

応答の `Set-Cookie` を足すだけ。

#### 認証認可

持たない。

#### テスト観点

- 結果が `undefined` の時に応答の Cookie が増えない
- 結果が `{rotatedCsrfToken:'t'}` の時に、`csrfCookieName` の Cookie が値 `t` で付く（今ある POST の成功の試験を引き継ぐ）

### DD-STOCKIST-038 読みと変更の回数の制限（送り元と操作者の2本）

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-STOCKIST-003、SEC-STOCKIST-007 |
| 根拠 | 漏れた session で短い時間に大量の列挙・書き換えをさせないため、管理の窓口を読みと変更の2つの枠で数える（SEC-STOCKIST-007）。送り元の見出しは偽れるので、送り元の枠に加えて操作者の枠も数える。6つの窓口で同じ数え方にするため守りの部品にまとめる（ARC-STOCKIST-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/features/stockist/services/admin-security.ts`）、`docs/05_Quality/reviews/code/2026-04-18-stockist-review.md` |

#### 対応要件

ARC-STOCKIST-003、SEC-STOCKIST-007（その上は ADR-0259）

#### 入出力

| 関数 | 入力 | 枠の名前 | 回数 | 窓の長さ |
| --- | --- | --- | --- | --- |
| `enforceAdminStockistReadRateLimit` | 要求、操作者の id | `admin:stockists:read` | 120 | 600 秒ごとに区切った固定の窓 |
| `enforceAdminStockistMutationRateLimit` | 要求、操作者の id | `admin:stockists:mutation` | 20 | 600 秒ごとに区切った固定の窓 |

出力: 止める時は応答（429 `Too many requests` か 503 `Rate limiter unavailable`、`Retry-After: 600`）、通す時は `undefined`。

#### 正常フロー（中の `enforceStockistAdminRateLimit`）

1. 送り元の枠を数える（共有の `enforceRateLimit` を `subject` なしで呼ぶ）
2. 止める応答が返れば、それを返す。操作者の枠は数えない
3. 通れば、同じ枠の名前・回数・窓で、`subject` に操作者の id を渡して数え、その結果を返す

#### 異常フロー

- 数えの DB が使えない時は、共有の部品が 503 を返す（閉じる側に倒す。`rateLimit.ts`）
- 送り元は共有の部品が `x-forwarded-for` の先頭を読む（`rateLimit.ts`）。信頼できる中継の値だけから取ることは共有の部品の側にあり、SEC-STOCKIST-007 に書いた。操作者の枠で補う
- 窓は、時刻を 600 秒で割った境で区切る（`rateLimit.ts` の `bucketTs`）。動く窓ではないので、区切りをまたぐ21回目は 429 にならない（SEC-STOCKIST-007）。受け入れ条件は同じ区切りの中で数える
- 送り元の枠で止まった要求は操作者の枠を使わない。送り元の枠を通った要求は2つの枠の両方を1つ増やす

#### 状態・永続化

共有の部品の数えの表（`increment_rate_limit_counter`）に、窓ごとに数を足す。

#### 認証認可

持たない。認可の後に呼ばれ、操作者の id は認可が返した `userId`。

#### テスト観点

（`@/features/auth/middleware/rateLimit` を差し替える）

- 読みの関数が `enforceRateLimit` を2回、`{endpoint:'admin:stockists:read', limit:120, windowSeconds:600}` で呼び、2回目だけに `subject` が操作者の id（今ある GET の試験を引き継ぐ）
- 変更の関数が `admin:stockists:mutation`・20・600 で同じ2回を呼ぶ
- 1回目が応答を返した時はそれを返し、2回目を呼ばない
- 1回目が `undefined` で2回目が応答を返した時はその応答を返す
- 2回とも `undefined` の時は `undefined`

## 未確認事項

- 本番の DB の `stockists.type` が今も必須・既定値なしか。そうなら作成の窓口（DD-STOCKIST-034）はいつも 500 で、FR-ADMIN-006-AC-02・FREQ-18-AC-01 を満たさない
- 存在しない店への PUT・PATCH・DELETE を成功とすること、削除の監査に中身を残さないことを、直すか今の動きとして残すか（SEC-STOCKIST-013）
- 管理の作成・編集の頁（`/admin/stockist/create`・`/admin/stockist/edit/[id]`）にサーバーの守りを置くか（SEC-STOCKIST-019）
- 回した CSRF の token と試験の作り物の形を受ける道（DD-STOCKIST-036・037）を残すか。今の本番の道からは通らない
- 各項目の「テスト観点」のテストのファイルの多くはまだ無い。分岐を全部通せるかは、書いて `npm run test:trace-coverage` で確かめていない
- この頁の項目は全部「推定」。ユーザーの確認を受けたら「現行」にする
