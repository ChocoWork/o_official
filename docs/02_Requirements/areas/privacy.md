# PRIVACY の要件

> 状態: 推定 | 確認日: 2026-10-24 | 対象: PRIVACY（プライバシーポリシー `/privacy`） | 基準コミット: `4e84d5c5`

## 概要

PRIVACY の領域の要求・要件・受け入れ条件・派生要件を、追跡できる項目（`### <ID> <題>` と属性の表）で書く。
要求の表（`requirements.md`）の PRIVACY にかかる行（FREQ-100・FREQ-101）を丸ごと写し、上位の無い要件（FR-PRIVACY-001・002）には新しい要求 `SR-PRIVACY-001` を起こし、受け入れ条件の無い要件には `<要件ID>-AC-NN` を起こした。要件が求めていないのにコードがしている動きは派生要件 `DRV-PRIVACY-` に書いた。セキュリティ要件 `SEC-PRIVACY-` は脅威の文書（`docs/05_Quality/security/threats/privacy.md`）の `THR-PRIVACY-001〜011` を上位にして起こした。

| 段 | 数 | ID |
| --- | --- | --- |
| 要求 | 3 | 既存の `FREQ-100`・`FREQ-101`、新しい `SR-PRIVACY-001` |
| 要件 | 4 | 既存の `FREQ-100-REQ-01`・`FREQ-101-REQ-01`、`FR-PRIVACY-001`・`FR-PRIVACY-002` |
| 受け入れ条件 | 6 | 既存の `FREQ-100-AC-01`・`02`、`FREQ-101-AC-01`・`02`、新しい `FR-PRIVACY-001-AC-01`・`FR-PRIVACY-002-AC-01` |
| 派生要件 | 4 | `DRV-PRIVACY-001`〜`004` |
| セキュリティ要件 | 19 | `SEC-PRIVACY-001`〜`019`（全部「推定」） |
| セキュリティ要件の受け入れ条件 | 24 | `SEC-PRIVACY-NNN-AC-NN`（各要件の下） |

- 状態: 全部「推定」。元の行に理由の記述が無く、根拠の「なぜ」を推定で補った。要求の文そのものはユーザーの依頼を写した物で、ユーザーが確かめたら「現行」にする。どちらが正しいかは決めず、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せた
- 結論: プライバシーポリシーを公表する要求は元の文書に無かった（`SR-PRIVACY-001` を推定で起こした）。FR-PRIVACY-001 の「静的ページ」は今のコード（request のたびに描き、ショップの設定を読む）と合わない。配送の追跡の委託の一文（FREQ-495-AC-05）は持ち主の無い行なので写していない

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 写した元 | `docs/02_Requirements/requirements.md`（「1.17 プライバシーポリシーページ（PRIVACY）」節と、「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-100・FREQ-101 の行）。元の行は消していない |
| 要求の出どころ | `docs/02_Requirements/stakeholder-requirements.md` の「2. 目標」、`requirements.md` の LEGAL-001、個人情報の保護に関する法律 |
| 対象のコード | `src/app/privacy/page.tsx`（範囲の src はこの1本だけ） |
| 調べた時点 | 2026-10-24 の作業ツリー（コードを読んで起こした。単体テストと DB を使わない結合テストは流して通した。E2E と DB の結合テストは流していない） |
| 持ち主 | FREQ-100・FREQ-101・FR-PRIVACY-001・002 はほかの領域が触れない（領域ごとの持ち主の割り当てによる）。FREQ-540 は誰も定義していない（在庫の作業が書き直し中）ので、根拠に `（範囲外）` 付きで挙げるだけにした |

### 写した行と写さなかった行

FREQ-101 は範囲外の `/terms` にもかかるが、範囲の E2E（`e2e/FR-PRIVACY-004`）が `/terms` も試していて、名前に付ける受け入れ条件が要るので丸ごと写した。

| 写さなかった行 | 理由 |
| --- | --- |
| FREQ-495（AC-05 の委託の一文） | 行の主な頁は管理の配送の追跡の設定（配送の追跡の追加と在庫の作業の範囲）で、持ち主は「なし」。AC-01〜04 は管理の話で、AC-05 を確かめる E2E（`e2e/FR-ACCOUNT-043`）も PRIVACY の型に入らない。追跡がオンの時だけ委託の一覧に 17TRACK の一文を出す動きは、設計の上位に `FREQ-495-REQ-01（範囲外）` と書いてつなぐ |
| FREQ-490 | 追跡を初期オフにする要求（配送の追跡の追加）。委託の一文が既定で出ない理由の上位として、設計から `（範囲外）` で指す |
| FREQ-541 | 在庫の作業が、配送の追跡の客向けの公開範囲を保つ回帰の要求。`tests/unit/components/PrivacyPage.test.tsx` を回帰に使う（在庫の作業の範囲） |
| FREQ-343 | フッターの「Privacy Policy」のリンクを隠さない話。持ち主は LOOK で、フッターは範囲外 |
| LEGAL-001・002・006 | ID の形が検査の種類に無く、上位に書けない。LEGAL-001 は SR-PRIVACY-001 の出どころにした。LEGAL-002（保持・同意の仕組み）と LEGAL-006（GDPR）は頁が満たしていない（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節へ） |
| NFR-SEC-001・003・005・008・010 | 全体の非機能要件で持ち主は「なし」。`SEC-` の上位には `THR-` しか書けないので、セキュリティ要件・脅威の根拠に `（範囲外）` 付きで挙げる |
| FR-CHECKOUT-002・NFR-COMP-001 | カード情報を Stripe に任せる要件。委託の一覧と9節の Stripe の文の裏付けで、この領域の要件ではない |

範囲外の共有部品の動き（`/privacy` ではカートの取得を止める `src/contexts/Providers.tsx`、CSP と `frame-ancestors` の `src/proxy.ts`、フッターのリンク）は、PRIVACY の範囲のコードではないので派生要件にしていない。

### E2E と受け入れ条件の対応

`e2e/FR-PRIVACY-*` のファイルが試している受け入れ条件。テスト名に ID を付ける時に使う。

