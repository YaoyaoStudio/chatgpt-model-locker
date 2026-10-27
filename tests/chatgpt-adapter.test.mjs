import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  ChatGPTAdapter,
  effortIdFromLabel,
  matchesEffortOption,
  parseEffortStatus
} from "../src/chatgpt-adapter.ts";

function makePage({ language = "zh-CN", path = "/", activeView = "effort", message = false, control = "" } = {}) {
  const dom = new JSDOM(`<!doctype html>
    <html lang="${language}"><body>
      <main>
        <h1>随时可以开始。</h1>
        <div role="textbox" contenteditable="true" aria-label="${language.startsWith("en") ? "Ask ChatGPT" : "询问 ChatGPT"}"></div>
        ${message ? '<article data-message-author-role="assistant">Test reply</article>' : ""}
        ${control ? `<button aria-label="${control}"></button>` : ""}
        <button id="model-trigger" aria-label="${language.startsWith("en") ? "Select ChatGPT model" : "选择 ChatGPT 模型"}"
          aria-haspopup="menu" aria-expanded="true" aria-controls="model-menu" data-selected-reasoning-effort="medium"></button>
      </main>
      <div id="model-menu" role="menu" aria-labelledby="model-trigger">
        <div role="menuitemradio" aria-checked="true" data-model-selected="true" data-hit="${activeView === "models"}">GPT-6</div>
        <div role="menuitemradio" aria-checked="false" data-model-selected="false" data-hit="${activeView === "models"}">GPT-5.6 Sol</div>
        <div role="menuitem" data-reasoning-slider="true" aria-label="${language.startsWith("en") ? "Power" : "强度"}"
          data-hit="${activeView === "effort"}" aria-describedby="effort-status">
          <span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"></span>
        </div>
        <div id="effort-status" role="status">${language.startsWith("en") ? "Medium, 2 of 3. Use Left and Right arrow keys to adjust power" : "中, 第 2 项，共 3 项。使用左右方向键调整强度"}</div>
        <div role="status" data-hit="${activeView !== "models"}">已锁定，打开访问权限选项</div>
      </div>
    </body></html>`, { url: `https://chatgpt.com${path}` });
  const adapter = new ChatGPTAdapter(dom.window.document, {
    isHitTestable: (element) => element.dataset.hit === "true"
  });
  return { dom, adapter };
}

test("recognizes the Chinese blank chat and uses a host-only cache scope", () => {
  const { adapter } = makePage();
  const snapshot = adapter.readPageSnapshot();
  assert.equal(snapshot.kind, "new-empty");
  assert.equal(snapshot.language, "zh");
  assert.equal(snapshot.scopeKey, "chatgpt.com");
  assert.equal(snapshot.composer?.getAttribute("aria-label"), "询问 ChatGPT");
});

test("reads only topmost model menu rows without completeness classification", () => {
  const { adapter } = makePage({ activeView: "models" });
  const menu = adapter.findMenu();
  assert.ok(menu);
  assert.equal(adapter.menuView(menu), "models");
  const listing = adapter.readModelOptions(menu);
  assert.deepEqual(listing.map((option) => [option.id, option.selected]), [
    ["label:GPT-6", true],
    ["label:GPT-5.6 Sol", false]
  ]);
});

test("only the live native reasoning control is an effort adjustment target", () => {
  const { dom, adapter } = makePage();
  try {
    const document = dom.window.document;
    const control = document.querySelector('[data-reasoning-slider="true"]');
    assert.equal(adapter.isNativeEffortTarget(control.querySelector('[role="slider"]')), true);
    assert.equal(adapter.isNativeEffortTarget(adapter.findModelTrigger()), false);
    assert.equal(adapter.isNativeEffortTarget(document.querySelector('[role="menuitemradio"]')), false);
    assert.equal(adapter.isNativeEffortTarget(document.querySelector('[role="textbox"]')), false);
    control.dataset.hit = "false";
    assert.equal(adapter.isNativeEffortTarget(control), false);
    control.dataset.hit = "true";
    adapter.findModelTrigger().setAttribute("aria-expanded", "false");
    assert.equal(adapter.isNativeEffortTarget(control), false);
  } finally { dom.window.close(); }
});

test("an unsent draft remains a new conversation but does not bypass the running-reply guard", () => {
  const { dom, adapter } = makePage();
  try {
    dom.window.document.querySelector('[role="textbox"]').textContent = "Unsent draft";
    assert.equal(adapter.readPageSnapshot().kind, "new-empty");
    const stop = dom.window.document.createElement("button");
    stop.setAttribute("aria-label", "停止");
    dom.window.document.querySelector("main").append(stop);
    assert.equal(adapter.replyGenerationState(), "running");
  } finally { dom.window.close(); }
});

