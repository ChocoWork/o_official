# 運用文書

## 概要

このディレクトリは DB 変更、シークレット、注文証憑アーカイブなどの運用手順をまとめる。ソース上の構成は本番での実行結果を保証しない。適用前に対象環境と現行設定を確認する。

| 文書 | 用途 | 注意 |
| --- | --- | --- |
| `docs/06_Operations/deployment-topology.md` | コードから確認できる外部連携と未確認事項 | 本番配置を断定しない |
| `docs/06_Operations/db-migrations.md` | Supabase CLI による DB 変更と台帳管理 | 対象プロジェクトと適用履歴を確認する |
| `docs/06_Operations/secrets.md` | 秘密値の管理、Stripe 同期 | 値そのものは文書に記録しない |
| `docs/06_Operations/webhook-queue-operations.md` | Stripe の知らせのキューと定期処理（開店のときの順番・合言葉の入れ替え・知らせが届いたときの調べ方） | 本番は読むだけの SQL で確かめる |
| [注文のメールの手順書](order-email-operations.md) | 注文のメールの送信・やり直し・一時停止・配達の見回り・店への知らせ | 環境の門、24時間の重複防止、読み取り権限を公開前に確かめる |
| `docs/06_Operations/legal-archive.md` | 注文証憑の保存と復元確認 | 保存結果と復元結果を別途確認する |
| `docs/06_Operations/kpi-migration-setup.md` | KPI 目標管理のセットアップ記録 | 履歴。現行DBへのSQL再実行に使わない |
| `docs/06_Operations/archive/auth_migration.md` | 旧認証 DB 移行手順 | 履歴であり、現在の適用手順ではない |

DB スキーマ適用の現行ワークフローは `.github/workflows/db-migrations.yml` にある。旧 `migrations/*.sql` の一括再実行手順は現行の適用経路として使用しない。
