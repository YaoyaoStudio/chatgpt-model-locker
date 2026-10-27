import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { LANGUAGE_OPTIONS, emptyLanguageSettings, readLanguageSettings, matchDisplayLanguage, resolveDisplayLanguage } from "../src/language-settings.ts";
import { MESSAGES } from "../src/i18n.ts";
import { englishEffortLabel, localizedEffortLabel } from "../src/effort-labels.ts";
import { ChatGPTAdapter, parseEffortStatus } from "../src/chatgpt-adapter.ts";

test("browser locale matching distinguishes all Chinese regions and respects preference order", () => {
  for (const [tag, expected] of Object.entries({
    "zh-CN": "zh-CN", "zh-SG": "zh-CN", "zh-Hans": "zh-CN", "zh-Hans-HK": "zh-CN", zh: "zh-CN",
    "zh-HK": "zh-HK", "zh-Hant-HK": "zh-HK", "zh_MO": "zh-MO", "zh-Hant-MO": "zh-MO",
    "zh-TW": "zh-TW", "zh-Hant": "zh-TW", "en-GB": "en", "en-US": "en", "ja-JP": "ja"
  })) assert.equal(matchDisplayLanguage(tag), expected, tag);
  for (const tag of ["", "bad_tag_!", "fr-FR"]) assert.equal(matchDisplayLanguage(tag), null);
  assert.equal(resolveDisplayLanguage(emptyLanguageSettings(), ["fr", "ja-JP", "en"]), "ja");
  assert.equal(resolveDisplayLanguage(emptyLanguageSettings(), ["en", "zh-HK"]), "en");
  assert.equal(resolveDisplayLanguage(emptyLanguageSettings(), ["fr"]), "en");
  assert.equal(resolveDisplayLanguage({ ...emptyLanguageSettings(), followBrowser: false, manualLanguage: "zh-MO" }, ["ja"]), "zh-MO");
});

test("legacy test choices migrate without affecting actual language selections", () => {
  for (const manualLanguage of ["test1", "test2"]) {
    assert.deepEqual(readLanguageSettings({ schemaVersion: 1, followBrowser: false, manualLanguage }).value, emptyLanguageSettings());
  }
  for (const { value } of LANGUAGE_OPTIONS) {
    const saved = { schemaVersion: 1, followBrowser: false, manualLanguage: value };
    assert.deepEqual(readLanguageSettings(saved), { kind: "valid", value: saved });
  }
  assert.equal(readLanguageSettings(undefined).kind, "missing");
  assert.equal(readLanguageSettings({ schemaVersion: 1, followBrowser: true, manualLanguage: "invalid" }).kind, "invalid");
});

test("all six message catalogs contain every visible message", () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), LANGUAGE_OPTIONS.map(({ value }) => value).sort());
  for (const messages of Object.values(MESSAGES)) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(MESSAGES.en).sort());
    for (const value of Object.values(messages)) assert.ok(typeof value === "string" && value.trim().length > 0);
  }
  assert.notEqual(MESSAGES["zh-HK"].autoApply, MESSAGES["zh-TW"].autoApply);
});

test("slider labels stay English using native semantics, not highest position", () => {
  const effort = { id: "native:high", label: "高", order: 2 };
  const original = structuredClone(effort);
  for (const { value } of LANGUAGE_OPTIONS) {
    assert.equal(englishEffortLabel(effort), "High");
    assert.ok(localizedEffortLabel(effort, value));
  }
  assert.deepEqual(effort, original);
  const instant = { id: "native:none", label: "Instant", order: 0 };
  assert.equal(englishEffortLabel(instant), "Instant");
  assert.equal(englishEffortLabel({ label: "None" }), "Instant");
  assert.equal(localizedEffortLabel(instant, "en"), "Instant");
  assert.equal(instant.id, "native:none");
  assert.equal(englishEffortLabel({ label: "中等" }), "Medium");
  assert.equal(englishEffortLabel({ label: "非常に高い" }), "XHigh");
  assert.equal(englishEffortLabel({ id: "native:ultra", label: "超高" }), "Ultra");
  assert.equal(englishEffortLabel({ label: "新しい強度", order: 3 }), "Level 4");
  assert.equal(englishEffortLabel({ label: "Adaptive" }), "Adaptive");
  assert.equal(localizedEffortLabel(effort, "ja"), "高");
});

