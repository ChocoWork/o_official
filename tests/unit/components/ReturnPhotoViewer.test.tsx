import { fireEvent, render, screen, within } from '@testing-library/react';
import ReturnPhotoViewer, {
  PHOTO_LOAD_FAILURE_TEXT,
  PHOTO_PURGED_TEXT,
  type ReturnPhotoViewerProps,
} from '@/components/ReturnPhotoViewer';

const PHOTOS: ReturnPhotoViewerProps['photos'] = [
  { photoId: 'photo-1', url: 'https://storage.example.test/photo-1.jpg', purged: false },
  { photoId: 'photo-2', url: 'https://storage.example.test/photo-2.jpg', purged: false },
  { photoId: 'photo-3', url: 'https://storage.example.test/photo-3.jpg', purged: false },
];

function renderViewer(overrides: Partial<ReturnPhotoViewerProps> = {}) {
  const onClose = jest.fn();
  const props: ReturnPhotoViewerProps = { photos: PHOTOS, open: true, startIndex: 0, onClose, ...overrides };
  const utils = render(<ReturnPhotoViewer {...props} />);
  return { ...utils, props, onClose };
}

describe('ReturnPhotoViewer', () => {
  it('open が偽の間と、写真が無い時は何も描かない', () => {
    const closed = renderViewer({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    closed.unmount();

    renderViewer({ photos: [] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('題に何枚目かと合計を出し、startIndex の写真から始める。スマホの幅では画面いっぱいに開く', () => {
    renderViewer({ startIndex: 1 });

    const dialog = screen.getByRole('dialog', { name: '写真（2／3）' });
    expect(within(dialog).getByRole('img', { name: '写真 2' })).toHaveAttribute('src', PHOTOS[1].url);
    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('前の写真・次の写真で動き、いちばん前といちばん後ろでは押せない', () => {
    renderViewer();

    expect(screen.getByRole('button', { name: '前の写真' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次の写真' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '次の写真' }));
    expect(screen.getByRole('dialog', { name: '写真（2／3）' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '写真 2' })).toHaveAttribute('src', PHOTOS[1].url);

    fireEvent.click(screen.getByRole('button', { name: '次の写真' }));
    expect(screen.getByRole('dialog', { name: '写真（3／3）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の写真' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '前の写真' }));
    expect(screen.getByRole('dialog', { name: '写真（2／3）' })).toBeInTheDocument();
  });

  it('消した写真と、リンクの無い写真は、画像の代わりに文を出す', () => {
    expect(PHOTO_PURGED_TEXT).toBe('写真は消しました（返品が終わってから90日を過ぎたため）');
    expect(PHOTO_LOAD_FAILURE_TEXT).toBe('写真を読み込めませんでした。');
    renderViewer({
      photos: [
        { photoId: 'photo-1', url: null, purged: true },
        { photoId: 'photo-2', url: null, purged: false },
      ],
    });

    expect(screen.getByText(PHOTO_PURGED_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '次の写真' }));
    expect(screen.getByText(PHOTO_LOAD_FAILURE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('画像を読み込めなかった時（10分のリンクが切れた）は、画像の代わりに読み込めない旨を出す', () => {
    renderViewer();

    fireEvent.error(screen.getByRole('img', { name: '写真 1' }));

    expect(screen.getByText(PHOTO_LOAD_FAILURE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('「閉じる」と Esc で閉じる', () => {
    const { onClose } = renderViewer();

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('開き直すと、最初の写真が startIndex に戻る', () => {
    const { rerender, props } = renderViewer({ startIndex: 1 });
    fireEvent.click(screen.getByRole('button', { name: '次の写真' }));
    expect(screen.getByRole('dialog', { name: '写真（3／3）' })).toBeInTheDocument();

    rerender(<ReturnPhotoViewer {...props} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<ReturnPhotoViewer {...props} open />);
    expect(screen.getByRole('dialog', { name: '写真（2／3）' })).toBeInTheDocument();
  });

  it.each([
    [9, '写真（3／3）'],
    [-1, '写真（1／3）'],
  ])('startIndex が範囲を出ていても（%i）、いちばん近い端の写真を出す', (startIndex, title) => {
    renderViewer({ startIndex });

    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
  });
});
