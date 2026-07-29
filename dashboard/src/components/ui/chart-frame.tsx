import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * ChartFrame — defers rendering of recharts ResponsiveContainer until the
 * container has non-zero dimensions.
 *
 * When a tab panel is inactive, Base UI sets the `hidden` attribute, which
 * makes the element `display: none`. Recharts' ResponsiveContainer measures
 * 0×0 in that state and floods the console with width(0)/height(0) warnings
 * (observed: 776 occurrences). This wrapper detects zero-size containers
 * and renders an empty placeholder div instead, eliminating the warnings.
 *
 * When the container becomes visible (tab switched to), the ResizeObserver
 * fires and the chart renders normally.
 */
interface ChartFrameProps {
  /** Tailwind height class for the outer div, e.g. "h-32" or "h-16". */
  className?: string;
  /** The chart content (ResponsiveContainer + chart). */
  children: ReactNode;
}

export function ChartFrame({ className, children }: ChartFrameProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const check = () => {
      // getBoundingClientRect returns {width:0, height:0} when the element
      // or an ancestor has display:none (e.g. the hidden attribute set by
      // Base UI TabsPanel). Unlike offsetParent, this works regardless of
      // position:fixed/absolute on the container or its ancestors.
      const { width, height } = el.getBoundingClientRect();
      setVisible(width > 0 && height > 0);
    };

    // Initial check.
    check();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      check();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className={cn("w-full", className)}>
      {visible ? children : null}
    </div>
  );
}
