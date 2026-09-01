/**
 * 既存マイグレーションを再生するための補正パッチ。
 *
 * migrations/*.sql は本番の再現手段になっていない。実測で判明した乖離:
 *   - 007 は has_permission を使うが、定義は 023。順序が破綻している
 *   - 020 / 021 は UNIQUE 制約に COALESCE 式を書いており Postgres で実行不可
 *     （式を使えるのは UNIQUE 制約ではなく UNIQUE インデックス）
 *   - 020 / 021 は profiles(id) を参照するが、本番の profiles に id 列は無い（PK は user_id）
 *
 * ファイル自体は履歴として残したいので書き換えず、再生時にだけ当てる。
 * 本番のカタログから採った定義に合わせているので、再生結果は本番と一致するはず。
 */

/** ファイル適用前に流す SQL。 */
export const PRE_SQL = {
  // 023 が CREATE OR REPLACE で本実装に差し替えるので、ここではスタブで十分。
  // 引数名・引数型・戻り値型を 023 と揃えないと CREATE OR REPLACE が通らない。
  "007_create_audit_logs.sql": `
    CREATE OR REPLACE FUNCTION public.has_permission(permission_code text)
    RETURNS boolean LANGUAGE sql AS $stub$ SELECT false $stub$;
  `,
};

/** ファイル本文へのテキスト置換。 */
export const TEXT_PATCHES = {
  "020_create_cart_table.sql": [
    // 本番の外部キーは profiles(user_id)
    { from: "REFERENCES public.profiles(id)", to: "REFERENCES public.profiles(user_id)" },
    // 式を含む UNIQUE 制約は不正。丸ごと落として、後段でインデックスとして作り直す。
    {
      from: /,\s*\n\s*--[^\n]*\n\s*CONSTRAINT cart_unique_per_user_session_item UNIQUE\([\s\S]*?\n\s*\)/,
      to: "\n",
    },
  ],
  "021_create_wishlist_table.sql": [
    { from: "REFERENCES public.profiles(id)", to: "REFERENCES public.profiles(user_id)" },
    {
      from: /,\s*\n\s*--[^\n]*\n\s*CONSTRAINT wishlist_unique_per_user_session_item UNIQUE\([\s\S]*?\n\s*\)/,
      to: "\n",
    },
  ],
};

/** ファイル適用後に流す SQL。本番のカタログから採った定義そのまま。 */
export const POST_SQL = {
  "020_create_cart_table.sql": `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_unique_per_user_session_item
      ON public.carts USING btree (
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(session_id, ''::text),
        item_id,
        COALESCE(color, ''::text),
        COALESCE(size, ''::text)
      );
  `,
  "021_create_wishlist_table.sql": `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_unique_per_user_session_item
      ON public.wishlist USING btree (
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(session_id, ''::text),
        item_id
      );
  `,
};