test("localized native effort status parsing retains strict index validation", () => {
  for (const text of ["高，第 2 項，共 3 項。", "高、3 項目中 2 番目。", "高、2 / 3。", "高、全3個中の2個。"])
    assert.deepEqual(parseEffortStatus(text), { label: "高", index: 2, total: 3 }, text);
  assert.equal(parseEffortStatus("高、2 項目中 3 番目。"), null);
  assert.equal(parseEffortStatus("高、順位不明"), null);
});

for (const [language, composer, trigger, effort, status, chat, work, stop] of [
  ["zh-HK", "詢問 ChatGPT", "選擇 ChatGPT 模型", "強度", "高，第 2 項，共 3 項。", "聊天", "工作", "停止產生"],
  ["zh-MO", "詢問 ChatGPT", "選擇 ChatGPT 模型", "強度", "高，第 2 項，共 3 項。", "聊天", "工作", "停止產生"],
  ["zh-TW", "詢問 ChatGPT", "選擇 ChatGPT 模型", "強度", "高，第 2 項，共 3 項。", "對話", "工作", "停止產生"],
  ["ja", "ChatGPT に質問する", "ChatGPT のモデルを選択", "強度", "高、3 項目中 2 番目。", "チャット", "ワーク", "生成を停止"]
]) test(`native ${language} labels retain chat/work and generation checks`, () => {
  const dom = new JSDOM(`<html lang="${language}"><body><main><h1><span data-headline></span></h1>
    <div role="textbox" contenteditable="true" aria-label="${composer}"></div>
    <button id="trigger" aria-haspopup="menu" aria-label="${trigger}" aria-controls="menu" aria-expanded="true" data-selected-reasoning-effort="high"></button>
    <div role="radio" aria-label="${chat}" aria-checked="true" id="chat"></div><div role="radio" aria-label="${work}" aria-checked="false" id="work"></div>
    </main><div id="menu" role="menu" aria-labelledby="trigger"><div role="menuitem" data-reasoning-slider="true" aria-label="${effort}"><div role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></div></div><div role="status">${status}</div></div></body></html>`, { url: "https://chatgpt.com/" });
  try {
    const doc = dom.window.document;
    const adapter = new ChatGPTAdapter(doc, { isHitTestable: () => true });
    assert.equal(adapter.readPageSnapshot().kind, "new-empty");
    assert.equal(adapter.readEffort(doc.querySelector("#menu"))?.nativeId, "high");
    const stopping = doc.createElement("button");
    stopping.setAttribute("aria-label", stop);
    doc.querySelector("main").append(stopping);
    assert.equal(adapter.replyGenerationState(), "running");
    doc.querySelector("#chat").setAttribute("aria-checked", "false");
    doc.querySelector("#work").setAttribute("aria-checked", "true");
    assert.equal(adapter.isChatMode(), false);
    assert.equal(adapter.findModelTrigger(), null);
  } finally { dom.window.close(); }
});

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/content.ts", import.meta.url))], bundle: true, format: "iife", platform: "browser", write: false });
const script = bundle.outputFiles[0].text;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(15); }
  assert.fail("Timed out waiting for UI update");
}

