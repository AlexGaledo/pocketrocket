import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@claudebot/shared';

class HubEvents extends EventEmitter {
  emitEvent(ev: ServerEvent) {
    this.emit('event', ev);
  }
  onEvent(fn: (ev: ServerEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
export const events = new HubEvents();
events.setMaxListeners(100);
