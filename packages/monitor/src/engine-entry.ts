import axe from 'axe-core';
import { startCollector, type StartOptions } from '@accessible-so/monitor-core';

declare const __VERSION__: string;

declare global {
  interface Window {
    __accessibleRum?: { start(o: Omit<StartOptions, 'axe'>): void; version: string };
  }
}

window.__accessibleRum = {
  version: __VERSION__,
  start(o) {
    try {
      startCollector({ ...o, axe: axe as unknown as StartOptions['axe'] });
    } catch {}
  },
};
