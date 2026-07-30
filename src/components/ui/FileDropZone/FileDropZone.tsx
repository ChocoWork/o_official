// File: src/components/ui/FileDropZone/FileDropZone.tsx
import "@/components/ui/FileDropZone/FileDropZone.css";
import { useState, type DragEvent } from "react";
import type { FileDropZoneProps } from "@/components/ui/FileDropZone/FileDropZone_type";

export type { FileDropZoneProps } from "@/components/ui/FileDropZone/FileDropZone_type";

/**
 * ファイルの追加口。ドラッグ＆ドロップとクリック（フォルダから選択）の両方を
 * 1つの面で受ける。label が input を包むので、クリックもキーボードも同じ経路になる。
 */
export function FileDropZone({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  label = "ファイルをドラッグ＆ドロップ",
  hint,
  busy = false,
  busyLabel = "処理中...",
  size = "md",
  shape = "rounded",
  className,
  "aria-label": ariaLabel,
}: FileDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isLocked = disabled || busy;

  const emit = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    onFiles(multiple ? files : files.slice(0, 1));
  };

  const handleDragOver = (event: DragEvent<HTMLLabelElement>) => {
    if (isLocked) return;
    // preventDefault しないとブラウザがファイルを開いてしまう。
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    if (isLocked) return;
    event.preventDefault();
    setIsDragOver(false);
    emit(event.dataTransfer?.files ?? null);
  };

  return (
    <label
      data-ui-file-drop-zone="true"
      data-ui-file-drop-zone-size={size}
      data-ui-size={size}
      data-ui-file-drop-zone-shape={shape}
      data-ui-file-drop-zone-dragover={isDragOver ? "true" : undefined}
      data-ui-file-drop-zone-disabled={isLocked ? "true" : undefined}
      className={className}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        data-ui-file-drop-zone-input=""
        aria-label={ariaLabel}
        accept={accept}
        multiple={multiple}
        disabled={isLocked}
        onChange={(event) => {
          emit(event.target.files);
          // 同じファイルを続けて選び直せるように値を空へ戻す。
          event.target.value = "";
        }}
      />
      <i
        data-ui-file-drop-zone-icon=""
        className="ri-upload-cloud-2-line"
        aria-hidden="true"
      />
      <span data-ui-file-drop-zone-label="">{busy ? busyLabel : label}</span>
      {hint !== undefined && !busy ? (
        <span data-ui-file-drop-zone-hint="">{hint}</span>
      ) : null}
    </label>
  );
}
