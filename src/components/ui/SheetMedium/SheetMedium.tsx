import type { BaseOverlayProps } from '../OverlayShell/OverlayShell';
import { Sheet } from '../Sheet/Sheet';

export function SheetMedium({ className, ...props }: BaseOverlayProps) {
  return <Sheet size="md" {...props} className={className} />;
}
