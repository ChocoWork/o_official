# privacy セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/17_privacy.md](../4_DetailDesign/17_privacy.md)
- レビュー観点: フロントエンド、共通レイアウト依存、不要な外部/動的処理 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/layout.tsx](../../src/app/layout.tsx) | /privacy のような静的なポリシーページでも Cloudflare Turnstile の外部スクリプトを常時読み込んでおり、不要なサードパーティ実行面と閲覧メタデータ送信面を増やしている | Turnstile は認証フォームや CAPTCHA が必要な画面だけで条件付き読込に分離する | Open | High |
| [src/contexts/Providers.tsx](../../src/contexts/Providers.tsx) | /privacy 表示時にも共通 Provider 経由で cart/wishlist のクライアント API 呼び出しが走り、静的公開ページとして不要なバックエンド通信と攻撃面を増やしている | 情報ページ用の軽量レイアウトを分離するか、cart/wishlist 取得を UI 操作時の遅延読込に変更する | Open | High |
| [src/app/layout.tsx](../../src/app/layout.tsx) | headers() に依存して nonce を取得しているため、/privacy が実質的にリクエスト依存レンダリングになり、静的ページに不要な動的処理が入っている | nonce が必要なスクリプト配置を該当ルート群へ限定し、/privacy では request-bound な処理を外す | Open | High |
| [src/app/layout.tsx](../../src/app/layout.tsx) | jsDelivr 上の外部 CSS を SRI なしで全ページ読込しており、共通レイアウト経由で privacy ページにもサプライチェーンリスクを持ち込んでいる | アイコンフォントを自己ホストするか、固定可能なら integrity 付き配信へ切り替える | Open | High |