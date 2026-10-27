import type { StoredValue } from "./domain.js";

export type ThemeId = "blue" | "green" | "yellow" | "pink" | "orange" | "purple" | "default";

const THEME_IDS: readonly ThemeId[] = ["blue", "green", "yellow", "pink", "orange", "purple", "default"];
const EXACT_THEME_COLORS: Record<string, ThemeId> = {
  "#3a83f7": "blue",
  "#53b559": "green",
  "#f6c543": "yellow",
  "#f077af": "pink",
  "#ee7c37": "orange",
  "#8952ee": "purple",
  "#a67df2": "purple",
  "#000000": "default"
};

export interface PageTheme {
  schemaVersion: 1;
  scopeKey: string;
  accent: string;
  textAccent: string;
  onAccent: string;
  themeId?: ThemeId;
}

/** Keep unknown/custom themes deterministic; ordinary accent colors remain untouched. */
export function resolveThemeId(theme: Pick<PageTheme, "accent" | "themeId"> | null): ThemeId {
  if (theme && isThemeId(theme.themeId)) return theme.themeId;
  return themeIdFromColor(theme?.accent) ?? "purple";
}

/** Read public computed theme tokens, without opening settings or reading account data. */
export function readPageTheme(document: Document): PageTheme | null {
  const view = document.defaultView;
  if (!view || !document.documentElement) return null;
  const style = view.getComputedStyle(document.documentElement);
  const readColor = (names: string[]): string | null => {
    for (const name of names) {
      const color = solidColor(style.getPropertyValue(name));
      if (color) return color;
    }
    return null;
  };
  const accent = readColor(["--codex-base-accent", "--color-background-accent-action"]);
  if (!accent) return null;
  const themeId = themeIdFromColor(readColor(["--color-background-accent-action"])) ??
    themeIdFromColor(accent) ?? "purple";
  const textAccent = readColor(["--app-color-text-accent", "--accent-icon"]) ?? accent;
  const declaredOnAccent = readColor(["--app-color-text-on-accent", "--color-text-accent-action"]);
  const onAccent = declaredOnAccent && contrast(accent, declaredOnAccent) >= 4.5
    ? declaredOnAccent
    : contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#000000";
  return { schemaVersion: 1, scopeKey: document.location.hostname, accent, textAccent, onAccent, themeId };
}

export function readStoredPageTheme(raw: unknown): StoredValue<PageTheme | null> {
  if (raw === undefined) return { kind: "missing", value: null };
  if (raw === null || typeof raw !== "object") return { kind: "invalid", value: null };
  const value = raw as Record<string, unknown>;
  const accent = solidColor(value.accent);
  const textAccent = solidColor(value.textAccent);
  const onAccent = solidColor(value.onAccent);
  if (value.schemaVersion !== 1 || typeof value.scopeKey !== "string" || !value.scopeKey.trim() ||
    !accent || !textAccent || !onAccent) return { kind: "invalid", value: null };
  const themeId = isThemeId(value.themeId) ? value.themeId : themeIdFromColor(accent) ?? "purple";
  return { kind: "valid", value: { schemaVersion: 1, scopeKey: value.scopeKey, accent, textAccent, onAccent, themeId } };
}

export function pageThemesEqual(left: PageTheme | null, right: PageTheme | null): boolean {
  if (!left || !right) return left === right;
  return left.scopeKey === right.scopeKey && left.accent === right.accent &&
    left.textAccent === right.textAccent && left.onAccent === right.onAccent &&
    resolveThemeId(left) === resolveThemeId(right);
}

function isThemeId(raw: unknown): raw is ThemeId {
  return typeof raw === "string" && THEME_IDS.includes(raw as ThemeId);
}

function themeIdFromColor(raw: unknown): ThemeId | null {
  const color = solidColor(raw);
  return color ? EXACT_THEME_COLORS[color] ?? null : null;
}

/** Ignore ordinary chat mutations; root attributes and stylesheet changes can alter the accent. */
export function mutationTouchesPageTheme(record: MutationRecord, document: Document): boolean {
  const ElementType = document.defaultView!.Element;
  const target = record.target instanceof ElementType ? record.target : record.target.parentElement;
  if (record.type === "attributes" && (target === document.documentElement || target === document.body)) {
    return ["style", "class", "data-theme"].includes(record.attributeName ?? "");
  }
  if (target?.closest("style")) return true;
  if (record.type !== "childList") return false;
  return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof ElementType &&
    node.matches('style,link[rel~="stylesheet"]'));
}

/** Persist only opaque literal colors, never arbitrary CSS expressions or page values. */
function solidColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(value)) return value;
  if (/^#[\da-f]{3}$/.test(value)) return "#" + [...value.slice(1)].map((part) => part + part).join("");
  const rgb = /^rgba?\(([^()]+)\)$/.exec(value);
  if (!rgb) return null;
  const parts = rgb[1].trim().split(/[\s,/]+/);
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts.length === 4 && Number(parts[3].endsWith("%") ? parts[3].slice(0, -1) : parts[3]) !==
    (parts[3].endsWith("%") ? 100 : 1)) return null;
  const channels = parts.slice(0, 3).map((part) => part.endsWith("%")
    ? Number(part.slice(0, -1)) * 255 / 100 : Number(part));
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return "#" + channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("");
}

function contrast(left: string, right: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
