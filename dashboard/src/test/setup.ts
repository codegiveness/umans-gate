import "@testing-library/jest-dom/vitest";
import { afterAll, beforeAll } from "vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// React 19 act() gate. Set once per worker; vitest imports setup once.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Snapshot of per-worker globals that the polyfills below override, so afterAll
// can restore them at worker teardown and avoid leaking into sibling workers.
interface WorkerGlobals {
  resizeObserver: typeof globalThis.ResizeObserver | undefined;
  getAnimations: (() => Animation[]) | undefined;
  showModal: ((this: HTMLDialogElement) => void) | undefined;
  close: ((this: HTMLDialogElement) => void) | undefined;
  warn: typeof console.warn;
  error: typeof console.error;
  errorListener: ((e: ErrorEvent) => void) | null;
}

let snapshot: WorkerGlobals | null = null;

// Radix ScrollArea uses ResizeObserver; jsdom doesn't provide one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Recharts emits console.warn when a chart renders in a container with zero
// width/height — expected in jsdom (no layout engine). The warning is async
// and can race with vitest worker teardown, producing an
// EnvironmentTeardownError that fails CI despite all tests passing. Suppress it.
const rechartsDimWarn = /The width\(0\) and height\(0\) of chart should be greater than 0/;

// React's "not wrapped in act(...)" warning fires when <App /> mounts polling
// or WS hooks whose async state updates escape the test's act() scope. The
// updates are harmless (tests assert static DOM structure), but the warning
// is emitted via console.error and queues on the vitest worker RPC channel.
// On slow CI the queue outlives the worker → EnvironmentTeardownError →
// exit 1 despite all tests passing. Same race as the Recharts warn above;
// same suppression pattern. Narrow to the act warning only — real errors
// still surface.
const actWarn =
  /An update to .* inside a test was not wrapped in act\(\.\.\.\)|When testing, code that causes React state updates should be wrapped into act\(\.\.\.\)|This ensures that you're testing the behavior the user would see in the browser/;

beforeAll(() => {
  snapshot = {
    resizeObserver: globalThis.ResizeObserver,
    getAnimations: Element.prototype.getAnimations as (() => Animation[]) | undefined,
    showModal: HTMLDialogElement.prototype.showModal as
      | ((this: HTMLDialogElement) => void)
      | undefined,
    close: HTMLDialogElement.prototype.close as ((this: HTMLDialogElement) => void) | undefined,
    warn: console.warn,
    error: console.error,
    errorListener: null,
  };

  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  // Base UI ScrollArea.Viewport calls Element.getAnimations() to detect running
  // transitions; jsdom doesn't implement the Web Animations API.
  if (typeof Element.prototype.getAnimations !== "function") {
    Element.prototype.getAnimations = () => [];
  }

  // jsdom doesn't implement HTMLDialogElement.showModal() / close().
  // Polyfill with a no-op that sets the `open` attribute so tests can assert visibility.
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }

  // React's dev-mode invokeGuardedCallback dispatches a fake DOM event to invoke
  // the error boundary. jsdom prints the thrown error to stderr unless the error
  // event is defaultPrevented. This global listener silences that noise.
  const errorListener = (e: ErrorEvent) => {
    e.preventDefault();
  };
  window.addEventListener("error", errorListener);
  snapshot.errorListener = errorListener;

  console.warn = (...args: unknown[]) => {
    if (rechartsDimWarn.test(String(args[0]))) return;
    snapshot!.warn(...args);
  };

  console.error = (...args: unknown[]) => {
    if (actWarn.test(String(args[0]))) return;
    snapshot!.error(...args);
  };
});

afterAll(() => {
  if (!snapshot) return;

  console.warn = snapshot.warn;
  console.error = snapshot.error;

  if (snapshot.errorListener) {
    window.removeEventListener("error", snapshot.errorListener);
  }

  if (snapshot.resizeObserver !== undefined) {
    globalThis.ResizeObserver = snapshot.resizeObserver;
  }

  if (snapshot.getAnimations !== undefined) {
    Element.prototype.getAnimations = snapshot.getAnimations;
  }

  if (snapshot.showModal !== undefined) {
    HTMLDialogElement.prototype.showModal = snapshot.showModal;
  }

  if (snapshot.close !== undefined) {
    HTMLDialogElement.prototype.close = snapshot.close;
  }

  snapshot = null;
});
