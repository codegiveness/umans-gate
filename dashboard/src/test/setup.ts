import "@testing-library/jest-dom/vitest";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Radix ScrollArea uses ResizeObserver; jsdom doesn't provide one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
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
window.addEventListener("error", (e: ErrorEvent) => {
  e.preventDefault();
});

// Recharts emits console.warn when a chart renders in a container with zero
// width/height — expected in jsdom (no layout engine). The warning is async
// and can race with vitest worker teardown, producing an
// EnvironmentTeardownError that fails CI despite all tests passing. Suppress it.
const rechartsDimWarn = /The width\(0\) and height\(0\) of chart should be greater than 0/;
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (rechartsDimWarn.test(String(args[0]))) return;
  originalWarn(...args);
};

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
const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (actWarn.test(String(args[0]))) return;
  originalError(...args);
};