| E2E のファイル | 受け入れ条件 |
| --- | --- |
| FR-PRIVACY-001-policy-content | FR-PRIVACY-001-AC-01（窓口のメールも見るが、名前の ID は1つ） |
| FR-PRIVACY-002-metadata | FR-PRIVACY-002-AC-01（og:title・og:description も見る。DRV-PRIVACY-001 の動き） |
| FR-PRIVACY-003-additional-legal-sections | FREQ-100-AC-01・AC-02（1つのテストで両方） |
| FR-PRIVACY-004-typography-spacing | FREQ-101-AC-01・AC-02（1つのテストで両方。6件のうち3件は範囲外の `/terms`） |

- E2E のファイル名の番号 `FR-PRIVACY-003`・`004` は要件の ID ではない（E2E のファイル名の番号の割り当てによる）。要件として定義しない
- FR-PRIVACY-001・002 の E2E は既定の幅1つだけで、3つの幅の決まりを満たしていない
- 受け入れ条件があって範囲の E2E が無い物は無い。派生要件 DRV-PRIVACY-002〜004 の動きを試す E2E は無い

## 要求

### SR-PRIVACY-001 訪問者とお客様が、店の個人情報の扱いをいつでも読める

| 属性 | 値 |
| --- | --- |
| 根拠 | 買い物の前後に、名前・住所・連絡先・決済の情報をどう集め、何に使い、誰に預けるかを本人が知れる状態に置かないと、安心して注文できず、法令の求める公表も欠ける。stakeholder-requirements.md の目標「セキュリティと法令遵守（個人情報保護、税・返品対応）」と LEGAL-001「プライバシーポリシー・利用規約を整備する」から起こした。要求の表に公開の頁を求める行が無いので、FR-PRIVACY-001・002 の上位として足した |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/stakeholder-requirements.md`（「2. 目標」）、`docs/02_Requirements/requirements.md`（LEGAL-001）、個人情報の保護に関する法律（利用目的・保有個人データに関する事項の公表） |

訪問者とお客様が、サイトの1つの頁で、当店の個人情報の取り扱い（収集の方法・利用目的・第三者提供・委託・保有期間・国外移転・安全管理・Cookie・開示などの請求・窓口）を読めること。

### FREQ-100 プライバシーポリシーに不足していた法的な節を足す

| 属性 | 値 |
| --- | --- |
| 根拠 | 委託・保有期間・国外移転・開示などの請求・方針の変更・窓口は、同業のブランド（HYKE・ssstein・AURALEE）の頁にあり、当店の頁に無かった。個人情報保護法の公表事項を欠かさず、お客様が請求の仕方と連絡先を知れるようにするため |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-100 の行（題と中身は合わない） |

要求の文: プライバシーポリシーページに、同業ブランド（HYKE / ssstein / AURALEE）を参考に不足していた法的項目を追加すること

### FREQ-101 プライバシーポリシー・利用規約の字の大きさと余白を読みやすくする

| 属性 | 値 |
| --- | --- |
| 根拠 | 法務の長文は小さな字と詰まった行で読み通しにくい。行間と見出しの大きさに差を付け、節の切れ目を見つけやすくするため（参照先は HYKE・ssstein・AURALEE） |
| 状態 | 推定 |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-101 の行 |

要求の文: プライバシーポリシー・利用規約ページのフォントサイズと余白を、参照先（HYKE / ssstein / AURALEE）を参考に可読性向上の観点で改善すること

`/terms`（利用規約）は範囲外。PRIVACY は `/privacy` の分を作る。

## 要件

### 要求の表から写した要件

### FREQ-100-REQ-01 委託・保有期間・国外移転・開示などの請求・変更・窓口の節を足す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-100 |
| 根拠 | FREQ-100 の「不足していた法的項目」を、6つの節として名前で決めた。窓口には事業者名とメールの宛先を置き、開示などの請求の宛先を本人が分かるようにする |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-100 の行 |

「個人情報の取扱いの委託」「個人情報の保有期間」「個人情報の国外移転」「保有個人データの開示・訂正・利用停止等の請求」「本ポリシーの変更」「お問い合わせ窓口（事業者名・メール窓口）」の各セクションを /privacy に追加すること

今のコード: 5・6・7・10・11・12 の節として出す。窓口の節は事業者名「Le Fil des Heures」とメール「privacy@lefildesheures.com」を文字で出す（メールの宛先へのリンクにはしていない）。

### FREQ-101-REQ-01 本文の行間を広げ、見出しを大きくし、節の間を空ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-101 |
| 根拠 | FREQ-101 の「可読性向上」を、本文の行間・節と頁の見出しの大きさ・節の間の余白の値で決めた。ただし今のコードは節の見出しと節の間の値が文と違う（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-101 の行 |

本文（bodyText）に行間 line-height 1.9 を付与し、セクション見出しを `--lk-size-xl`、ページ見出しを `--lk-size-5xl` に拡大し、セクション間の縦余白を `space-y-12` に広げること（/privacy・/terms 共通）

今のコード: 本文の行間 1.9 と頁の見出し `--lk-size-5xl` は文のとおり。節の見出しは `--lk-size-md`、節の間は `space-y-8`。節の見出しの `--lk-size-md` と本文の行間 1.9 はコミット b82f3450（2026-07-12）で入った（その前は dfcc2c57 が付けた `--lk-size-lg`）。節の間は 04e60c5a（2026-05-06）で `space-y-12` から `space-y-8` に変えた後、変わっていない。要件の行は直っていない。`/terms` も同じ値。

### プライバシーポリシーの頁の要件

### FR-PRIVACY-001 プライバシーポリシーの内容を頁として出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-PRIVACY-001 |
| 根拠 | 個人情報の扱いを本人が読める場をサイトに1つ置くため（SR-PRIVACY-001）。文は「静的ページ」とするが、今のコードは request のたびに描き、ショップの設定を読む（食い違い。状態は推定） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | MUST |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.17 プライバシーポリシーページ（PRIVACY）」節の FR-PRIVACY-001 の行 |

プライバシーポリシーの内容を静的ページとして表示する。

今のコード: h1「Privacy Policy / 個人情報の取り扱いについて」の下に、前置きの節と 1〜12 の節（定義・収集の方法・利用目的・第三者提供・委託・保有期間・国外移転・安全管理・Cookie と外部サービス・開示などの請求・変更・窓口）を `section` と h2 で並べ、末尾に制定日と最終改定日を出す。

### FR-PRIVACY-002 頁の title と description を決めて出す

| 属性 | 値 |
| --- | --- |
| 上位 | SR-PRIVACY-001 |
| 根拠 | 検索の結果やブラウザのタブで、プライバシーポリシーの頁だと分かり、探している人がたどり着けるようにするため（SR-PRIVACY-001） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | `docs/02_Requirements/requirements.md` |
| 優先度 | SHOULD |
| 旧所在 | `docs/02_Requirements/requirements.md` の「1.17 プライバシーポリシーページ（PRIVACY）」節の FR-PRIVACY-002 の行 |

`generateMetadata` で `title` / `description` を設定する。

今のコード: title は「Privacy Policy | Le Fil des Heures」、description は「Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。」。OGP も出す（DRV-PRIVACY-001）。

## 受け入れ条件

### 要求の表から写した受け入れ条件

### FREQ-100-AC-01 足した6つの節の見出しが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-100-REQ-01 |
| 根拠 | FREQ-100-REQ-01 の6つの節が足されたことを、番号付きの見出しの字で外から確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-100 の行 |

/privacy に見出し「5. 個人情報の取扱いの委託」「6. 個人情報の保有期間」「7. 個人情報の国外移転」「10. 保有個人データの開示・訂正・利用停止等の請求」「11. 本ポリシーの変更」「12. お問い合わせ窓口」が表示されること

### FREQ-100-AC-02 窓口のメールが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-100-REQ-01 |
| 根拠 | FREQ-100-REQ-01 の「メール窓口」が、開示などの請求の宛先として読めることを確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-100 の行 |

/privacy にお問い合わせ先メール「privacy@lefildesheures.com」が表示されること

### FREQ-101-AC-01 本文の行間が字の大きさの 1.5 倍より広い

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-101-REQ-01 |
| 根拠 | FREQ-101-REQ-01 の行間 1.9 を、描かれた本文の段落の行間と字の大きさの比で確かめる（値そのものでなく比で見るので、字の大きさの変更に強い） |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-101 の行 |

/privacy と /terms の本文段落の line-height が 1.5 より大きく（1.9 相当）表示されること

`/terms` の分は範囲外の頁だが、範囲の E2E（`e2e/FR-PRIVACY-004`）が同じ受け入れ条件で試す。

### FREQ-101-AC-02 節の見出しの字が本文より大きい

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-101-REQ-01 |
| 根拠 | FREQ-101-REQ-01 の見出しの拡大を、節の見出しと本文の字の大きさの大小で確かめる。今のコードの値（`--lk-size-md`）でも満たす |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ユーザーの依頼（`docs/02_Requirements/requirements.md` の要求の表） |
| 旧所在 | `docs/02_Requirements/requirements.md` の「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-101 の行 |

/privacy と /terms のセクション見出し（h2）のフォントサイズが本文段落より大きいこと

### 新しく起こした受け入れ条件

### FR-PRIVACY-001-AC-01 頁の見出しと、FREQ-100 以外の節の見出しが出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-PRIVACY-001 |
| 根拠 | FR-PRIVACY-001 の「内容を表示」を、頁の見出しと、収集・利用目的・第三者提供など元からある節の見出しで確かめる。FREQ-100 が足した6つの節は FREQ-100-AC-01 が見る |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-PRIVACY-001）。節の名前は `src/app/privacy/page.tsx` から |

`/privacy` を開くと、「Privacy Policy」を含む h1 と、h2「個人情報の取り扱いについて」「1. 個人情報の定義」「2. 個人情報の収集方法」「3. 個人情報の利用目的」「4. 個人情報の第三者提供」「8. 個人情報の安全管理」「9. Cookie 及び外部サービスの利用」が表示されること。

今の E2E（`e2e/FR-PRIVACY-001`）は h1 と h2 の3つ（前置き・3・4）だけを見る。

### FR-PRIVACY-002-AC-01 頁の title と description が出る

| 属性 | 値 |
| --- | --- |
| 上位 | FR-PRIVACY-002 |
| 根拠 | FR-PRIVACY-002 の title・description が、頁の head に決めた字のまま出ていることを確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 要件の文から起こした（FR-PRIVACY-002）。字は `src/app/privacy/page.tsx` から |

`/privacy` を開くと、title が「Privacy Policy | Le Fil des Heures」、meta の description が「Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。」であること。

## セキュリティ要件

上位は `THR-PRIVACY-NNN` だけ。全体の要件（`NFR-SEC-001〜012`）は上位に書けない種類なので、根拠に `（範囲外）` 付きで書いた。優先度は元の文書に値が無いので案。過去のレビュー（`security_review_privacy.md`）の High・Medium の指摘から起こした物は MUST（007・013・014・015・016）、Low は SHOULD（018）。レビューに無い物は、配送の追跡の追加の作業の文書が直すと決めた物（003・005・006）、権限と誤りの中身で個人情報や公表の文を守る物（001・008・010）、法令の公表・請求に直に当たる物（011・017・019）を MUST、ほか（002・004・009・012）を SHOULD にした。本文の「今のコード」は 2026-10-24 の作業ツリーを読んだ結果で、今のコードが満たさない所は、その SEC の本文で1度だけ書く（ほかの文書は SEC の番号で指す）。一覧は `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せた。

