import { Menu } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import type { ReactNode } from "react";

import { CaptureDetailPanel } from "@/components/capture-detail";
import { CaptureList } from "@/components/capture-list";
import {
  MasterDetailLayout,
  MasterDetailProvider,
  useMasterDetail,
} from "@/components/layout/master-detail-layout";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCaptures } from "@/hooks/use-captures";
import { useClipboard } from "@/hooks/use-clipboard";

const ConfigTab = lazy(() =>
  import("@/components/config-tab").then((m) => ({ default: m.ConfigTab })),
);
const ModelsTab = lazy(() =>
  import("@/components/models-tab").then((m) => ({ default: m.ModelsTab })),
);
const PerformanceMeter = lazy(() =>
  import("@/components/performance-meter").then((m) => ({ default: m.PerformanceMeter })),
);
const VisionCalls = lazy(() =>
  import("@/components/vision-calls").then((m) => ({ default: m.VisionCalls })),
);
const ModeToggle = lazy(() =>
  import("@/components/mode-toggle").then((m) => ({ default: m.ModeToggle })),
);
const Toaster = lazy(() => import("@/components/ui/sonner").then((m) => ({ default: m.Toaster })));

function TabPanelFallback() {
  return <Loader />;
}

interface TabTipProps {
  value: string;
  label: string;
  tip: string;
  children?: ReactNode;
}

function TabTriggerWithTip({ value, label, tip }: TabTipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <TabsTrigger value={value}>{label}</TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function App() {
  const {
    captures,
    selectedCapture,
    isLoadingDetail,
    isLoadingList,
    wsState,
    selectedId,
    gateStats,
    listError,
    detailError,
    selectCapture,
    clearCaptures,
    retryList,
    retryDetail,
  } = useCaptures();

  const { copyText } = useClipboard();
  const [copyStatus, setCopyStatus] = useState("Copy");

  return (
    <TooltipProvider delay={300}>
      <MasterDetailProvider>
        <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:border focus:border-border"
          >
            Skip to content
          </a>
          <Tabs defaultValue="captures" className="flex flex-1 flex-col overflow-hidden">
            <header className="flex items-center gap-2 px-4 py-2 border-b bg-background">
              <MobileDrawerTrigger />
              <h1 className="text-base font-semibold shrink-0">umans-gate</h1>
              <div className="tab-scroll flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-none">
                <TabsList className="flex w-max md:mx-auto md:w-fit">
                  <TabTriggerWithTip
                    value="captures"
                    label="Captures"
                    tip="Live log of every intercepted API call"
                  />
                  <TabTriggerWithTip
                    value="vision"
                    label="Vision Calls"
                    tip="Image-bearing requests with model responses"
                  />
                  <TabTriggerWithTip
                    value="performance"
                    label="Performance"
                    tip="Per-model TTFT, TPS, and token throughput"
                  />
                  <TabTriggerWithTip
                    value="models"
                    label="Models"
                    tip="Upstream model catalog with pricing"
                  />
                  <TabTriggerWithTip
                    value="config"
                    label="Config"
                    tip="Edit proxy settings and reload live"
                  />
                </TabsList>
              </div>
              <Suspense fallback={null}>
                <ModeToggle />
              </Suspense>
            </header>
            <main id="main" aria-label="Inspector" className="flex-1 flex flex-col overflow-hidden">
              <TabsContent value="captures" className="flex-1 overflow-hidden" keepMounted>
                <MasterDetailLayout
                  master={
                    <CaptureList
                      captures={captures}
                      selectedId={selectedId}
                      wsState={wsState}
                      gateStats={gateStats}
                      listError={listError}
                      isLoading={isLoadingList}
                      onSelect={selectCapture}
                      onClear={clearCaptures}
                      onRetry={retryList}
                    />
                  }
                  detail={
                    <CaptureDetailPanel
                      capture={selectedCapture}
                      isLoading={isLoadingDetail}
                      detailError={detailError}
                      onCopy={copyText}
                      onCopyStatus={setCopyStatus}
                      onRetry={retryDetail}
                    />
                  }
                  masterAriaLabel="Captures list"
                  detailAriaLabel="Capture detail"
                />
              </TabsContent>
              <TabsContent value="vision" className="min-h-0 flex-1 overflow-hidden" keepMounted>
                <Suspense fallback={<TabPanelFallback />}>
                  <VisionCalls />
                </Suspense>
              </TabsContent>
              <TabsContent
                value="performance"
                className="min-h-0 flex-1 overflow-hidden"
                keepMounted
              >
                <Suspense fallback={<TabPanelFallback />}>
                  <PerformanceMeter />
                </Suspense>
              </TabsContent>
              <TabsContent value="models" className="min-h-0 flex-1 overflow-hidden" keepMounted>
                <Suspense fallback={<TabPanelFallback />}>
                  <ModelsTab />
                </Suspense>
              </TabsContent>
              <TabsContent value="config" className="min-h-0 flex-1 overflow-hidden" keepMounted>
                <Suspense fallback={<TabPanelFallback />}>
                  <ConfigTab />
                </Suspense>
              </TabsContent>
            </main>
          </Tabs>
          <Suspense fallback={null}>
            <Toaster />
          </Suspense>
          <output aria-live="polite" className="sr-only">
            {copyStatus}
          </output>
        </div>
      </MasterDetailProvider>
    </TooltipProvider>
  );
}

function MobileDrawerTrigger() {
  const { openDrawer } = useMasterDetail();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open captures"
          onClick={openDrawer}
        >
          <Menu className="h-5 w-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Open captures list</TooltipContent>
    </Tooltip>
  );
}

export default App;
