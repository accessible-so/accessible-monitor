/**
 * Teardown bookkeeping.
 *
 * Each piece of the collector registers how to undo itself the moment it
 * attaches, so there is exactly one list to run — whether the page is hiding,
 * the host called `stop()`, or the wiring threw half-way through and the
 * collector has to leave the page exactly as it found it. Steps run in
 * reverse order (last attached, first detached) and a step that throws never
 * stops the ones behind it.
 */
export interface LifecycleApi {
  add(step: () => void): void;
  run(): void;
  done(): boolean;
}

export function Lifecycle(debug: (...args: unknown[]) => void): LifecycleApi {
  const steps: Array<() => void> = [];
  let ran = false;

  return {
    add(step: () => void): void {
      steps.push(step);
    },
    run(): void {
      if (ran) return;
      ran = true;
      while (steps.length > 0) {
        const step = steps.pop();
        try { step?.(); } catch (err) { debug('teardown step failed', err); }
      }
    },
    done: (): boolean => ran,
  };
}