### SEC-PRIVACY-001 設定の関数と表は、anon・一般会員から直接読めない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-001 |
| 根拠 | 担当者のメールと件数を返す関数を、アプリを通さずに PostgREST から読まれないため。全体の NFR-SEC-005（範囲外）の権限管理と NFR-SEC-010（範囲外）の個人情報のマスクを、設定の読み取りに当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3。実装から推定 |
| 優先度 | MUST |

`get_delivery_tracking_settings` の実行と `shop_settings` の読み取りは service role だけに許す。service role も表には読み取り（SELECT）しか持たず、書き込みは所有者の権限で動く関数（SECURITY DEFINER）の中だけで起きる（DATA-PRIVACY-002）。今のコードは満たす（`supabase/migrations/20261021221140_delivery_tracking_admin.sql`、`supabase/migrations/20261011222930_order_refund_records.sql`）。権限は結合テストが確かめる（範囲外の `tests/integration/db/delivery_tracking_admin.integration.test.ts` と、DATA-PRIVACY-002 の `tests/integration/db/privacy_settings_permissions.integration.test.ts`。後者は書いただけで、手元の DB では流していない）。PostgREST の経路で試す E2E は無い。

#### SEC-PRIVACY-001-AC-01 anon と一般会員の鍵で設定の関数を呼べない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-001 |
| 根拠 | DB の権限の段だけで閉じているかを、アプリを通さずに確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に anon の鍵と一般会員の JWT で `rpc/get_delivery_tracking_settings` を呼ぶ） |
| 出どころ | 実装から推定 |

