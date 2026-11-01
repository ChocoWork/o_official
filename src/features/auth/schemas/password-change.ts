/**
 * パスワード変更の窓口の入力の形（src/features/auth/schemas/password-change.ts）。
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { passwordSchema } from './common';

/** 開始: 現行パスワード。長さの下限は課さない（昔のパスワードも確かめられるように。上限だけ GoTrue と揃える）。 */
export const PasswordChangeStartSchema = z.object({
  current_password: z.string().min(1).max(128),
});

/** 確定: メールの 8 桁のコード（文字列。数値だと先頭の 0 が消える）と、新しいパスワード（16〜128 文字）。 */
export const PasswordChangeConfirmSchema = z.object({
  code: z.string().regex(/^\d{8}$/),
  new_password: passwordSchema,
});
