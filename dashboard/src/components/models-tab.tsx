import { AlertCircle, Boxes, Brain, ExternalLink, Eye, RefreshCw, Wrench } from "lucide-react";
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
        {info?.base_model &&
          (info.base_model.provider || info.base_model.family || info.base_model.oss_base) && (
            <p className="text-[11px] text-muted-foreground">
              {[info.base_model.provider, info.base_model.family, info.base_model.oss_base]
                .filter(Boolean)
                .join(" · ")}
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
            <CapabilityBadge
              icon={<Boxes className="h-3 w-3" />}
              tooltip="Maximum number of tokens (input + output) the model can process in a single request."
            >
              {formatTokens(caps.context_window)} ctx
            </CapabilityBadge>
            {caps.max_completion_tokens > 0 && (
              <CapabilityBadge tooltip="Hard ceiling on output tokens per response. Requests asking for more will be capped or rejected.">
                {formatTokens(caps.max_completion_tokens)} max out
              </CapabilityBadge>
            )}
            {caps.recommended_max_tokens > 0 &&
              caps.recommended_max_tokens !== caps.max_completion_tokens && (
                <CapabilityBadge tooltip="Suggested output token limit for best quality. Exceeding this may degrade responses.">
                  {formatTokens(caps.recommended_max_tokens)} rec out
                </CapabilityBadge>
              )}
            {caps.supports_vision === true && (
              <CapabilityBadge
                icon={<Eye className="h-3 w-3" />}
                tooltip="Accepts image inputs directly — the model processes images natively."
              >
                vision
              </CapabilityBadge>
            )}
            {caps.supports_vision === "via-handoff" && (
              <CapabilityBadge
                icon={<Eye className="h-3 w-3" />}
                variant="outline"
                tooltip="Image inputs are forwarded to a secondary model for preprocessing, then handed back. Less efficient than native vision; may be retired."
              >
                vision handoff
              </CapabilityBadge>
            )}
            {caps.supports_tools && (
              <CapabilityBadge
                icon={<Wrench className="h-3 w-3" />}
                tooltip="Supports function/tool calling — the model can emit structured tool-use requests that clients execute."
              >
                tools
              </CapabilityBadge>
            )}
            {reasoning?.supported && (
              <CapabilityBadge
                icon={<Brain className="h-3 w-3" />}
                tooltip={
                  reasoning.can_disable
                    ? `Extended thinking is supported and can be toggled. Default level: ${reasoning.default_level ?? "on"}. Available levels: ${reasoning.levels.length > 0 ? reasoning.levels.join(", ") : "default"}.`
                    : `Extended thinking is always on and cannot be disabled. Default level: ${reasoning.default_level ?? "on"}.`
                }
              >
                {reasoning.default_level ?? "on"}
                {!reasoning.can_disable && " · locked"}
              </CapabilityBadge>
            )}
            {info?.weights?.precision && (
              <CapabilityBadge
                tooltip={`Weight precision: ${info.weights.precision}. "full" means unquantized (higher quality, more VRAM). "fp8" is 8-bit quantized (lower memory, faster, minor quality loss).`}
              >
                {info.weights.precision}
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

        {/* Weights / model source link */}
        {info?.weights?.hf_url && (
          <a
            href={info.weights.hf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            HuggingFace weights
          </a>
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
  tooltip,
}: {
  children: ReactNode;
  icon?: ReactNode;
  variant?: "default" | "secondary" | "outline" | "destructive";
  className?: string;
  tooltip: string;
}) {
  const badge = (
    <Badge variant={variant ?? "outline"} size="sm" className={cn("gap-1", className)}>
      {icon}
      {children}
    </Badge>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export default ModelsTab;
