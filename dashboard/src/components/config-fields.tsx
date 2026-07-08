import { Beaker, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { FieldDef } from "@/components/config-sections";
import type { SectionDef } from "@/components/config-sections";
import { Badge } from "@/components/ui/badge";
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
import type { RawConfig } from "@/hooks/use-config";
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
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  dirty: boolean;
  error?: string;
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
            <Badge variant="outline" size="sm" className="border-destructive/30 text-destructive">
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
            <Badge variant="outline" size="sm" className="border-amber-500/40 text-amber-600">
              <Beaker className="h-2.5 w-2.5" />
              experimental
            </Badge>
          ) : null}
        </div>
        {def.description ? (
          <span className="text-xs text-muted-foreground">{def.description}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {FIELD_RENDERERS[def.kind]({
          def,
          value,
          onChange,
          id,
          isInvalid,
          placeholder,
        })}
        {hasError ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
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
  isLast,
}: {
  section: SectionDef;
  values: RawConfig;
  originals: RawConfig;
  onField: (key: keyof RawConfig, v: unknown) => void;
  errors: Record<string, string>;
  isLast: boolean;
}) {
  return (
    <section className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">{section.title}</h3>
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
        />
      ))}
      {!isLast ? <Separator className="my-2" /> : null}
    </section>
  );
}
