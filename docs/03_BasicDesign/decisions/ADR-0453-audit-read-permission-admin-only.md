# ADR-0453 監査ログの閲覧は専用の権限 admin.audit.read で守り、店長にだけ付ける

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/audit-logs/route.ts`、`supabase/migrations/20261023061453_audit_read_permission.sql` | 基準コミット: `4facf63b`

## 概要

監査ログの窓口は、役割の名前でなく専用の権限の印 `admin.audit.read`（名前「監査ログの閲覧」）で守る。移行はこの権限を登録して店長（`admin`）にだけ結び、ほかの役割の今の結び付きは消さない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | FREQ-508-REQ-01 |
| 対象のコード | `src/app/api/admin/audit-logs/route.ts`、`supabase/migrations/20261023061453_audit_read_permission.sql` |
| 関連文書 | `docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md`（監査ログの権限の項）、`docs/superpowers/specs/2026-10-23-group-g-design.md`（監査の閲覧は店長だけ） |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0453 監査ログの閲覧は専用の権限 admin.audit.read で守り、店長にだけ付ける

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-508-REQ-01 |
| 根拠 | 監査ログには管理の操作の跡が全部残るので、読む人を店長に絞る。役割の名前で決め打ちせず権限の印にすれば、窓口は権限の有る無しだけを見ればよく、付け外しは DB の ACL の1か所で済む。既にある結び付きを消さないのは、ほかの役割の操作を壊さないため（`docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md` の監査ログの権限の項）。元の文書は「店長だけ」と決めるだけで理由を書いていないので、理由は書き手が補った（推定） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md`、`docs/superpowers/specs/2026-10-23-group-g-design.md`、`docs/02_Requirements/requirements.md`（FREQ-508） |

#### 背景

- 監査ログの窓口は前から `admin.audit.read` を求めていたが（git `77def926`）、DB の権限の表にこの印が無く、ACL で付けられなかった（`docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md` の監査ログの権限の項）
- 権限と割当の設計（`docs/superpowers/specs/2026-10-23-group-g-design.md`）の権限の表は、監査の閲覧を店長は可、サポーターは不可とする

#### 決定

- 移行が `admin.audit.read`（名前「監査ログの閲覧」）を権限の表に入れ、既にあれば名前だけ直す。結び付けるのは店長の役割だけで、重ねて当てても増えない（`20261023061453_audit_read_permission.sql`、`launch-fixes-wave1.md`）
- ほかの役割の今の結び付きは消さない
- 窓口は `admin.audit.read` を共有の認可の部品に渡すだけで、役割の名前を見ない（`audit-logs/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| サポーターにも付ける | 監査ログは管理の操作の跡で、発送の担当には要らない（`group-g-design.md` の不可） |
| 窓口で役割の名前（店長か）を見る | 権限の付け外しが ACL と窓口の2か所に分かれる（FREQ-508-REQ-01 の根拠） |

#### 結果

- 良くなること: 店長だけが読め、付け外しは ACL で済む
- 悪くなること: 監査ログを読む画面が無いので、店長は窓口を直接呼ぶしかない（FREQ-508-AC-01 の「一覧が表示される」と合わない。TM-ADMIN-02）
- 見直す条件: 監査ログを読む画面を作る時、サポーターにも読ませる必要が出た時

## 未確認事項

- 監査ログを読む画面を作るか（FREQ-508-AC-01。今は窓口だけがある。ユーザーの判断）
