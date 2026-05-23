import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import type { PublicLook } from '@/lib/look/public';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { alt } = props;
    return <div data-testid="next-image-mock" aria-label={typeof alt === 'string' ? alt : ''} />;
  },
}));

jest.mock('@/components/ui/Button/Button', () => ({
  __esModule: true,
  Button: ({ children, href }: { children?: ReactNode; href?: string }) =>
    href ? <a href={href}>{children}</a> : <button type="button">{children}</button>,
}));

jest.mock('@/components/ui/SectionTitle/SectionTitle', () => ({
  __esModule: true,
  SectionTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

jest.mock('@/components/ui/Drawer/Drawer', () => ({
  __esModule: true,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/ui/MultiSelect/MultiSelect', () => ({
  __esModule: true,
  MultiSelect: () => <div data-testid="multi-select" />,
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
  it('公開LOOKが7件あるときに VIEW LOOKBOOK を表示する', async () => {
    render(<PublicLookGrid variant="home" looks={createLooks(7)} />);

    expect(screen.getByRole('link', { name: 'VIEW LOOKBOOK' })).toBeInTheDocument();
  });

  it('公開LOOKが6件のときに VIEW LOOKBOOK を表示しない', async () => {
    render(<PublicLookGrid variant="home" looks={createLooks(6)} />);

    expect(screen.queryByRole('link', { name: 'VIEW LOOKBOOK' })).not.toBeInTheDocument();
  });
});
