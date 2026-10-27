export const PREFERENCES_SCHEMA_VERSION = 1 as const;
export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

export type Completeness = "partial";
export type Availability = "available" | "disabled" | "unknown";
export type EffortState = "observed" | "unsupported" | "not-read" | "unknown";
export type EffortOrdering = "strength" | "non-ordered" | "unknown";

export interface EffortOption {
  id: string;
  label: string;
  ordering: EffortOrdering;
  order: number | null;
  disabled: boolean;
}

export interface ModelCapability {
  id: string;
  label: string;
  availability: Availability;
  effortState: EffortState;
  efforts: EffortOption[];
}

export interface Preferences {
  schemaVersion: typeof PREFERENCES_SCHEMA_VERSION;
  modelId: string | null;
  effortByModel: Record<string, string | null>;
  autoApply: boolean;
  applyWithNativeMenuOpen: boolean;
  applyInHistory: boolean;
}

export interface CapabilitiesCache {
  schemaVersion: typeof CAPABILITIES_SCHEMA_VERSION;
  scopeKey: string;
  completeness: Completeness;
  models: ModelCapability[];
  lastSuccessfulReadAt: number | null;
}

export interface CapabilitiesSnapshot {
  scopeKey: string;
  completeness: Completeness;
  models: ModelCapability[];
}

export type StoredValue<T> =
  | { kind: "missing"; value: T }
  | { kind: "valid"; value: T }
  | { kind: "invalid"; value: T };

export function emptyPreferences(): Preferences {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    modelId: null,
    effortByModel: {},
    autoApply: true,
    applyWithNativeMenuOpen: false,
    applyInHistory: false
  };
}

export function emptyCapabilities(scopeKey = ""): CapabilitiesCache {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    scopeKey,
    completeness: "partial",
    models: [],
    lastSuccessfulReadAt: null
  };
}

export function preferencesEqual(left: Preferences, right: Preferences): boolean {
  if (left.schemaVersion !== right.schemaVersion || left.modelId !== right.modelId || left.autoApply !== right.autoApply ||
    left.applyWithNativeMenuOpen !== right.applyWithNativeMenuOpen || left.applyInHistory !== right.applyInHistory) return false;
  const modelIds = new Set([...Object.keys(left.effortByModel), ...Object.keys(right.effortByModel)]);
  return [...modelIds].every((id) => (left.effortByModel[id] ?? null) === (right.effortByModel[id] ?? null));
}

/** Compare capability data without treating a repeated observation's timestamp as new data. */
export function capabilityDataEqual(left: CapabilitiesCache, right: CapabilitiesCache): boolean {
  return left.schemaVersion === right.schemaVersion && left.scopeKey === right.scopeKey &&
    left.completeness === right.completeness && left.models.length === right.models.length &&
    left.models.every((model, index) => {
      const other = right.models[index];
      return model.id === other.id && model.label === other.label && model.availability === other.availability &&
        model.effortState === other.effortState && model.efforts.length === other.efforts.length &&
        model.efforts.every((effort, effortIndex) => {
          const otherEffort = other.efforts[effortIndex];
          return effort.id === otherEffort.id && effort.label === otherEffort.label &&
            effort.ordering === otherEffort.ordering && effort.order === otherEffort.order && effort.disabled === otherEffort.disabled;
        });
    });
}

export function readPreferences(raw: unknown): StoredValue<Preferences> {
  if (raw === undefined) return { kind: "missing", value: emptyPreferences() };
  if (!isRecord(raw) || raw.schemaVersion !== PREFERENCES_SCHEMA_VERSION) {
    return { kind: "invalid", value: emptyPreferences() };
  }

  const { modelId, effortByModel, autoApply, applyWithNativeMenuOpen, applyInHistory } = raw;
  if (
    !(modelId === null || isNonEmptyString(modelId)) ||
    !isRecord(effortByModel) ||
    typeof autoApply !== "boolean" ||
    !(applyWithNativeMenuOpen === undefined || typeof applyWithNativeMenuOpen === "boolean") ||
    !(applyInHistory === undefined || typeof applyInHistory === "boolean")
  ) {
    return { kind: "invalid", value: emptyPreferences() };
  }

  const safeEfforts: Record<string, string | null> = {};
  for (const [model, effort] of Object.entries(effortByModel)) {
    if (!isNonEmptyString(model) || !(effort === null || isNonEmptyString(effort))) {
      return { kind: "invalid", value: emptyPreferences() };
    }
    safeEfforts[model] = effort;
  }

  return {
    kind: "valid",
    value: {
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      modelId,
      effortByModel: safeEfforts,
      autoApply,
      applyWithNativeMenuOpen: applyWithNativeMenuOpen ?? false,
      applyInHistory: applyInHistory ?? false
    }
  };
}