anon の鍵と一般会員の JWT で呼ぶと、どちらも断られ、応答に `updated_by_email` の値が表示されないこと。

#### SEC-PRIVACY-001-AC-02 anon と一般会員の鍵で設定の表を読めない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-001 |
| 根拠 | 関数を通さずに表を直接読む道も閉じているかを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に anon の鍵と一般会員の JWT で `shop_settings` を select する） |
| 出どころ | 実装から推定 |

anon の鍵と一般会員の JWT の select が断られるか、行が0件で返ること。

### SEC-PRIVACY-002 公開の頁は、表示に要る設定の値だけを受け取る

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-001 |
| 根拠 | RLS を素通りする service role で、表示しない担当者のメールまで公開の頁の処理に渡さないため。後の変更で画面や記録に出る道を、元から無くす。全体の NFR-SEC-010（範囲外）を当てはめた |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V4.1.3。実装から推定 |
| 優先度 | SHOULD |

`/privacy` が読む設定は、追跡がオンかどうかの1つだけにする。担当者のメール・変えた時刻・件数は受け取らない。今のコードは満たさない。

#### SEC-PRIVACY-002-AC-01 頁に担当者のメールが表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-002 |
| 根拠 | 受け取った値が利用者の見える所へ出ていないことを、画面で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で追跡の設定を管理者のメール付きで保存した後に `/privacy` を開く。mobile 390・tablet 768・desktop 1280）。画面だけでは SEC-PRIVACY-002 の達成を見分けられないので、頁の処理が受け取る欄が `enabled` だけであることは単体テストかレビューで確かめる |
| 出どころ | 実装から推定 |

`/privacy` の HTML に、設定を変えた担当者のメールの字が表示されないこと。

### SEC-PRIVACY-003 頁を開くたびに重い数え上げを走らせない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-002 |
| 根拠 | ログイン無しで開ける頁から、発送の数に比例して重くなる処理を呼ばせないため。運用の文書（`docs/06_Operations/webhook-queue-operations.md`）が、追跡をオンにする前に直すと決めた |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4（重い処理の呼び出しを抑える点で当てはめた）。`docs/06_Operations/webhook-queue-operations.md` |
| 優先度 | MUST |

`/privacy` が呼ぶ DB の処理は、`shop_settings` の1行を読むだけにする。取り込み待ちの件数は数えない。今のコードは満たさない。

#### SEC-PRIVACY-003-AC-01 発送が多くても頁の表示が遅くならない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-003 |
| 根拠 | 数え上げを外したことを、利用者の待ち時間で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase に取り込み待ちの発送を多数入れた状態と、0件の状態で `/privacy` を開き比べる） |
| 出どころ | 実装から推定 |

取り込み待ちの発送が多数ある時と0件の時で、`/privacy` の本文が表示されるまでの時間の差が、許す幅に収まること。発送の件数と許す幅はまだ決まっておらず、ユーザーの決定待ち（未確認事項）。決まるまでこの条件は試せない。

### SEC-PRIVACY-004 頁の連打を回数で止める

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-002 |
| 根拠 | DB を読む公開の頁を、回数の制限も共有のキャッシュも無いまま開け放たないため。DB が詰まると注文・決済まで遅れる |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V11.1.4 |
| 優先度 | SHOULD |

同じ送り元から短い間に `/privacy` を決めた回数より多く開くと、DB を読まずに断る（または DB を読まない応答を返す）。回数の制限を置く時は、送り元を偽った見出しで抜けられない取り方にする。今のコードは満たさない。

#### SEC-PRIVACY-004-AC-01 回数の上限を超えると DB を読まない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-004 |
| 根拠 | 連打が DB へ届かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（同じ送り元から上限を超えて `/privacy` を開く） |
| 出どころ | 実装から推定 |

同じ送り元から上限の回数を超えて開いた後の応答で、断る旨の画面または DB を読まない応答が表示されること。`x-forwarded-for` を毎回変えても、超えた後は同じ結果になること。上限の回数と数える窓の長さはまだ決まっておらず、ユーザーの決定待ち（未確認事項）。決まるまでこの条件は試せない。

### SEC-PRIVACY-005 設定を読めない時は、委託の一覧を出さずに頁を失敗にする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-003 |
| 根拠 | 読めない時に一文を黙って出す・隠すと、誤った委託先を公表し続けるため。配送の追跡の追加の計画（`docs/superpowers/plans/2026-10-21-delivery-status.md`）が決めた形 |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.3.3。`src/app/privacy/page.tsx` |
| 優先度 | MUST |

設定を読めない時と service role の client を作れない時は、委託の一覧を描かずに頁の失敗にする。今のコードは満たす（`src/app/privacy/page.tsx`、単体テスト `tests/unit/components/PrivacyPage.test.tsx`、結合テスト `tests/integration/ui/privacy-request-time-render.test.tsx`・`privacy-tracking-clause-state.test.tsx`）。E2E は無い。

#### SEC-PRIVACY-005-AC-01 設定を読めない時に委託の一覧が表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-005 |
| 根拠 | 読めない時に古い一覧を出さないことを、利用者の見える所で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase の設定の関数を一時的に呼べなくして `/privacy` を開く。並列の揺れを避け、ほかの spec と同時に流さない） |
| 出どころ | 実装から推定 |

