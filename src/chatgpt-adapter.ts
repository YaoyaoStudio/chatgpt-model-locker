import type { EffortOption, ModelCapability } from "./domain.js";

export type UiLanguage = "zh" | "en" | "ja" | "unknown";
export type MenuView = "models" | "effort" | "ambiguous" | "unknown";
export type ChatPageKind = "new-empty" | "history" | "unknown" | "unsupported";
export type ReplyGenerationState = "idle" | "running" | "unknown";

export interface ModelMenuOption {
  id: string;
  label: string;
  selected: boolean | null;
  availability: "available" | "disabled" | "unknown";
  element: HTMLElement;
}

export interface EffortReading {
  nativeId: string | null;
  label: string;
  index: number;
  total: number;
  min: number;
  max: number;
  value: number;
  ordered: boolean;
  control: HTMLElement;
  statusText: string;
}

export interface ChatPageSnapshot {
  kind: ChatPageKind;
  language: UiLanguage;
  scopeKey: string;
  composer: HTMLElement | null;
  modelTrigger: HTMLElement | null;
  messageCount: number;
}

export interface AdapterOptions {
  /** Test seam; production uses hit testing to distinguish overlapping portal views. */
  isHitTestable?: (element: HTMLElement) => boolean;
}

export interface InteractionGuard {
  isCurrent(): boolean;
}

type KnownUiLanguage = Exclude<UiLanguage, "unknown">;
type UiTextKey = "composer" | "trigger" | "selectModel" | "effort" | "homeHeadings" | "newChat";

const UI_TEXT: Record<KnownUiLanguage, Record<UiTextKey, readonly string[]>> = {
  zh: {
    composer: ["询问 ChatGPT", "詢問 ChatGPT", "向 ChatGPT 提問"],
    trigger: ["选择 ChatGPT 模型", "選擇 ChatGPT 模型"],
    selectModel: ["选择模型", "選擇模型"],
    effort: ["强度", "強度"],
    homeHeadings: ["随时可以开始。", "我们从哪里开始？", "今天有什么安排？", "隨時可以開始。", "我們從哪裡開始？", "今天有什麼安排？"],
    newChat: ["新聊天", "新對話", "新增對話"]
  },
  ja: {
    composer: ["ChatGPT に質問する", "ChatGPT に質問", "ChatGPTに質問する", "ChatGPTに質問"],
    trigger: ["ChatGPT のモデルを選択", "ChatGPT モデルを選択", "ChatGPTのモデルを選択", "ChatGPT のモデルを選択する"],
    selectModel: ["モデルを選択", "モデルを選択する"],
    effort: ["強度", "推論強度", "パワー"],
    homeHeadings: ["どこから始めましょうか？", "何から始めましょうか？", "いつでも始められます。"],
    newChat: ["新しいチャット", "新規チャット"]
  },
  en: {
    composer: ["Ask ChatGPT"],
    trigger: ["Select ChatGPT model"],
    selectModel: ["Select model"],
    effort: ["Power"],
    homeHeadings: ["Where should we begin?"],
    newChat: ["New chat"]
  }
} as const;

const allUiText = (key: UiTextKey): string[] => Object.values(UI_TEXT).flatMap((text) => text[key]);

const CONVERSATION_REGION = '[data-app-action-timeline-scroll][role="region"]';
const MESSAGE_SELECTOR = '[data-message-author-role], [data-message-id], article[data-testid*="conversation-turn"], ' +
  CONVERSATION_REGION + ' [data-user-message-bubble="true"], ' + CONVERSATION_REGION + ' [data-conversation-role="assistant"]';
const PAGE_SIGNAL_SELECTOR = 'main, [data-headline], [role="textbox"][contenteditable="true"], [aria-haspopup="menu"][aria-label], ' + MESSAGE_SELECTOR;
const MODE_CONTROL_SELECTOR = '[role="checkbox"], [role="radio"], [role="tab"], input[type="checkbox"], input[type="radio"]';

export class ChatGPTAdapter {
  readonly document: Document;
  menuReadinessDiagnostic = "not-started";
  private readonly isHitTestable: (element: HTMLElement) => boolean;

  constructor(document: Document, options: AdapterOptions = {}) {
    this.document = document;
    this.isHitTestable = options.isHitTestable ?? ((element) => isTopmostAtCenter(element, document));
  }

