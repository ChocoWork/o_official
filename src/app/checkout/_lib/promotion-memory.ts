import { PROMOTION_CODE_PATTERN } from "@/features/checkout/services/promotion-code.service";

const STORAGE_KEY = "checkout:promotion-codes";
/** 単一コードだった頃の記録。初回の読取で配列へ取り込んで消す。 */
const LEGACY_STORAGE_KEY = "checkout:promotion-code";
const MAX_CODES = 5;

function normalize(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim().toUpperCase()))];
}

function isCodeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_CODES && value.every((code) => typeof code === "string" && PROMOTION_CODE_PATTERN.test(code));
}

/** カートへ戻っても、このタブで入力したコードを確かめ直せるようにする。コード以外（金額・資格・メール・名前）は保存しない。 */
export function writePromotionCodes(codes: readonly string[]): void {
  const normalized = normalize(codes);
  try {
    if (normalized.length === 0) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, codes: normalized }));
  } catch {
    // 記録できなくても、いまの画面で適用した割引は使える。
  }
}

export function clearPromotionCodes(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 記録が残っても、次に入力画面を開いたときにサーバーで確かめ直す。
  }
}

function readLegacyCode(): string | null {
  const raw = window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) return null;
  window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "code" in parsed && typeof parsed.code === "string" && PROMOTION_CODE_PATTERN.test(parsed.code)) {
      return parsed.code.toUpperCase();
    }
  } catch {
    // 壊れた旧記録は捨てる。
  }
  return null;
}

/** 保存した金額は信用せず、コードだけを読んでサーバーへ確かめ直す。壊れた記録は捨てる。 */
export function readPromotionCodes(): string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      const legacy = readLegacyCode();
      if (legacy === null) return [];
      writePromotionCodes([legacy]);
      return [legacy];
    }
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
        Object.keys(parsed).sort().join(",") === "codes,version" &&
        "version" in parsed && parsed.version === 1 && "codes" in parsed && isCodeList(parsed.codes)
      ) {
        return normalize(parsed.codes);
      }
    } catch {
      // 壊れた記録は下で捨てる。
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存域が読めなくても、割引なしで入力画面から進める。
  }
  return [];
}
