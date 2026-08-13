// 申告資料。申告に必要な資料を1か所に集め、状態と不足を見えるようにする。
//
// 並ぶのはこの画面から出力できる資料だけ。状態は帳簿・証憑の実データから決まる。
// 左＝資料の一覧、右＝選択した資料の中身と検証結果、下＝提出までの段取り。

import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  buildFilingDocuments,
  FILING_DOCUMENT_SOURCE_LABELS,
  FILING_DOCUMENT_STATUS_LABELS,
  type FilingDocument,
} from "@/lib/finance/tax";
import type { TaxReportProps } from "@/components/tax/types";
import {
  ProgressRing,
  StateBadge,
  TaxMetricCard,
  boxRadiusClassName,
  panelTitleClassName,
} from "@/components/tax/shared";

/** 提出までの段取り。前の段が終わってから次へ進む。 */
const PACKAGE_STEPS = [
  { key: "ledger", label: "帳簿一致", note: "帳簿と決算書の数値が一致" },
  { key: "receipts", label: "証憑確認", note: "証憑の収集・紐付けを確認" },
  { key: "privacy", label: "個人情報確認", note: "マスキング・除外設定を確認" },
  { key: "approval", label: "最終承認", note: "承認者による最終確認" },
] as const;

export function FilingDocumentsView({
  fiscalYear,
  fiscalYearLabel,
  balanceSheet,
  fixedAssets,
  closedAt,
  entryCounts,
  onExportJournal,
  onNavigate,
}: TaxReportProps) {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const inventory = useMemo(
    () =>
      buildFilingDocuments({
        fiscalYear,
        journalCount: entryCounts.total,
        receiptCount: entryCounts.withReceipt,
        missingReceiptCount: entryCounts.withoutReceipt,
        expenseCount: entryCounts.expense,
        incomeCount: entryCounts.income,
        fixedAssetCount: fixedAssets.length,
        closedAt,
        isBalanced: balanceSheet.isBalanced,
      }),
    [
      fiscalYear,
      entryCounts,
      fixedAssets.length,
      closedAt,
      balanceSheet.isBalanced,
    ],
  );

  const categories = useMemo(
    () => [...new Set(inventory.documents.map((item) => item.category))],
    [inventory.documents],
  );

  const filtered = inventory.documents.filter((document) => {
    if (category !== "all" && document.category !== category) return false;
    if (status !== "all" && document.status !== status) return false;
    if (keyword.trim() && !document.name.includes(keyword.trim())) return false;
    return true;
  });

  // カテゴリごとにまとめる。表の中で見出し行として出す。
  const grouped = useMemo(() => {
    const map = new Map<string, FilingDocument[]>();
    for (const document of filtered) {
      map.set(document.category, [
        ...(map.get(document.category) ?? []),
        document,
      ]);
    }
    return [...map.entries()];
  }, [filtered]);

  const selected =
    inventory.documents.find((document) => document.key === selectedKey)
    ?? inventory.documents[0];

  // 段取りの進み具合。帳簿一致と証憑が終わっていれば次の段へ進める。
  const stepStates: Record<string, "done" | "current" | "idle"> = {
    ledger: balanceSheet.isBalanced ? "done" : "current",
    receipts: !balanceSheet.isBalanced
      ? "idle"
      : entryCounts.withoutReceipt === 0
        ? "done"
        : "current",
    privacy:
      balanceSheet.isBalanced && entryCounts.withoutReceipt === 0
        ? "current"
        : "idle",
    approval: closedAt ? "current" : "idle",
  };

  const validations = selected
    ? ([
        ["必須項目の入力", selected.status !== "notCreated"],
        ["帳簿との一致", balanceSheet.isBalanced],
        ["証憑の充足", selected.missingCount === 0],
        ["関連仕訳の紐付け", selected.entryCount > 0],
      ] as const)
    : [];

  return (
    <div className="space-y-4">
      <h3 className="font-acumin text-base font-medium tracking-widest text-black">
        申告資料
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TaxMetricCard
          icon="ri-file-list-3-line"
          label="必要資料"
          value={`${inventory.requiredCount} 件`}
          note={`${fiscalYearLabel}の申告に必要な資料`}
        />
        <TaxMetricCard
          icon="ri-checkbox-circle-line"
          label="準備完了"
          value={`${inventory.readyCount} 件`}
          note={`準備完了率 ${Math.round(inventory.progress)}%`}
          tone="positive"
        />
        <TaxMetricCard
          icon="ri-error-warning-line"
          label="証憑不足"
          value={`${inventory.missingReceiptCount} 件`}
          note={`未添付 ${entryCounts.withoutReceipt} 件 / 理由記録済み ${entryCounts.unavailableRecorded} 件`}
          tone={inventory.missingReceiptCount > 0 ? "warning" : "positive"}
        />
        <TaxMetricCard
          icon="ri-question-line"
          label="要確認"
          value={`${inventory.reviewCount} 件`}
          note="作成中の資料"
          tone={inventory.reviewCount > 0 ? "warning" : "positive"}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <SearchField
            size="2xs"
            aria-label="資料名を検索"
            placeholder="資料名を検索"
            className="font-acumin [&_[data-ui-search-field-input]]:rounded-md"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            showClearButton
            onClear={() => setKeyword("")}
            onSearch={() => setKeyword((value) => value.trim())}
            searchButtonAriaLabel="資料名を検索する"
          />
        </div>
        <SingleSelect
          variant="dropdown"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          aria-label="カテゴリ"
          options={[
            { value: "all", label: "カテゴリ：すべて" },
            ...categories.map((item) => ({ value: item, label: item })),
          ]}
          value={category}
          onValueChange={setCategory}
        />
        <SingleSelect
          variant="dropdown"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          aria-label="状態"
          options={[
            { value: "all", label: "状態：すべて" },
            { value: "created", label: "作成済み" },
            { value: "drafting", label: "作成中" },
            { value: "notCreated", label: "未作成" },
          ]}
          value={status}
          onValueChange={setStatus}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="申告資料一覧"
          title={<span className={panelTitleClassName}>申告資料一覧</span>}
        >
          {grouped.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              条件に一致する資料がありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {[
                      "資料名",
                      "対象期間",
                      "関連仕訳",
                      "ファイル",
                      "入力元",
                      "状態",
                    ].map((heading) => (
                      <th
                        key={heading}
                        className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(([group, documents]) => (
                    <Fragment key={group}>
                      <tr className="bg-[#fafafa]">
                        <td
                          colSpan={6}
                          className="px-2 py-1.5 font-acumin text-[11px] font-medium text-[#474747]"
                        >
                          <i
                            className="ri-arrow-down-s-line mr-1"
                            aria-hidden="true"
                          />
                          {group}
                        </td>
                      </tr>
                      {documents.map((document) => {
                        const active = selected?.key === document.key;
                        return (
                          <tr
                            key={document.key}
                            onClick={() => setSelectedKey(document.key)}
                            className={`cursor-pointer border-b border-[#ededed] transition-colors hover:bg-[#faf7f2] ${active ? "bg-[#f2f8f4]" : ""}`}
                          >
                            <td className="px-2 py-2.5 font-acumin text-xs text-black">
                              <i
                                className="ri-file-text-line mr-1.5 text-[#707070]"
                                aria-hidden="true"
                              />
                              {document.name}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747] tabular-nums">
                              {document.period}
                            </td>
                            <td className="px-2 py-2.5 text-right font-acumin text-[11px] text-[#474747] tabular-nums">
                              {document.entryCount === 0
                                ? "—"
                                : `${document.entryCount} 件`}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2.5">
                              <span className="inline-flex items-center gap-1.5">
                                <i
                                  className={
                                    document.fileKind === "pdf"
                                      ? "ri-file-pdf-2-line text-[#b91c1c]"
                                      : "ri-file-excel-2-line text-[#16844b]"
                                  }
                                  aria-hidden="true"
                                />
                                <span className="font-acumin text-[11px] text-[#474747]">
                                  {document.fileName}
                                </span>
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747]">
                              {FILING_DOCUMENT_SOURCE_LABELS[document.source]}
                            </td>
                            <td className="px-2 py-2.5">
                              <StateBadge
                                state={
                                  document.missingCount > 0
                                    ? "todo"
                                    : document.status === "created"
                                      ? "done"
                                      : document.status === "drafting"
                                        ? "todo"
                                        : "idle"
                                }
                              >
                                {document.missingCount > 0
                                  ? "証憑不足"
                                  : FILING_DOCUMENT_STATUS_LABELS[
                                      document.status
                                    ]}
                              </StateBadge>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 font-acumin text-[10px] leading-relaxed text-[#707070]">
            ※
            PDF・Excelは帳簿から自動生成したファイルです。内容に問題がある場合は再生成してください。
          </p>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="資料詳細"
          title={<span className={panelTitleClassName}>資料詳細</span>}
        >
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-14 w-11 shrink-0 items-center justify-center border border-[#ededed] bg-[#fafafa] ${boxRadiusClassName}`}
                  aria-hidden="true"
                >
                  <i
                    className={
                      selected.fileKind === "pdf"
                        ? "ri-file-pdf-2-line text-xl text-[#b91c1c]"
                        : "ri-file-excel-2-line text-xl text-[#16844b]"
                    }
                  />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-acumin text-xs font-medium text-black">
                      {selected.name}
                    </span>
                    <StateBadge
                      state={
                        selected.status === "created"
                          ? "done"
                          : selected.status === "drafting"
                            ? "todo"
                            : "idle"
                      }
                    >
                      {FILING_DOCUMENT_STATUS_LABELS[selected.status]}
                    </StateBadge>
                  </p>
                  <p className="mt-1 font-acumin text-[10px] text-[#707070] tabular-nums">
                    {selected.period}
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {(
                  [
                    ["ファイル名", selected.fileName],
                    ["関連仕訳数", `${selected.entryCount} 件`],
                    [
                      "入力元",
                      FILING_DOCUMENT_SOURCE_LABELS[selected.source],
                    ],
                    ["カテゴリ", selected.category],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="font-acumin text-[10px] text-[#707070]">
                      {label}
                    </dt>
                    <dd className="truncate font-acumin text-[11px] text-black tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="3xs"
                  shape="rounded"
                  className="font-acumin"
                  onClick={onExportJournal}
                >
                  <i className="ri-download-line mr-1" aria-hidden="true" />
                  出力
                </Button>
                <Button
                  variant="outline"
                  size="3xs"
                  shape="rounded"
                  className="font-acumin"
                  onClick={() => onNavigate("journal")}
                >
                  <i className="ri-links-line mr-1" aria-hidden="true" />
                  関連仕訳を確認
                </Button>
              </div>

              <div>
                <p className="font-acumin text-[11px] font-medium text-black">
                  バリデーションチェック
                </p>
                <ul className="mt-1">
                  {validations.map(([label, ok]) => (
                    <li
                      key={label}
                      className="flex items-center justify-between gap-2 border-b border-[#ededed] py-1.5"
                    >
                      <span className="min-w-0 truncate font-acumin text-[11px] text-[#474747]">
                        {label}
                      </span>
                      <StateBadge state={ok ? "done" : "todo"}>
                        {ok ? "OK" : "要確認"}
                      </StateBadge>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="font-acumin text-xs text-[#707070]">
              資料を選択すると詳細を表示します。
            </p>
          )}
        </Panel>
      </div>

      {/* 提出までの段取り。準備率と各段の状態を1行にまとめる。 */}
      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="申告資料パッケージ"
        title={<span className={panelTitleClassName}>申告資料パッケージ</span>}
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:items-center">
          <div className="flex items-center gap-3">
            <ProgressRing
              value={inventory.progress}
              size={72}
              label={
                <span className="font-acumin text-xs font-medium text-black tabular-nums">
                  {Math.round(inventory.progress)}%
                </span>
              }
            />
            <p className="font-acumin text-[11px] leading-relaxed text-[#707070]">
              申告資料の準備状況です。
              <br />
              すべての資料を整えて申告に備えましょう。
            </p>
          </div>

          <div className="min-w-0 overflow-x-auto">
            <ol className="flex min-w-[420px] items-center gap-1.5">
              {PACKAGE_STEPS.map((step, index) => {
                const state = stepStates[step.key];
                return (
                  <li
                    key={step.key}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                  >
                    <span
                      className={`min-w-0 flex-1 border px-3 py-2 ${boxRadiusClassName} ${
                        state === "done"
                          ? "border-[#bcdcc9] bg-[#eff7f2]"
                          : state === "current"
                            ? "border-[#f0d3b6] bg-[#fdf6ef]"
                            : "border-[#ededed] bg-white"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <i
                          className={
                            state === "done"
                              ? "ri-checkbox-circle-fill shrink-0 text-[#16844b]"
                              : state === "current"
                                ? "ri-error-warning-line shrink-0 text-[#d98324]"
                                : "ri-checkbox-blank-circle-line shrink-0 text-[#c4c4c4]"
                          }
                          aria-hidden="true"
                        />
                        <span className="truncate font-acumin text-[11px] font-medium text-black">
                          {step.label}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-acumin text-[10px] text-[#707070]">
                        {step.note}
                      </span>
                    </span>
                    {index < PACKAGE_STEPS.length - 1 ? (
                      <i
                        className="ri-arrow-right-s-line shrink-0 text-[#c4c4c4]"
                        aria-hidden="true"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="flex shrink-0 flex-col gap-2 xl:w-44">
            <Button
              variant="primary"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              onClick={onExportJournal}
            >
              <i className="ri-download-2-line mr-1" aria-hidden="true" />
              申告資料一括出力
            </Button>
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              onClick={() => onNavigate("journal")}
            >
              <i className="ri-book-open-line mr-1" aria-hidden="true" />
              帳簿で確認
            </Button>
          </div>
        </div>
        <p className="mt-3 font-acumin text-[10px] leading-relaxed text-[#707070]">
          <StatusBadge
            shape="rounded"
            size="4xs"
            className="mr-1.5 font-acumin"
            tone="neutral"
          >
            {fiscalYearLabel}
          </StatusBadge>
          状態は帳簿・証憑の実データから判定しています。証憑の追加は取引管理タブから行えます。
        </p>
      </Panel>
    </div>
  );
}
