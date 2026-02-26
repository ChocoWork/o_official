import { Button } from './Button';

export interface PageControlProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function PageControl({ page, totalPages, onPageChange }: PageControlProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <nav className="flex items-center gap-2" aria-label="pagination">
      <Button variant="secondary" size="sm" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>
        前へ
      </Button>
      {pages.map((number) => (
        <Button
          key={number}
          size="sm"
          variant={number === page ? 'primary' : 'secondary'}
          onClick={() => onPageChange(number)}
          aria-current={number === page ? 'page' : undefined}
        >
          {number}
        </Button>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        次へ
      </Button>
    </nav>
  );
}
