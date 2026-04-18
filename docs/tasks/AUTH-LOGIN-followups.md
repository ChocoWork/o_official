# AUTH-LOGIN-FOLLOWUPS

## 対象
- docs/4_DetailDesign/14_login.md

## TODO
- [x] FR-LOGIN-003: LoginModal にパスワード再設定導線を追加する
- [x] FR-LOGIN-005: login ページを Server Component 化し generateMetadata を実装する
- [x] AUTH-01-SUPA-05: 登録/確認フローの既存統合テスト有無を確認し、14_login.md の実装ステータスを実態に合わせて更新する
- [x] AUTH-01-IDF-09: identify API 既存テストを確認し、LoginModal UI テストを追加する
- [x] AUTH-01-IDF-10: ログイン要件単位の Playwright 試験を追加する
- [ ] AUTH-01-IDF-14: Supabase Dashboard の OTP コード送信モードを手動確認する
- [x] AUTH-SEC-001: HSTS 実装有無を確認し、14_login.md を更新する
- [x] AUTH-SEC-007: secrets 運用手順の既存ドキュメントを確認し、14_login.md を更新する
- [x] AUTH-SEC-008: JTI 再利用検出テストの既存有無を確認し、14_login.md を更新する
- [x] AUTH-SEC-009: CSP ヘッダの既存実装を確認し、14_login.md を更新する
- [ ] AUTH-SEC-010: WAF/CDN 設定をインフラ側で手動確認する
- [ ] AUTH-SEC-012: 監査証跡保全のハッシュチェーン設計を別タスク化する
- [ ] AUTH-02-AC-009: OAuth 既存メール衝突時の link-proposal 導線を実装する
- [ ] AUTH-02-CFG-001: Google Cloud Console の redirect URI を手動確認する
- [ ] AUTH-02-CFG-002: Supabase Google Provider 設定を手動確認する
- [ ] AUTH-02-CFG-003: Supabase Redirect URLs 設定を手動確認する

## 実装方針
- コード修正対象は login ページ metadata と LoginModal 導線を優先する。
- 試験ファイルは FR-LOGIN 要件ごとに Playwright で追加し、WONT/外部設定依存は skip で明示する。
- 外部サービス設定が必要な項目は TODO を残し、コード側から確認できる範囲のみ反映する。