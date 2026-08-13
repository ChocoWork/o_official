/**
 * 取引が「要確認」になる理由と、担当者が何を確認すべきか。
 *
 * 状態そのものは検知ルールから毎回導出する（保存しない）。ここに置くのは
 * 「なぜ引っかかったか」と「何を見れば解消できるか」の文言だけで、
 * 確認済みの記録は admin_finance_entry_review_acks（migration 082）が持つ。
 */

export type EntryReviewReasonId =
  | "duplicate"
  | "unknownAccount"
  | "unlinkedAsset"
  | "revisedEntry";

export type EntryReviewReasonDef = {
  id: EntryReviewReasonId;
  /** 一覧・パネルの見出し。 */
  label: string;
  icon: string;
  /** なぜ要確認になったか（検知ルールと、放置した場合の影響）。 */
  why: string;
  /** 何を確認すべきか。上から順に確認すれば判断がつく並びにする。 */
  checklist: readonly string[];
};

/** 表示順は「影響が大きい順」。確認パネルもこの順に並べる。 */
export const ENTRY_REVIEW_REASONS: readonly EntryReviewReasonDef[] = [
  {
    id: "duplicate",
    label: "重複の疑い",
    icon: "ri-file-copy-line",
    why: "同じ日付・同じ取引先・同じ金額の取引が他にもあります。二重計上のままだと利益と税額がずれます。",
    checklist: [
      "下の該当取引と、摘要・注文番号・証憑を見比べる",
      "別々の取引（同日に同額を2回）なら、そのまま確認済みにする",
      "同じ取引が二重に入っていたら、余分な1件を削除する",
    ],
  },
  {
    id: "unknownAccount",
    label: "勘定科目が未登録",
    icon: "ri-file-list-3-line",
    why: "この取引の勘定科目が科目マスタにありません。決算書のどの区分に載るかが決まらず、損益計算書・貸借対照表から漏れます。",
    checklist: [
      "科目名の表記ゆれ（全角・半角、送り仮名）がないか確認する",
      "正しい科目名へ取引を訂正する",
      "科目自体が正しければ、そのまま確認済みにする",
    ],
  },
  {
    id: "unlinkedAsset",
    label: "固定資産の登録待ち",
    icon: "ri-building-line",
    why: "資産科目で計上されていますが、固定資産台帳に登録がありません。このままだと減価償却されず、その年以降の経費が計上されません。",
    checklist: [
      "取得価額が10万円以上か確認する",
      "固定資産なら台帳へ登録し、この取引と紐付ける",
      "少額など資産にしない場合は、費用として対象外にする",
    ],
  },
  {
    id: "revisedEntry",
    label: "訂正内容の確認",
    icon: "ri-file-edit-line",
    why: "法人の取引が訂正されています。訂正前後の内容と証憑が一致しているか確認する必要があります。",
    checklist: [
      "更新履歴で訂正前後の金額・日付・勘定科目を見比べる",
      "訂正後の内容が証憑と一致しているか確認する",
      "問題がなければ確認済みにする",
    ],
  },
];

export const ENTRY_REVIEW_REASON_BY_ID = new Map(
  ENTRY_REVIEW_REASONS.map((reason) => [reason.id, reason]),
);

/**
 * 確認記録のキー。
 * 注文由来の取引は DB 行を持たず id が永続しないので、注文IDで指す。
 */
export function entryReviewRef(entry: {
  id: number;
  source?: string;
  sourceId?: string;
}): string {
  if (entry.source === "order" && entry.sourceId) {
    return `order:${entry.sourceId}`;
  }
  return `entry:${entry.id}`;
}
