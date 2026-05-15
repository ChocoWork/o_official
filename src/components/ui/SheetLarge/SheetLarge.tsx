import { cn } from '@/lib/utils';
import type { BaseOverlayProps } from '../OverlayShell/OverlayShell';
import { SheetMedium } from '../SheetMedium/SheetMedium';

export function SheetLarge(props: BaseOverlayProps) {
  return <SheetMedium {...props} className={cn('max-h-[90vh]', props.className)} />;
}
