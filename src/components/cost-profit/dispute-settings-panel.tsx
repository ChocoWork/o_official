"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { ACCOUNTS } from "@/lib/finance/accounts";
import {
  accountingUrl,
  getAccountingData,
  hasArray,
  inputClassName,
  noteClassName,
  NO_PERMISSIONS,
  Section,
  tableClassName,
  type ViewPermissions,
} from "./accounting-api";
import {
  accountLabel,
  DISPUTE_CAUSE_LABELS,
  DisputeList,
} from "./dispute-list";
import {
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// 設定のタブの「カード会社からの支払いの取り消し」の振り替え先（FREQ-568-AC-05・AC-02）。
// 原因ごとに、確定した時に振り替える先の科目（費用か収益）を決める。決まるまでは「仮払金（確定・科目の決定待ち）」に置かれる。
// 保存は admin.accounting.settings.manage の人だけ。振り替えの操作は admin.accounting.entries.correct の人だけ。

type DisputeSetting = { reason: string; account_code: string; version: string; updated_at: string };

/** 振り替え先に選べる勘定。SQL は費用か収益だけを受ける。 */
const ACCOUNT_OPTIONS = ACCOUNTS.filter((a) => a.type === "expense" || a.type === "revenue");

const CAUSES = Object.keys(DISPUTE_CAUSE_LABELS);

export function DisputeSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<Record<string, DisputeSetting>>({});
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingReason, setSavingReason] = useState<string | null>(null);
  const guard = useRef(false);

  const load = useCallback(async () => {
    const result = await getAccountingData<{ settings: DisputeSetting[] }>("dispute-settings", {}, (data) => hasArray(data, "settings"));
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setLoadError(null);
    setPermissions(result.permissions);
    const byReason: Record<string, DisputeSetting> = {};
    for (const row of result.data.settings) byReason[row.reason] = row;
    setSettings(byReason);
    setChoices(Object.fromEntries(result.data.settings.map((row) => [row.reason, row.account_code])));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (reason: string) => {
    const accountCode = choices[reason];
    if (!accountCode || guard.current) return;
    guard.current = true;
    setSavingReason(reason);
    setNotice(null);
    const result = await sendAccountingJson(accountingUrl("dispute-settings"), "PUT", {
      reason,
      accountCode,
      expectedVersion: settings[reason]?.version ?? null,
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      setNotice(successNotice("保存しました。"));
      await load();
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setSavingReason(null);
  };

  const settingsByReason = Object.fromEntries(
    Object.values(settings).map((row) => [row.reason, row.account_code]),
  );

  return (
    <Section title="支払いの取り消しの振り替え先">
      <p className={noteClassName}>
        カード会社からの支払いの取り消しが確定した時に、原因ごとに振り替える先の科目を決めます。費用か収益の科目だけ選べます。消費税の区分は、課税事業者になる前に税理士と決めてください。
      </p>
      {loadError ? (
        <div className="space-y-2">
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {loadError}
          </p>
          <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={() => void load()}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}
      {loaded ? (
        <div className="overflow-x-auto">
          <table aria-label="原因ごとの振り替え先" className={`${tableClassName} min-w-[480px]`}>
            <thead>
              <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                <th scope="col" className="py-2 pr-3 font-normal">原因</th>
                <th scope="col" className="py-2 pr-3 font-normal">振り替え先の科目</th>
                {permissions.manageSettings ? <th scope="col" className="py-2 font-normal">操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {CAUSES.map((reason) => {
                const label = DISPUTE_CAUSE_LABELS[reason];
                const current = settings[reason]?.account_code ?? "";
                const chosen = choices[reason] ?? "";
                return (
                  <tr key={reason} className="border-b border-[#ededed]">
                    <td className="py-2 pr-3">{label}</td>
                    <td className="py-2 pr-3">
                      {permissions.manageSettings ? (
                        <select
                          aria-label={`${label}の振り替え先`}
                          className={inputClassName}
                          value={chosen}
                          onChange={(event) => setChoices((c) => ({ ...c, [reason]: event.target.value }))}
                        >
                          <option value="">選んでください</option>
                          {ACCOUNT_OPTIONS.map((account) => (
                            <option key={account.code} value={account.code}>
                              {`${account.code} ${account.name}`}
                            </option>
                          ))}
                        </select>
                      ) : current ? (
                        <span>{accountLabel(current)}</span>
                      ) : (
                        <span className="text-[#707070]">未設定</span>
                      )}
                    </td>
                    {permissions.manageSettings ? (
                      <td className="py-2">
                        <Button
                          variant="outline"
                          size="2xs"
                          shape="rounded"
                          className="font-acumin"
                          disabled={!chosen || chosen === current || savingReason !== null}
                          aria-label={`${label}を保存`}
                          onClick={() => void save(reason)}
                        >
                          保存
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <NoticeLine notice={notice} onReload={() => void load()} />
      <div className="border-t border-[#ededed] pt-3">
        <DisputeList awaitingOnly settingsByReason={settingsByReason} />
      </div>
    </Section>
  );
}
