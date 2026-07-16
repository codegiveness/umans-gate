import type { FieldDef } from "@/components/config-sections";
import type { RawConfig } from "@/hooks/use-config";

export interface FieldValidation {
  error?: string;
  warning?: string;
}

export interface ConfigDraftValidation {
  errors: Record<string, string>;
  warnings: Record<string, string>;
}

export interface ConfigDraftContext {
  upstreamRequestsLimit?: number | null;
}

type FieldValidator = (def: FieldDef, value: unknown) => FieldValidation;

type FieldKind = FieldDef["kind"];

const KIND_VALIDATORS: Record<FieldKind, FieldValidator> = {
  number: validateNumberField,
  text: validateTextField,
  password: validateTextField,
  json: validateJsonField,
  boolean: () => ({}),
  select: () => ({}),
  textarea: () => ({}),
  toggle: () => ({}),
};

function validateNumberField(def: FieldDef, value: unknown): FieldValidation {
  const strVal = value === null || value === undefined ? "" : String(value);
  const n = Number(strVal);
  if (strVal.length === 0) return {};
  if (!Number.isInteger(n)) {
    return { error: `${def.label} must be an integer` };
  }
  if (def.min !== undefined && n < def.min) {
    return { error: `${def.label} must be ≥ ${def.min}` };
  }
  if (def.max !== undefined && n > def.max) {
    return { error: `${def.label} must be ≤ ${def.max}` };
  }
  return {};
}

function validateTextField(def: FieldDef, value: unknown): FieldValidation {
  const strVal = value === null || value === undefined ? "" : String(value);
  if (def.pattern && strVal.length > 0) {
    const re = new RegExp(def.pattern);
    if (!re.test(strVal)) {
      return { error: `${def.label} must match ${def.patternHint ?? def.pattern}` };
    }
  }
  if (def.inputMode === "url" && strVal.length > 0) {
    try {
      const u = new URL(strVal);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { error: `${def.label} must use http: or https: protocol` };
      }
    } catch {
      return { error: `${def.label} is not a valid URL` };
    }
  }
  return {};
}

function validateJsonField(def: FieldDef, value: unknown): FieldValidation {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: `${def.label} must be a JSON object` };
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { error: `${def.label}: value for "${k}" must be a positive number` };
    }
  }
  return {};
}

const FIELD_WARNINGS: Partial<
  Record<keyof RawConfig, (value: unknown, ctx?: ConfigDraftContext) => string | null>
> = {
  rate_limit_requests: (v, ctx) => {
    const n = Number(v);
    if (n !== -1) return null;
    if (ctx?.upstreamRequestsLimit === null) return null;
    return "Unlimited — no request cap is enforced. The upstream may still reject excessive traffic.";
  },
};

function validateField(def: FieldDef, value: unknown): FieldValidation {
  const strVal = value === null || value === undefined ? "" : String(value);

  if (def.required && !def.nullable && strVal.length === 0) {
    return { error: `${def.label} is required` };
  }

  if (def.nullable && strVal.length === 0) return {};

  const validator = KIND_VALIDATORS[def.kind];
  if (validator) {
    return validator(def, value);
  }

  return {};
}

export function validateConfigDraft(
  draft: RawConfig,
  sections: { fields: FieldDef[] }[],
  ctx?: ConfigDraftContext,
): ConfigDraftValidation {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.disabled) continue;
      const result = validateField(field, draft[field.key]);
      if (result.error) {
        errors[field.key as string] = result.error;
      }
      const warningFn = FIELD_WARNINGS[field.key];
      if (warningFn) {
        const w = warningFn(draft[field.key], ctx);
        if (w) warnings[field.key as string] = w;
      }
    }
  }
  return { errors, warnings };
}
