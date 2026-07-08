import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function Loader({ className }: { className?: string }) {
  return (
    <div data-slot="loader" className={cn("flex h-full items-center justify-center", className)}>
      <Spinner className="size-8 text-muted-foreground" />
    </div>
  );
}

export { Loader };
