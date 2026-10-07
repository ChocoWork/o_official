import { PROMOTION_CODE_PATTERN } from "@/features/checkout/services/promotion-code.service";

export type RememberedPromotionCode = { code: string };

const STORAGE_KEY = "checkout:promotion-code";

/** カートへ戻っても、このタブで適用したコードを確かめ直せるようにする。 */
export function rememberPromotionCode(promotion: RememberedPromotionCode): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(promotion));
  } catch {
    // 記録できなくても、いまの画面で適用した割引は使える。
  }
}

export function clearPromotionCode(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 記録が残っても、次に入力画面を開いたときにサーバーで確かめ直す。
  }
}

/** 保存した金額は信用せず、コードだけを読んでサーバーへ確かめ直す。壊れた記録は捨てる。 */
export function readPromotionCode(): RememberedPromotionCode | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      "code" in parsed && typeof parsed.code === "string" && PROMOTION_CODE_PATTERN.test(parsed.code)
    ) {
      return { code: parsed.code };
    }
  } catch {
    // 保存域や JSON が読めなくても、割引なしで入力画面から進める。
  }
  clearPromotionCode();
  return null;
}
