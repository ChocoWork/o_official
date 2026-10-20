'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';

export type ReturnPhotoViewerProps = {
  photos: Array<{ photoId: string; url: string | null; purged: boolean }>;
  open: boolean;
  /** 最初に見せる写真の番号（0 始まり）。範囲を出ていれば、いちばん近い端の写真 */
  startIndex: number;
  onClose: () => void;
};

/** 置き場から消した写真の文（C-5）。申し込みを確かめる画面の写真の欄も同じ文を出す */
export const PHOTO_PURGED_TEXT = '写真は消しました（返品が終わってから90日を過ぎたため）';
/** 写真のリンクを作れなかった・読めなかった時と、画像を読み込めなかった時（10分のリンクが切れた）の文（C-5） */
export const PHOTO_LOAD_FAILURE_TEXT = '写真を読み込めませんでした。';

type ReturnPhotoViewerBodyProps = Pick<ReturnPhotoViewerProps, 'photos' | 'startIndex' | 'onClose'>;

/**
 * 写真を大きく見る画面（C-5）。開いている間だけ描き、開くたびに作り直す（最初に見せる写真が startIndex に戻る）。写真が無い時は開かない。
 * Dialog は重ねると Esc で下の画面が閉じるので、親はこの画面が開いている間、自分の画面を描かない
 */
export default function ReturnPhotoViewer({ photos, open, startIndex, onClose }: ReturnPhotoViewerProps) {
  return open && photos.length > 0 ? <ReturnPhotoViewerBody photos={photos} startIndex={startIndex} onClose={onClose} /> : null;
}

function ReturnPhotoViewerBody({ photos, startIndex, onClose }: ReturnPhotoViewerBodyProps) {
  const [index, setIndex] = useState(startIndex);
  // 画像を読み込めなかった写真（署名つきのリンクは10分で切れる。置き場の不調も）。画像の代わりに読み込めない旨を出す
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  // 写真の数が減って番号が範囲を出ても、端の写真を出す
  const current = Math.min(Math.max(index, 0), photos.length - 1);
  const photo = photos[current];

  return (
    <Dialog open onClose={onClose} title={`写真（${current + 1}／${photos.length}）`} fullScreenOnMobile>
      <div className="space-y-3">
        <div className="flex min-h-48 items-center justify-center bg-[#f3f3f3]">
          {photo.purged ? (
            <p className="p-4 font-acumin lk-text-sm text-black">{PHOTO_PURGED_TEXT}</p>
          ) : photo.url === null || broken.has(photo.photoId) ? (
            <p className="p-4 font-acumin lk-text-sm text-red-700">{PHOTO_LOAD_FAILURE_TEXT}</p>
          ) : (
            // 署名つきのリンク（10分だけ使える）は、画像の最適化の経由に載せず、そのまま出す
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.url}
              alt={`写真 ${current + 1}`}
              onError={() => setBroken((previous) => new Set(previous).add(photo.photoId))}
              className="max-h-[70vh] w-auto max-w-full object-contain"
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="w-full font-acumin"
            disabled={current <= 0}
            onClick={() => setIndex(current - 1)}
          >
            前の写真
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="w-full font-acumin"
            disabled={current >= photos.length - 1}
            onClick={() => setIndex(current + 1)}
          >
            次の写真
          </Button>
        </div>
        <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </Dialog>
  );
}
