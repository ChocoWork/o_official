import React from 'react';
import { render } from '@testing-library/react';
import { Drawer } from '@/components/ui/Drawer';

describe('Drawer size prop', () => {
  const children = <div>content</div>;
  const baseProps = { open: true, onClose: () => {} };

  it('defaults to md width', () => {
    const { container } = render(<Drawer {...baseProps}>{children}</Drawer>);
    const aside = container.querySelector('aside');
    expect(aside).toHaveClass('max-w-md');
  });

  it('sm size applies small width', () => {
    const { container } = render(
      <Drawer {...baseProps} size="sm">
        {children}
      </Drawer>
    );
    expect(container.querySelector('aside')).toHaveClass('max-w-sm');
  });

  it('lg size applies large width', () => {
    const { container } = render(
      <Drawer {...baseProps} size="lg">
        {children}
      </Drawer>
    );
    expect(container.querySelector('aside')).toHaveClass('max-w-lg');
  });
});
