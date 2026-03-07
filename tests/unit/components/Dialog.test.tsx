import { render, screen, fireEvent, within } from '@testing-library/react';
import { Dialog } from '@/app/components/ui/Dialog';

describe('Dialog', () => {
  it('renders with appropriate size classes', () => {
    render(<Dialog open onClose={() => {}} size="sm" title="Hi-sm" />);
    const findDialog = (el: Element | null) => {
      let cur = el;
      while (cur && cur !== document.body) {
        if (cur.className && typeof cur.className === 'string' && cur.className.match(/max-w-/)) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    };

    const titleEl = screen.getByText('Hi-sm');
    const container = findDialog(titleEl);
    expect(container).toHaveClass('max-w-sm');

    // verify buttons inside the small dialog
    const { getByText } = within(container!);
    expect(getByText('CANCEL')).toHaveClass('h-8');
    expect(getByText('CONFIRM')).toHaveClass('h-8');

    render(
      <Dialog open onClose={() => {}} size="lg" title="Hi-lg" />,
    );
    const containerLg = findDialog(screen.getByText('Hi-lg'));
    expect(containerLg).toHaveClass('max-w-lg');
  });

  it('buttons grow with size prop', () => {
    render(<Dialog open onClose={() => {}} size="lg" title="Hi-lg" />);
    // large should give h-12 from Button size map
    expect(screen.getByText('CANCEL')).toHaveClass('h-12');
    expect(screen.getByText('CONFIRM')).toHaveClass('h-12');
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = jest.fn();
    render(<Dialog open onClose={onClose} title="Test" />);
    fireEvent.click(document.querySelector('.fixed')!);
    expect(onClose).toHaveBeenCalled();
  });
});
