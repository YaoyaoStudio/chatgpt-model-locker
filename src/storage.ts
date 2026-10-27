import {
  emptyCapabilities,
  capabilityDataEqual,
  mergeCapabilities,
  readCapabilities,
  readPreferences,
  type CapabilitiesCache,
  type CapabilitiesSnapshot,
  type Preferences,
  type StoredValue
} from "./domain.js";
import { readStoredPageTheme, type PageTheme } from "./page-theme.js";
import { readLanguageSettings, type LanguageSettings } from "./language-settings.js";

const PREFERENCES_KEY = "preferences";
// Legacy host-only "capabilities" may contain Work rows. Rebuild only from chat;
// a distinct key also prevents older, still-open content scripts from repolluting it.
const CAPABILITIES_KEY = "chatCapabilities";
const PAGE_THEME_KEY = "pageTheme";
const LANGUAGE_SETTINGS_KEY = "languageSettings";
const PREFERENCE_ORIGIN_KEY = "_writeOrigin";
const preferenceWriterId = crypto.randomUUID();

export interface LoadedStorage {
  preferences: StoredValue<Preferences>;
  capabilities: StoredValue<CapabilitiesCache>;
  pageTheme: StoredValue<PageTheme | null>;
  languageSettings: StoredValue<LanguageSettings>;
}

export interface StorageChanges {
  preferences?: StoredValue<Preferences>;
  capabilities?: StoredValue<CapabilitiesCache>;
  pageTheme?: StoredValue<PageTheme | null>;
  languageSettings?: StoredValue<LanguageSettings>;
}

let capabilityWriteQueue: Promise<void> = Promise.resolve();
let preferenceWriteQueue: Promise<void> = Promise.resolve();
let themeWriteQueue: Promise<void> = Promise.resolve();
let languageSettingsWriteQueue: Promise<void> = Promise.resolve();

export async function loadStorage(): Promise<LoadedStorage> {
  const stored = await chrome.storage.local.get([PREFERENCES_KEY, CAPABILITIES_KEY, PAGE_THEME_KEY, LANGUAGE_SETTINGS_KEY]);
  const capabilities = readCapabilities(stored[CAPABILITIES_KEY]);
  if (capabilities.kind === "valid" && !hasPartialCompleteness(stored[CAPABILITIES_KEY])) {
    const migration = capabilityWriteQueue.then(async () => {
      const latest = await chrome.storage.local.get(CAPABILITIES_KEY);
      const parsed = readCapabilities(latest[CAPABILITIES_KEY]);
      if (parsed.kind === "valid" && !hasPartialCompleteness(latest[CAPABILITIES_KEY])) {
        await chrome.storage.local.set({ [CAPABILITIES_KEY]: parsed.value });
      }
    });
    capabilityWriteQueue = migration.then(() => undefined, () => undefined);
    await migration.catch(() => undefined);
  }
  return {
    preferences: readPreferences(stored[PREFERENCES_KEY]),
    capabilities,
    pageTheme: readStoredPageTheme(stored[PAGE_THEME_KEY]),
    languageSettings: readLanguageSettings(stored[LANGUAGE_SETTINGS_KEY])
  };
}

export function savePageTheme(theme: PageTheme, isCurrent: () => boolean): Promise<void> {
  const checked = readStoredPageTheme(theme);
  if (checked.kind !== "valid" || !checked.value) return Promise.reject(new TypeError("无效的页面主题色。"));
  const operation = themeWriteQueue.then(async () => {
    if (isCurrent()) await chrome.storage.local.set({ [PAGE_THEME_KEY]: checked.value });
  });
  themeWriteQueue = operation.catch(() => undefined);
  return operation;
}

/** Call only after an explicit preference change; corrupt stored values are never rewritten on startup. */
export async function savePreferences(preferences: Preferences): Promise<void> {
  const checked = readPreferences(preferences);
  if (checked.kind !== "valid") throw new TypeError("拒绝保存格式无效的偏好设置。");
  const operation = preferenceWriteQueue.then(() => chrome.storage.local.set({
    [PREFERENCES_KEY]: { ...checked.value, [PREFERENCE_ORIGIN_KEY]: preferenceWriterId }
  }));
  preferenceWriteQueue = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
}

