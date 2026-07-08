import { useCallback, useEffect, useRef, useState } from "react";

interface UseCaptureListboxOptions {
  captures: { id: number; path: string }[];
  selectedId: number | null;
  onSelectId: (id: number) => void;
  scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
}

interface UseCaptureListboxResult {
  activeIndex: number;
  activeOptionId: string | undefined;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleRowClick: (index: number) => void;
}

const TYPEAHEAD_TIMEOUT_MS = 500;

export function useCaptureListbox({
  captures,
  selectedId,
  onSelectId,
  scrollToIndex,
}: UseCaptureListboxOptions): UseCaptureListboxResult {
  const count = captures.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const typeaheadRef = useRef<{
    chars: string;
    timer: ReturnType<typeof setTimeout> | undefined;
  }>({ chars: "", timer: undefined });

  // Sync activeIndex when selectedId changes to keep focus and selection aligned
  useEffect(() => {
    if (selectedId === null || count === 0) return;
    const idx = captures.findIndex((c) => c.id === selectedId);
    if (idx >= 0) {
      setActiveIndex(idx);
    }
  }, [selectedId, count, captures]);

  // Cleanup typeahead timer on unmount
  useEffect(() => {
    return () => {
      if (typeaheadRef.current.timer) {
        clearTimeout(typeaheadRef.current.timer);
      }
    };
  }, []);

  const clamp = useCallback(
    (idx: number) => {
      if (count === 0) return -1;
      return Math.max(0, Math.min(idx, count - 1));
    },
    [count],
  );

  const move = useCallback(
    (idx: number) => {
      const clamped = clamp(idx);
      if (clamped < 0) return;
      setActiveIndex(clamped);
      scrollToIndex(clamped, { align: "auto" });
    },
    [clamp, scrollToIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (count === 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(activeIndex + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(activeIndex - 1);
          break;
        case "Home":
          e.preventDefault();
          move(0);
          break;
        case "End":
          e.preventDefault();
          move(count - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < count) {
            onSelectId(captures[activeIndex].id);
          }
          break;
        default: {
          // Typeahead: jump to first row whose path starts with typed chars
          if (e.key.length === 1 && /[a-zA-Z0-9/]/.test(e.key)) {
            const char = e.key.toLowerCase();
            const current = typeaheadRef.current;
            current.chars += char;
            if (current.timer) clearTimeout(current.timer);
            current.timer = setTimeout(() => {
              typeaheadRef.current.chars = "";
            }, TYPEAHEAD_TIMEOUT_MS);

            const searchStr = current.chars;
            for (let i = 0; i < count; i++) {
              if (captures[i].path.toLowerCase().startsWith(searchStr)) {
                move(i);
                break;
              }
            }
          }
          break;
        }
      }
    },
    [count, activeIndex, move, onSelectId, captures],
  );

  const handleRowClick = useCallback(
    (index: number) => {
      if (index < 0 || index >= count) return;
      setActiveIndex(index);
      onSelectId(captures[index].id);
    },
    [onSelectId, captures, count],
  );

  const safeActiveIndex = count === 0 ? -1 : Math.min(activeIndex, count - 1);
  const activeOptionId =
    safeActiveIndex >= 0 ? `capture-opt-${captures[safeActiveIndex].id}` : undefined;

  return {
    activeIndex: safeActiveIndex,
    activeOptionId,
    handleKeyDown,
    handleRowClick,
  };
}
