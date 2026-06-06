// File: src/components/ui/Drawer/Drawer.tsx
import '@/components/ui/Drawer/Drawer.css';
import { cn } from '@/lib/utils';
import type { DrawerProps } from '@/components/ui/Drawer/Drawer_type';

export function Drawer({
  open,
  onClose,
  side = 'right',
  children,
  className,
  size = 'md',
}: DrawerProps) {
  if (!open) {
    return null;
  }

  const rootDataAttrs = {
    'data-ui-drawer': 'true',
    'data-ui-drawer-side': side,
    'data-ui-drawer-size': size,
  } as const;

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="presentation"
      {...rootDataAttrs}
    >
      <div className="drawer-overlay__scrim" aria-hidden="true" />
      <aside
        className={cn('drawer-panel', className)}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </aside>
    </div>
  );
}