test("rejects Work's shared model trigger and menu even when native rows look selectable", () => {
  const { dom, adapter } = makePage({ activeView: "models" });
  const menu = adapter.findMenu();
  const trigger = adapter.findModelTrigger();
  dom.window.document.querySelector('[role="textbox"]').setAttribute("aria-label", "使用 ChatGPT Work");
  assert.equal(adapter.isChatMode(), false);
  assert.equal(adapter.findModelTrigger(), null);
  assert.equal(adapter.findMenu(trigger), null);
  assert.equal(adapter.menuView(menu), "unknown");
  assert.deepEqual(adapter.readModelOptions(menu), []);
  assert.deepEqual(adapter.readRetainedModelOptions(menu), []);
  dom.window.close();
});

test("a selected Work mode blocks retained chat controls; switching back restores chat-only reads", () => {
  const { dom, adapter } = makePage({ activeView: "models" });
  const document = dom.window.document;
  const menu = adapter.findMenu();
  const modes = document.createElement("div");
  modes.innerHTML = '<button role="checkbox" aria-checked="false">聊天</button>' +
    '<button role="checkbox" aria-checked="true">工作</button>';
  document.body.prepend(modes);
  assert.equal(adapter.isChatMode(), false);
  assert.deepEqual(adapter.readModelOptions(menu), []);
  modes.children[0].setAttribute("aria-checked", "true");
  modes.children[1].setAttribute("aria-checked", "false");
  assert.equal(adapter.isChatMode(), true);
  assert.deepEqual(adapter.readModelOptions(menu).map((option) => option.label), ["GPT-6", "GPT-5.6 Sol"]);
  dom.window.close();
});

test("an unlabelled page language can identify the normal chat without recursive mode lookup", () => {
  const { dom, adapter } = makePage({ language: "", activeView: "models" });
  assert.equal(adapter.isChatMode(), true);
  assert.equal(adapter.language(), "zh");
  assert.equal(adapter.readPageSnapshot().kind, "new-empty");
  dom.window.close();
});

test("does not mistake overlapped model rows for the active view", () => {
  const { adapter } = makePage({ activeView: "effort" });
  const menu = adapter.findMenu();
  assert.ok(menu);
  assert.equal(adapter.menuView(menu), "effort");
  assert.deepEqual(adapter.readModelOptions(menu), []);
  assert.deepEqual(adapter.readRetainedModelOptions(menu).map((option) => option.label), ["GPT-6", "GPT-5.6 Sol"]);
});

test("reads Chinese and English effort status and uses semantic effort IDs", () => {
  for (const [language, text, label] of [
    ["zh-CN", "中, 第 2 项，共 3 项。使用左右方向键调整强度", "中"],
    ["en", "Medium, 2 of 3. Use Left and Right arrow keys to adjust power", "Medium"]
  ]) {
    const parsed = parseEffortStatus(text);
    assert.deepEqual(parsed, { label, index: 2, total: 3 });
    const { adapter } = makePage({ language, activeView: "effort" });
    const menu = adapter.findMenu();
    assert.ok(menu);
    const reading = adapter.readEffort(menu);
    assert.equal(reading?.label, label);
    assert.equal(reading?.index, 2);
    assert.equal(reading?.ordered, true);
    assert.equal(reading?.nativeId, "medium");
  }
  assert.equal(effortIdFromLabel(" High "), "label:High");
  assert.notEqual(effortIdFromLabel("High"), effortIdFromLabel("Medium"));
});

test("requires cached effort label, order, and level count to match the native reading", () => {
  const target = { id: "label:High", label: "High", ordering: "strength", order: 1, disabled: false };
  const reading = {
    label: " High ", index: 2, total: 4, min: 0, max: 3, value: 1,
    ordered: true, control: {}, statusText: "High, 2 of 4"
  };
  assert.equal(matchesEffortOption(reading, target, 2, 4), true);
  assert.equal(matchesEffortOption({ ...reading, label: "Medium" }, target, 2, 4), false);
  assert.equal(matchesEffortOption({ ...reading, index: 3 }, target, 2, 4), false);
  assert.equal(matchesEffortOption(reading, target, 2, 5), false);
});

test("verified native effort IDs survive label localization while still checking model-local position and count", () => {
  const target = { id: "native:medium", label: "Medium", ordering: "strength", order: 1, disabled: false };
  const reading = { nativeId: "medium", label: "中", index: 2, total: 3, ordered: true };
  assert.equal(matchesEffortOption(reading, target, 2, 3), true);
  assert.equal(matchesEffortOption({ ...reading, nativeId: "high" }, target, 2, 3), false);
  assert.equal(matchesEffortOption({ ...reading, nativeId: null }, target, 2, 3), false);
  assert.equal(matchesEffortOption(reading, target, 2, 4), false);
});

