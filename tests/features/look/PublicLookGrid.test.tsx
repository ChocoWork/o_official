import { render, screen } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { getPublishedLooks, type PublicLook } from '@/lib/look/public';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { alt } = props;
    return <div data-testid="next-image-mock" aria-label={typeof alt === 'string' ? alt : ''} />;
  },
}));

jest.mock('@/lib/look/public', () => ({
  __esModule: true,
  getPublishedLooks: jest.fn(),
  formatLookSeason: (seasonYear: number, seasonType: 'SS' | 'AW') => `${seasonYear} ${seasonType}`,
}));

function createLooks(count: number): PublicLook[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    seasonYear: 2026,
    seasonType: 'SS',
    theme: `Theme ${index + 1}`,
    themeDescription: `Theme description ${index + 1}`,
    imageUrls: ['/placeholder.png'],
    createdAt: new Date().toISOString(),
    linkedItems: [],
  }));
}

describe('PublicLookGrid', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('公開LOOKが7件あるときに VIEW LOOKBOOK を表示する', async () => {
    (getPublishedLooks as jest.Mock).mockResolvedValue(createLooks(7));

    const ui = await PublicLookGrid({ variant: 'home' });
    render(ui);

    expect(screen.getByRole('link', { name: 'VIEW LOOKBOOK' })).toBeInTheDocument();
  });

  it('公開LOOKが6件のときに VIEW LOOKBOOK を表示しない', async () => {
    (getPublishedLooks as jest.Mock).mockResolvedValue(createLooks(6));

    const ui = await PublicLookGrid({ variant: 'home' });
    render(ui);

    expect(screen.queryByRole('link', { name: 'VIEW LOOKBOOK' })).not.toBeInTheDocument();
  });
});