test("language changes translate current UI and feedback without applying models or losing focus", async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><main><h1>随时可以开始。</h1><div role="textbox" contenteditable="true" aria-label="询问 ChatGPT"></div><button id="native" aria-haspopup="menu" aria-label="选择 ChatGPT 模型" aria-expanded="false"></button></main></body></html>', { url: "https://chatgpt.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  let browserLanguages = ["ja-JP", "en"];
  Object.defineProperty(window.navigator, "languages", { get: () => browserLanguages });
  const observers = [];
  const Observer = window.MutationObserver;
  window.MutationObserver = class extends Observer { constructor(callback) { super(callback); observers.push(this); } };
  const preferences = { schemaVersion: 1, modelId: "label:GPT-6", effortByModel: { "label:GPT-6": "native:high" }, autoApply: false };
  let state = { preferences, chatCapabilities: { schemaVersion: 1, scopeKey: "chatgpt.com", completeness: "partial", lastSuccessfulReadAt: 1792720800000, models: [{ id: "label:GPT-6", label: "GPT-6", availability: "available", effortState: "observed", efforts: ["low", "medium", "high"].map((id, order) => ({ id: "native:" + id, label: ["低", "中等", "高"][order], order, ordering: "strength", disabled: false })) }] } };
  const listeners = new Set();
  window.chrome = { storage: { local: {
    get: async () => structuredClone(state),
    set: async (value) => { state = { ...state, ...structuredClone(value) }; for (const fn of listeners) fn(Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }])), "local"); }
  }, onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } } };
  let nativeClicks = 0;
  window.document.querySelector("#native").addEventListener("click", () => nativeClicks++);
  try {
    window.eval(script);
    const host = window.document.querySelector("#chatgpt-default-model-effort-host");
    const q = (selector) => host.shadowRoot.querySelector(selector);
    q("[data-role=bubble]").click();
    await until(() => q("#default-model-trigger"));
    assert.equal(host.lang, "ja");
    assert.equal(q(".range-value").textContent, "High");
    assert.equal(q(".range-value").lang, "en");
    assert.equal(q(".range-value").translate, false);
    q("[data-role=settings-entry]").click();
    q("[data-preference=follow-browser-language]").click();
    await until(() => state.languageSettings?.followBrowser === false);
    for (const { value } of LANGUAGE_OPTIONS) {
      const select = q("#manual-language-select");
      select.focus();
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => state.languageSettings.manualLanguage === value && q("[data-role=status]").textContent === MESSAGES[value].languageSettingsSaved);
      assert.equal(host.lang, value);
      assert.equal(q("[data-role=title]").textContent, MESSAGES[value].settings);
      assert.equal(q("[data-action=refresh]").textContent, MESSAGES[value].refresh);
      assert.equal(q("[data-role=footer]").textContent, MESSAGES[value].footer);
      assert.equal(q("[data-preference=follow-browser-language]").parentElement.textContent, MESSAGES[value].followBrowserLanguage);
      assert.equal(host.shadowRoot.activeElement, q("#manual-language-select"));
      assert.ok(q("[data-role=cache-info]").textContent.includes(new Intl.DateTimeFormat(value, { dateStyle: "short", timeStyle: "short" }).format(state.chatCapabilities.lastSuccessfulReadAt)));
      assert.equal(q("[data-role=cache-info]").textContent.split("\n").length, 2);
      q("[data-action=back]").click();
      assert.equal(q(".range-value").textContent, "High");
      assert.equal(q("[data-role=title]").textContent, MESSAGES[value].title);
      q("[data-role=settings-entry]").click();
    }
    assert.deepEqual([...q("#manual-language-select").options].map((item) => item.value), LANGUAGE_OPTIONS.map(({ value }) => value));
    q("#manual-language-select").focus();
    await window.chrome.storage.local.set({ languageSettings: { schemaVersion: 1, followBrowser: true, manualLanguage: "en" } });
    assert.equal(host.shadowRoot.activeElement, q("[data-preference=follow-browser-language]"));
    browserLanguages = ["zh-HK"];
    window.dispatchEvent(new window.Event("languagechange"));
    assert.equal(host.lang, "zh-HK");
    assert.equal(q("#manual-language-select").disabled, true);
    assert.equal(q("#manual-language-select").value, "zh-HK");
    assert.equal(q("[data-role=status]").textContent, MESSAGES["zh-HK"].languageSettingsSaved);
    assert.equal(nativeClicks, 0);
    assert.deepEqual(state.preferences, preferences);
    assert.equal(state.chatCapabilities.models[0].efforts[2].label, "高");
  } finally { observers.forEach((observer) => observer.disconnect()); window.close(); }
});
