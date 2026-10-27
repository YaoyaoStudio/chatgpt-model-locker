import type { DisplayLanguage } from "./language-settings.js";

const NAMES = ["None", "Instant", "Minimal", "Low", "Light", "Medium", "High", "XHigh", "Max", "Ultra", "Standard", "Extended", "Auto"] as const;
type EffortName = typeof NAMES[number];
type EffortLabel = { label: string; id?: string; order?: number | null };

const ALIASES: Record<EffortName, readonly string[]> = {
  None: ["none", "off", "无", "無", "不思考", "なし"],
  Instant: ["instant", "即时", "即時", "即答"],
  Minimal: ["minimal", "最小", "最低"],
  Low: ["low", "低", "低い", "较低", "較低"],
  Light: ["light", "轻量", "輕量", "轻度", "輕度", "ライト"],
  Medium: ["medium", "中", "中等", "中程度", "中くらい"],
  High: ["high", "高", "高い", "较高", "較高"],
  XHigh: ["xhigh", "extrahigh", "veryhigh", "超高", "非常に高い"],
  Max: ["max", "maximum", "最大", "最高"],
  Ultra: ["ultra", "极致", "極致", "极高", "極高", "ウルトラ"],
  Standard: ["standard", "标准", "標準"],
  Extended: ["extended", "扩展", "擴展", "延长", "延長", "拡張"],
  Auto: ["auto", "automatic", "自动", "自動"]
};

const normalize = (value: string): string => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/gu, "");

function knownEffortName(effort: EffortLabel): EffortName | null {
  // Native semantics take precedence over labels and never rewrite stored identifiers.
  const candidates = [effort.id?.startsWith("native:") ? effort.id.slice(7) : "", effort.label];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalize(candidate);
    const name = NAMES.find((item) => ALIASES[item].includes(normalized));
    if (name) return name;
  }
  return null;
}

/** The slider value must remain English even when ChatGPT supplied a translated label. */
export function englishEffortLabel(effort: EffortLabel, index = effort.order ?? 0): string {
  const known = knownEffortName(effort);
  if (known) return known === "None" ? "Instant" : known;
  const label = effort.label.trim();
  return /^[\x20-\x7e]+$/u.test(label) ? label : `Level ${index + 1}`;
}

const SIMPLIFIED: Record<EffortName, string> = {
  None: "无", Instant: "即时", Minimal: "最低", Low: "低", Light: "轻量", Medium: "中等", High: "高",
  XHigh: "超高", Max: "最大", Ultra: "极致", Standard: "标准", Extended: "扩展", Auto: "自动"
};
const TRADITIONAL: Record<EffortName, string> = {
  None: "無", Instant: "即時", Minimal: "最低", Low: "低", Light: "輕量", Medium: "中等", High: "高",
  XHigh: "超高", Max: "最大", Ultra: "極致", Standard: "標準", Extended: "擴展", Auto: "自動"
};
const JAPANESE: Record<EffortName, string> = {
  None: "なし", Instant: "即答", Minimal: "最小", Low: "低", Light: "軽量", Medium: "中", High: "高",
  XHigh: "非常に高い", Max: "最大", Ultra: "ウルトラ", Standard: "標準", Extended: "拡張", Auto: "自動"
};

/** Localized descriptions outside the slider; unknown native names remain intact. */
export function localizedEffortLabel(effort: EffortLabel, language: DisplayLanguage): string {
  const known = knownEffortName(effort);
  if (!known) return effort.label;
  if (language === "en") return known === "None" ? "Instant" : known;
  return (language === "ja" ? JAPANESE : language === "zh-CN" ? SIMPLIFIED : TRADITIONAL)[known];
}