export function readCapabilities(raw: unknown): StoredValue<CapabilitiesCache> {
  if (raw === undefined) return { kind: "missing", value: emptyCapabilities() };
  if (!isRecord(raw) || raw.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) {
    return { kind: "invalid", value: emptyCapabilities() };
  }

  if (
    !isNonEmptyString(raw.scopeKey) ||
    !Array.isArray(raw.models) ||
    !(raw.lastSuccessfulReadAt === null || isTimestamp(raw.lastSuccessfulReadAt))
  ) {
    return { kind: "invalid", value: emptyCapabilities() };
  }

  const models: ModelCapability[] = [];
  for (const candidate of raw.models) {
    const model = readModelCapability(candidate);
    if (!model || models.some((existing) => existing.id === model.id)) {
      return { kind: "invalid", value: emptyCapabilities() };
    }
    models.push(model);
  }

  return {
    kind: "valid",
    value: {
      schemaVersion: CAPABILITIES_SCHEMA_VERSION,
      scopeKey: raw.scopeKey,
      // Older caches used complete/partial/unknown. Keep the field for storage
      // compatibility, but normalize every value to the single retained state.
      completeness: "partial",
      models,
      lastSuccessfulReadAt: raw.lastSuccessfulReadAt
    }
  };
}

/** Merge observations without completeness-based pruning; unobserved cached models remain. */
export function mergeCapabilities(
  previous: CapabilitiesCache,
  incoming: CapabilitiesSnapshot,
  readAt: number
): CapabilitiesCache {
  if (
    !isNonEmptyString(incoming.scopeKey) ||
    !isTimestamp(readAt)
  ) {
    return previous;
  }
  const validated = readSnapshotModels(incoming.models);
  if (!validated) return previous;
  if (validated.length === 0) return previous;

  const sameScope = previous.scopeKey === incoming.scopeKey;
  const oldById = new Map((sameScope ? previous.models : []).map((model) => [model.id, model]));
  const nextModels = new Map<string, ModelCapability>(
    sameScope ? previous.models.map((model) => [model.id, model]) : []
  );

  for (const observed of validated) {
    const old = oldById.get(observed.id);
    const merged = mergeModel(old, observed);
    nextModels.set(merged.id, merged);
  }

  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    scopeKey: incoming.scopeKey,
    completeness: "partial",
    models: [...nextModels.values()],
    lastSuccessfulReadAt: readAt
  };
}

function mergeModel(old: ModelCapability | undefined, observed: ModelCapability): ModelCapability {
  if (!old) return observed;
  return {
    ...old,
    ...observed,
    availability: observed.availability === "unknown" ? old.availability : observed.availability,
    efforts:
      observed.effortState === "observed"
        ? observed.efforts
        : observed.effortState === "unsupported"
          ? []
          : old.efforts,
    effortState:
      observed.effortState === "observed" || observed.effortState === "unsupported"
        ? observed.effortState
        : old.effortState
  };
}

function readSnapshotModels(models: ModelCapability[]): ModelCapability[] | null {
  if (!Array.isArray(models)) return null;
  const result: ModelCapability[] = [];
  for (const candidate of models) {
    const model = readModelCapability(candidate);
    if (!model || result.some((existing) => existing.id === model.id)) return null;
    result.push(model);
  }
  return result;
}

function readModelCapability(value: unknown): ModelCapability | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.label) ||
    !isAvailability(value.availability) ||
    !isEffortState(value.effortState) ||
    !Array.isArray(value.efforts)
  ) {
    return null;
  }

  const efforts: EffortOption[] = [];
  for (const effortCandidate of value.efforts) {
    if (!isRecord(effortCandidate)) return null;
    const { id, label, ordering, order, disabled } = effortCandidate;
    if (
      !isNonEmptyString(id) ||
      !isNonEmptyString(label) ||
      !isEffortOrdering(ordering) ||
      !(order === null || (typeof order === "number" && Number.isFinite(order))) ||
      typeof disabled !== "boolean" ||
      efforts.some((existing) => existing.id === id)
    ) {
      return null;
    }
    efforts.push({ id, label, ordering, order, disabled });
  }

  if (value.effortState !== "observed" && efforts.length > 0) return null;
  return {
    id: value.id,
    label: value.label,
    availability: value.availability,
    effortState: value.effortState,
    efforts
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAvailability(value: unknown): value is Availability {
  return value === "available" || value === "disabled" || value === "unknown";
}

function isEffortState(value: unknown): value is EffortState {
  return value === "observed" || value === "unsupported" || value === "not-read" || value === "unknown";
}

function isEffortOrdering(value: unknown): value is EffortOrdering {
  return value === "strength" || value === "non-ordered" || value === "unknown";
}
