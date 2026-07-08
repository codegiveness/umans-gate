import { useCallback } from "react";

export function useClipboard(): {
  copyText: (text: string) => Promise<boolean>;
} {
  const copyText = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to textarea fallback
    }

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();

    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      // ignore
    }
    document.body.removeChild(ta);
    return ok;
  }, []);

  return { copyText };
}
