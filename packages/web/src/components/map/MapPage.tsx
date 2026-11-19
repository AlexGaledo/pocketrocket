// New layout: a project's Map tab (docs/specs/toki-ui.md). Phase 2 holds the place; the canvas, Generate and the
// prompt bar arrive in phase 3. Nothing here is faked: with no canvas yet, it says so.
import { Map as MapIcon } from 'lucide-react';
import { Button, EmptyState } from '../ui';

export function MapPage() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas">
      <EmptyState icon={<MapIcon size={18} />} title="No map yet" as="h2" action={<Button disabled>Generate map</Button>}>
        A bot will be able to draw this project's map here soon.
      </EmptyState>
    </div>
  );
}