test("rejects malformed status and does not treat a populated conversation as a blank chat", () => {
  assert.equal(parseEffortStatus("Medium, some options available"), null);
  const { adapter } = makePage({ path: "/c/example", activeView: "effort" });
  assert.notEqual(adapter.readPageSnapshot().kind, "new-empty");
});

test("classifies reply generation from composer controls and fails closed when the state is unknown", () => {
  const running = makePage({ path: "/c/example", message: true, control: "Stop generating" }).adapter;
  const idle = makePage({ path: "/c/example", message: true, control: "Send prompt" }).adapter;
  const unknown = makePage({ path: "/c/example", message: true }).adapter;
  assert.equal(running.replyGenerationState(), "running");
  assert.equal(idle.replyGenerationState(), "idle");
  assert.equal(unknown.replyGenerationState(), "unknown");
});

test("mutation filtering notices portal and delayed menu rows without watching reply stream text", async () => {
  const { dom, adapter } = makePage({ activeView: "models", message: true });
  const document = dom.window.document;
  const records = [];
  const observer = new dom.window.MutationObserver((items) => records.push(...items));
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  document.querySelector("[data-message-author-role]").firstChild.data += " chunk";
  document.querySelector("[role=menu]").append(document.createElement("div"));
  const portal = document.createElement("div");
  portal.innerHTML = '<div role="menu"></div>';
  document.body.append(portal);
  await Promise.resolve();
  assert.deepEqual(records.map((record) => adapter.mutationTouchesModelMenu(record)), [false, true, true]);
  observer.disconnect();
  dom.window.close();
});

test("menu readiness remains bounded when the browser suspends animation frames", async () => {
  const { dom, adapter } = makePage({ activeView: "effort" });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  try {
    const menu = await adapter.ensureMenuOpen(adapter.findModelTrigger(), { isCurrent: () => true }, 200);
    assert.equal(menu?.id, "model-menu");
  } finally { dom.window.close(); }
});

test("native headline markers recognize rotating greetings without accepting an arbitrary empty root", () => {
  const { dom, adapter } = makePage();
  const heading = dom.window.document.querySelector("h1");
  heading.textContent = "今天想聊点什么？";
  assert.equal(adapter.readPageSnapshot().kind, "unknown");
  heading.innerHTML = '<span data-headline="onYourMind">今天想聊点什么？</span>';
  assert.equal(adapter.readPageSnapshot().kind, "new-empty");
  dom.window.close();
});

test("duplicate model names and contradictory selection flags cannot become selectable unique targets", async () => {
  const { dom, adapter } = makePage({ activeView: "models" });
  const menu = adapter.findMenu();
  const selected = menu.querySelector('[role="menuitemradio"]');
  const duplicate = selected.cloneNode(true);
  duplicate.setAttribute("aria-checked", "false");
  duplicate.setAttribute("data-model-selected", "false");
  menu.append(duplicate);
  assert.equal(adapter.readModelOptions(menu).some((option) => option.id === "label:GPT-6"), false);
  assert.equal(await adapter.selectModel(menu, "label:GPT-6", { isCurrent: () => true }), false);
  duplicate.remove();
  selected.setAttribute("data-model-selected", "false");
  assert.equal(adapter.readModelOptions(menu).some((option) => option.id === "label:GPT-6"), false);
  dom.window.close();
});

test("a stop control overrides an otherwise blank home during the first-send transition", () => {
  for (const control of ["Stop generating", "停止"]) {
    const { dom, adapter } = makePage({ control });
    assert.equal(adapter.replyGenerationState(), "running");
    dom.window.close();
  }
});

test("observed conversation region and completed assistant turn identify an idle history with an empty composer", () => {
  const { dom, adapter } = makePage({ path: "/c/example" });
  const document = dom.window.document;
  const region = document.createElement("div");
  region.setAttribute("role", "region");
  region.setAttribute("data-app-action-timeline-scroll", "");
  region.innerHTML = '<div data-talvt-turn-state="complete"><div data-user-message-bubble="true"></div><h4 data-conversation-role="assistant"></h4></div>';
  document.querySelector("main").append(region);
  assert.equal(adapter.readPageSnapshot().kind, "history");
  assert.equal(adapter.readPageSnapshot().messageCount, 2);
  assert.equal(adapter.replyGenerationState(), "idle");
  region.querySelector('[data-talvt-turn-state]').setAttribute("data-talvt-turn-state", "unknown");
  assert.equal(adapter.replyGenerationState(), "unknown");
  region.querySelector('[data-talvt-turn-state]').setAttribute("data-talvt-turn-state", "complete");
  const stop = document.createElement("button");
  stop.setAttribute("aria-label", "停止");
  document.querySelector("main").append(stop);
  assert.equal(adapter.replyGenerationState(), "running");
  dom.window.close();
});

