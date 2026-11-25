import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { MESSAGES } from "../src/i18n.ts";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/content.ts", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", write: false });
const script = bundle.outputFiles[0].text;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, diagnose = () => ({}), timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for the observed UI/storage result: " + JSON.stringify(diagnose()));
    await pause(20);
  }
}

function fixture(cached = false, openingDelay = 0, initialPreferences = null, path = "/", { replaceOnFocus = false, replaceTrigger = false, deferOutsideClose = false, timelineHistory = false, retainedPage = false, ignoredOpeningClicks = 0, initialNativeModel = "GPT-6", restoreFailures = 0, unreadableRestoration = false, legacyModelScenario } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><main><h1>随时可以开始。</h1>' +
    '<div role="textbox" contenteditable="true" aria-label="询问 ChatGPT"></div>' +
    '<button id="trigger" aria-label="选择 ChatGPT 模型" aria-haspopup="menu" aria-expanded="false" aria-controls="native-menu"></button>' +
    '<button id="focus-sentinel">Keep focus</button></main></body></html>',
    { url: `https://chatgpt.com${path}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const observers = [];
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const levels = ["Instant", "Medium", "High"];
  let level = 1;
  let clicks = 0;
  let openingAttempts = 0;
  let restoreAttempts = 0;
  let currentModel = initialNativeModel;
  let openedAt = 0;
  let writes = 0;
  let state = cached ? { chatCapabilities: {
    schemaVersion: 1, scopeKey: "chatgpt.com", completeness: "partial", lastSuccessfulReadAt: 1,
    models: [{ id: "label:GPT-6", label: "GPT-6", availability: "available", effortState: "observed",
      efforts: levels.map((label, order) => ({ id: `label:${label}`, label, order, ordering: "strength", disabled: false })) }]
  } } : {};
  if (initialPreferences) state.preferences = initialPreferences;
  if (legacyModelScenario) {
    const old = state.chatCapabilities.models[0];
    for (const label of ["GPT-5.6 Sol", "GPT-5.6 Sol 将于 12月23日 下线"]) {
      state.chatCapabilities.models.push({ ...old, id: "label:" + label, label });
    }
  }
  if (path.startsWith("/c/")) {
    const message = document.createElement(timelineHistory ? "div" : "article");
    if (timelineHistory) {
      message.setAttribute("data-app-action-timeline-scroll", "");
      message.setAttribute("role", "region");
      message.innerHTML = '<div data-talvt-turn-state="complete"><div data-user-message-bubble="true"></div><h4 data-conversation-role="assistant"></h4></div>';
    } else {
      message.setAttribute("data-message-author-role", "assistant");
      message.textContent = "Fixture reply";
    }
    document.querySelector("main").append(message);
  }
  const listeners = new Set();
  window.chrome = { storage: {
    local: {
      get: async () => structuredClone(state),
      set: async (value) => {
        state = { ...state, ...structuredClone(value) };
        writes += 1;
        // Chrome may deliver onChanged after set() has resolved and apply has begun.
        window.setTimeout(() => listeners.forEach((fn) => fn(Object.fromEntries(
          Object.entries(value).map(([key, newValue]) => [key, { newValue }])
        ), "local")), 8);
      }
    },
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) }
  } };
  let trigger = document.querySelector("#trigger");
  let view = "effort";
  let modelListShownAt = 0;
  const native = () => document.querySelector("#native-menu");
  const close = () => { native()?.remove(); trigger.setAttribute("aria-expanded", "false"); };
  const update = () => {
    trigger.setAttribute("data-selected-reasoning-effort", ["none", "medium", "high"][level]);
    native().querySelector("[role=slider]").setAttribute("aria-valuenow", String(level));
    native().querySelector("[role=status]").textContent = `${levels[level]}，第 ${level + 1} 项，共 3 项。 使用左右方向键调整强度`;
  };
  const setView = (next) => {
    view = next;
    if (next === "models") modelListShownAt = Date.now();
    native().setAttribute("data-view", next);
  };
  const handleTriggerKey = (event) => { if (event.key === "Escape") close(); };
  const handleTriggerClick = () => {
    clicks += 1;
    if (native()) return close();
    if (replaceTrigger) {
      const fresh = trigger.cloneNode(true);
      fresh.addEventListener("click", handleTriggerClick);
      fresh.addEventListener("keydown", handleTriggerKey);
      trigger.replaceWith(fresh);
      trigger = fresh;
    }
    openingAttempts += 1;
    if (openingAttempts <= ignoredOpeningClicks) return;
    openedAt = Date.now();
    const menu = document.createElement("div");
    menu.id = "native-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", "trigger");
    const modelNames = initialNativeModel === "GPT-6" ? ["GPT-6"] : [initialNativeModel, "GPT-6"];
    menu.innerHTML = '<div role="menuitem" aria-label="选择模型">选择模型</div>' +
      modelNames.map((label) => `<div role="menuitemradio" aria-checked="${label === currentModel}">${label}</div>`).join("") +
      '<div role="menuitem" data-reasoning-slider="true" aria-label="强度" tabindex="0">' +
      '<span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></span></div><div role="status"></div>';
    if (legacyModelScenario && legacyModelScenario !== "missing") {
      const row = document.createElement("div");
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", "false");
      if (legacyModelScenario === "disabled") row.setAttribute("aria-disabled", "true");
      row.dataset.modelName = "GPT-5.6 Sol";
      row.innerHTML = '<div data-menu-row-content="true"><div class="flex-col"><span class="truncate">GPT-5.6 Sol</span><span class="text-tertiary">将于 12月24日 下线</span></div></div>';
      menu.insertBefore(row, menu.querySelector("[data-reasoning-slider]"));
    }
    menu.querySelector('[aria-label="选择模型"]').addEventListener("click", () => {
      clicks += 1;
      setView("models");
      if (legacyModelScenario === "delayed") {
        // The associated portal can disappear briefly while the last model row is still clipped.
        window.setTimeout(() => trigger.removeAttribute("aria-controls"), 65);
        window.setTimeout(() => trigger.setAttribute("aria-controls", "native-menu"), 120);
      }
    });
    menu.querySelectorAll("[role=menuitemradio]").forEach((option) => option.addEventListener("click", () => {
      clicks += 1;
      if (option.dataset.modelName && legacyModelScenario === "ignored") return;
      currentModel = option.dataset.modelName ?? option.textContent;
      menu.querySelectorAll("[role=menuitemradio]").forEach((row) => row.setAttribute("aria-checked", String(row === option)));
      setView("effort");
    }));
    let focusPending = false;
    menu.addEventListener("focusin", (event) => {
      if (!replaceOnFocus || !event.target.matches("[data-reasoning-slider]")) return;
      focusPending = true;
      window.requestAnimationFrame(() => {
        if (event.target.isConnected) event.target.replaceWith(event.target.cloneNode(true));
        focusPending = false;
      });
    });
    menu.addEventListener("keydown", (event) => {
      if (focusPending || !event.target.matches("[data-reasoning-slider]")) return;
      const restoring = level === 2 && event.key === "ArrowLeft";
      if (restoring && ++restoreAttempts <= restoreFailures) return;
      level = Math.max(0, Math.min(2, level + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0)));
      update();
      if (restoring && unreadableRestoration) menu.querySelector("[role=status]").textContent = "Unreadable slider status";
    });
    document.body.append(menu);
    trigger.setAttribute("aria-expanded", "true");
    setView("effort");
    update();
  };
  trigger.addEventListener("click", handleTriggerClick);
  trigger.addEventListener("keydown", handleTriggerKey);
  document.addEventListener("click", (event) => {
    if (native() && !event.target.matches("#trigger") && !native().contains(event.target)) {
      if (deferOutsideClose) window.requestAnimationFrame(close);
      else close();
    }
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.closest("#native-menu") && (Date.now() - openedAt < openingDelay || (this.matches("[role=menuitemradio]") && view !== "models") ||
      (!this.matches("[role=menuitemradio]") && view === "models"));
    const items = [...(native()?.querySelectorAll('[role^="menuitem"]') ?? [])];
    const left = Math.max(0, items.indexOf(this)) * 200;
    return { x: left, y: 0, left, top: 0, right: left + (hidden ? 0 : 100), bottom: hidden ? 0 : 20, width: hidden ? 0 : 100, height: hidden ? 0 : 20 };
  };
  document.elementFromPoint = (x, y) => {
    const element = native()?.querySelectorAll('[role^="menuitem"]')[Math.floor(x / 200)];
    if (legacyModelScenario === "delayed" && view === "models" && element?.dataset.modelName &&
      Date.now() - modelListShownAt < 200) return trigger;
    if (legacyModelScenario === "partially-visible" && view === "models" && element?.dataset.modelName && y > 5) return trigger;
    return element ?? trigger;
  };
  if (retainedPage) {
    const retained = document.createElement("div");
    retained.style.setProperty("display", "none", "important");
    retained.innerHTML = '<main><div role="textbox" contenteditable="true" aria-label="询问 ChatGPT"></div>' +
      '<button aria-haspopup="menu" aria-label="选择 ChatGPT 模型"></button><button aria-label="停止"></button>' +
      '<article data-message-author-role="assistant"></article></main>';
    document.body.prepend(retained);
  }
  window.eval(script);
  return { dom, window, document, get trigger() { return trigger; }, native, get level() { return level; }, get clicks() { return clicks; },
    get openingAttempts() { return openingAttempts; }, get model() { return currentModel; },
    get restoreAttempts() { return restoreAttempts; },
    set restoreFailures(value) { restoreFailures = value; },
    get writes() { return writes; }, get state() { return state; },
    shadow: document.querySelector("#chatgpt-default-model-effort-host").shadowRoot,
    close: () => { observers.forEach((observer) => observer.disconnect()); dom.window.close(); } };
}

test("refresh confirms the original reasoning level, including a successful outer restoration fallback", async (t) => {
  for (const restoreFailures of [0, 1]) await t.test(`restoration failures: ${restoreFailures}`, async () => {
    const f = fixture(false, 0, null, "/", { restoreFailures });
    try {
      await pause(450);
      f.shadow.querySelector("[data-role=bubble]").click();
      f.shadow.querySelector("[data-role=settings-entry]").click();
      f.shadow.querySelector("[data-action=refresh]").click();
      await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.refreshSuccess);
      assert.equal(f.level, 1);
      assert.equal(f.restoreAttempts, restoreFailures + 1);
      assert.equal(f.shadow.querySelector("[data-role=restore-warning]"), null);
      assert.equal(f.state.chatCapabilities.models[0].efforts.length, 3);
    } finally { f.close(); }
  });
});

test("refresh preserves discovered options but warns on the second hint line when final restoration fails", async (t) => {
  for (const [history, existingView] of [[false, null], [true, null], [true, "effort"], [true, "models"]]) {
    await t.test(`${history ? "history" : "new chat"}, prior menu: ${existingView ?? "closed"}`, async () => {
      const f = fixture(false, 0, null, history ? "/c/restore-failure" : "/", {
        timelineHistory: history, restoreFailures: Number.POSITIVE_INFINITY
      });
      try {
        await pause(450);
        f.shadow.querySelector("[data-role=bubble]").click();
        f.shadow.querySelector("[data-role=settings-entry]").click();
        if (existingView) {
          // Exercise native layouts that retain an open portal on toolbar clicks.
          f.document.querySelector("#chatgpt-default-model-effort-host").addEventListener("click", (event) => event.stopPropagation());
          f.trigger.click();
          if (existingView === "models") f.native().querySelector('[aria-label="选择模型"]').click();
        }
        f.shadow.querySelector("[data-action=refresh]").click();
        await until(() => f.shadow.querySelector("[data-role=restore-warning]") &&
          !f.shadow.querySelector("[data-action=refresh]").disabled, () => ({}), 10000);
        assert.equal(f.level, 2);
        assert.equal(f.restoreAttempts, !history || existingView === "effort" ? 2 : 1);
        assert.equal(f.shadow.querySelector("[data-role=status]").dataset.tone, "warning");
        assert.equal(f.shadow.querySelector("[data-role=status]").hidden, true);
        assert.deepEqual(f.shadow.querySelector("[data-role=cache-info]").textContent.split("\n").slice(0, 2),
          [MESSAGES.en.cacheTime, MESSAGES.en.refreshRestoreFailed]);
        assert.equal(f.shadow.querySelector("[data-role=cache-info]").textContent.split("\n").length, 3);
        assert.equal(f.state.chatCapabilities.models[0].efforts.length, 3);
        assert.ok(f.state.chatCapabilities.lastSuccessfulReadAt > 0);
        assert.equal(Boolean(f.native()), Boolean(existingView));
        if (existingView) assert.equal(f.native().dataset.view, existingView);
        await pause(300);
        assert.equal(f.shadow.querySelector("[data-role=restore-warning]").textContent, MESSAGES.en.refreshRestoreFailed);
        assert.notEqual(f.shadow.querySelector("[data-role=status]").textContent, MESSAGES.en.refreshSuccess);

        // A later successful refresh clears the warning without deleting the read timestamp.
        if (!history) {
          f.shadow.querySelector('[data-preference="follow-browser-language"]').click();
          await until(() => f.state.languageSettings?.followBrowser === false);
          for (const language of [...Object.keys(MESSAGES), "en"]) {
            const select = f.shadow.querySelector("#manual-language-select");
            select.value = language;
            select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
            await until(() => f.state.languageSettings.manualLanguage === language &&
              f.shadow.querySelector("[data-role=restore-warning]").textContent === MESSAGES[language].refreshRestoreFailed);
            assert.equal(f.shadow.querySelector("[data-role=cache-info]").textContent.split("\n")[1],
              MESSAGES[language].refreshRestoreFailed);
          }
          f.restoreFailures = 0;
          f.shadow.querySelector("[data-action=refresh]").click();
          assert.equal(f.shadow.querySelector("[data-role=restore-warning]"), null);
          await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.refreshSuccess);
          assert.equal(f.level, 2); // High is the original level for this new probe.
          assert.equal(f.shadow.querySelector("[data-role=cache-info]").textContent.split("\n").length, 2);
        }
      } finally { f.close(); }
    });
  }
});

test("refresh warns when restoring changes the slider but its final state cannot be read", async () => {
  const f = fixture(false, 0, null, "/", { unreadableRestoration: true });
  try {
    await pause(450);
    f.shadow.querySelector("[data-role=bubble]").click();
    f.shadow.querySelector("[data-role=settings-entry]").click();
    f.shadow.querySelector("[data-action=refresh]").click();
    await until(() => f.shadow.querySelector("[data-role=restore-warning]"), () => ({}), 7000);
    assert.equal(f.level, 1);
    assert.equal(f.shadow.querySelector("[data-role=restore-warning]").textContent, MESSAGES.en.refreshRestoreFailed);
    assert.notEqual(f.shadow.querySelector("[data-role=status]").textContent, MESSAGES.en.refreshSuccess);
  } finally { f.close(); }
});

test("probe cancellation does not force a restoration after reply generation begins", async () => {
  const f = fixture();
  try {
    await pause(450);
    f.document.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" || f.level !== 2) return;
      const stop = f.document.createElement("button");
      stop.setAttribute("aria-label", "停止生成");
      f.document.querySelector("main").append(stop);
    });
    f.shadow.querySelector("[data-role=bubble]").click();
    f.shadow.querySelector("[data-role=settings-entry]").click();
    f.shadow.querySelector("[data-action=refresh]").click();
    await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.refreshFailed);
    await pause(200);
    assert.equal(f.level, 2);
    assert.equal(f.restoreAttempts, 0);
    assert.equal(f.shadow.querySelector("[data-role=restore-warning]"), null);
  } finally { f.close(); }
});

test("controller passively reads a delayed menu row and updates timestamps without clicks or focus changes", async () => {
  const f = fixture();
  try {
    await pause(450);
    f.trigger.click();
    f.native().querySelector('[aria-label="选择模型"]').click();
    f.document.querySelector("#focus-sentinel").focus();
    const clicks = f.clicks;
    await until(() => f.state.chatCapabilities?.models.length === 1);
    const extra = f.document.createElement("div");
    extra.setAttribute("role", "menuitemradio");
    extra.setAttribute("aria-checked", "false");
    extra.textContent = "New native option";
    f.native().append(extra);
    await until(() => f.state.chatCapabilities?.models.length === 2);
    const writes = f.writes;
    const readAt = f.state.chatCapabilities.lastSuccessfulReadAt;
    f.native().querySelector("[role=status]").textContent += " ";
    await until(() => f.state.chatCapabilities.lastSuccessfulReadAt > readAt);
    assert.ok(f.writes > writes);
    assert.equal(f.clicks, clicks);
    assert.equal(f.document.activeElement.id, "focus-sentinel");
    assert.equal(f.trigger.getAttribute("aria-expanded"), "true");
  } finally { f.close(); }
});

test("controller waits for animated controls, preserves model-only feedback, and applies effort despite delayed own notifications and outside clicks", async () => {
  const f = fixture(true, 90, null, "/", { deferOutsideClose: true });
  try {
    await pause(450);
    f.shadow.querySelector("[data-role=bubble]").click();
    const select = f.shadow.querySelector("select");
    select.value = "label:GPT-6";
    select.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    await until(() => f.shadow.querySelector("[data-role=status]").textContent.startsWith(MESSAGES.en.applyModelOnly));
    assert.equal(f.level, 1);
    const range = f.shadow.querySelector("input[type=range]");
    range.value = "2";
    range.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    await until(() => f.level === 2 && f.shadow.querySelector("[data-role=status]").textContent.includes("/ High"));
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
    assert.equal(f.native(), null);
    f.trigger.click();
    f.shadow.querySelector('[data-action="apply"]').click();
    await until(() => f.native() === null && f.shadow.querySelector("[data-role=status]").textContent.includes("/ High"));
    assert.equal(f.level, 2);
    assert.equal(f.shadow.querySelector("[data-role=status]").dataset.tone, "success");
  } finally { f.close(); }
});

const highPreference = { schemaVersion: 1, modelId: "label:GPT-6", effortByModel: { "label:GPT-6": "label:High" }, autoApply: true };

test("applies legacy model preferences after the target is clickable and leaves other models' effort unchanged on failure", async (t) => {
  const canonical = "label:GPT-5.6 Sol";
  const legacy = canonical + " 将于 12月23日 下线";
  for (const [scenario, message] of [
    ["delayed", "applySuccess"], ["partially-visible", "applySuccess"], ["missing", "applyUnavailable"],
    ["disabled", "applyModelDisabled"], ["ignored", "applyModelUnconfirmed"]
  ]) await t.test(scenario, async () => {
    const prefs = { ...highPreference, modelId: legacy, autoApply: false, effortByModel: {
      [canonical]: "label:Instant", [legacy]: "label:High"
    } };
    const f = fixture(true, 0, prefs, "/", { initialNativeModel: "GPT-6.2", legacyModelScenario: scenario });
    try {
      await pause(350);
      f.shadow.querySelector("[data-role=bubble]").click();
      const select = f.shadow.querySelector("#default-model-select");
      assert.equal(select.value, canonical);
      assert.deepEqual([...select.options].filter((option) => option.value.startsWith(canonical)).map((option) => option.value), [canonical]);
      assert.equal(f.shadow.querySelector("[data-role=effort-value]").textContent, "High");
      f.shadow.querySelector("[data-role=settings-entry]").click();
      f.shadow.querySelector("[data-action=apply]").click();
      await until(() => f.shadow.querySelector("[data-role=status]").textContent.startsWith(MESSAGES.en[message]));
      assert.equal(f.model, message === "applySuccess" ? "GPT-5.6 Sol" : "GPT-6.2");
      assert.equal(f.level, message === "applySuccess" ? 2 : 1);
    } finally { f.close(); }
  });
});

test("pushState history navigation is detected when only messages change and composer controls are retained", async (t) => {
  for (const replaceContainer of [false, true]) await t.test(replaceContainer ? "container under wrapper" : "container contents", async () => {
    const f = fixture(true, 0, { ...highPreference, applyInHistory: true }, "/c/old-chat", { timelineHistory: true });
    try {
      await until(() => f.level === 2 && f.native() === null);
      const composer = f.document.querySelector("[role=textbox]");
      const trigger = f.trigger;
      let region = f.document.querySelector("[data-app-action-timeline-scroll]");
      if (replaceContainer) {
        const wrapper = f.document.createElement("div");
        region.replaceWith(wrapper);
        wrapper.append(region);
        await pause(250);
      }
      const openings = f.openingAttempts;
      const contents = '<div data-talvt-turn-state="complete"><div data-user-message-bubble="true">Question</div><h4 data-conversation-role="assistant">Answer</h4></div>';
      region.innerHTML = contents;
      await pause(600);
      assert.equal(f.openingAttempts, openings, "message updates within one conversation must not reapply settings");
      let popstateCount = 0;
      f.window.addEventListener("popstate", () => { popstateCount += 1; });
      f.window.history.pushState({}, "", "/c/new-chat");
      if (replaceContainer) {
        const next = region.cloneNode(false);
        next.innerHTML = contents;
        region.replaceWith(next);
        region = next;
      } else {
        region.innerHTML = contents;
      }
      await until(() => f.openingAttempts === openings + 1 && f.native() === null);
      assert.equal(popstateCount, 0);
      assert.equal(f.document.querySelector("[role=textbox]"), composer);
      assert.equal(f.trigger, trigger);
      await pause(500);
      assert.equal(f.openingAttempts, openings + 1, "the new conversation should apply only once");
    } finally { f.close(); }
  });
});

test("first-send pushState preserves completed application when the composer is retained", async () => {
  const f = fixture(true, 0, { ...highPreference, applyInHistory: true });
  try {
    await until(() => f.level === 2 && f.native() === null);
    const openings = f.openingAttempts;
    const composer = f.document.querySelector("[role=textbox]");
    f.window.history.pushState({}, "", "/c/first-send");
    const region = f.document.createElement("div");
    region.setAttribute("data-app-action-timeline-scroll", "");
    region.setAttribute("role", "region");
    region.innerHTML = '<div data-talvt-turn-state="complete"><div data-user-message-bubble="true"></div><h4 data-conversation-role="assistant"></h4></div>';
    f.document.querySelector("main").append(region);
    await pause(800);
    assert.equal(f.document.querySelector("[role=textbox]"), composer);
    assert.equal(f.openingAttempts, openings);
  } finally { f.close(); }
});

test("automatic apply waits for an open native menu to close without reapplying after it has finished", async () => {
  const f = fixture(true, 0, highPreference);
  try {
    f.trigger.click();
    await until(() => f.shadow.querySelector('[data-role="status"]').textContent === MESSAGES.en.autoApplyMenuWaiting);
    assert.equal(f.level, 1);
    assert.ok(f.native());
    f.trigger.click();
    await until(() => f.level === 2 && f.native() === null);
    f.trigger.click();
    const clicks = f.clicks;
    await pause(600);
    assert.equal(f.clicks, clicks);
    assert.ok(f.native());
  } finally { f.close(); }
});

test("the native-menu override allows automatic apply and restores the existing open menu view", async () => {
  const f = fixture(true, 0, { ...highPreference, applyWithNativeMenuOpen: true });
  try {
    f.trigger.click();
    f.native().querySelector('[aria-label="选择模型"]').click();
    await until(() => f.level === 2 && f.native()?.dataset.view === "models" &&
      f.shadow.querySelector('[data-role="status"]').textContent.includes("/ High"));
    assert.equal(f.trigger.getAttribute("aria-expanded"), "true");
    assert.equal(f.native().dataset.view, "models");
  } finally { f.close(); }
});

test("a draft and opening extension settings do not pause new-conversation application", async () => {
  const f = fixture(true, 0, highPreference);
  try {
    f.document.querySelector('[role="textbox"]').textContent = "Unsent draft";
    f.shadow.querySelector('[data-role="bubble"]').click();
    await until(() => f.level === 2 && f.native() === null);
    assert.ok(!f.shadow.querySelector('[data-role="status"]').textContent.includes("已暂停"));
  } finally { f.close(); }
});

test("startup applies cached preferences after an animated menu remounts its trigger and focus rebuilds its controls", async () => {
  const f = fixture(true, 1100, highPreference, "/", { replaceOnFocus: true, replaceTrigger: true });
  try {
    await until(() => f.level === 2 && f.native() === null && f.shadow.querySelector("[data-role=status]").textContent.includes("/ High"),
      () => ({ level: f.level, status: f.shadow.querySelector("[data-role=status]").textContent,
        host: f.shadow.host.outerHTML.slice(0, 500), open: !!f.native() }));
    assert.equal(f.shadow.querySelector("[data-role=status]").dataset.tone, "success");
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
  } finally { f.close(); }
});

test("automatic menu retry waits one second for an initially disabled button and applies once", async () => {
  const f = fixture(true, 0, highPreference, "/", { initialNativeModel: "GPT-5.6 Sol" });
  try {
    f.trigger.disabled = true;
    await until(() => f.shadow.host.dataset.step === "wait-menu-retry");
    f.trigger.disabled = false;
    await pause(600);
    assert.equal(f.openingAttempts, 0);
    assert.equal(f.model, "GPT-5.6 Sol");
    await until(() => f.model === "GPT-6" && f.level === 2 && f.native() === null);
    assert.equal(f.openingAttempts, 1);
    await pause(500);
    assert.equal(f.openingAttempts, 1);
  } finally { f.close(); }
});

test("automatic menu retry reacquires a rebuilt button after the first opening click was ignored", async () => {
  const f = fixture(true, 0, highPreference, "/", {
    ignoredOpeningClicks: 1, replaceTrigger: true, initialNativeModel: "GPT-5.6 Sol"
  });
  try {
    const originalTrigger = f.trigger;
    await until(() => f.shadow.host.dataset.step === "wait-menu-retry");
    assert.notEqual(f.trigger, originalTrigger);
    assert.equal(f.openingAttempts, 1);
    assert.equal(f.model, "GPT-5.6 Sol");
    await until(() => f.model === "GPT-6" && f.level === 2 && f.native() === null);
    assert.equal(f.openingAttempts, 2);
    assert.equal(f.shadow.host.dataset.step, "verified");
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
  } finally { f.close(); }
});

test("automatic menu retry stops after two ignored opening clicks", async () => {
  const f = fixture(true, 0, highPreference, "/", { ignoredOpeningClicks: 2, initialNativeModel: "GPT-5.6 Sol" });
  try {
    await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.applyNoControls,
      () => ({ attempts: f.openingAttempts, step: f.shadow.host.dataset.step }), 14000);
    assert.equal(f.openingAttempts, 2);
    assert.equal(f.model, "GPT-5.6 Sol");
    f.trigger.setAttribute("aria-label", "选择 ChatGPT 模型");
    await pause(1200);
    assert.equal(f.openingAttempts, 2);
    assert.equal(f.native(), null);
  } finally { f.close(); }
});

test("automatic menu retry rechecks configuration, navigation, visibility, generation and chat mode", async (t) => {
  const changes = {
    "automatic application disabled": async (f) => f.window.chrome.storage.local.set({ preferences: { ...highPreference, autoApply: false } }),
    navigation: (f) => {
      f.window.history.pushState({}, "", "/c/another-chat");
      f.window.dispatchEvent(new f.window.PopStateEvent("popstate"));
    },
    "hidden tab": (f) => {
      Object.defineProperty(f.document, "visibilityState", { configurable: true, value: "hidden" });
      f.document.dispatchEvent(new f.window.Event("visibilitychange"));
    },
    "reply generation": (f) => {
      const stop = f.document.createElement("button");
      stop.setAttribute("aria-label", "Stop generating");
      f.document.querySelector("main").append(stop);
    },
    "work mode": (f) => {
      const mode = f.document.createElement("button");
      mode.setAttribute("role", "tab");
      mode.setAttribute("aria-selected", "true");
      mode.textContent = "Work";
      f.document.querySelector("main").append(mode);
    }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = fixture(true, 0, highPreference, "/", { initialNativeModel: "GPT-5.6 Sol" });
    try {
      f.trigger.disabled = true;
      await until(() => f.shadow.host.dataset.step === "wait-menu-retry");
      await change(f);
      f.trigger.disabled = false;
      await pause(1300);
      assert.equal(f.openingAttempts, 0);
      assert.equal(f.model, "GPT-5.6 Sol");
    } finally { f.close(); }
  });
});

test("automatic menu retry is cancelled promptly when manual application takes over", async () => {
  const f = fixture(true, 0, highPreference, "/", { initialNativeModel: "GPT-5.6 Sol" });
  try {
    f.trigger.disabled = true;
    await until(() => f.shadow.host.dataset.step === "wait-menu-retry");
    f.trigger.disabled = false;
    f.shadow.querySelector("[data-role=bubble]").click();
    f.shadow.querySelector("[data-action=open-settings]").click();
    f.shadow.querySelector("[data-action=apply]").click();
    await until(() => f.model === "GPT-6" && f.level === 2 && f.native() === null, () => ({}), 900);
    await pause(1200);
    assert.equal(f.openingAttempts, 1);
  } finally { f.close(); }
});

test("manual application does not receive an automatic menu retry", async () => {
  const f = fixture(true, 0, { ...highPreference, autoApply: false }, "/", { ignoredOpeningClicks: 2 });
  try {
    await pause(50);
    f.shadow.querySelector("[data-role=bubble]").click();
    f.shadow.querySelector("[data-action=open-settings]").click();
    f.shadow.querySelector("[data-action=apply]").click();
    await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.applyNoControls);
    await pause(1200);
    assert.equal(f.openingAttempts, 1);
  } finally { f.close(); }
});

test("history startup and setting changes do not open native controls", async () => {
  const f = fixture(true, 90, highPreference, "/c/fixture-history");
  try {
    await pause(500);
    assert.equal(f.clicks, 0);
    f.shadow.querySelector("[data-role=bubble]").click();
    const range = f.shadow.querySelector("input[type=range]");
    range.value = "1";
    range.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    await until(() => f.state.preferences.effortByModel["label:GPT-6"] === "label:Medium");
    await pause(400);
    assert.equal(f.clicks, 0);
    assert.equal(f.native(), null);
  } finally { f.close(); }
});

test("history opt-in applies once and preserves that state across temporary control removal", async () => {
  const f = fixture(true, 0, { ...highPreference, applyInHistory: true }, "/c/opt-in", { timelineHistory: true });
  try {
    await until(() => f.level === 2 && f.native() === null);
    const clicks = f.clicks;
    const trigger = f.trigger;
    trigger.remove();
    await pause(250);
    f.document.querySelector("main").append(trigger);
    await pause(800);
    assert.equal(f.clicks, clicks);
    f.shadow.querySelector('[data-role="bubble"]').click();
    assert.deepEqual([...f.shadow.querySelectorAll('[role="switch"]')].map((el) => el.dataset.preference),
      ["auto-apply", "apply-with-native-menu-open", "apply-in-history", "follow-browser-language"]);
    assert.equal(f.shadow.querySelector('[data-preference="apply-in-history"]').checked, true);
  } finally { f.close(); }
});

test("history opt-in waits for generation to end and disabling it cancels that wait", async () => {
  const f = fixture(true, 0, { ...highPreference, applyInHistory: true }, "/c/busy", { timelineHistory: true });
  try {
    const stop = f.document.createElement("button");
    stop.setAttribute("aria-label", "Stop generating");
    f.document.querySelector("main").append(stop);
    await pause(600);
    assert.equal(f.clicks, 0);
    f.shadow.querySelector('[data-role="bubble"]').click();
    const toggle = f.shadow.querySelector('[data-preference="apply-in-history"]');
    toggle.checked = false;
    toggle.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    await until(() => f.state.preferences.applyInHistory === false);
    stop.remove();
    await pause(600);
    assert.equal(f.clicks, 0);
    toggle.checked = true;
    toggle.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    await until(() => f.level === 2 && f.native() === null);
    assert.equal(f.state.preferences.applyInHistory, true);
  } finally { f.close(); }
});

test("history opt-in resumes once after generation and still obeys the automatic-apply master switch", async () => {
  const f = fixture(true, 0, { ...highPreference, applyInHistory: true }, "/c/resume", { timelineHistory: true });
  try {
    const stop = f.document.createElement("button");
    stop.setAttribute("aria-label", "Stop generating");
    f.document.querySelector("main").append(stop);
    await pause(600);
    assert.equal(f.clicks, 0);
    stop.remove();
    await until(() => f.level === 2 && f.native() === null);
  } finally { f.close(); }
  const disabled = fixture(true, 0, { ...highPreference, autoApply: false, applyInHistory: true }, "/c/off", { timelineHistory: true });
  try {
    await pause(700);
    assert.equal(disabled.clicks, 0);
  } finally { disabled.close(); }
});

test("an unready automatic menu exits after one retry and closes only the menu it opened", async () => {
  const f = fixture(true, 20000, highPreference);
  try {
    await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.applyNoControls, () => ({}), 14000);
    assert.equal(f.shadow.querySelector("[data-role=status]").dataset.tone, "quiet");
    assert.equal(f.native(), null);
    assert.equal(f.level, 1);
    assert.equal(f.clicks, 2);
  } finally { f.close(); }
});

test("a missing saved level is shown as needing reselection without changing the preference", async () => {
  const preference = { ...highPreference, effortByModel: { "label:GPT-6": "label:Retired level" } };
  const f = fixture(true, 0, preference);
  try {
    await until(() => f.shadow.host.dataset.step === "attempted" && f.native() === null);
    f.shadow.querySelector("[data-role=bubble]").click();
    assert.equal(f.shadow.querySelector("[data-role=effort-value]").textContent, MESSAGES.en.effortUnavailable);
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:Retired level");
  } finally { f.close(); }
});

test("generation beginning while a menu is opening prevents later native changes and result commits", async () => {
  const f = fixture(true, 1100, highPreference);
  try {
    await until(() => f.native() !== null);
    const stop = f.document.createElement("button");
    stop.setAttribute("aria-label", "Stop generating");
    f.document.querySelector("main").append(stop);
    await until(() => f.shadow.querySelector("[data-role=status]").textContent === MESSAGES.en.applyNoControls);
    assert.equal(f.shadow.querySelector("[data-role=status]").dataset.tone, "quiet");
    assert.equal(f.clicks, 1);
    assert.equal(f.level, 1);
    assert.equal(f.state.chatCapabilities.lastSuccessfulReadAt, 1);
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
  } finally { f.close(); }
});

test("completed native conversation stays unchanged on startup and applies only after an explicit request", async () => {
  const f = fixture(true, 0, highPreference, "/c/test", { timelineHistory: true });
  try {
    await pause(500);
    assert.equal(f.clicks, 0);
    assert.equal(f.level, 1);
    f.shadow.querySelector('[data-role="bubble"]').click();
    f.shadow.querySelector('[data-action="apply"]').click();
    await until(() => f.level === 2 && f.shadow.querySelector('[data-role="status"]').dataset.tone === "success");
    assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
    assert.equal(f.native(), null);
  } finally { f.close(); }
});

test("cached blank-chat startup still applies when the SPA retains an older hidden page", async () => {
  const f = fixture(true, 0, highPreference, "/", { retainedPage: true });
  try {
    await until(() => f.level === 2 && f.shadow.querySelector('[data-role="status"]').dataset.tone === "success");
    assert.equal(f.shadow.host.style.display, "block");
    assert.equal(f.native(), null);
    assert.equal(f.document.querySelectorAll('#chatgpt-default-model-effort-host').length, 1);
  } finally { f.close(); }
});

test("opening only the reasoning view updates retained models without changing focus or native selection", async () => {
  const f = fixture();
  try {
    await pause(450);
    f.trigger.click();
    f.document.querySelector("#focus-sentinel").focus();
    const clicks = f.clicks;
    await until(() => f.state.chatCapabilities?.models.length === 1);
    assert.equal(f.clicks, clicks);
    assert.equal(f.level, 1);
    assert.equal(f.native().getAttribute("data-view"), "effort");
    assert.equal(f.document.activeElement.id, "focus-sentinel");
    assert.equal(f.state.chatCapabilities.models[0].effortState, "not-read");
  } finally { f.close(); }
});

test("the same body-mounted host recovers after removal and body replacement without duplicate initialization", async () => {
  const f = fixture();
  try {
    const host = f.shadow.host;
    assert.equal(host.parentElement, f.document.body);
    host.remove();
    await until(() => host.isConnected);
    const replacement = f.document.createElement("body");
    replacement.append(f.document.querySelector("main").cloneNode(true));
    f.document.body.replaceWith(replacement);
    await until(() => host.parentElement === replacement);
    f.window.eval(script);
    assert.equal(f.document.querySelectorAll("#chatgpt-default-model-effort-host").length, 1);
    assert.equal(f.shadow.host, host);
  } finally { f.close(); }
});

test("passive reasoning reads relabel only a verified cached native ID and keep non-strength categories off the strength axis", async () => {
  const f = fixture(true);
  try {
    await pause(450);
    const cached = structuredClone(f.state.chatCapabilities);
    cached.models[0].efforts = cached.models[0].efforts.map((effort, index) => ({
      ...effort, id: "native:" + ["none", "medium", "high"][index]
    }));
    await f.window.chrome.storage.local.set({ chatCapabilities: cached });
    await pause(30);
    f.trigger.click();
    const clicks = f.clicks;
    f.native().querySelector("[role=status]").textContent = "中，第 2 项，共 3 项。";
    await until(() => f.state.chatCapabilities.models[0].efforts[1].label === "中");
    assert.equal(f.state.chatCapabilities.models[0].efforts[1].id, "native:medium");
    f.native().querySelector("[role=status]").textContent = "Auto，第 2 项，共 3 项。";
    await pause(400);
    assert.equal(f.state.chatCapabilities.models[0].efforts[1].label, "中");
    assert.equal(f.clicks, clicks);
  } finally { f.close(); }
});

test("settings distinguish unread, unknown, unsupported and unavailable levels without inventing a strength order", async () => {
  const f = fixture(true, 0, { ...highPreference, autoApply: false });
  try {
    await pause(450);
    f.shadow.querySelector('[data-role="bubble"]').click();
    for (const [state, expected] of [
      ["not-read", "No reasoning levels recorded"], ["unknown", "could not be confirmed"],
      ["unsupported", "explicitly provides no reasoning levels"], ["observed", "No available reasoning levels were observed"]
    ]) {
      const cache = structuredClone(f.state.chatCapabilities);
      cache.models[0] = { ...cache.models[0], effortState: state, efforts: [] };
      await f.window.chrome.storage.local.set({ chatCapabilities: cache });
      await until(() => f.shadow.textContent.includes(expected));
      assert.equal(f.shadow.querySelector('input[type="range"]'), null);
      assert.equal(f.state.preferences.effortByModel["label:GPT-6"], "label:High");
    }
    const cache = structuredClone(f.state.chatCapabilities);
    cache.models[0] = { ...cache.models[0], effortState: "observed", efforts: [
      { id: "label:Auto", label: "Auto", order: null, ordering: "non-ordered", disabled: false }
    ] };
    await f.window.chrome.storage.local.set({ chatCapabilities: cache });
    await until(() => f.shadow.textContent.includes(MESSAGES.en.effortNonOrdered));
    assert.equal(f.shadow.querySelector('input[type="range"]'), null);
    assert.equal(f.shadow.querySelector('[data-preference="effort-select"] option[value="label:Auto"]').textContent, "Auto");
    assert.equal(f.shadow.querySelector('[data-preference="effort-select"]').value, "");
    assert.equal(f.shadow.querySelector('[data-preference="effort-select"] option[value=""]').textContent, MESSAGES.en.effortUnavailable);
  } finally { f.close(); }
});
