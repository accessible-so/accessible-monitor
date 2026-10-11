/**
 * When the visitor is idle — the moment heavy checks may run while the page is
 * still visible.
 *
 * The 50 ms budget exists to protect responsiveness, and a long task only
 * hurts it when input lands during it. A visitor who has not touched the page
 * for a second is usually reading, so the scheduler may run a longer task
 * then (spec: docs/specs/2026-10-11-adaptive-collection.md §3.2). Any input
 * closes the gate at once; `axe.run` cannot be interrupted, so the guarantee
 * is that nothing *new* starts until the visitor is quiet again.
 */
export const IDLE_QUIET_MS = 1000;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export interface IdleGateApi {
  isOpen(): boolean;
  whenOpen(cb: () => void): void;
  detach(): void;
}

export interface IdleGateOptions {
  win: Window;
  doc: Document;
  quietMs?: number;
}

type SchedulingNavigator = Navigator & { scheduling?: { isInputPending?: () => boolean } };

export function IdleGate(options: IdleGateOptions): IdleGateApi {
  const { win, doc } = options;
  const quietMs = options.quietMs ?? IDLE_QUIET_MS;
  let loaded = doc.readyState === 'complete';
  let quiet = false;
  let detached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: (() => void)[] = [];

  function visible(): boolean {
    try { return doc.visibilityState !== 'hidden'; } catch { return false; }
  }

  function inputPending(): boolean {
    try { return (win.navigator as SchedulingNavigator).scheduling?.isInputPending?.() === true; } catch { return false; }
  }

  function isOpen(): boolean {
    return !detached && loaded && quiet && visible() && !inputPending();
  }

  function release(): void {
    if (!isOpen()) return;
    const now = waiters;
    waiters = [];
    for (const cb of now) { try { cb(); } catch { /* a waiter never throws into the host */ } }
  }

  function restartQuiet(): void {
    quiet = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (detached || !loaded) return;
    timer = setTimeout(() => {
      timer = null;
      quiet = true;
      release();
    }, quietMs);
  }

  const onInput = (): void => { try { restartQuiet(); } catch { /* never throws into the host */ } };
  const onLoad = (): void => { try { loaded = true; restartQuiet(); } catch { /* never throws */ } };
  const onVisibilityChange = (): void => { try { if (!visible()) return; restartQuiet(); } catch { /* never throws into the host */ } };
  const listen = { capture: true, passive: true } as const;

  for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, listen);
  if (!loaded) win.addEventListener('load', onLoad);
  doc.addEventListener('visibilitychange', onVisibilityChange, listen);
  restartQuiet();

  return {
    isOpen,
    whenOpen(cb: () => void): void {
      if (detached) return;
      waiters.push(cb);
      if (isOpen()) setTimeout(release, 0);
    },
    detach(): void {
      detached = true;
      waiters = [];
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, listen);
      win.removeEventListener('load', onLoad);
      doc.removeEventListener('visibilitychange', onVisibilityChange, listen);
    },
  };
}
