import { render, screen } from '@testing-library/react';

jest.mock('@/lib/look/server', () => {
  class LookFetchError extends Error {
    readonly code: string | null;
    constructor(code: string | null) {
      super('Failed to fetch published looks');
      this.name = 'LookFetchError';
      this.code = code;
    }
  }
  return { getPublishedLookList: jest.fn(), LookFetchError };
});

jest.mock('@/features/look/components/PublicLookGrid', () => ({
  PublicLookGrid: jest.fn(
    (props: { variant: string; looks: unknown[]; initialSeason: string }) => (
      <div
        data-testid="grid"
        data-variant={props.variant}
        data-count={props.looks.length}
        data-season={props.initialSeason}
      />
    ),
  ),
}));

import LookPage, { generateMetadata } from '@/app/look/page';
import { getPublishedLookList, LookFetchError } from '@/lib/look/server';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

const mockGetPublishedLookList = getPublishedLookList as jest.Mock;
const mockGrid = PublicLookGrid as unknown as jest.Mock;

const LOOKS = [
  { id: 2, theme: 'B', seasonType: 'AW' },
  { id: 1, theme: 'A', seasonType: 'SS' },
];

const DESCRIPTION =
  'Le Fil des Heures の公開LOOKを一覧で掲載。シーズン別のスタイリングと関連アイテムを確認できます。';

async function renderPage(searchParams?: Promise<{ season?: string }>) {
  const element = await LookPage(searchParams === undefined ? {} : { searchParams });
  return render(element);
}

describe('LookPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublishedLookList.mockResolvedValue([]);
  });

  it('DD-LOOK-002 メタは固定の title・description と OG の画像 /mainphoto.png を返す', async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe('LOOK BOOK | Le Fil des Heures');
    expect(metadata.description).toBe(DESCRIPTION);
    expect(metadata.openGraph).toEqual({
      title: 'LOOK BOOK | Le Fil des Heures',
      description: DESCRIPTION,
      images: ['/mainphoto.png'],
    });
  });

  it('DD-LOOK-002 searchParams が無ければ getPublishedLookList を引数なしで呼び、部品に ALL を渡す', async () => {
    await renderPage();

    expect(mockGetPublishedLookList).toHaveBeenCalledTimes(1);
    expect(mockGetPublishedLookList).toHaveBeenCalledWith();
    expect(screen.getByTestId('grid')).toHaveAttribute('data-season', 'ALL');
  });

  it('DD-LOOK-002 season が無い searchParams は ALL を渡す', async () => {
    await renderPage(Promise.resolve({}));

    expect(screen.getByTestId('grid')).toHaveAttribute('data-season', 'ALL');
  });

  it('DD-LOOK-002 小文字の season は大文字に直して部品に渡す', async () => {
    await renderPage(Promise.resolve({ season: 'ss' }));

    expect(screen.getByTestId('grid')).toHaveAttribute('data-season', 'SS');
  });

  it('DD-LOOK-002 AW の season はそのまま部品に渡す', async () => {
    await renderPage(Promise.resolve({ season: 'AW' }));

    expect(screen.getByTestId('grid')).toHaveAttribute('data-season', 'AW');
  });

  it.each(['FOO', '', '   ', 'SS,AW'])(
    'DD-LOOK-002 正しくない season "%s" は ALL を渡す',
    async (season) => {
      await renderPage(Promise.resolve({ season }));

      expect(screen.getByTestId('grid')).toHaveAttribute('data-season', 'ALL');
    },
  );

  it('DD-LOOK-002 取り出した LOOK を catalog の部品にそのまま渡す', async () => {
    mockGetPublishedLookList.mockResolvedValue(LOOKS);

    await renderPage(Promise.resolve({ season: 'ss' }));

    expect(mockGrid).toHaveBeenCalledTimes(1);
    expect(mockGrid.mock.calls[0][0]).toEqual({
      variant: 'catalog',
      looks: LOOKS,
      initialSeason: 'SS',
    });
    expect(screen.getByTestId('grid')).toHaveAttribute('data-variant', 'catalog');
    expect(screen.getByTestId('grid')).toHaveAttribute('data-count', '2');
  });

  it('DD-LOOK-002 部品を w-full の div で包む', async () => {
    const { container } = await renderPage();

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('w-full');
    expect(wrapper).toContainElement(screen.getByTestId('grid'));
  });

  it('DD-LOOK-002 取り出しが空の配列でも部品に空の配列を渡して描く', async () => {
    mockGetPublishedLookList.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByTestId('grid')).toHaveAttribute('data-count', '0');
  });

  it('DD-LOOK-002 取り出しが LookFetchError で失敗したらページも reject し、誤りの画面に任せる', async () => {
    mockGetPublishedLookList.mockRejectedValue(new LookFetchError('42501'));

    await expect(LookPage({})).rejects.toBeInstanceOf(LookFetchError);
    expect(mockGrid).not.toHaveBeenCalled();
  });
});
