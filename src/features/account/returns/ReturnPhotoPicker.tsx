'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import {
  MAX_PHOTOS_PER_LINE,
  REQUEST_TEXT,
  readPreviewDataUrl,
  type PickedPhoto,
} from '@/features/account/returns/return-request-model';
import type { ReasonPhotoRule } from '@/lib/orders/returns/customer-return-types';
import {
  RETURN_PHOTO_ACCEPT,
  RETURN_PHOTO_FILE_ERROR_MESSAGES,
  RETURN_PHOTO_UPLOAD_FAILED_MESSAGE,
  checkReturnPhotoFile,
  resizeReturnPhoto,
  uploadReturnPhoto,
} from '@/lib/orders/returns/return-photo-client';

type ReturnPhotoPickerProps = {
  /** 入力欄の id の頭（行ごとに違う物） */
  idPrefix: string;
  orderId: string;
  /** 理由の設定の写真の決まり。「なし」の理由では、親がこの部品を出さない */
  rule: Exclude<ReasonPhotoRule, 'none'>;
  /** 理由の設定の写真の案内の文。空なら出さない */
  instructions: string;
  photos: PickedPhoto[];
  /** 写真の一覧を直す。送り終わりは選んだ時から時間が経つので、直す関数を渡して、その時の一覧に当てる */
  onPhotosChange: (update: (previous: PickedPhoto[]) => PickedPhoto[]) => void;
  /** 親の確かめで出た誤り（写真が必須なのに無い時など） */
  errorText?: string;
};

/**
 * 写真を選ぶ・確かめる・縮める・送る・外す（共通の約束 C-5・Global Constraints「申し込みの写真」）。
 * 選んだ写真は、ファイルの種類と大きさを確かめ、画面で縮めて JPEG に作り直し、署名つきの送り先へ直接送る。
 * 送っている間の写真は status が sending で、親は「内容を確かめる」を押せなくする。送り先の番号（uploadId）は親が申し込みに添える。
 * 撮影の情報の削除は、画面の作り直しだけに頼らず、申し込みの時にサーバーが確かめて行う（Task 5）。
 */
export function ReturnPhotoPicker({ idPrefix, orderId, rule, instructions, photos, onPhotosChange, errorText }: ReturnPhotoPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const labelId = `${idPrefix}-photos-label`;

  const dropPhoto = (id: string) => {
    onPhotosChange((previous) => previous.filter((photo) => photo.id !== id));
  };

  const sendOne = async (file: File) => {
    const id = crypto.randomUUID();
    onPhotosChange((previous) => [...previous, { id, status: 'sending', uploadId: null, previewUrl: null }]);
    try {
      const resized = await resizeReturnPhoto(file);
      // 見本は送るのと並べて作る（送り終えるのを待たない）。外された後に出来上がっても、一覧に無い写真は直さない
      void readPreviewDataUrl(resized).then((previewUrl) => {
        if (previewUrl === null) return;
        onPhotosChange((previous) => previous.map((photo) => (photo.id === id ? { ...photo, previewUrl } : photo)));
      });
      const result = await uploadReturnPhoto(orderId, resized);
      if (result.kind === 'ok') {
        onPhotosChange((previous) =>
          previous.map((photo) => (photo.id === id ? { ...photo, status: 'sent', uploadId: result.uploadId } : photo)),
        );
        return;
      }
      dropPhoto(id);
      setMessage(result.message);
    } catch {
      dropPhoto(id);
      setMessage(RETURN_PHOTO_UPLOAD_FAILED_MESSAGE);
    }
  };

  const handleSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // 同じファイルをもう一度選べるように、選び終わったら入力を空にする
    event.target.value = '';
    if (files.length === 0) return;
    let room = MAX_PHOTOS_PER_LINE - photos.length;
    let nextMessage: string | null = null;
    for (const file of files) {
      const checked = checkReturnPhotoFile(file);
      if (checked !== 'ok') {
        nextMessage ??= RETURN_PHOTO_FILE_ERROR_MESSAGES[checked];
        continue;
      }
      if (room <= 0) {
        nextMessage ??= REQUEST_TEXT.photoLimit(MAX_PHOTOS_PER_LINE);
        continue;
      }
      room -= 1;
      void sendOne(file);
    }
    setMessage(nextMessage);
  };

  const removePhoto = (photo: PickedPhoto) => {
    dropPhoto(photo.id);
    setMessage(null);
  };

  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-2">
      <p id={labelId} className="font-acumin lk-text-sm text-black">
        {REQUEST_TEXT.photoLabel(rule)}
      </p>
      {instructions ? <p className="whitespace-pre-wrap break-words font-acumin lk-text-3xs text-[#474747]">{instructions}</p> : null}
      {photos.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {photos.map((photo) => (
            <li key={photo.id} className="flex w-24 min-w-0 flex-col gap-1">
              {photo.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- 手元で作った縮小画像（data:）はサーバーの画像最適化を通せない
                <img src={photo.previewUrl} alt="" className="h-20 w-20 object-cover" />
              ) : (
                <div className="h-20 w-20 bg-black/5" aria-hidden="true" />
              )}
              {photo.status === 'sending' ? (
                <span className="font-acumin lk-text-3xs text-[#474747]">{REQUEST_TEXT.sendingPhoto}</span>
              ) : (
                <Button type="button" variant="secondary" size="sm" className="font-acumin" onClick={() => removePhoto(photo)}>
                  {REQUEST_TEXT.removePhoto}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={RETURN_PHOTO_ACCEPT}
        data-testid="return-photo-input"
        onChange={handleSelect}
      />
      <Button
        id={`${idPrefix}-photo-button`}
        type="button"
        variant="secondary"
        size="sm"
        className="font-acumin"
        disabled={photos.length >= MAX_PHOTOS_PER_LINE}
        onClick={() => inputRef.current?.click()}
      >
        {REQUEST_TEXT.pickPhoto}
      </Button>
      <LiveMessage as="p" politeness="polite" className="font-acumin lk-text-3xs text-red-600">
        {message ?? errorText}
      </LiveMessage>
    </div>
  );
}
