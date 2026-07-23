import { Beaker, Cloud, Download, Info, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FieldDef, GroupDef, SectionDef } from "@/components/config-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RawConfig } from "@/hooks/use-config";
import { badgeInfo, badgeWarning } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

/** Convert a RawConfig value into a string suitable for an input field. */
function valueToString(v: unknown, nullable?: boolean): string {
  if (v === null || v === undefined) return nullable ? "" : "";
  return String(v);
}

function serializeJson(v: unknown): string {
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Shared props every field renderer receives. */
interface RendererProps {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  isInvalid: boolean;
  placeholder: string | undefined;
}

type FieldRenderer = (props: RendererProps) => React.JSX.Element;

function BooleanRenderer({ id, value, onChange }: RendererProps) {
  return <Switch id={id} checked={Boolean(value)} onCheckedChange={(c) => onChange(c)} />;
}

function ToggleRenderer({ id, value, onChange }: RendererProps) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={Boolean(value)} onCheckedChange={(c) => onChange(c)} />
      <span className="text-xs text-muted-foreground">{value ? "On" : "Off"}</span>
    </div>
  );
}

function SelectRenderer({ def, value, onChange, id, isInvalid }: RendererProps) {
  return (
    <Select
      value={String(value ?? "")}
      onValueChange={(v) => onChange(def.nullable && v === "" ? null : v)}
    >
      <SelectTrigger id={id} aria-invalid={isInvalid || undefined}>
        <SelectValue placeholder={def.placeholder ?? "Select…"} />
      </SelectTrigger>
      <SelectContent>
        {(def.options ?? []).map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TextareaRenderer({ def, value, onChange, id, isInvalid, placeholder }: RendererProps) {
  return (
    <Textarea
      id={id}
      value={valueToString(value, def.nullable)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      aria-invalid={isInvalid || undefined}
    />
  );
}

function PasswordRenderer({ def, value, onChange, id, isInvalid, placeholder }: RendererProps) {
  return (
    <PasswordInput
      id={id}
      value={valueToString(value, def.nullable)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      disabled={def.disabled}
      aria-invalid={isInvalid || undefined}
    />
  );
}

function NumberRenderer({ def, value, onChange, id, isInvalid, placeholder }: RendererProps) {
  return (
    <NumberInput
      id={id}
      min={def.min}
      max={def.max}
      suffix={def.suffix}
      value={valueToString(value, def.nullable)}
      placeholder={placeholder}
      onChange={(v) => onChange(v)}
      disabled={def.disabled}
      aria-invalid={isInvalid || undefined}
    />
  );
}

function JsonRenderer({ def, value, onChange, id, isInvalid }: RendererProps) {
  return <JsonFieldRow def={def} value={value} onChange={onChange} id={id} isInvalid={isInvalid} />;
}

function TextRenderer({ def, value, onChange, id, isInvalid, placeholder }: RendererProps) {
  return (
    <div className="relative flex items-center">
      <Input
        id={id}
        type={def.inputMode === "url" ? "url" : "text"}
        value={valueToString(value, def.nullable)}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={def.disabled}
        aria-invalid={isInvalid || undefined}
      />
      {def.suffix ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {def.suffix}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Registry of field renderers keyed by FieldDef.kind.
 * Adding a new field kind requires only one entry here.
 */
const FIELD_RENDERERS: Record<FieldDef["kind"], FieldRenderer> = {
  boolean: BooleanRenderer,
  toggle: ToggleRenderer,
  select: SelectRenderer,
  textarea: TextareaRenderer,
  password: PasswordRenderer,
  number: NumberRenderer,
  json: JsonRenderer,
  text: TextRenderer,
};

function JsonFieldRow({
  def,
  value,
  onChange,
  id,
  isInvalid,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  isInvalid: boolean;
}) {
  const [text, setText] = useState(() => serializeJson(value));
  const [parseError, setParseError] = useState<string | null>(null);
  const lastValueRef = useRef<unknown>(value);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setText(serializeJson(value));
      setParseError(null);
    }
  }, [value]);

  const handleChange = (newText: string) => {
    setText(newText);
    if (newText.trim() === "") {
      setParseError(null);
      const fallback = def.nullable ? null : {};
      if (lastValueRef.current !== fallback) {
        lastValueRef.current = fallback;
        onChange(fallback);
      }
      return;
    }
    try {
      const parsed = JSON.parse(newText);
      setParseError(null);
      lastValueRef.current = parsed;
      onChange(parsed);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      // Don't call onChange — keep previous valid value in draft.
    }
  };

  return (
    <>
      <Textarea
        id={id}
        value={text}
        placeholder={def.placeholder ?? "JSON object"}
        onChange={(e) => handleChange(e.target.value)}
        rows={6}
        aria-invalid={isInvalid || Boolean(parseError) || undefined}
        className="font-mono text-xs"
      />
      {parseError ? (
        <p className="text-xs font-medium text-destructive" role="alert">
          {parseError}
        </p>
      ) : null}
    </>
  );
}

export function FieldRow({
  def,
  value,
  onChange,
  dirty,
  error,
  warning,
  onRefreshSource,
  refreshing,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  dirty: boolean;
  error?: string;
  warning?: string;
  onRefreshSource?: () => void;
  refreshing?: boolean;
}) {
  const id = `cfg-${def.key}`;
  const hasError = Boolean(error);
  const isInvalid = hasError;
  const placeholder = def.placeholder ?? def.patternHint ?? undefined;

  return (
    <div className="grid grid-cols-1 gap-1.5 py-2.5 sm:grid-cols-[minmax(200px,1fr)_2fr] sm:items-start sm:gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Label
            htmlFor={id}
            className={cn(dirty && "text-primary", hasError && "text-destructive")}
          >
            {def.label}
          </Label>
          {def.required ? (
            <Badge variant="destructive" size="sm">
              Required
            </Badge>
          ) : null}
          {def.restartRequired ? (
            <Badge variant="secondary" size="sm">
              <RotateCw className="h-2.5 w-2.5" />
              restart
            </Badge>
          ) : null}
          {def.experimental ? (
            <Badge variant="secondary" size="sm" className={badgeWarning}>
              <Beaker className="h-2.5 w-2.5" />
              experimental
            </Badge>
          ) : null}
          {def.umansSourced ? (
            <Badge variant="secondary" size="sm" className={badgeInfo}>
              <Cloud className="h-2.5 w-2.5" />
              Umans API
            </Badge>
          ) : null}
          {def.tooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={`More info about ${def.label}`}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[320px]">
                {def.tooltip}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {def.description ? (
          <span className="text-xs text-muted-foreground">{def.description}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <div className="flex-1">
            {FIELD_RENDERERS[def.kind]({
              def,
              value,
              onChange,
              id,
              isInvalid,
              placeholder,
            })}
          </div>
          {def.refreshSource && onRefreshSource ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  disabled={refreshing}
                  onClick={onRefreshSource}
                  aria-label={`Refresh ${def.label} from source`}
                >
                  <Download className={cn("h-3.5 w-3.5", refreshing && "animate-pulse")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Re-fetch from upstream rate-limit headers</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {hasError ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {warning && !hasError ? (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">{warning}</p>
        ) : null}
      </div>
    </div>
  );
}

export function SectionBlock({
  section,
  values,
  originals,
  onField,
  errors,
  warnings,
  isLast,
  onRefreshSource,
  refreshingSource,
}: {
  section: SectionDef;
  values: RawConfig;
  originals: RawConfig;
  onField: (key: keyof RawConfig, v: unknown) => void;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  isLast: boolean;
  onRefreshSource?: () => void;
  refreshingSource?: boolean;
}) {
  return (
    <section className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <div>
          <h4 className="text-sm font-semibold tracking-tight">{section.title}</h4>
          <p className="text-xs text-muted-foreground">{section.description}</p>
        </div>
      </div>
      {section.fields.map((f) => (
        <FieldRow
          key={f.key}
          def={f}
          value={values[f.key]}
          onChange={(v) => onField(f.key, v)}
          dirty={JSON.stringify(values[f.key] ?? null) !== JSON.stringify(originals[f.key] ?? null)}
          error={errors[f.key as string]}
          warning={warnings[f.key as string]}
          onRefreshSource={f.refreshSource ? onRefreshSource : undefined}
          refreshing={refreshingSource}
        />
      ))}
      {!isLast ? <Separator className="my-2" /> : null}
    </section>
  );
}

export function GroupBlock({
  group,
  values,
  originals,
  onField,
  errors,
  warnings,
  isLast,
  onRefreshSource,
  refreshingSource,
}: {
  group: GroupDef;
  values: RawConfig;
  originals: RawConfig;
  onField: (key: keyof RawConfig, v: unknown) => void;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  isLast: boolean;
  onRefreshSource?: () => void;
  refreshingSource?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="pb-1">
        <h3 className="text-base font-semibold tracking-tight">{group.title}</h3>
        <p className="text-xs text-muted-foreground">{group.description}</p>
      </div>
      {group.sections.map((s, i) => (
        <SectionBlock
          key={s.title}
          section={s}
          values={values}
          originals={originals}
          onField={onField}
          errors={errors}
          warnings={warnings}
          isLast={isLast && i === group.sections.length - 1}
          onRefreshSource={onRefreshSource}
          refreshingSource={refreshingSource}
        />
      ))}
      {!isLast ? <Separator className="my-3" /> : null}
    </div>
  );
}
