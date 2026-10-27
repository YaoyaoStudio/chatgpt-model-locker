import type { StoredValue } from "./domain.js";

export const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-HK", label: "繁體中文（香港）" },
  { value: "zh-MO", label: "繁體中文（澳門）" },
  { value: "zh-TW", label: "繁體中文（台灣）" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" }
] as const;
export type DisplayLanguage = typeof LANGUAGE_OPTIONS[number]["value"];

export function isDisplayLanguage(value: unknown): value is DisplayLanguage {
  return LANGUAGE_OPTIONS.some((option) => option.value === value);
}

export function matchDisplayLanguage(tag: string): DisplayLanguage | null {
  try {
    const locale = new Intl.Locale(tag.trim().replaceAll("_", "-"));
    if (locale.language === "en" || locale.language === "ja") return locale.language;
    if (locale.language !== "zh") return null;
    if (locale.script === "Hans") return "zh-CN";
    if (locale.region === "HK") return "zh-HK";
    if (locale.region === "MO") return "zh-MO";
    if (locale.region === "TW" || locale.script === "Hant") return "zh-TW";
    return "zh-CN";
  } catch {
    return null;
  }
}

/** Browser preference order wins; unsupported languages fall back to English. */
export function resolveDisplayLanguage(settings: LanguageSettings, browserLanguages: readonly string[]): DisplayLanguage {
  if (!settings.followBrowser) return settings.manualLanguage;
  for (const language of browserLanguages) {
    const matched = matchDisplayLanguage(language);
    if (matched) return matched;
  }
  return "en";
}

export interface LanguageSettings {
  schemaVersion: 1;
  followBrowser: boolean;
  manualLanguage: DisplayLanguage;
}

export function emptyLanguageSettings(): LanguageSettings {
  return { schemaVersion: 1, followBrowser: true, manualLanguage: "en" };
}

export function readLanguageSettings(raw: unknown): StoredValue<LanguageSettings> {
  if (raw === undefined) return { kind: "missing", value: emptyLanguageSettings() };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", value: emptyLanguageSettings() };
  }
  const value = raw as Record<string, unknown>;
  // Test choices never represented actual languages. Migrate them to browser follow.
  if (value.schemaVersion === 1 && typeof value.followBrowser === "boolean" &&
    (value.manualLanguage === "test1" || value.manualLanguage === "test2")) {
    return { kind: "valid", value: emptyLanguageSettings() };
  }
  if (value.schemaVersion !== 1 || typeof value.followBrowser !== "boolean" ||
    !isDisplayLanguage(value.manualLanguage)) {
    return { kind: "invalid", value: emptyLanguageSettings() };
  }
  return {
    kind: "valid",
    value: {
      schemaVersion: 1,
      followBrowser: value.followBrowser,
      manualLanguage: value.manualLanguage
    }
  };
}
