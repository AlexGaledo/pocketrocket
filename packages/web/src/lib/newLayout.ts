/**
 * Whether the restyled screens are drawn (docs/specs/toki-ui.md, phases 4-6): the "New layout" switch is on and this
 * is not a paired phone, which keeps the classic app (the same rule as the sidebar). Here rather than in a component
 * so the primitives in `components/ui.tsx` can ask too.
 */
import { useStore } from '../store';
import { useLayout } from './layout';

export function useNewLayout(): boolean {
  const device = useStore((s) => s.device);
  return useLayout() === 'toki' && !device;
}
