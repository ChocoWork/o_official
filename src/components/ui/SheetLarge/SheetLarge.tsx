import type { BaseOverlayProps } from '../OverlayShell/OverlayShell';
import { Sheet } from '../Sheet/Sheet';

export function SheetLarge({ className, ...props }: BaseOverlayProps) {
  return <Sheet size="lg" {...props} className={className} />;
}