設定を読めない状態で `/privacy` を開くと、「5. 個人情報の取扱いの委託」の一覧が表示されず、誤りの画面が表示されること。

### SEC-PRIVACY-006 委託の一文は、ショップの追跡の設定がオンの時だけ出す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-003 |
| 根拠 | 17TRACK に渡していない時に渡すと書かず、渡している時に書き漏らさないため。鍵の有無では実際に渡すかが決まらない（配送の追跡の追加の設計の決定 25、`docs/superpowers/specs/2026-10-21-delivery-status-design.md`） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.3.3。`docs/04_DetailDesign/pages/17_privacy.md` |
| 優先度 | MUST |

一文を出す条件は `shop_settings` の追跡の設定だけにする。今のコードは満たす（`src/app/privacy/page.tsx`、単体テスト `tests/unit/components/PrivacyPage.test.tsx`）。E2E は範囲外の `e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts` だけにある（FREQ-495-AC-05（範囲外））。

#### SEC-PRIVACY-006-AC-01 追跡がオフの時に 17TRACK の一文が表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-006 |
| 根拠 | 渡していない先を公表しないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280。追跡の設定を切り替える spec と同時に流さない） |
| 出どころ | 実装から推定 |

追跡がオフの時、`/privacy` に「17TRACK」の字が表示されず、委託の一覧が3項目であること。

#### SEC-PRIVACY-006-AC-02 鍵が無くても設定がオンなら一文が表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-006 |
| 根拠 | 条件が鍵でなく設定であることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（17TRACK の鍵を設けない手元の環境で、設定だけをオンにする） |
| 出どころ | 実装から推定 |

17TRACK の鍵が無く設定がオンの時、委託の一覧に17TRACK の一文が項目として表示されること。

### SEC-PRIVACY-007 方針の応答を共有のキャッシュに残さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-003 |
| 根拠 | 追跡を切り替えた後も、中継の CDN が古い委託の一覧を配り続けないため。過去のレビューがキャッシュの方針を仕様に書くよう求めた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.1.1（共有のキャッシュに機微なデータを残さない点で当てはめた）。`docs/05_Quality/reviews/security/security_review_privacy.md`（Open、Medium） |
| 優先度 | MUST |

`/privacy` の応答の `Cache-Control` は、共有のキャッシュに保たせない値（`private` か `no-store`）にする。今は request ごとに描くので Next.js がそうした値を付ける見込みだが、確かめていない。

#### SEC-PRIVACY-007-AC-01 応答の見出しが共有のキャッシュを止める

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-007 |
| 根拠 | 本番ビルドの応答で、見込みでなく実際の値を確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドに `/privacy` を GET する） |
| 出どころ | 実装から推定 |

`/privacy` の応答の `Cache-Control` に `private` または `no-store` が含まれ、`public`・`s-maxage` が含まれないこと。

### SEC-PRIVACY-008 頁の失敗の時は、中の事情を出さない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-004 |
| 根拠 | 設定の関数の名前・DB の誤りの文を、ログイン無しの閲覧者へ見せないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V7.4.1 |
| 優先度 | MUST |

設定を読めずに頁が失敗した時、画面には一般の誤りの文だけを出す。本番の Next.js は中身を伏せる見込みだが、確かめていない。

#### SEC-PRIVACY-008-AC-01 失敗の画面に DB の誤りの文が表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-008 |
| 根拠 | 本番ビルドで実際に伏せられるかを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（SEC-PRIVACY-005-AC-01 と同じ状態を本番ビルドで作る） |
| 出どころ | 実装から推定 |

失敗の画面に `get_delivery_tracking_settings`・`DELIVERY_`・`SUPABASE_SERVICE_ROLE_KEY`・`SUPABASE_URL`・SQL の誤りの文が表示されないこと。

### SEC-PRIVACY-009 DB が使えない間も、方針を知る道を残す

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-004 |
| 根拠 | 個人情報保護法は、利用目的などを本人の知り得る状態に置くよう求める。DB の障害の間に方針が全く読めないと、その状態が崩れる（推定。法務の判断） |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | ASVS 未対応付け。実装から推定（個人情報保護法の「本人の知り得る状態」の公表の求めから、推定） |
| 優先度 | SHOULD |

設定を読めない時の画面に、方針を後で読める・窓口へ問い合わせられる案内を出す。SEC-PRIVACY-005 と両立させる形はユーザーが決める。今は `error.tsx` が無く Next.js の既定の誤りの頁になる。

#### SEC-PRIVACY-009-AC-01 失敗の画面に窓口の案内が表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-009 |
| 根拠 | 方針を読めない時も、本人が問い合わせる道が残ることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（SEC-PRIVACY-005-AC-01 と同じ状態。mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

設定を読めない状態で `/privacy` を開くと、時間を置いて開き直す案内か、窓口（メールかお問い合わせのフォーム）が表示されること。

### SEC-PRIVACY-010 公表の文を変える追跡の切り替えは、aal2 の管理者だけができる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-005 |
| 根拠 | 公表の委託の一覧は追跡の設定で変わるので、設定を変えられる者が方針を書き換えられる者になる。全体の NFR-SEC-008（範囲外）の RBAC、NFR-SEC-005（範囲外）の監査ログ、FREQ-540（範囲外）の DB の ACL・aal2 の守りを当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | OWASP ASVS 4.0.3 V4.3.1 |
| 優先度 | MUST |

追跡の切り替えは、`admin.settings.manage` を持ち aal2 を済ませた管理者が、CSRF の token と回数の制限と監査の記録を通る窓口からだけできる。PostgREST から切り替えの関数・表の直接の書き換えはできない。今のコードは満たす（`src/app/api/admin/settings/shop/route.ts`、`src/lib/auth/admin-rbac.ts`、`supabase/migrations/20261021221140_delivery_tracking_admin.sql`、`supabase/migrations/20261011222930_order_refund_records.sql`、`supabase/migrations/20261021220816_delivery_tracking_records.sql`）。PostgREST の経路の E2E は無い。

