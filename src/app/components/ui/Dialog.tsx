import { OverlayShell, type BaseOverlayProps } from './OverlayShell';

export function Dialog(props: BaseOverlayProps) {
  return <OverlayShell {...props} />;
}