/** Persist only explicit UI changes; missing or invalid saved language settings remain untouched on load. */
export async function saveLanguageSettings(settings: LanguageSettings): Promise<void> {
  const checked = readLanguageSettings(settings);
  if (checked.kind !== "valid") throw new TypeError("拒绝保存格式无效的语言设置。");
  const operation = languageSettingsWriteQueue.then(() => chrome.storage.local.set({
    [LANGUAGE_SETTINGS_KEY]: { ...checked.value, [PREFERENCE_ORIGIN_KEY]: preferenceWriterId }
  }));
  languageSettingsWriteQueue = operation.then(
    () => undefined,
    () => undefined
  );
  await operation;
}

/** Serialize read/merge/write operations in this page so simultaneous refreshes cannot drop observations. */
export function mergeAndSaveCapabilities(
  incoming: CapabilitiesSnapshot,
  isCurrent: () => boolean = () => true,
  options: { onlyIfChanged?: boolean } = {}
): Promise<CapabilitiesCache | null> {
  const operation = capabilityWriteQueue.then(async () => {
    if (!isCurrent()) return null;
    const stored = await chrome.storage.local.get(CAPABILITIES_KEY);
    if (!isCurrent()) return null;
    const raw = stored[CAPABILITIES_KEY];
    const parsed = readCapabilities(raw);
    const prior = parsed.kind === "valid" ? parsed.value : emptyCapabilities(incoming.scopeKey);
    const merged = mergeCapabilities(prior, incoming, Date.now());

    const needsCompletenessMigration = parsed.kind === "valid" && !hasPartialCompleteness(raw);
    if (options.onlyIfChanged && capabilityDataEqual(prior, merged) && !needsCompletenessMigration) return prior;

    if (merged !== prior || needsCompletenessMigration) {
      if (!isCurrent()) return null;
      await chrome.storage.local.set({ [CAPABILITIES_KEY]: merged });
    }
    return isCurrent() ? merged : null;
  });
  capabilityWriteQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function hasPartialCompleteness(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).completeness === "partial";
}

export function subscribeToStorageChanges(
  listener: (changes: StorageChanges) => void
): () => void {
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== "local") return;
    const preferenceChange = changes[PREFERENCES_KEY];
    const capabilityChange = changes[CAPABILITIES_KEY];
    const themeChange = changes[PAGE_THEME_KEY];
    const languageSettingsChange = changes[LANGUAGE_SETTINGS_KEY];
    if (!preferenceChange && !capabilityChange && !themeChange && !languageSettingsChange) return;

    const parsedChanges: StorageChanges = {};
    const preferenceValue = preferenceChange?.newValue;
    const fromThisPage = preferenceValue !== null && typeof preferenceValue === "object" &&
      PREFERENCE_ORIGIN_KEY in preferenceValue &&
      preferenceValue[PREFERENCE_ORIGIN_KEY] === preferenceWriterId;
    if (preferenceChange && !fromThisPage) parsedChanges.preferences = readPreferences(preferenceValue);
    if (capabilityChange) parsedChanges.capabilities = readCapabilities(capabilityChange.newValue);
    if (themeChange) parsedChanges.pageTheme = readStoredPageTheme(themeChange.newValue);
    const languageSettingsValue = languageSettingsChange?.newValue;
    const languageSettingsFromThisPage = languageSettingsValue !== null && typeof languageSettingsValue === "object" &&
      PREFERENCE_ORIGIN_KEY in languageSettingsValue &&
      languageSettingsValue[PREFERENCE_ORIGIN_KEY] === preferenceWriterId;
    if (languageSettingsChange && !languageSettingsFromThisPage) {
      parsedChanges.languageSettings = readLanguageSettings(languageSettingsValue);
    }
    if (!parsedChanges.preferences && !parsedChanges.capabilities && !parsedChanges.pageTheme && !parsedChanges.languageSettings) return;
    listener(parsedChanges);
  };

  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