#### SEC-PRIVACY-010-AC-01 aal1 の管理者は直接も窓口からも切り替えられない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-010 |
| 根拠 | パスワードだけの session で、アプリの窓口と DB の直接の道のどちらも閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（手元の Supabase で、`admin.settings.manage` を持つ aal1 の JWT で `rpc/admin_set_delivery_tracking` と `shop_settings` の update と設定の保存の窓口を叩く） |
| 出どころ | 実装から推定 |

どの道も断られ、その後に `/privacy` を開くと委託の一覧が切り替える前のまま表示されること。

#### SEC-PRIVACY-010-AC-02 anon と一般会員は切り替えられない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-010 |
| 根拠 | 管理の権限の無い者の道が閉じていることを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（anon の鍵と一般会員の JWT で、AC-01 と同じ3つの道を叩く） |
| 出どころ | 実装から推定 |

どの道も断られ、`/privacy` の委託の一覧が変わらないこと。

### SEC-PRIVACY-011 個人情報を渡す外部のサービスと使い道を、実際と合わせて公表する

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-006 |
| 根拠 | 本人が、個人情報の渡る先と使い道を知った上で使えるようにするため。個人情報保護法の公表・通知の義務と、国外移転の情報提供の義務に関わる（推定。法務の判断）。Stripe の扱いは FR-CHECKOUT-002（範囲外）・NFR-COMP-001（範囲外）と合う |
| 状態 | 推定 |
| 確かめ方 | レビュー・E2E |
| 出どころ | OWASP ASVS 4.0.3 V8.3.3。LEGAL-001・LEGAL-006（`docs/02_Requirements/requirements.md`） |
| 優先度 | MUST |

委託の一覧と 9 節に、個人情報を受け取る外部サービス（今のコードでは Stripe・Resend・Supabase・Cloudflare Turnstile。追跡がオンなら 17TRACK）を、法務が決めた粒度で書く。無い機能（メールマガジン）を使い道に書かない。今の頁は満たさない。

#### SEC-PRIVACY-011-AC-01 外部サービスの名前が表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-011 |
| 根拠 | 個人情報を受け取る外部サービスが頁から漏れていないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280） |
| 出どころ | 実装から推定 |

`/privacy` に「Stripe」「Resend」「Supabase」「Cloudflare Turnstile」の名前が表示され、追跡がオンの時は「17TRACK」も表示されること。この5つは今のコードが個人情報を渡す先。どこまで名前で書くかは法務とユーザーの判断待ち（未確認事項）で、決まったら一覧を直す。

#### SEC-PRIVACY-011-AC-02 無い機能の使い道が表示されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-011 |
| 根拠 | 実際に無い使い道を公表しないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

メールマガジンの機能が無い間、`/privacy` に「メールマガジン」の字が表示されないこと。

### SEC-PRIVACY-012 公表の中身が変わったら、改定日も変わる

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-006 |
| 根拠 | 頁の 11 節は「掲載した時点から効力を生じる」と書く。追跡の切り替えで委託の一覧が変わっても改定日が古いままだと、本人がいつ変わったかを知れない |
| 状態 | 推定 |
| 確かめ方 | 単体テスト・E2E |
| 出どころ | ASVS 未対応付け。実装から推定（`src/app/privacy/page.tsx`） |
| 優先度 | SHOULD |

委託の一覧が変わる時（追跡の切り替えを含む）に、頁の「最終改定日」が変わった日になる。今の頁は日付を固定の字で持ち、切り替えに従わない。

#### SEC-PRIVACY-012-AC-01 追跡をオンにすると改定日がオンにした日になる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-012 |
| 根拠 | 一覧の変化と改定日が合うことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（追跡の設定を切り替える spec と同時に流さない） |
| 出どころ | 実装から推定 |

追跡をオンにした後に `/privacy` を開くと、「最終改定日」にオンにした日か、それより後の日が表示されること。

### SEC-PRIVACY-013 頁を外のサイトの枠に入れさせない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-007 |
| 根拠 | 方針の頁を枠に入れて重ね押しを誘う・偽の窓口を重ねる攻撃を断つため。全体の NFR-SEC-001（範囲外）の HSTS と NFR-SEC-003（範囲外）の CSP を当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | OWASP ASVS 4.0.3 V14.4.7。`docs/05_Quality/reviews/security/security_review_privacy.md` |
| 優先度 | MUST |

`/privacy` の応答に `frame-ancestors 'none'` を含む CSP と `X-Frame-Options: DENY` を付ける。HSTS と `nosniff` も付ける。今のコードは満たす（`src/proxy.ts`）。`/privacy` で試す E2E は無い。

#### SEC-PRIVACY-013-AC-01 応答に枠の禁止と基本の守りの見出しが付く

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-013 |
| 根拠 | 共有部品の変更で `/privacy` の見出しが落ちていないかを、この頁で確かめるため（過去のレビューの Open、Low） |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドに `/privacy` を GET する） |
| 出どころ | `docs/05_Quality/reviews/security/security_review_privacy.md` |

応答の CSP に `frame-ancestors 'none'` が含まれ、`X-Frame-Options` が `DENY`、`Strict-Transport-Security` と `X-Content-Type-Options: nosniff` が在ること。

### SEC-PRIVACY-014 頁で動く script を、店の物と必要な外の物だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-007 |
| 根拠 | 注入した script で偽の方針・偽の窓口を見せられないため。方針の頁は決済を使わず、認証の確かめ（Cloudflare Turnstile）はヘッダーのログインの窓を開いた時にだけ使う。だから決済の配信元と、頁で使わない配信元を許す要が無い。全体の NFR-SEC-003（範囲外）を当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・レビュー |
| 出どころ | OWASP ASVS 4.0.3 V14.4.3。`docs/05_Quality/reviews/security/security_review_privacy.md`（Open、High） |
| 優先度 | MUST |

`/privacy` の CSP の `script-src` は nonce を求め、この頁で使わない外のドメイン（`js.stripe.com`・`cdn.jsdelivr.net`）を許さない。`challenges.cloudflare.com` は、ヘッダーのログインの窓が Turnstile の script を読むので許したままにする。今のコードは一部満たさない（nonce は満たすが、使わない外のドメインを全頁で同じに許している。`src/proxy.ts`）。