test("native reply chunks do not trigger model scans, while a turn completion signals page state", async () => {
  const { dom, adapter } = makePage({ path: "/c/example" });
  const document = dom.window.document;
  const region = document.createElement("div");
  region.setAttribute("role", "region");
  region.setAttribute("data-app-action-timeline-scroll", "");
  region.innerHTML = '<div data-talvt-turn-state="complete"><h4 data-conversation-role="assistant"></h4><p>Fixture</p></div>';
  document.querySelector("main").append(region);
  const records = [];
  const observer = new dom.window.MutationObserver(items => records.push(...items));
  observer.observe(region, { subtree: true, characterData: true, attributes: true });
  region.querySelector("p").firstChild.data += " chunk";
  region.querySelector('[data-talvt-turn-state]').setAttribute("data-talvt-turn-state", "unknown");
  await Promise.resolve();
  assert.deepEqual(records.map(record => adapter.mutationTouchesModelMenu(record)), [false, false]);
  assert.deepEqual(records.map(record => adapter.mutationMayChangePageState(record, 1)), [false, true]);
  observer.disconnect();
  dom.window.close();
});

test("retained pages under display:none cannot duplicate active controls, messages, or generation state", () => {
  const { dom, adapter } = makePage();
  const document = dom.window.document;
  const active = document.querySelector("main");
  const retained = document.createElement("div");
  retained.style.setProperty("display", "none", "important");
  retained.innerHTML = '<main><div role="textbox" contenteditable="true" aria-label="询问 ChatGPT"></div>' +
    '<button aria-haspopup="menu" aria-label="选择 ChatGPT 模型"></button>' +
    '<article data-message-author-role="assistant"></article><button aria-label="停止"></button></main>';
  document.body.prepend(retained);
  assert.equal(adapter.findComposer(), active.querySelector('[role="textbox"]'));
  assert.equal(adapter.findModelTrigger(), active.querySelector("#model-trigger"));
  assert.equal(adapter.activeMain(), active);
  assert.equal(adapter.readPageSnapshot().kind, "new-empty");
  assert.equal(adapter.readPageSnapshot().messageCount, 0);
  assert.equal(adapter.replyGenerationState(), "idle");
  // Portal/page fades do not detach controls; active interactions also require hit testing.
  active.style.opacity = "0";
  assert.equal(adapter.readPageSnapshot().kind, "new-empty");
  active.style.opacity = "1";
  document.querySelector("h1").remove();
  const message = document.createElement("article");
  message.setAttribute("data-message-author-role", "assistant");
  active.append(message);
  dom.reconfigure({ url: "https://chatgpt.com/c/fixture" });
  assert.equal(adapter.readPageSnapshot().kind, "history");
  assert.equal(adapter.replyGenerationState(), "unknown");
  dom.window.close();
});

test("hiding a retained page schedules page recognition without requesting a model scan", async () => {
  const { dom, adapter } = makePage();
  const document = dom.window.document;
  const wrapper = document.createElement("div");
  document.querySelector("main").replaceWith(wrapper);
  wrapper.innerHTML = '<main><div role="textbox" contenteditable="true" aria-label="询问 ChatGPT"></div></main>';
  const records = [];
  const observer = new dom.window.MutationObserver(items => records.push(...items));
  observer.observe(wrapper, { attributes: true });
  wrapper.style.display = "none";
  await Promise.resolve();
  assert.equal(records.length, 1);
  assert.equal(adapter.mutationMayChangePageState(records[0], 1), true);
  assert.equal(adapter.mutationTouchesModelMenu(records[0]), false);
  observer.disconnect();
  dom.window.close();
});

test("a portal view that temporarily becomes non-actionable after opening is awaited within the same bounded task", async () => {
  const { dom, adapter } = makePage();
  const menu = adapter.findMenu();
  const control = menu.querySelector('[data-reasoning-slider]');
  control.dataset.hit = "false";
  const navigate = dom.window.document.createElement("div");
  navigate.setAttribute("role", "menuitem");
  navigate.setAttribute("aria-label", "选择模型");
  navigate.dataset.hit = "true";
  menu.append(navigate);
  navigate.addEventListener("click", () => {
    control.dataset.hit = "false";
    menu.querySelectorAll('[role="menuitemradio"]').forEach(e => { e.dataset.hit = "true"; });
  });
  dom.window.setTimeout(() => { control.dataset.hit = "true"; }, 80);
  try {
    assert.equal(await adapter.showModelList(menu, { isCurrent: () => true }, 400), true);
    assert.equal(adapter.menuView(menu), "models");
    menu.querySelectorAll('[role="menuitemradio"]').forEach(e => { e.dataset.hit = "false"; });
    assert.equal(await adapter.showModelList(menu, { isCurrent: () => true }, 60), false);
  } finally { dom.window.close(); }
});
