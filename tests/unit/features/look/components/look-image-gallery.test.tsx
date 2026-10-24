import { fireEvent, render, screen, within } from '@testing-library/react';
import { LookImageGallery } from '@/features/look/components/LookImageGallery';
import {
  carouselIndexFromScroll,
  scrollCarouselTo,
} from '@/features/items/components/ItemImageCarousel';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    priority,
    unoptimized,
    ...rest
  }: {
    src: string;
    alt: string;
    priority?: boolean;
    unoptimized?: boolean;
  } & Record<string, unknown>) => {
    const testId = rest['data-testid'];
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        data-testid={typeof testId === 'string' ? testId : undefined}
        data-priority={String(Boolean(priority))}
        data-unoptimized={String(Boolean(unoptimized))}
      />
    );
  },
}));

jest.mock('@/features/items/components/ItemImageCarousel', () => ({
  __esModule: true,
  carouselIndexFromScroll: jest.fn(),
  scrollCarouselTo: jest.fn(),
  CarouselArrowButton: ({
    direction,
    testId,
    onClick,
  }: {
    direction: string;
    testId: string;
    onClick: () => void;
  }) => (
    <button type="button" data-testid={testId} data-direction={direction} onClick={onClick}>
      {direction}
    </button>
  ),
  CarouselSegmentIndicator: ({
    testId,
    count,
    selectedIndex,
    onSelect,
    label,
  }: {
    testId: string;
    count: number;
    selectedIndex: number;
    onSelect: (index: number) => void;
    label: string;
  }) => (
    <div data-testid={testId} data-count={count} data-selected={selectedIndex} aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          data-testid={`${testId}-segment-${index}`}
          onClick={() => onSelect(index)}
        >
          {index}
        </button>
      ))}
    </div>
  ),
}));

const mockedIndexFromScroll = carouselIndexFromScroll as jest.Mock;
const mockedScrollTo = scrollCarouselTo as jest.Mock;

const THEME = 'Dawn';
const THREE = ['/a.png', '/b.png', '/c.png'];

function mainImage() {
  return screen.getByTestId('look-main-image');
}

beforeEach(() => {
  mockedIndexFromScroll.mockReset();
  mockedScrollTo.mockReset();
});