  /** Cheap local filtering; portal discovery scans only newly added/removed subtrees. */
  mutationTouchesModelMenu(record: MutationRecord): boolean {
    const ElementType = this.document.defaultView!.Element;
    const target = record.target instanceof ElementType ? record.target : record.target.parentElement;
    if (target?.closest(MESSAGE_SELECTOR + ', [data-talvt-turn-state]')) return false;
    if (target?.closest('[role="menu"]')) return true;
    if (record.type === "attributes" && target?.getAttribute("aria-haspopup") === "menu") {
      const label = target.getAttribute("aria-label") ?? "";
      return allUiText("trigger").includes(label);
    }
    if (record.type !== "childList") return false;
    return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof ElementType &&
      (node.matches('[role="menu"]') || Boolean(node.querySelector('[role="menu"]'))));
  }

  mutationMayChangePageState(record: MutationRecord, messageCount: number): boolean {
    const ElementType = this.document.defaultView!.Element;
    const target = record.target instanceof ElementType ? record.target : record.target.parentElement;
    if (target && this.isComposerModeTarget(target)) return true;
    const hasSignal = (node: Node) => node instanceof ElementType &&
      (node.matches(PAGE_SIGNAL_SELECTOR) || Boolean(node.querySelector(PAGE_SIGNAL_SELECTOR)));
    if (record.type === "attributes" && ["style", "hidden", "aria-hidden", "inert"].includes(record.attributeName ?? "") &&
      target && (target.matches("main") || Boolean(target.querySelector("main")))) return true;
    if (target?.closest("main")) {
      if (target.matches("main")) return true;
      if (record.type === "characterData" && target.closest("h1,h2") && messageCount === 0) return true;
      if (record.type === "attributes") {
        if (target.matches('button[aria-label], [role="button"][aria-label]') &&
          !target.closest(MESSAGE_SELECTOR + ', [data-talvt-turn-state]')) return true;
        return target.matches('[data-talvt-turn-state]') || Boolean(target.closest(
          '[role="textbox"][contenteditable="true"], [aria-haspopup="menu"][aria-label]'));
      }
      // A history-page apply may be waiting for Stop to disappear or Send to become
      // available. Observe composer controls without scanning streamed message text.
      if (record.type === "childList" && !target.closest(MESSAGE_SELECTOR + ', [data-talvt-turn-state]') &&
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof ElementType &&
          (node.matches('button[aria-label], [role="button"][aria-label]') ||
            Boolean(node.querySelector('button[aria-label], [role="button"][aria-label]'))))) return true;
      if (messageCount > 0) return false;
      return [...record.addedNodes, ...record.removedNodes].some(hasSignal);
    }
    if (target === this.document.documentElement || target === this.document.body) {
      return [...record.addedNodes, ...record.removedNodes].some(hasSignal);
    }
    return false;
  }

  language(): UiLanguage {
    const documentLanguage = this.document.documentElement.lang.trim().toLowerCase();
    if (documentLanguage.startsWith("zh")) return "zh";
    if (documentLanguage.startsWith("en")) return "en";
    if (documentLanguage.startsWith("ja")) return "ja";

    const trigger = this.findModelTrigger();
    const label = trigger?.getAttribute("aria-label") ?? "";
    if (UI_TEXT.zh.trigger.includes(label as (typeof UI_TEXT.zh.trigger)[number])) return "zh";
    if (UI_TEXT.en.trigger.includes(label as (typeof UI_TEXT.en.trigger)[number])) return "en";
    if (UI_TEXT.ja.trigger.includes(label)) return "ja";
    return "unknown";
  }

  scopeKey(): string {
    return this.document.location.hostname;
  }

  /** A shared model-menu label is insufficient: only the normal chat composer is supported. */
  isChatMode(): boolean {
    if (!this.findComposer()) return false;
    const controls = Array.from(this.document.querySelectorAll<HTMLElement>(MODE_CONTROL_SELECTOR))
      .filter((element) => isDomVisible(element) && this.composerModeLabel(element) !== null);
    if (controls.length === 0) return true;
    const selected = controls.filter((element) => element.getAttribute("aria-checked") === "true" ||
      element.getAttribute("aria-selected") === "true" ||
      (element instanceof this.document.defaultView!.HTMLInputElement && element.checked));
    return selected.length > 0 && selected.every((element) => this.composerModeLabel(element) === "chat");
  }

  isComposerModeTarget(target: Element): boolean {
    const control = target.closest(MODE_CONTROL_SELECTOR) ?? target.closest("label")?.control;
    return control instanceof this.document.defaultView!.HTMLElement && this.composerModeLabel(control) !== null;
  }

  private composerModeLabel(control: HTMLElement): "chat" | "work" | null {
    if (control.closest(MESSAGE_SELECTOR + ', [role="menu"]')) return null;
    const labelledBy = (control.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean)
      .map((id) => this.document.getElementById(id)?.textContent ?? "").join(" ");
    const inputLabel = control instanceof this.document.defaultView!.HTMLInputElement
      ? Array.from(control.labels ?? []).map((label) => label.textContent ?? "").join(" ") : "";
    const label = normalizeDisplayName(control.getAttribute("aria-label") || labelledBy || inputLabel || control.textContent || "").toLowerCase();
    return ["聊天", "對話", "chat", "チャット"].includes(label) ? "chat" : ["工作", "work", "ワーク", "作業", "仕事"].includes(label) ? "work" : null;
  }

  findComposer(): HTMLElement | null {
    const language = this.languageWithoutTriggerRecursion();
    const labels = language === "unknown" ? allUiText("composer") : UI_TEXT[language].composer;
    const candidates = Array.from(
      this.document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"], textarea[aria-label]')
    ).filter((element) => labels.includes(element.getAttribute("aria-label") ?? "") && isDomVisible(element));
    return candidates.length === 1 ? candidates[0] : null;
  }

  findModelTrigger(): HTMLElement | null {
    if (!this.isChatMode()) return null;
    const language = this.languageWithoutTriggerRecursion();
    const labels = language === "unknown" ? allUiText("trigger") : UI_TEXT[language].trigger;
    const candidates = Array.from(
      this.document.querySelectorAll<HTMLElement>('[aria-haspopup="menu"][aria-label]')
    ).filter((element) => labels.includes(element.getAttribute("aria-label") ?? "") && isDomVisible(element));
    return candidates.length === 1 ? candidates[0] : null;
  }

  activeMain(composer = this.findComposer()): HTMLElement | null {
    return composer?.closest<HTMLElement>("main") ?? null;
  }

  isNewChatTarget(target: Element): boolean {
    const control = target.closest('button, a, [role="button"]');
    if (!control) return false;
    const label = normalizeDisplayName(control.getAttribute("aria-label") || control.textContent || "");
    return allUiText("newChat").includes(label);
  }

  isNativeModelTarget(target: Element): boolean {
    const trigger = this.findModelTrigger();
    return Boolean(trigger?.contains(target) || this.findMenu(trigger)?.contains(target));
  }

  isNativeEffortTarget(target: Element): boolean {
    const menu = this.findMenu();
    const control = target.closest<HTMLElement>('[role="menuitem"][data-reasoning-slider="true"]');
    const labels = allUiText("effort");
    return Boolean(menu && control && menu.contains(control) &&
      labels.includes(control.getAttribute("aria-label") ?? "") && this.isHitTestable(control));
  }

  findMenu(trigger = this.findModelTrigger()): HTMLElement | null {
    const activeTrigger = this.findModelTrigger();
    if (!activeTrigger || (trigger?.isConnected && trigger !== activeTrigger)) return null;
    trigger = activeTrigger;
    if (!trigger || trigger.getAttribute("aria-expanded") !== "true") return null;
    const triggerId = trigger.id;
    const controlledId = trigger.getAttribute("aria-controls");
    if (!triggerId || !controlledId) return null;
    const menu = this.document.getElementById(controlledId);
    if (!(menu instanceof this.document.defaultView!.HTMLElement) || menu.getAttribute("role") !== "menu") {
      return null;
    }
    const labelledBy = (menu.getAttribute("aria-labelledby") ?? "").split(/\s+/u);
    if (!labelledBy.includes(triggerId) || !isDomVisible(menu)) return null;
    return menu;
  }

  menuView(menu: HTMLElement): MenuView {
    menu = this.liveMenu(menu);
    if (this.findMenu() !== menu) return "unknown";
    const language = this.language();
    const labels = language === "unknown" ? allUiText("effort") : UI_TEXT[language].effort;
    const effortControls = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"][data-reasoning-slider="true"]'))
      .filter((element) => labels.includes(element.getAttribute("aria-label") ?? "") && this.isHitTestable(element));
    const modelOptions = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .filter((element) => this.isHitTestable(element));

    if (effortControls.length > 0 && modelOptions.length === 0) return "effort";
    if (modelOptions.length > 0 && effortControls.length === 0) return "models";
    if (effortControls.length > 0 || modelOptions.length > 0) return "ambiguous";
    return "unknown";
  }

  readModelOptions(menu: HTMLElement): ModelMenuOption[] {
    menu = this.liveMenu(menu);
    if (this.menuView(menu) !== "models") return [];
    return this.extractModelOptions(menu, false);
  }

  /** Read retained native rows without making them eligible for an active click. */
  readRetainedModelOptions(menu: HTMLElement): ModelMenuOption[] {
    menu = this.liveMenu(menu);
    if (this.findMenu() !== menu || this.menuView(menu) !== "effort") return [];
    return this.extractModelOptions(menu, true);
  }

  private extractModelOptions(menu: HTMLElement, includeRetained: boolean): ModelMenuOption[] {
    const elements = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .filter((element) => includeRetained || this.isHitTestable(element));
    const options: ModelMenuOption[] = [];
    const ids = new Set<string>();
    const ambiguousIds = new Set<string>();

    for (const element of elements) {
      const label = normalizeDisplayName(element.innerText || element.textContent || "");
      if (!label) continue;
      const id = modelIdFromDisplayName(label);
      if (ids.has(id)) {
        ambiguousIds.add(id);
        continue;
      }
      ids.add(id);

      const ariaChecked = element.getAttribute("aria-checked");
      const dataSelected = element.getAttribute("data-model-selected");
      const selected = ariaChecked === "true" || dataSelected === "true"
        ? true
        : ariaChecked === "false" && dataSelected !== "true"
          ? false
          : null;
      if ((ariaChecked === "true" && dataSelected === "false") || (ariaChecked === "false" && dataSelected === "true")) {
        ambiguousIds.add(id);
      }

      const disabled = element.getAttribute("aria-disabled") === "true" ||
        ("disabled" in element && Boolean((element as HTMLButtonElement).disabled));
      options.push({
        id,
        label,
        selected,
        availability: disabled ? "disabled" : "available",
        element
      });
    }

    const trustedOptions = options.filter((option) => !ambiguousIds.has(option.id));
    return trustedOptions;
  }

  currentModel(menu: HTMLElement): ModelMenuOption | null {
    const options = this.readModelOptions(menu);
    const selected = options.filter((option) => option.selected === true);
    return selected.length === 1 ? selected[0] : null;
  }

  readEffort(menu: HTMLElement): EffortReading | null {
    menu = this.liveMenu(menu);
    if (this.menuView(menu) !== "effort") return null;
    const language = this.language();
    const labels = language === "unknown" ? allUiText("effort") : UI_TEXT[language].effort;
    const controls = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"][data-reasoning-slider="true"]'))
      .filter((element) => labels.includes(element.getAttribute("aria-label") ?? "") && this.isHitTestable(element));
    if (controls.length !== 1) return null;

    const control = controls[0];
    const thumb = control.querySelector<HTMLElement>('[role="slider"][aria-valuenow]');
    if (!thumb) return null;
    const min = toFiniteInt(thumb.getAttribute("aria-valuemin"));
    const max = toFiniteInt(thumb.getAttribute("aria-valuemax"));
    const value = toFiniteInt(thumb.getAttribute("aria-valuenow"));
    if (min === null || max === null || value === null || max < min || max - min > 12 || value < min || value > max) {
      return null;
    }

    const statusText = this.readEffortStatus(control, menu);
    if (!statusText) return null;
    const parsed = parseEffortStatus(statusText);
    if (!parsed || parsed.total !== max - min + 1 || parsed.index !== value - min + 1) return null;

    const title = control.getAttribute("aria-label") ?? "";
    const ordered = labels.includes(title) && !/\bauto(?:matic)?\b|自动|自動/iu.test(parsed.label);
    const trigger = this.findModelTrigger();
    const rawNativeId = trigger && this.findMenu(trigger) === menu
      ? trigger.getAttribute("data-selected-reasoning-effort")?.trim() ?? ""
      : "";
    const nativeId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(rawNativeId) ? rawNativeId : null;
    return {
      nativeId,
      label: parsed.label,
      index: parsed.index,
      total: parsed.total,
      min,
      max,
      value,
      ordered,
      control,
      statusText
    };
  }

  readPageSnapshot(): ChatPageSnapshot {
    const language = this.language();
    const composer = this.findComposer();
    const modelTrigger = this.findModelTrigger();
    const main = this.activeMain(composer);
    const messageCount = main?.querySelectorAll(MESSAGE_SELECTOR).length ?? 0;
    const pathname = this.document.location.pathname;
    const hasHomeHeading = main && Array.from(main.querySelectorAll("h1, h2"))
      .some((heading) => {
        // Native splash headlines rotate their greeting without changing this semantic marker.
        if (isDomVisible(heading as HTMLElement) && heading.querySelector('[data-headline]')) return true;
        const labels = language === "unknown" ? allUiText("homeHeadings") : UI_TEXT[language].homeHeadings;
        return labels.includes(normalizeDisplayName(heading.textContent ?? "") as never);
      });
    let kind: ChatPageKind = "unknown";
    if (!composer || !modelTrigger) {
      kind = "unsupported";
    } else if (/^\/c\//u.test(pathname) && messageCount > 0) {
      kind = "history";
    } else if (pathname === "/" && hasHomeHeading && messageCount === 0) {
      // An unsent draft does not relinquish automatic selection for this new conversation.
      kind = "new-empty";
    }

    return {
      kind,
      language,
      scopeKey: this.scopeKey(),
      composer,
      modelTrigger,
      messageCount
    };
  }

  replyGenerationState(snapshot = this.readPageSnapshot()): ReplyGenerationState {
    const main = this.activeMain(snapshot.composer);
    if (!main || !snapshot.composer?.isConnected) return "unknown";
    const labels = Array.from(main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]'))
      .map((element) => normalizeDisplayName(element.getAttribute("aria-label") ?? "").toLowerCase());
    const stopLabels = new Set([
      "stop generating",
      "stop streaming",
      "stop response",
      "stop generating response",
      "停止生成",
      "停止",
      "停止响应",
      "停止流式输出",
      "停止生成响应", "停止回應", "停止串流", "停止產生回應", "停止產生",
      "生成を停止", "応答の生成を停止", "回答の生成を停止", "ストリーミングを停止"
    ]);
    if (labels.some((label) => stopLabels.has(label))) return "running";
    if (snapshot.kind === "new-empty") return "idle";
    const sendLabels = new Set(["send", "send prompt", "send message", "发送", "发送提示", "发送消息", "傳送", "傳送訊息", "傳送提示", "發送", "發送訊息", "送信", "メッセージを送信", "プロンプトを送信"]);
    const sendAvailable = Array.from(main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]'))
      .some((element) => {
        const label = normalizeDisplayName(element.getAttribute("aria-label") ?? "").toLowerCase();
        const disabled = element.getAttribute("aria-disabled") === "true" ||
          ("disabled" in element && Boolean((element as HTMLButtonElement).disabled));
        return sendLabels.has(label) && !disabled;
      });
    if (sendAvailable) return "idle";
    // This native layout replaces Send with Start voice when an idle composer is empty.
    // A completed assistant turn provides positive evidence; absence of Stop alone does not.
    const turns = Array.from(main.querySelectorAll<HTMLElement>(CONVERSATION_REGION + ' [data-talvt-turn-state]'));
    const lastTurn = turns.at(-1);
    const composerEnabled = snapshot.composer.getAttribute("aria-disabled") !== "true" &&
      !("disabled" in snapshot.composer && Boolean((snapshot.composer as HTMLTextAreaElement).disabled));
    if (snapshot.kind === "history" && composerEnabled && lastTurn?.getAttribute("data-talvt-turn-state") === "complete" &&
      lastTurn.querySelector('[data-conversation-role="assistant"]')) return "idle";
    return "unknown";
  }

  async ensureMenuOpen(trigger: HTMLElement, guard: InteractionGuard, timeoutMs = 800): Promise<HTMLElement | null> {
    if (!guard.isCurrent()) return null;
    const disabled = trigger.getAttribute("aria-disabled") === "true" ||
      ("disabled" in trigger && Boolean((trigger as HTMLButtonElement).disabled));
    if (disabled) return null;
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    return this.waitForMenu(trigger, guard, timeoutMs);
  }

  async settlePageInput(guard: InteractionGuard): Promise<boolean> {
    // Let native outside-click handlers and their focus/render updates finish first.
    for (let frame = 0; frame < 2; frame += 1) {
      await nextFrame(this.document);
      if (!guard.isCurrent()) return false;
    }
    return true;
  }

  async showModelList(menu: HTMLElement, guard: InteractionGuard, timeoutMs = 1800): Promise<boolean> {
    const started = Date.now();
    while (guard.isCurrent() && Date.now() - started <= timeoutMs) {
      menu = this.liveMenu(menu);
      const view = this.menuView(menu);
      if (view === "models") return true;
      if (view === "effort") {
        const currentLanguage = this.language();
        const labels = currentLanguage === "unknown" ? allUiText("selectModel") : UI_TEXT[currentLanguage].selectModel;
        const candidates = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .filter((element) => labels.includes(normalizeDisplayName(element.getAttribute("aria-label") || element.innerText || element.textContent || "")) && this.isHitTestable(element));
        if (candidates.length === 1 && guard.isCurrent()) {
          candidates[0].click();
          return this.waitForView(menu, "models", guard, Math.max(0, timeoutMs - (Date.now() - started)));
        }
      }
      // Native portal animation can start after initial readiness was confirmed.
      // Keep the same bounded task; never click through a temporarily hidden view.
      await nextFrame(this.document);
    }
    return false;
  }

  async showEffortControl(menu: HTMLElement, guard: InteractionGuard, timeoutMs = 1800): Promise<boolean> {
    const started = Date.now();
    while (guard.isCurrent() && Date.now() - started <= timeoutMs) {
      menu = this.liveMenu(menu);
      const view = this.menuView(menu);
      if (view === "effort") return true;
      if (view === "models") {
        const selected = this.currentModel(menu);
        if (!selected) return false;
        if (!guard.isCurrent()) return false;
        selected.element.click();
        return this.waitForView(menu, "effort", guard, Math.max(0, timeoutMs - (Date.now() - started)));
      }
      await nextFrame(this.document);
    }
    return false;
  }

  async selectModel(menu: HTMLElement, modelId: string, guard: InteractionGuard, timeoutMs = 700): Promise<boolean> {
    if (!guard.isCurrent() || !(await this.showModelList(menu, guard))) return false;
    const candidates = this.readModelOptions(menu).filter((option) => option.id === modelId);
    if (candidates.length !== 1 || candidates[0].availability !== "available") return false;
    if (candidates[0].selected === true) return this.currentModel(menu)?.id === modelId;
    if (!guard.isCurrent()) return false;
    candidates[0].element.click();
    const returnedToEffort = await this.waitForView(menu, "effort", guard, timeoutMs);
    if (!returnedToEffort || !guard.isCurrent()) return false;
    if (!(await this.showModelList(menu, guard, timeoutMs))) return false;
    const selected = this.currentModel(menu);
    if (selected?.id !== modelId || !guard.isCurrent()) return false;
    return this.showEffortControl(menu, guard, timeoutMs);
  }

  async setEffortIndex(
    menu: HTMLElement,
    targetIndex: number,
    guard: InteractionGuard,
    timeoutMs = 900
  ): Promise<boolean> {
    if (!guard.isCurrent() || !(await this.showEffortControl(menu, guard))) return false;
    let current = this.readEffort(menu);
    if (!current || targetIndex < 1 || targetIndex > current.total) return false;
    if (current.index === targetIndex) return true;

    for (let attempt = 0; current.index !== targetIndex && attempt < 12; attempt += 1) {
      if (!guard.isCurrent()) return false;
      const view = this.document.defaultView;
      if (!view) return false;
      current.control.focus({ preventScroll: true });
      // Native focus can update the slider subtree. Use the fresh control after that render.
      await nextFrame(this.document);
      if (!guard.isCurrent()) return false;
      const focused = this.readEffort(menu);
      if (!focused) return false;
      current = focused;
      if (current.index === targetIndex) return true;
      const oldIndex = current.index;
      const key = targetIndex > oldIndex ? "ArrowRight" : "ArrowLeft";
      current.control.dispatchEvent(new view.KeyboardEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true
      }));
      current.control.dispatchEvent(new view.KeyboardEvent("keyup", {
        key,
        code: key,
        bubbles: true,
        cancelable: true
      }));

      current = await this.waitForEffortChange(menu, oldIndex, guard, timeoutMs);
      if (!current) return false;
    }

    return guard.isCurrent() && current.index === targetIndex;
  }

  async enumerateEfforts(
    menu: HTMLElement,
    guard: InteractionGuard,
    timeoutMs = 900
  ): Promise<EffortOption[] | null> {
    if (!guard.isCurrent() || !(await this.showEffortControl(menu, guard))) return null;
    const original = this.readEffort(menu);
    if (!original || original.total > 12) return null;

    const readings: EffortReading[] = [];
    let completed = false;
    try {
      for (let index = 1; index <= original.total; index += 1) {
        if (!guard.isCurrent()) return null;
        if (!(await this.setEffortIndex(menu, index, guard, timeoutMs))) return null;
        const reading = this.readEffort(menu);
        if (!reading || reading.index !== index || reading.total !== original.total) return null;
        readings.push(reading);
      }
      completed = true;
    } finally {
      if (guard.isCurrent()) {
        const now = this.readEffort(menu);
        if (now && now.index !== original.index) await this.setEffortIndex(menu, original.index, guard, timeoutMs);
      }
    }

    if (!completed || !guard.isCurrent() || readings.length !== original.total) return null;
    const allStrengthOrdered = original.ordered && readings.every((reading) => reading.ordered);
    const hasDistinctNativeIds = readings.every((reading) => reading.nativeId !== null) &&
      new Set(readings.map((reading) => reading.nativeId)).size === readings.length;
    return readings.map((reading) => ({
      id: hasDistinctNativeIds ? "native:" + reading.nativeId : effortIdFromLabel(reading.label),
      label: reading.label,
      ordering: allStrengthOrdered ? "strength" : "non-ordered",
      order: allStrengthOrdered ? reading.index - 1 : null,
      disabled: false
    }));
  }

  toModelCapability(option: ModelMenuOption, efforts: EffortOption[] = []): ModelCapability {
    return {
      id: option.id,
      label: option.label,
      availability: option.availability,
      effortState: efforts.length > 0 ? "observed" : "not-read",
      efforts
    };
  }

  private languageWithoutTriggerRecursion(): UiLanguage {
    const documentLanguage = this.document.documentElement.lang.trim().toLowerCase();
    if (documentLanguage.startsWith("zh")) return "zh";
    if (documentLanguage.startsWith("en")) return "en";
    if (documentLanguage.startsWith("ja")) return "ja";
    return "unknown";
  }

  private readEffortStatus(control: HTMLElement, menu: HTMLElement): string | null {
    const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);
    const described = ids.map((id) => this.document.getElementById(id)).filter((el): el is HTMLElement =>
      el instanceof this.document.defaultView!.HTMLElement && el.getAttribute("role") === "status"
    );
    const candidates = described.length > 0
      ? described
      : Array.from(menu.querySelectorAll<HTMLElement>('[role="status"]'));
    const texts = candidates
      .filter(isDomVisible)
      .map((element) => normalizeDisplayName(element.innerText || element.textContent || ""))
      .filter(Boolean);
    return texts.find((text) => parseEffortStatus(text)) ?? null;
  }

  private async waitForMenu(
    trigger: HTMLElement,
    guard: InteractionGuard,
    timeoutMs: number
  ): Promise<HTMLElement | null> {
    const started = Date.now();
    let readyMenu: HTMLElement | null = null;
    let samples = 0;
    while (guard.isCurrent() && Date.now() - started <= timeoutMs) {
      const menu = this.findMenu(this.findModelTrigger() ?? trigger);
      const view = menu ? this.menuView(menu) : "unknown";
      samples += 1;
      this.menuReadinessDiagnostic = "associated:" + Boolean(menu) + ";view:" + view + ";samples:" + samples + ";elapsed:" + (Date.now() - started);
      if (menu && (view === "models" || view === "effort")) {
        // A mounted portal can still be animating and have no hit-testable controls.
        // Confirm an actionable view across frames before issuing the next click.
        if (readyMenu === menu) return menu;
        readyMenu = menu;
      } else readyMenu = null;
      await nextFrame(this.document);
    }
    return null;
  }

  private async waitForView(
    menu: HTMLElement,
    expected: "models" | "effort",
    guard: InteractionGuard,
    timeoutMs: number
  ): Promise<boolean> {
    const started = Date.now();
    let ready = false;
    while (guard.isCurrent() && Date.now() - started <= timeoutMs) {
      menu = this.liveMenu(menu);
      if (!menu.isConnected) return false;
      if (this.menuView(menu) === expected) {
        if (ready) return true;
        ready = true;
      } else ready = false;
      await nextFrame(this.document);
    }
    return false;
  }

  private async waitForEffortChange(
    menu: HTMLElement,
    previousIndex: number,
    guard: InteractionGuard,
    timeoutMs: number
  ): Promise<EffortReading | null> {
    const started = Date.now();
    let candidate: EffortReading | null = null;
    while (guard.isCurrent() && Date.now() - started <= timeoutMs) {
      const reading = this.readEffort(menu);
      if (reading && reading.index !== previousIndex) {
        if (candidate?.index === reading.index && candidate.label === reading.label && candidate.nativeId === reading.nativeId && candidate.total === reading.total) return reading;
        candidate = reading;
      } else candidate = null;
      await nextFrame(this.document);
    }
    return null;
  }

  private liveMenu(menu: HTMLElement): HTMLElement {
    return menu.isConnected ? menu : this.findMenu() ?? menu;
  }
}

