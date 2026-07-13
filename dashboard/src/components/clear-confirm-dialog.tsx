import { useEffect } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ClearConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onClose: () => void;
  count: number;
  title?: string;
  itemLabel?: string;
  confirmTooltip?: string;
}

export function ClearConfirmDialog({
  open,
  onConfirm,
  onClose,
  count,
  title = "Clear all captures?",
  itemLabel = "captured request",
  confirmTooltip = "Permanently delete all captured requests",
}: ClearConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    // Use capture phase so we intercept Escape before Base UI's AlertDialog
    // (which blocks Escape to enforce non-dismissable behavior) can swallow it.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {count} {itemLabel}
            {count === 1 ? "" : "s"}? This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Tooltip>
            <TooltipTrigger render={<AlertDialogCancel />}>Cancel</TooltipTrigger>
            <TooltipContent side="top">Dismiss without deleting</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<AlertDialogAction onClick={onConfirm} />}>
              Clear
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px]">
              {confirmTooltip}
            </TooltipContent>
          </Tooltip>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
