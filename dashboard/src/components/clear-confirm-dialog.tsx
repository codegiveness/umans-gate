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
}

export function ClearConfirmDialog({ open, onConfirm, onClose, count }: ClearConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all captures?</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {count} captured request{count === 1 ? "" : "s"}? This cannot be undone.
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
              Permanently delete all captured requests
            </TooltipContent>
          </Tooltip>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
