// 会計画面の CSV 書き出しの共通の関数。
// 全セルを `"` で囲み（`"` は二重化）、区切りは `,`、行末は CRLF、先頭に BOM を付ける。

/** CSV の中身の文字列（先頭の BOM を含む）を返す。 */
export function buildCsvText(rows: Array<Array<string | number>>): string {
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\r\n");
  return `﻿${csv}`;
}

/** CSV をブラウザーでファイルとして保存させる。 */
export function exportCsv(
  filename: string,
  rows: Array<Array<string | number>>,
): void {
  const blob = new Blob([buildCsvText(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