export function normalizeDisplayName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function modelIdFromDisplayName(label: string): string {
  return `label:${normalizeDisplayName(label)}`;
}

export function effortIdFromLabel(label: string): string {
  return `label:${normalizeDisplayName(label)}`;
}

/** Verify the semantic reading as well as the slider position cached for this model. */
export function matchesEffortOption(
  reading: EffortReading | null,
  target: EffortOption,
  targetIndex: number,
  expectedTotal: number
): boolean {
  if (!reading || reading.index !== targetIndex || reading.total !== expectedTotal) return false;
  if (target.id.startsWith("native:")) {
    if (reading.nativeId !== target.id.slice("native:".length)) return false;
  } else if (normalizeDisplayName(reading.label) !== normalizeDisplayName(target.label)) return false;
  return target.ordering !== "strength" || target.order === reading.index - 1;
}

export function parseEffortStatus(value: string): { label: string; index: number; total: number } | null {
  const chinese = /第\s*(\d+)\s*[项項]\s*[,，]\s*共\s*(\d+)\s*[项項]/u.exec(value);
  const english = /\b(\d+)\s*of\s*(\d+)\b/iu.exec(value);
  const japanese = /(?:全)?(\d+)\s*(?:項目|個|つ)?\s*中(?:の)?\s*(\d+)\s*(?:番目|項目|個|つ)?/u.exec(value);
  const fraction = /(\d+)\s*\/\s*(\d+)/u.exec(value);
  const match = chinese ?? english ?? japanese ?? fraction;
  if (!match) return null;
  const index = Number.parseInt(match === japanese ? match[2] : match[1], 10);
  const total = Number.parseInt(match === japanese ? match[1] : match[2], 10);
  const label = normalizeDisplayName(value.slice(0, match.index).replace(/[,，、.。\s]+$/u, ""));
  if (!label || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1 || index > total) {
    return null;
  }
  return { label, index, total };
}

function isDomVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  if (view.getComputedStyle(element).opacity === "0") return false;
  // SPA navigation retains previous pages under display:none ancestors.
  // The child's computed display remains visible, so inspect its full ancestor chain.
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
      style.contentVisibility === "hidden") return false;
  }
  return true;
}

function isTopmostAtCenter(element: HTMLElement, document: Document): boolean {
  if (!isDomVisible(element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && (hit === element || element.contains(hit)));
}

function toFiniteInt(value: string | null): number | null {
  if (value === null || !/^-?\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nextFrame(document: Document): Promise<void> {
  const view = document.defaultView;
  if (!view) return Promise.resolve();
  return new Promise((resolve) => {
    // A background tab can suspend animation callbacks; keep every wait bounded.
    let settled = false;
    let frame: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      view.clearTimeout(timer);
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      resolve();
    };
    const timer = view.setTimeout(finish, 32);
    if (typeof view.requestAnimationFrame === "function") frame = view.requestAnimationFrame(finish);
  });
}
