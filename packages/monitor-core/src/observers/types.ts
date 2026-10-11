/**
 * Shared shape for everything a behavioral observer reports. Unlike axe
 * findings, these carry no DOM snapshot of their own — redaction/signature
 * happens downstream (Task 4) once the element is in hand.
 */
import type { Impact } from '../protocol/types';

export type ObserverName = 'spa-focus-loss' | 'rage-tab' | 'focus-trap' | 'focus-not-visible';

export interface ObservedFinding {
  observer: ObserverName;
  wcag: string;
  impact: Impact;
  element: Element;
}

export type FindingEmitter = (finding: ObservedFinding) => void;

export interface ObserverApi {
  detach(): void;
}