describe('LookImageGallery', () => {
  it('DD-LOOK-031 テスト観点#1 画像なしなら /placeholder.png だけで、サムネイルの列と送りのボタンを出さない', () => {
    render(<LookImageGallery theme={THEME} imageUrls={[]} />);

    expect(mainImage()).toHaveAttribute('src', '/placeholder.png');
    expect(screen.getAllByRole('img').every((img) => img.getAttribute('src') === '/placeholder.png')).toBe(true);
    expect(screen.getAllByTestId('look-detail-carousel-slide')).toHaveLength(1);
    expect(screen.getAllByTestId('look-detail-tablet-carousel-slide')).toHaveLength(1);
    expect(screen.queryByTestId('look-detail-thumbnail-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-tablet-carousel-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-tablet-carousel-next')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-main-image-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-main-image-next')).not.toBeInTheDocument();
  });

  it('DD-LOOK-031 テスト観点#2 画像1枚ならサムネイルの列も送りのボタンも出さない', () => {
    render(<LookImageGallery theme={THEME} imageUrls={['/only.png']} />);

    expect(mainImage()).toHaveAttribute('src', '/only.png');
    expect(screen.queryByTestId('look-detail-thumbnail-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-thumb-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-tablet-carousel-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-tablet-carousel-next')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-main-image-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-main-image-next')).not.toBeInTheDocument();
  });

  it('DD-LOOK-031 テスト観点#3 画像3枚の初めはサムネイル3つで1つ目が押された状態、次送りだけ出る', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    const thumbs = screen.getAllByTestId('look-thumb-button');
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs[0]).toHaveClass('ring-1', 'ring-black', 'opacity-100');
    expect(thumbs[1]).toHaveAttribute('aria-pressed', 'false');
    expect(thumbs[1]).toHaveClass('opacity-50');
    expect(thumbs[0]).toHaveAttribute('aria-label', `${THEME} の 1枚目を表示`);
    expect(thumbs[2]).toHaveAttribute('aria-label', `${THEME} の 3枚目を表示`);
    expect(mainImage()).toHaveAttribute('src', '/a.png');
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 1枚目`);
    expect(screen.queryByTestId('look-detail-main-image-prev')).not.toBeInTheDocument();
    expect(screen.getByTestId('look-detail-main-image-next')).toBeInTheDocument();
    expect(screen.queryByTestId('look-detail-tablet-carousel-prev')).not.toBeInTheDocument();
    expect(screen.getByTestId('look-detail-tablet-carousel-next')).toBeInTheDocument();
  });

  it('DD-LOOK-031 テスト観点#3 mobile と tablet は先頭の画像だけ priority で、全画像を unoptimized で並べる', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    for (const slideId of ['look-detail-carousel-slide', 'look-detail-tablet-carousel-slide']) {
      const slides = screen.getAllByTestId(slideId);
      expect(slides).toHaveLength(3);
      const images = slides.map((slide) => within(slide).getByRole('img'));
      expect(images.map((img) => img.getAttribute('data-priority'))).toEqual(['true', 'false', 'false']);
      expect(images.map((img) => img.getAttribute('data-unoptimized'))).toEqual(['true', 'true', 'true']);
      expect(images.map((img) => img.getAttribute('alt'))).toEqual([
        `${THEME} - 1枚目`,
        `${THEME} - 2枚目`,
        `${THEME} - 3枚目`,
      ]);
    }
  });

  it('DD-LOOK-031 テスト観点#4 サムネイルを押すと選択が2枚目に移り、前送りと次送りが出る', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    fireEvent.click(screen.getAllByTestId('look-thumb-button')[1]);

    expect(mainImage()).toHaveAttribute('src', '/b.png');
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 2枚目`);
    expect(screen.getAllByTestId('look-thumb-button')[1]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('look-thumb-button')[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('look-detail-main-image-prev')).toBeInTheDocument();
    expect(screen.getByTestId('look-detail-main-image-next')).toBeInTheDocument();
    expect(screen.getByTestId('look-detail-tablet-carousel-prev')).toBeInTheDocument();
    expect(screen.getByTestId('look-detail-tablet-carousel-next')).toBeInTheDocument();
  });

  it('DD-LOOK-031 テスト観点#5 desktop の送りで選択が1つずつ動き、端で押せない側が消える', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    fireEvent.click(screen.getByTestId('look-detail-main-image-next'));
    expect(mainImage()).toHaveAttribute('src', '/b.png');

    fireEvent.click(screen.getByTestId('look-detail-main-image-next'));
    expect(mainImage()).toHaveAttribute('src', '/c.png');
    expect(screen.queryByTestId('look-detail-main-image-next')).not.toBeInTheDocument();
    expect(screen.getByTestId('look-detail-main-image-prev')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('look-detail-main-image-prev'));
    expect(mainImage()).toHaveAttribute('src', '/b.png');
    fireEvent.click(screen.getByTestId('look-detail-main-image-prev'));
    expect(mainImage()).toHaveAttribute('src', '/a.png');
    expect(screen.queryByTestId('look-detail-main-image-prev')).not.toBeInTheDocument();
    expect(mockedScrollTo).not.toHaveBeenCalled();
  });

  it('DD-LOOK-031 テスト観点#5 desktop のインジケータは選択だけを変えスクロールしない', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    const indicator = screen.getByTestId('look-detail-main-image-indicator');
    expect(indicator).toHaveAttribute('data-count', '3');
    expect(indicator).toHaveAttribute('aria-label', `${THEME} の画像インジケータ`);
    fireEvent.click(screen.getByTestId('look-detail-main-image-indicator-segment-2'));

    expect(mainImage()).toHaveAttribute('src', '/c.png');
    expect(indicator).toHaveAttribute('data-selected', '2');
    expect(mockedScrollTo).not.toHaveBeenCalled();
  });

  it('DD-LOOK-031 テスト観点#6 tablet の送りで選択が動き、tablet の参照でスクロールする', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    const tabletCarousel = screen.getByTestId('look-detail-tablet-carousel');

    fireEvent.click(screen.getByTestId('look-detail-tablet-carousel-next'));
    expect(mockedScrollTo).toHaveBeenLastCalledWith(tabletCarousel, 1);
    expect(mainImage()).toHaveAttribute('src', '/b.png');

    fireEvent.click(screen.getByTestId('look-detail-tablet-carousel-next'));
    expect(mockedScrollTo).toHaveBeenLastCalledWith(tabletCarousel, 2);
    expect(screen.queryByTestId('look-detail-tablet-carousel-next')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('look-detail-tablet-carousel-prev'));
    expect(mockedScrollTo).toHaveBeenLastCalledWith(tabletCarousel, 1);
    fireEvent.click(screen.getByTestId('look-detail-tablet-carousel-prev'));
    expect(mockedScrollTo).toHaveBeenLastCalledWith(tabletCarousel, 0);
    expect(mainImage()).toHaveAttribute('src', '/a.png');
    expect(screen.queryByTestId('look-detail-tablet-carousel-prev')).not.toBeInTheDocument();
    expect(mockedScrollTo).toHaveBeenCalledTimes(4);
  });

  it('DD-LOOK-031 テスト観点#6 tablet のインジケータも tablet の参照でスクロールする', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    fireEvent.click(screen.getByTestId('look-detail-tablet-carousel-indicator-segment-2'));

    expect(mockedScrollTo).toHaveBeenCalledWith(screen.getByTestId('look-detail-tablet-carousel'), 2);
    expect(mainImage()).toHaveAttribute('src', '/c.png');
  });

  it('DD-LOOK-031 テスト観点#7 mobile のインジケータを押すと選択が移り、mobile の参照でスクロールする', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);

    const indicator = screen.getByTestId('look-detail-carousel-indicator');
    expect(indicator).toHaveAttribute('data-count', '3');
    fireEvent.click(screen.getByTestId('look-detail-carousel-indicator-segment-1'));

    expect(mockedScrollTo).toHaveBeenCalledTimes(1);
    expect(mockedScrollTo).toHaveBeenCalledWith(screen.getByTestId('look-detail-carousel'), 1);
    expect(indicator).toHaveAttribute('data-selected', '1');
    expect(mainImage()).toHaveAttribute('src', '/b.png');
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 2枚目`);
  });

  it('DD-LOOK-031 テスト観点#8 mobile のスクロールで添字が出れば選択を変える', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    const carousel = screen.getByTestId('look-detail-carousel');
    mockedIndexFromScroll.mockReturnValue(2);

    fireEvent.scroll(carousel);

    expect(mockedIndexFromScroll).toHaveBeenCalledWith(carousel);
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 3枚目`);
    expect(screen.getAllByTestId('look-thumb-button')[2]).toHaveAttribute('aria-pressed', 'true');
  });

  it('DD-LOOK-031 テスト観点#8 tablet のスクロールで添字が出れば選択を変える', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    const carousel = screen.getByTestId('look-detail-tablet-carousel');
    mockedIndexFromScroll.mockReturnValue(1);

    fireEvent.scroll(carousel);

    expect(mockedIndexFromScroll).toHaveBeenCalledWith(carousel);
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 2枚目`);
  });

  it('DD-LOOK-031 テスト観点#8 添字が 0 でも出せたものとして選択を変える', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    fireEvent.click(screen.getAllByTestId('look-thumb-button')[2]);
    mockedIndexFromScroll.mockReturnValue(0);

    fireEvent.scroll(screen.getByTestId('look-detail-carousel'));

    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 1枚目`);
  });

  it('DD-LOOK-031 テスト観点#9 スクロールで添字が出せなければ選択を変えない', () => {
    render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    fireEvent.click(screen.getAllByTestId('look-thumb-button')[1]);
    mockedIndexFromScroll.mockReturnValue(null);

    fireEvent.scroll(screen.getByTestId('look-detail-carousel'));
    fireEvent.scroll(screen.getByTestId('look-detail-tablet-carousel'));

    expect(mockedIndexFromScroll).toHaveBeenCalledTimes(2);
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 2枚目`);
  });

  it('DD-LOOK-031 テスト観点#10 描き直しで画像が減って選択が並びの外になったらメインの画像は先頭', () => {
    const { rerender } = render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    fireEvent.click(screen.getAllByTestId('look-thumb-button')[2]);
    expect(mainImage()).toHaveAttribute('src', '/c.png');

    rerender(<LookImageGallery theme={THEME} imageUrls={['/only.png']} />);

    expect(mainImage()).toHaveAttribute('src', '/only.png');
    expect(screen.queryByTestId('look-thumb-button')).not.toBeInTheDocument();
  });

  it('DD-LOOK-031 テスト観点#10 並びが同じ長さの描き直しでは選択を戻さない', () => {
    const { rerender } = render(<LookImageGallery theme={THEME} imageUrls={THREE} />);
    fireEvent.click(screen.getAllByTestId('look-thumb-button')[1]);

    rerender(<LookImageGallery theme={THEME} imageUrls={['/x.png', '/y.png', '/z.png']} />);

    expect(mainImage()).toHaveAttribute('src', '/y.png');
    expect(screen.getAllByTestId('look-thumb-button')[1]).toHaveAttribute('aria-pressed', 'true');
  });
});
