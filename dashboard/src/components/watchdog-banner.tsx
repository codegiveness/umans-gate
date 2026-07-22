import { AlertTriangle, X } from "lucide-react";

interface WatchdogBannerProps {
  watchdogDisabled: boolean;
  consecutiveFailures: number;
  onDismiss: () => void;
}

export function WatchdogBanner({
  watchdogDisabled,
  consecutiveFailures,
  onDismiss,
}: WatchdogBannerProps) {
  if (!watchdogDisabled) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-100"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="flex-1 text-sm">
        <p>
          TTFT watchdog auto-disabled after {consecutiveFailures} consecutive retry failures.
          Upstream stalls will no longer be retried — only the 5-min absolute timeout applies.
        </p>
        <p className="mt-1 text-amber-700 dark:text-amber-300">Reload config to re-enable.</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss watchdog banner"
        className="shrink-0 rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-800"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
