import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LookImageGallery } from '@/features/look/components/LookImageGallery';

const THEME = 'Winter Layers';
const SLIDE_WIDTH = 300;
const IMAGES = [
  'https://signed.test/look-images/looks/30-a.jpg',
  'https://signed.test/look-images/looks/30-b.jpg',
  'https://signed.test/look-images/looks/30-c.jpg',
];

const scrollToMock = jest.fn();
let originalScrollTo: PropertyDescriptor | undefined;
let originalOffsetWidth: PropertyDescriptor | undefined;

function renderGallery(imageUrls: string[] = IMAGES) {
  return render(<LookImageGallery theme={THEME} imageUrls={imageUrls} />);
}

function mainImage(): HTMLElement {
  return screen.getByTestId('look-main-image');
}

function segments(testId: string): HTMLElement[] {
  return screen.queryAllByTestId(`${testId}-segment`);
}

function activeSegmentIndexes(testId: string): number[] {
  return segments(testId).flatMap((segment, index) => (segment.getAttribute('data-active') === 'true' ? [index] : []));
}

function thumbnails(): HTMLElement[] {
  return screen.queryAllByTestId('look-thumb-button');
}

const INDICATORS = [
  'look-detail-carousel-indicator',
  'look-detail-tablet-carousel-indicator',
  'look-detail-main-image-indicator',
];

