import type { BaseOverlayProps } from '../OverlayShell/OverlayShell';
import { Sheet } from '../Sheet/Sheet';

export function SheetLarge({ className, ...props }: BaseOverlayProps) {
  return <Sheet {...props} className={className} size="lg" />;
}