#### SEC-PRIVACY-014-AC-01 CSP が nonce を求める

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-014 |
| 根拠 | 注入した inline の script が動かないことを確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドに `/privacy` を GET する） |
| 出どころ | 実装から推定 |

応答の CSP の `script-src` に `'nonce-` が含まれ、`'unsafe-inline'` だけで許す形になっていないこと。

#### SEC-PRIVACY-014-AC-02 CSP が頁で使わない外のドメインを許さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-014 |
| 根拠 | この頁で使わない外のドメインを、許可先から外したことを確かめるため。ヘッダーのログインが使う Turnstile の `challenges.cloudflare.com` は対象にしない（外すと頁からのログインが壊れる） |
| 状態 | 推定 |
| 確かめ方 | E2E（本番ビルドに `/privacy` を GET する） |
| 出どころ | 実装から推定 |

`/privacy` の応答の CSP の `script-src` に `js.stripe.com`・`cdn.jsdelivr.net` が含まれないこと。`challenges.cloudflare.com` は含まれてよい。

### SEC-PRIVACY-015 方針を読むだけの閲覧者に、要らない識別子の Cookie を付けない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-008 |
| 根拠 | `/privacy` ではカートを止めている（`src/contexts/Providers.tsx`）ので、カートのための識別子を付ける要が無い。方針の頁で閲覧を結び付けないため |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_privacy.md`（Open、Medium） |
| 優先度 | MUST |

Cookie の無い閲覧者が `/privacy` を開いても、`session_id` を発行しない。今のコードは満たさない。

#### SEC-PRIVACY-015-AC-01 初めての閲覧で session_id が発行されない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-015 |
| 根拠 | 共有部品の発行の条件を、この頁で確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（Cookie の無い新しい context で `/privacy` を開く） |
| 出どころ | 実装から推定 |

応答に `session_id` の `Set-Cookie` が無く、開いた後の context の Cookie に `session_id` が無いこと。

### SEC-PRIVACY-016 全頁で呼ぶ認証の状態の応答に、メールを載せない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-008 |
| 根拠 | 方針の頁を含む全頁で呼ぶ応答に会員のメールを載せると、script の注入一つでメールが読まれるため。応答は会員の `id` も載せる。この応答の窓口は AUTH の DRV-AUTH-007（範囲外）が持つので、直す時は AUTH の変更になる。全体の NFR-SEC-010（範囲外）の個人情報のマスクを当てはめた |
| 状態 | 推定 |
| 確かめ方 | E2E・結合テスト |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/code/2026-04-29-privacy-review.md`、`docs/05_Quality/reviews/security/security_review_privacy.md`（Open、Medium） |
| 優先度 | MUST |

`/privacy` を開いた時に呼ぶ認証の状態の応答は、画面の出し分けに要る値（ログインの有無・役割・2要素の済み）だけを返す。今のコードは満たさない。

#### SEC-PRIVACY-016-AC-01 頁を開いた時の認証の状態の応答にメールが無い

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-016 |
| 根拠 | ログイン中の会員が方針の頁を開いた時の応答を確かめるため |
| 状態 | 推定 |
| 確かめ方 | E2E（会員でログインして `/privacy` を開き、`/api/auth/me` の応答を見る） |
| 出どころ | 実装から推定 |

`/api/auth/me` の応答の本文に、ログイン中の会員のメールの字が含まれないこと。

### SEC-PRIVACY-017 頁に書いた窓口は、受けて応える運用につながっている

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-009 |
| 根拠 | 開示などの請求を法令の期間内に受けて応えるため。窓口が実在しないと、頁の 10 節・12 節の約束が守れない |
| 状態 | 推定 |
| 確かめ方 | E2E（表示）・運用の確かめ（受信） |
| 出どころ | ASVS 未対応付け。実装から推定（頁の 10 節・12 節の約束から、推定） |
| 優先度 | MUST |

`privacy@lefildesheures.com` のメール箱を用意し、受け手と応える期間を運用の文書に書く。開店の前に受信を確かめる。今は運用の文書にも開店の準備の表にも無い。

#### SEC-PRIVACY-017-AC-01 頁に窓口のメールとフォームが表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-017 |
| 根拠 | 本人が窓口へたどり着けることを確かめるため。受信の確かめは E2E でできないので、運用の文書の確かめと分ける |
| 状態 | 推定 |
| 確かめ方 | E2E（mobile 390・tablet 768・desktop 1280）。受信は開店の準備の確かめ |
| 出どころ | 実装から推定 |

`/privacy` の 12 節に `privacy@lefildesheures.com` と、`/contact` へのお問い合わせのフォームのリンクが表示されること。

### SEC-PRIVACY-018 迷惑メールが増えても、請求を取りこぼさない

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-010 |
| 根拠 | 住所の表示は FREQ-100-AC-02 が求めるので隠せない。受ける側で、迷惑メールの選別と見落としの確かめを持つ |
| 状態 | 推定 |
| 確かめ方 | レビュー（運用の文書） |
| 出どころ | ASVS 未対応付け。`docs/05_Quality/reviews/security/security_review_privacy.md` |
| 優先度 | SHOULD |

窓口のメール箱に迷惑メールの選別を置き、選別で外したメールを決めた間隔で見直す手順を運用の文書に書く。今は無い。

#### SEC-PRIVACY-018-AC-01 運用の文書に迷惑メールの選別と見直しの手順が在る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-018 |
| 根拠 | SEC-PRIVACY-018 は受ける側の運用の統制なので、手順が文書に在るかをレビューで確かめる。頁の側の形（メールを `mailto:` のリンクにしない）は、決めた理由の記録が無い成り行きなので、要件にしない（ADR-0352） |
| 状態 | 推定 |
| 確かめ方 | レビュー（運用の文書） |
| 出どころ | 実装から推定 |

運用の文書に、窓口のメール箱の迷惑メールの選別と、選別で外したメールを見直す間隔・担当が書かれていること。

### SEC-PRIVACY-019 開示などの請求は、本人を確かめてから応える

