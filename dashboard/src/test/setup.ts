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
