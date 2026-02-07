import { z } from 'zod';

// 日本語エラーメッセージをデフォルトで設定
z.setErrorMap((issue, _ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: '型が正しくありません' };
    case 'too_small':
      if (issue.type === 'string') return { message: '入力が短すぎます' };
      return { message: '値が小さすぎます' };
    case 'too_big':
      if (issue.type === 'string') return { message: '入力が長すぎます' };
      return { message: '値が大きすぎます' };
    case 'invalid_string':
      if (issue.validation === 'email') return { message: 'メールアドレスの形式が正しくありません' };
      return { message: '文字列の形式が正しくありません' };
    case 'custom':
      return { message: issue.message ?? '無効な値です' };
    default:
      return { message: issue.message ?? '入力が無効です' };
  }
});

export const emailSchema = z
  .string()
  .email({ message: 'メールアドレスの形式が正しくありません' })
  .transform((s) => s.trim().toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, { message: 'パスワードは8文字以上で入力してください' })
  .max(128, { message: 'パスワードは128文字以内で入力してください' });

export type Email = z.infer<typeof emailSchema>;
export type Password = z.infer<typeof passwordSchema>;

// Zod エラーを仕様に合わせたオブジェクトに変換するユーティリティ
export function formatZodError(err: unknown) {
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { code: 'validation_error', message: '入力に誤りがあります', detail: issues };
  }
  return { code: 'invalid_request', message: '無効なリクエスト' };
}
