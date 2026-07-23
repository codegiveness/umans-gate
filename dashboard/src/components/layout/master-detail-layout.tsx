import { type ReactNode, Suspense, createContext, lazy, useContext, useState } from "react";

const Sheet = lazy(() => import("@/components/ui/sheet").then((m) => ({ default: m.Sheet })));
const SheetContent = lazy(() =>
  import("@/components/ui/sheet").then((m) => ({ default: m.SheetContent })),
);

interface MasterDetailContextValue {
  openDrawer: () => void;
  closeDrawer: () => void;
  isOpen: boolean;
}

const MasterDetailContext = createContext<MasterDetailContextValue | null>(null);

const noopContext: MasterDetailContextValue = {
  openDrawer: () => {},
  closeDrawer: () => {},
  isOpen: false,
};

export function useMasterDetail(): MasterDetailContextValue {
  const ctx = useContext(MasterDetailContext);
  return ctx ?? noopContext;
}

interface MasterDetailProviderProps {
  children: ReactNode;
}

export function MasterDetailProvider({ children }: MasterDetailProviderProps) {
  const [open, setOpen] = useState(false);

  const value: MasterDetailContextValue = {
    openDrawer: () => setOpen(true),
    closeDrawer: () => setOpen(false),
    isOpen: open,
  };

  return <MasterDetailContext.Provider value={value}>{children}</MasterDetailContext.Provider>;
}

interface MasterDetailLayoutProps {
  master: ReactNode;
  detail: ReactNode;
  masterAriaLabel: string;
  detailAriaLabel: string;
}

export function MasterDetailLayout({
  master,
  detail,
  masterAriaLabel,
  detailAriaLabel,
}: MasterDetailLayoutProps) {
  const { isOpen, closeDrawer } = useMasterDetail();

  return (
    <>
      <div className="flex h-full">
        <aside aria-label={masterAriaLabel} className="hidden w-[400px] shrink-0 md:flex">
          {master}
        </aside>
        <div className="flex flex-1 min-w-0" aria-label={detailAriaLabel}>
          {detail}
        </div>
      </div>
      {isOpen && (
        <Suspense fallback={null}>
          <Sheet
            open={isOpen}
            onOpenChange={(o) => {
              if (!o) closeDrawer();
            }}
          >
            <SheetContent
              side="left"
              aria-label={masterAriaLabel}
              className="p-0 data-[side=left]:w-[85vw] data-[side=left]:sm:w-[400px] data-[side=left]:sm:max-w-[400px]"
            >
              {master}
            </SheetContent>
          </Sheet>
        </Suspense>
      )}
    </>
  );
}
