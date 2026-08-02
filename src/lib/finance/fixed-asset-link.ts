// 固定資産台帳と購入取引の連携判定。
//
// 取得仕訳は取引からしか生まれず、減価償却仕訳は台帳からしか生まれない。
// どちらか片方だけを登録すると帳簿が壊れるため、
//   ・取引側 … 台帳へ登録すべき取引を「固定資産候補」として拾い上げる
//   ・台帳側 … 取引と繋がっているかを状態として表に出す
// の両方向から記入漏れを塞ぐ。判定はすべてこのファイルの純関数に寄せる。

import { accountByName } from "./accounts";
import type { DepreciationMethod } from "./depreciation";
import type { FinanceEntry } from "./journal";

/**
 * 固定資産として計上する取得価額の下限（国税庁 No.2100）。
 * 10万円未満は取得年に全額を必要経費へ算入できる。
 */
export const ASSET_THRESHOLD = 100_000;

/** 一括償却資産（3年均等）として扱える取得価額の上限。 */
export const LUMP_SUM_THRESHOLD = 200_000;

/** 固定資産の勘定科目が属する決算書区分。 */
export const FIXED_ASSET_SECTIONS = ["有形固定資産", "無形固定資産"] as const;

/**
 * 固定資産と紛らわしい費用科目。
 * これらで 10万円以上を支出しているときは科目の付け間違いを疑う。
 */
export const SUSPECT_EXPENSE_ACCOUNTS = [
  "消耗品費",
  "事務用品費",
  "修繕費",
] as const;

/** 勘定科目名が固定資産の科目か。 */
export function isFixedAssetAccount(name: string): boolean {
  const account = accountByName(name);
  if (!account) return false;
  return (FIXED_ASSET_SECTIONS as readonly string[]).includes(account.section);
}

/**
 * 取引の固定資産候補クラス。
 *
 * asset    勘定科目が固定資産。取得仕訳が既に資産として立っているので、
 *          台帳への登録は必須。費用として処理する逃げ道は用意しない。
 * suspect  費用科目だが 10万円以上。科目の付け間違いの疑い。
 *          科目を直せば asset になるため、台帳へは直行させない。
 */
export type AssetCandidateClass = "asset" | "suspect";

/** 候補判定に必要な取引の形。`fixedAssetExempt` は確認済みで除外した印。 */
export type AssetCandidateEntry = FinanceEntry & {
  fixedAssetExempt?: boolean;
  fixedAssetExemptReason?: string | null;
};

/** 取引が固定資産候補か。候補でなければ null。 */
export function classifyAssetCandidate(
  entry: AssetCandidateEntry,
): AssetCandidateClass | null {
  // 収入は資産の取得ではない。
  if (entry.entryType !== "expense") return null;

  // 利用者が理由付きで対象外と判断した取引は、科目にかかわらず確認済み。
  if (entry.fixedAssetExempt) return null;

  if (isFixedAssetAccount(entry.category)) return "asset";

  const isSuspectAccount = (
    SUSPECT_EXPENSE_ACCOUNTS as readonly string[]
  ).includes(entry.category);
  if (isSuspectAccount && entry.amount >= ASSET_THRESHOLD) return "suspect";

  return null;
}

/**
 * 固定資産の取引連携の状態。
 *
 * linked       購入取引と繋がっていて証憑もある
 * noReceipt    購入取引と繋がっているが証憑が無い（電子帳簿保存法の可視性）
 * entryMissing 連携先の取引が見つからない（論理削除された）
 * direct       取引を経由せず直接登録された（期首残高の移行・過去資産・現物発見）
 */
export type FixedAssetLinkStatus =
  | "linked"
  | "noReceipt"
  | "entryMissing"
  | "direct";

export const FIXED_ASSET_LINK_STATUS_LABELS: Record<
  FixedAssetLinkStatus,
  string
> = {
  linked: "取引連携済み",
  noReceipt: "証憑不足",
  entryMissing: "取引が削除済み",
  direct: "直接登録",
};

/** 状態判定に必要な固定資産の形。 */
export type LinkableFixedAsset = {
  id: number;
  acquiredOn: string;
  entryId: number | null;
};

/** 状態判定に必要な取引の形。証憑の有無だけを見る。 */
export type LinkedEntry = { id: number; receipts?: readonly unknown[] };

function yearOf(date: string): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

/**
 * 固定資産の取引連携の状態を1つに決める。
 *
 * `entry` は `asset.entryId` に対応する取引。会計期間を切り替えて表示している
 * 都合上、別年度に取得した資産の取引は手元に無い。取引が見つからないことを
 * 「削除された」と断定できるのは、取得年が表示中の年度と一致するときだけ。
 */
export function fixedAssetLinkStatus(
  asset: LinkableFixedAsset,
  entry: LinkedEntry | undefined,
  loadedFiscalYear: number,
): FixedAssetLinkStatus {
  if (asset.entryId === null) return "direct";
  if (!entry) {
    return yearOf(asset.acquiredOn) === loadedFiscalYear
      ? "entryMissing"
      : "linked";
  }
  return entry.receipts && entry.receipts.length > 0 ? "linked" : "noReceipt";
}

/**
 * 台帳へ未登録の固定資産取引。取引管理の確認キューに出す。
 * suspect は科目を直させるのが先なのでここには含めない。
 */
export function unlinkedAssetEntries<T extends AssetCandidateEntry>(
  entries: readonly T[],
  assets: readonly LinkableFixedAsset[],
): T[] {
  const linkedEntryIds = new Set(
    assets
      .map((asset) => asset.entryId)
      .filter((entryId): entryId is number => entryId !== null),
  );
  return entries.filter(
    (entry) =>
      classifyAssetCandidate(entry) === "asset" && !linkedEntryIds.has(entry.id),
  );
}

/** 台帳で確認する未処理候補。固定資産科目と高額な費用科目の疑いをまとめて返す。 */
export function pendingAssetCandidateEntries<T extends AssetCandidateEntry>(
  entries: readonly T[],
  assets: readonly LinkableFixedAsset[],
): T[] {
  const linkedEntryIds = new Set(
    assets
      .map((asset) => asset.entryId)
      .filter((entryId): entryId is number => entryId !== null),
  );
  return entries.filter(
    (entry) => classifyAssetCandidate(entry) !== null && !linkedEntryIds.has(entry.id),
  );
}

/**
 * 取得価額から償却方法の初期値を推奨する。
 * 30万円未満の少額減価償却資産の特例は青色申告者の選択なので自動では選ばない。
 */
export function suggestDepreciationMethod(amount: number): DepreciationMethod {
  if (amount < ASSET_THRESHOLD) return "immediate";
  if (amount < LUMP_SUM_THRESHOLD) return "lumpSum3Year";
  return "straightLine";
}

/**
 * 表示用の管理番号 FA-2026-0042。
 * 取得年と id から導出するので台帳に列を増やさない。
 */
export function fixedAssetCode(asset: {
  id: number;
  acquiredOn: string;
}): string {
  return `FA-${asset.acquiredOn.slice(0, 4)}-${String(asset.id).padStart(4, "0")}`;
}
