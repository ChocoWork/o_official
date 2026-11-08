# 運用文書

> 状態: 現行 | 確認日: 2026-11-08 | 対象: 運用文書と Git フック

## 概要

このディレクトリは DB 変更、シークレット、注文証憑アーカイブなどの運用手順をまとめる。ソース上の構成は本番での実行結果を保証しない。適用前に対象環境と現行設定を確認する。

| 文書 | 用途 | 注意 |
| --- | --- | --- |
| `docs/06_Operations/deployment-topology.md` | コードから確認できる外部連携と未確認事項 | 本番配置を断定しない |
| `docs/06_Operations/db-migrations.md` | Supabase CLI による DB 変更と台帳管理 | 対象プロジェクトと適用履歴を確認する |
| `docs/06_Operations/secrets.md` | 秘密値の管理、Stripe 同期 | 値そのものは文書に記録しない |
| [Supabase Auth の設定](supabase-auth-config.md) | 本番の Supabase Auth の目標の値（確認メール必須・captcha・最小長 16・OTP 300 秒・TOTP ほか）、段階 A・B の手順、戻し方、手で変える項目 | 手元は 2026-11-01 に切り替え済み、本番は未反映。Management API の変更は一つずつ許可を得て行う |
| `docs/06_Operations/webhook-queue-operations.md` | Stripe の知らせのキューと定期処理（開店のときの順番・合言葉の入れ替え・知らせが届いたときの調べ方） | 本番は読むだけの SQL で確かめる |
| [注文のメールの手順書](order-email-operations.md) | 注文のメールの送信・やり直し・一時停止・配達の見回り・店への知らせ | 環境の門、24時間の重複防止、読み取り権限を公開前に確かめる |
| [割引の手順書](group-h-discounts.md) | 共有・1人用コードの作成、編集、停止・再開、使用回数、要対応の確認 | 未入金で終了した注文は回数を戻し、入金後は返金しても戻さない |
| `docs/06_Operations/legal-archive.md` | 注文証憑の保存と復元確認 | 保存結果と復元結果を別途確認する |
| [取引書類の運用](purchase-order-documents.md) | 発注書に添付する見積書・請求書の原本（保存期間・片側だけ失敗した時の見方と再開・`sha256_source`・署名つきリンク） | 入れ物の設定、保存期間の起算点、置き場の WORM は公開前に確かめる |
| `docs/06_Operations/kpi-migration-setup.md` | KPI 目標管理のセットアップ記録 | 履歴。現行DBへのSQL再実行に使わない |
| `docs/06_Operations/archive/auth_migration.md` | 旧認証 DB 移行手順 | 履歴であり、現在の適用手順ではない |

DB スキーマ適用の現行ワークフローは `.github/workflows/db-migrations.yml` にある。旧 `migrations/*.sql` の一括再実行手順は現行の適用経路として使用しない。

## push の前の確認

[`scripts/hooks/pre-push`](../../scripts/hooks/pre-push) は lint → 型検査 → Jest 全件 → E2E の順で確認する。3/4 は `npm test -- --silent` を呼ぶ。`npm test` は [`scripts/test/run-unit-tests.mjs`](../../scripts/test/run-unit-tests.mjs) で、次の2段階を実行する。

1. 通常の [`jest.config.cjs`](../../jest.config.cjs) で、速さを測る試験を除いた全件を並列で流す。`node_modules` と `.claude` の既存の除外は残す。
2. 1 が成功したら、[`jest.timing.config.cjs`](../../jest.timing.config.cjs) で速さを測る試験だけを `--runInBand --passWithNoTests` で1本ずつ流す。対象が無ければ成功とする。

速さを測る試験は、名前の終わりを `.timing.test.ts` にする。この名前の決まりは、両方の設定が読む [`scripts/test/jest-timing.cjs`](../../scripts/test/jest-timing.cjs) だけで定める。現在は `tests/items/items-api.timing.test.ts` と `tests/unit/lib/discounts/discount-search.timing.test.ts` が対象で、割引の時間を測らない14件は `discount-search.test.ts` に残す。試験の中身と200ms未満の条件は変えない。

`npm test -- <引数>` のパスの絞り込みや `--silent` は両段へ渡す。前段が失敗したら後段は実行せず、どちらかが失敗すればその終了コードで終わり、push を止める。両方が通った後の E2E の実行条件と警告扱いは従来どおり。

- 速さの試験だけを指定すると、前段に当たる試験が無く「No tests found」で失敗する（打ち間違いを黙って通さないため、前段に `--passWithNoTests` は付けない）。速さの試験を1本だけ流す時は `npx jest -c jest.timing.config.cjs <パス>` を使う。
- `-c`・`--config`・`--watch`・`--watchAll`・`--coverage`・`--collectCoverage` は2段と合わないので、`npm test` は終了コード2で止める。これらは `npx jest` を直に使う。

## コミットの前の確認

[`scripts/hooks/pre-commit`](../../scripts/hooks/pre-commit) は、ステージした `.ts`・`.tsx` の lint → 型検査 → 関連する Jest の順で確認する。関連する Jest は、通常の設定で `--findRelatedTests $STAGED --passWithNoTests --silent` を流す。失敗すれば `set -e` でコミットを止める。

速さの試験（`.timing.test.ts`）は通常の設定で外れるので、コミットの前には流れない。割引の探索の速さの試験が1本だけで約100秒かかるため、2026-11-08 にオーナーが「コミットの前は流さない」と決めた。速さの試験は `npm test` と pre-push の後段で必ず1本ずつ流れる。遅くなったことに気づくのは push の時になる。
