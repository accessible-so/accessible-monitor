/**
 * Wires all four behavioral observers to one document/window and returns a
 * single detach that undoes everything they did (including the History
 * patch from spa-focus-loss). Each observer already wraps its own
 * listeners in try/catch; this only has to compose their detach calls.
 */
import { attachFocusTrap } from './focus-trap';
import { attachFocusVisible } from './focus-visible';
import { attachRageTab } from './rage-tab';
import { attachSpaFocusLoss } from './spa-focus-loss';
import type { FindingEmitter } from './types';

export type { ObservedFinding, ObserverName } from './types';
export { decideFocusVisible } from './focus-visible';
export { commonAncestor } from './focus-trap';

export interface ObserverContext {
  doc: Document;
  win: Window;
  onFinding: FindingEmitter;
  onRouteChange: (path: string) => void;
}

export function attachObservers(ctx: ObserverContext): () => void {
  const { doc, win, onFinding, onRouteChange } = ctx;
  const observers = [
    attachSpaFocusLoss(doc, win, onFinding, onRouteChange),
    attachRageTab(doc, win, onFinding),
    attachFocusTrap(doc, win, onFinding),
    attachFocusVisible(doc, win, onFinding),
  ];

  return function detach(): void {
    for (const observer of observers) {
      try {
        observer.detach();
      } catch {
        // best-effort teardown
      }
    }
  };
}