| 属性 | 値 |
| --- | --- |
| 上位 | THR-PRIVACY-011 |
| 根拠 | 頁の 10 節が「ご本人であることを確認」すると約束している。他人の名を名乗る請求に個人情報を渡すと漏えいになる |
| 状態 | 推定 |
| 確かめ方 | レビュー（運用の文書） |
| 出どころ | ASVS 未対応付け。実装から推定（`src/app/privacy/page.tsx`） |
| 優先度 | MUST |

開示などの請求を受けた時の本人の確かめ方（登録のメールへの返信で確かめる、など）と、確かめられない時に断る手順を運用の文書に書く。今は無い。

#### SEC-PRIVACY-019-AC-01 頁に本人の確かめの後に応える旨が表示される

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-019 |
| 根拠 | 本人の確かめを経ることを、請求する人が先に知れるようにするため。手順そのものは運用の文書のレビューで確かめる |
| 状態 | 推定 |
| 確かめ方 | E2E |
| 出どころ | 実装から推定 |

`/privacy` の 10 節に、本人であることを確かめた上で応える旨の文が表示されること。

## 派生要件

### DRV-PRIVACY-001 OGP の題・説明・画像を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 頁の URL を SNS などで共有した時に、ほかの頁と同じ形（題・説明・ブランドの写真）で見えるようにするため（推定）。FR-PRIVACY-002 は title・description だけを求め、OGP は求めていない。requirements.md の 1.17 節のレビューの注と詳細設計 17_privacy.md は OGP の設定を済みとする |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（レビューの注）、`docs/04_DetailDesign/pages/17_privacy.md`、実装から推定 |

og:title と og:description は title・description と同じ字にし、og:image は `/mainphoto.png` にする（`src/app/privacy/page.tsx` の metadata）。今の E2E は og:image を見ない。

### DRV-PRIVACY-002 頁を request のたびに描き、ショップの設定を読めない時は頁の失敗にする

| 属性 | 値 |
| --- | --- |
| 根拠 | 委託の一覧に 17TRACK の一文を出すかは店長が切り替える設定で決まる（FREQ-495-AC-05、範囲外の行）ので、ビルドの時に固めた頁では切り替えが公表に届かない。設定を読めない時に一文を黙って隠すと、実際は渡しているのに書かない（古い・誤った方針を公表する）恐れがあるので、隠さずに頁を失敗にした。読み方と失敗の扱いはどの要件も決めていない |
| 状態 | 推定 |
| 出どころ | `src/app/privacy/page.tsx` のコメント、`docs/superpowers/plans/2026-10-21-delivery-status.md`、`tests/unit/components/PrivacyPage.test.tsx`、実装から推定 |

Next.js の connection の後で、service_role の client を作ってショップの配送の追跡の設定を読む（ビルドの時に DB へ行かない）。client を作れない時も、設定を読めない時も、例外を握りつぶさずに頁の描画を失敗にする。`/privacy` に専用の誤りの頁は無く、Next.js の既定の誤りの頁になる。読んだ設定のうち使うのはオンかオフか（`enabled`）だけで、鍵の有無は条件にしない。

### DRV-PRIVACY-003 末尾に制定日と最終改定日を出す

| 属性 | 値 |
| --- | --- |
| 根拠 | 本人がいつの版の方針を読んでいるかを分かるようにし、変更（11節）の後に改定日で変わったことを知らせるため。uiux レビュー PV-4 で、ブランドの設立より前の日付だった誤りを直した。どの要件も日付の表示を求めていない |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_privacy.md`、実装から推定 |

頁の末尾に「制定日：2026年6月20日」「最終改定日：2026年7月11日」を出す。委託の一覧が変わった時の最終改定日の扱いは SEC-PRIVACY-012 を参照。

### DRV-PRIVACY-004 窓口の節にお問い合わせフォームへの入口を置く

| 属性 | 値 |
| --- | --- |
| 根拠 | uiux レビュー PV-2・PV-3 で、ユーザーの方針として連絡先をお問い合わせフォーム（`/contact`）に集めた。その後 FREQ-100 でメールの窓口を戻したが、フォームへの入口も残っている。FREQ-100-REQ-01 は事業者名とメールの窓口だけを求める |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_privacy.md`（ユーザー方針）、実装から推定 |

12節の事業者名とメールの下に、`/contact` への内部のリンク「お問い合わせフォーム」を出す。

## 未確認事項

- FR-PRIVACY-001 の「静的ページ」を今の形（request のたびに描く。DRV-PRIVACY-002）に直すか
- FREQ-101-REQ-01 の節の見出し（`--lk-size-xl` と `--lk-size-md`）と節の間（`space-y-12` と `space-y-8`）は、どちらが今の決まりか（`/terms` も同じ）
- 委託の一文（FREQ-495-AC-05）を PRIVACY の要求・受け入れ条件として持つか。今は写さず、設計から `FREQ-495-REQ-01（範囲外）` で指す
- SR-PRIVACY-001 を起こしたこと、DRV-PRIVACY-001〜004 を要件として認めるか（認めれば受け入れ条件を起こして E2E の名前に付けられる）
- 窓口のメール `privacy@lefildesheures.com` を受け取る箱が本番に在るか（リポジトリにも運用の文書にも作る・確かめる行が無い）
- GDPR（LEGAL-006）・保持と同意の仕組み（LEGAL-002）・メールマガジンの記載・委託先の名前（Resend・Supabase・Cloudflare Turnstile）を頁に書くか（法務の判断）
- 17TRACK の運営会社名と国を委託・国外移転の文に入れるか（ユーザーの開店前の確認待ち）
- 回数の制限の回数・窓（SEC-PRIVACY-004）、試す発送の件数と表示時間の差の幅（SEC-PRIVACY-003-AC-01）、キャッシュの扱い（SEC-PRIVACY-007）は案。ユーザーが決める
- 設定を読めない時に失敗にする（SEC-PRIVACY-005）と、方針を知る道を残す（SEC-PRIVACY-009）は向きが逆。どちらを優先するか、両立させる形をユーザーが決める
- 委託先・外部サービスをどこまで名前で書くか（SEC-PRIVACY-011）は法務の判断
- 本番の中継・メール箱・誤りの頁の設定は見ていない
