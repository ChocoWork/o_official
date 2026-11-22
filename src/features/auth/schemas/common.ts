import { z } from 'zod';

// 日本語エラーメッセージをデフォルトで設定
z.setErrorMap((issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: '型が正しくありません' };
    case 'too_small':
      if (issue.type === 'string') return { message: '入力が短すぎます' };
      return { message: '値が小さすぎます' };
    case 'too_big':
      if (issue.type === 'string') return { message: '入力が長すぎます' };
      return { message: '値が大きすぎます' };
    case 'invalid_format':
      if ('format' in issue && issue.format === 'email') {
        return { message: 'メールアドレスの形式が正しくありません' };
      }
      return { message: '文字列の形式が正しくありません' };
    case 'custom':
      return { message: issue.message ?? '無効な値です' };
    default:
      return { message: issue.message ?? '入力が無効です' };
  }
});

// 形の確認（.email()）は後続の transform より前に走るので、先に trim しないと前後に空白のあるメールが断られる。
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'メールアドレスの形式が正しくありません' });

export type Email = z.infer<typeof emailSchema>;

// Zod エラーを仕様に合わせたオブジェクトに変換するユーティリティ
export function formatZodError(err: unknown) {
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { code: 'validation_error', message: '入力に誤りがあります', detail: issues };
  }
  return { code: 'invalid_request', message: '無効なリクエスト' };
}
