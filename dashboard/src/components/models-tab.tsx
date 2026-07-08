import { AlertCircle, Boxes, Brain, Eye, RefreshCw, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModels } from "@/hooks/use-models";
import { cn } from "@/lib/utils";
import type { ModelEntry } from "@/types";

export function ModelsTab() {
  const { data, loading, error, refresh } = useModels();
  const models = data?.models ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Models</h2>
          {data && (
            <span className="text-xs text-muted-foreground">
              {models.length} model{models.length === 1 ? "" : "s"}
            </span>
          )}
          {data && !data.ok && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="destructive" className="ml-1">
                  stale
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px]">
                Upstream model list could not be refreshed — showing last snapshot
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? (
                <Spinner className="mr-1.5 size-3.5" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Re-fetch the upstream model catalog</TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {loading && !data ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <AlertCircle className="h-12 w-12 text-destructive" />
              <p className="text-sm font-medium text-destructive">Something went wrong</p>
              <p className="text-xs">{error}</p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={refresh}>
                    Retry
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Retry loading models</TooltipContent>
              </Tooltip>
            </div>
          ) : models.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Boxes className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">No models available</p>
              <p className="text-xs">The proxy could not fetch the upstream model list.</p>
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-1 place-content-center gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {models.map((m) => (
                <ModelCard key={m.id} entry={m} fetchedAt={data?.fetched_at ?? 0} />
              ))}
              {data && data.fetched_at > 0 && (
                <p className="col-span-full pt-2 text-center text-xs text-muted-foreground">
                  Last fetched {new Date(data.fetched_at).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
}

function ModelCard({ entry, fetchedAt }: { entry: ModelEntry; fetchedAt: number }) {
  const cheap = entry.weight < 1;
  const info = entry.info;
  const caps = info?.capabilities;
  const reasoning = caps?.reasoning;

  return (
    <Card className="flex w-full min-w-0 flex-col">
      <CardContent className="flex flex-1 flex-col gap-2 p-3">
        {/* Header: identity + weight */}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 overflow-hidden">
            <h3 className="truncate text-sm font-semibold" title={entry.id}>
              {info?.display_name ?? entry.id}
            </h3>
            {info && info.display_name !== info.name && (
              <p className="truncate text-[11px] text-muted-foreground" title={info.name}>
                {info.name}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant={cheap ? "secondary" : "outline"}>
                  weight={entry.weight.toFixed(1)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px]">
                Relative probability this model is picked when multiple match
                {cheap ? " — cheaper fallback" : " — primary pick"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Provider / family line */}
        {info?.base_model && (info.base_model.provider || info.base_model.family) && (
          <p className="text-[11px] text-muted-foreground">
            {[info.base_model.provider, info.base_model.family].filter(Boolean).join(" · ")}
          </p>
        )}

        {/* Description */}
        {info?.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground" title={info.description}>
            {info.description}
          </p>
        )}

        {/* Capabilities badges */}
        {caps && (
          <div className="flex flex-wrap gap-1">
            <CapabilityBadge icon={<Boxes className="h-3 w-3" />}>
              {formatTokens(caps.context_window)} ctx
            </CapabilityBadge>
            {caps.max_completion_tokens > 0 && (
              <CapabilityBadge>{formatTokens(caps.max_completion_tokens)} max out</CapabilityBadge>
            )}
            {caps.supports_vision === true && (
              <CapabilityBadge icon={<Eye className="h-3 w-3" />}>vision</CapabilityBadge>
            )}
            {caps.supports_vision === "via-handoff" && (
              <CapabilityBadge icon={<Eye className="h-3 w-3" />} variant="outline">
                vision handoff
              </CapabilityBadge>
            )}
            {caps.supports_tools && (
              <CapabilityBadge icon={<Wrench className="h-3 w-3" />}>tools</CapabilityBadge>
            )}
            {reasoning?.supported && (
              <CapabilityBadge icon={<Brain className="h-3 w-3" />}>
                {reasoning.default_level ?? "on"}
                {!reasoning.can_disable && " · locked"}
              </CapabilityBadge>
            )}
          </div>
        )}

        {/* Pricing */}
        {entry.pricing ? (
          <div className="mt-auto grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">in </span>
              <span className="font-mono">${entry.pricing.input.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">out </span>
              <span className="font-mono">${entry.pricing.output.toFixed(2)}</span>
            </div>
          </div>
        ) : (
          <p className="mt-auto text-xs italic text-muted-foreground">no pricing</p>
        )}

        {fetchedAt === 0 && (
          <p className="text-[11px] text-muted-foreground">catalog not yet fetched</p>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityBadge({
  children,
  icon,
  variant,
  className,
}: {
  children: ReactNode;
  icon?: ReactNode;
  variant?: "default" | "secondary" | "outline" | "destructive";
  className?: string;
}) {
  return (
    <Badge variant={variant ?? "outline"} size="sm" className={cn("gap-1", className)}>
      {icon}
      {children}
    </Badge>
  );
}

export default ModelsTab;