describe('look image gallery', () => {
  beforeEach(() => {
    scrollToMock.mockClear();
    originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: scrollToMock });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => SLIDE_WIDTH });
  });

  afterEach(() => {
    if (originalScrollTo) {
      Object.defineProperty(Element.prototype, 'scrollTo', originalScrollTo);
    } else {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
    }
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    }
  });

  it('SCR-LOOK-005 モバイルは画像の枚数分のスライドを並べ、署名つきの URL を最適化を通さずそのまま読み込む', () => {
    renderGallery();

    const slides = screen.getAllByTestId('look-detail-carousel-slide');
    expect(slides).toHaveLength(IMAGES.length);
    slides.forEach((slide, index) => {
      const image = within(slide).getByRole('img', { name: `${THEME} - ${index + 1}枚目` });
      expect(image).toHaveAttribute('src', IMAGES[index]);
    });
  });

  it('SCR-LOOK-005 モバイルは端まで広げたスワイプのカルーセルで、サムネイルの列を含めない', () => {
    renderGallery();

    const carousel = screen.getByTestId('look-detail-carousel');
    expect(carousel.parentElement).toHaveClass('md:hidden');
    expect(carousel).toHaveClass('snap-x', 'overflow-x-scroll');
    expect(within(carousel.parentElement as HTMLElement).queryByTestId('look-detail-thumbnail-list')).toBeNull();
    expect(within(carousel).queryAllByTestId('look-thumb-button')).toHaveLength(0);
  });

  it('SCR-LOOK-005 タブレットはスワイプのカルーセルを md〜lg 未満だけに置き、PC はメインの画像を lg 以上だけに置く', () => {
    renderGallery();

    const tabletCarousel = screen.getByTestId('look-detail-tablet-carousel');
    expect(tabletCarousel.closest('.lg\\:hidden')).not.toBeNull();
    expect(screen.getAllByTestId('look-detail-tablet-carousel-slide')).toHaveLength(IMAGES.length);
    expect(screen.getByTestId('look-detail-desktop-images')).toHaveClass('hidden', 'md:flex');
    const mainFrame = screen.getByTestId('look-detail-main-image-frame');
    expect(mainFrame.parentElement).toHaveClass('hidden', 'lg:flex');
    expect(mainFrame).toHaveClass('aspect-2/3');
  });

  it('SCR-LOOK-005 PC のメインの枠は高さ min(48rem,100svh-7rem) の 2:3 で、1枚目を出す', () => {
    renderGallery();

    expect(screen.getByTestId('look-detail-main-image-frame').className).toContain(
      'lg:h-[min(48rem,calc(100svh-7rem))]',
    );
    expect(mainImage()).toHaveAttribute('src', IMAGES[0]);
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 1枚目`);
  });

  it('SCR-LOOK-005 どの幅も画像が複数の時は枚数分の線のインジケータを出し、最初は1枚目を選んだ状態にする', () => {
    renderGallery();

    for (const testId of INDICATORS) {
      expect(screen.getByTestId(testId)).toHaveAttribute('aria-label', `${THEME} の画像インジケータ`);
      expect(segments(testId)).toHaveLength(IMAGES.length);
      expect(activeSegmentIndexes(testId)).toEqual([0]);
    }
  });

  it('SCR-LOOK-005 PC は画像が2枚以上の時だけ左にサムネイルの縦の列を出し、名前に「<テーマ> の N枚目を表示」を付ける', () => {
    renderGallery();

    const list = screen.getByTestId('look-detail-thumbnail-list');
    expect(list).toHaveClass('hidden', 'lg:flex');
    expect(thumbnails().map((button) => button.getAttribute('aria-label'))).toEqual([
      `${THEME} の 1枚目を表示`,
      `${THEME} の 2枚目を表示`,
      `${THEME} の 3枚目を表示`,
    ]);
    expect(thumbnails()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(thumbnails()[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('SCR-LOOK-005 サムネイルを押すとメインの画像と全部の幅のインジケータが同じ画像に変わる', async () => {
    const user = userEvent.setup();
    renderGallery();

    await user.click(screen.getByRole('button', { name: `${THEME} の 3枚目を表示` }));

    expect(mainImage()).toHaveAttribute('src', IMAGES[2]);
    expect(mainImage()).toHaveAttribute('alt', `${THEME} - 3枚目`);
    expect(thumbnails().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    for (const testId of INDICATORS) {
      expect(activeSegmentIndexes(testId)).toEqual([2]);
    }
  });

  it('SCR-LOOK-005 メインの画像は先頭で前へ送るボタンを出さず、末尾で次へ送るボタンを出さない', async () => {
    const user = userEvent.setup();
    renderGallery();

    expect(screen.queryByTestId('look-detail-main-image-prev')).toBeNull();
    expect(screen.getByTestId('look-detail-main-image-next')).toBeInTheDocument();

    await user.click(screen.getByTestId('look-detail-main-image-next'));
    expect(mainImage()).toHaveAttribute('src', IMAGES[1]);
    expect(screen.getByTestId('look-detail-main-image-prev')).toBeInTheDocument();
    expect(screen.getByTestId('look-detail-main-image-next')).toBeInTheDocument();

    await user.click(screen.getByTestId('look-detail-main-image-next'));
    expect(mainImage()).toHaveAttribute('src', IMAGES[2]);
    expect(screen.queryByTestId('look-detail-main-image-next')).toBeNull();

    await user.click(screen.getByTestId('look-detail-main-image-prev'));
    expect(mainImage()).toHaveAttribute('src', IMAGES[1]);
    expect(activeSegmentIndexes('look-detail-main-image-indicator')).toEqual([1]);
  });

  it('SCR-LOOK-005 メインの画像のインジケータの線を押すとその画像に移る', async () => {
    const user = userEvent.setup();
    renderGallery();

    await user.click(segments('look-detail-main-image-indicator')[1]);

    expect(mainImage()).toHaveAttribute('src', IMAGES[1]);
    expect(thumbnails()[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('SCR-LOOK-005 タブレットは先頭で前の送りボタンを、末尾で次の送りボタンを出さず、押すと1枚分スクロールする', async () => {
    const user = userEvent.setup();
    renderGallery();

    expect(screen.queryByTestId('look-detail-tablet-carousel-prev')).toBeNull();
    await user.click(screen.getByTestId('look-detail-tablet-carousel-next'));

    expect(scrollToMock).toHaveBeenLastCalledWith({ left: SLIDE_WIDTH, behavior: 'smooth' });
    expect(screen.getByTestId('look-detail-tablet-carousel-prev')).toBeInTheDocument();
    expect(activeSegmentIndexes('look-detail-tablet-carousel-indicator')).toEqual([1]);
    expect(mainImage()).toHaveAttribute('src', IMAGES[1]);

    await user.click(screen.getByTestId('look-detail-tablet-carousel-next'));
    expect(scrollToMock).toHaveBeenLastCalledWith({ left: SLIDE_WIDTH * 2, behavior: 'smooth' });
    expect(screen.queryByTestId('look-detail-tablet-carousel-next')).toBeNull();

    await user.click(screen.getByTestId('look-detail-tablet-carousel-prev'));
    expect(scrollToMock).toHaveBeenLastCalledWith({ left: SLIDE_WIDTH, behavior: 'smooth' });
    expect(activeSegmentIndexes('look-detail-tablet-carousel-indicator')).toEqual([1]);
  });

  it('SCR-LOOK-005 タブレットの送りボタンは画像の枠の縦の中央に置き、大きさを枠の幅の 4.5% に比例させる', () => {
    renderGallery();

    const next = screen.getByTestId('look-detail-tablet-carousel-next');
    expect(next).toHaveClass('top-1/2', '-translate-y-1/2');
    expect(next.parentElement).toHaveClass('@container', 'relative');
    expect(next.querySelector('svg')?.getAttribute('class')).toContain('4.5cqw');
  });

  it('SCR-LOOK-005 モバイルのインジケータの線を押すとその画像へスクロールし、選んだ画像を揃える', async () => {
    const user = userEvent.setup();
    renderGallery();

    await user.click(segments('look-detail-carousel-indicator')[2]);

    expect(scrollToMock).toHaveBeenLastCalledWith({ left: SLIDE_WIDTH * 2, behavior: 'smooth' });
    expect(activeSegmentIndexes('look-detail-carousel-indicator')).toEqual([2]);
    expect(mainImage()).toHaveAttribute('src', IMAGES[2]);
  });

  it('SCR-LOOK-005 モバイルのスワイプでスクロールの位置が変わると、位置から出した添字の画像を選ぶ', () => {
    renderGallery();
    const carousel = screen.getByTestId('look-detail-carousel');

    carousel.scrollLeft = SLIDE_WIDTH * 2;
    fireEvent.scroll(carousel);

    expect(activeSegmentIndexes('look-detail-carousel-indicator')).toEqual([2]);
    expect(mainImage()).toHaveAttribute('src', IMAGES[2]);
    expect(thumbnails()[2]).toHaveAttribute('aria-pressed', 'true');
  });

  it('SCR-LOOK-005 タブレットのスワイプでも位置から出した添字の画像を選ぶ', () => {
    renderGallery();
    const carousel = screen.getByTestId('look-detail-tablet-carousel');

    carousel.scrollLeft = SLIDE_WIDTH;
    fireEvent.scroll(carousel);

    expect(activeSegmentIndexes('look-detail-tablet-carousel-indicator')).toEqual([1]);
    expect(mainImage()).toHaveAttribute('src', IMAGES[1]);
  });

  it('SCR-LOOK-005 スライドの幅が測れない時はスクロールしても選んだ画像を変えない', () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 0 });
    renderGallery();
    const carousel = screen.getByTestId('look-detail-carousel');

    carousel.scrollLeft = 500;
    fireEvent.scroll(carousel);

    expect(activeSegmentIndexes('look-detail-carousel-indicator')).toEqual([0]);
    expect(mainImage()).toHaveAttribute('src', IMAGES[0]);
  });

  it('SCR-LOOK-005 画像が1枚の時はサムネイル・送りのボタン・インジケータを出さない', () => {
    renderGallery([IMAGES[0]]);

    expect(screen.queryByTestId('look-detail-thumbnail-list')).toBeNull();
    expect(thumbnails()).toHaveLength(0);
    expect(screen.queryByTestId('look-detail-main-image-next')).toBeNull();
    expect(screen.queryByTestId('look-detail-tablet-carousel-next')).toBeNull();
    for (const testId of INDICATORS) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    expect(mainImage()).toHaveAttribute('src', IMAGES[0]);
  });

  it('SCR-LOOK-005 画像が無い時は /placeholder.png の1枚を、どの幅にも出す', () => {
    renderGallery([]);

    expect(screen.getAllByTestId('look-detail-carousel-slide')).toHaveLength(1);
    expect(screen.getAllByTestId('look-detail-tablet-carousel-slide')).toHaveLength(1);
    expect(mainImage()).toHaveAttribute('src', '/placeholder.png');
    for (const image of screen.getAllByAltText(`${THEME} - 1枚目`)) {
      expect(image).toHaveAttribute('src', '/placeholder.png');
    }
    expect(thumbnails()).toHaveLength(0);
    for (const testId of INDICATORS) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
  });

  it('SCR-LOOK-005 画像の URL が変わると添字を保ったまま新しい画像の列で描き直す', () => {
    const { rerender } = renderGallery();
    fireEvent.click(thumbnails()[1]);

    rerender(<LookImageGallery theme={THEME} imageUrls={[IMAGES[2], IMAGES[0]]} />);

    expect(mainImage()).toHaveAttribute('src', IMAGES[0]);
    expect(segments('look-detail-main-image-indicator')).toHaveLength(2);
    expect(activeSegmentIndexes('look-detail-main-image-indicator')).toEqual([1]);
  });
});
