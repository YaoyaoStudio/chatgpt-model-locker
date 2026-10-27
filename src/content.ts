import {
  emptyCapabilities,
  emptyPreferences,
  preferencesEqual,
  type CapabilitiesCache,
  type CapabilitiesSnapshot,
  type EffortOption,
  type ModelCapability,
  type Preferences
} from "./domain.js";
import {
  ChatGPTAdapter,
  matchesEffortOption,
  type ChatPageSnapshot,
  type ModelMenuOption
} from "./chatgpt-adapter.js";
import { OperationCancelledError, OperationQueue, type OperationContext, type OperationKind } from "./operation-queue.js";
import {
  loadStorage,
  mergeAndSaveCapabilities,
  savePageTheme,
  savePreferences,
  saveLanguageSettings,
  subscribeToStorageChanges
} from "./storage.js";
import { mutationTouchesPageTheme, pageThemesEqual, readPageTheme, resolveThemeId, type PageTheme } from "./page-theme.js";
import { EFFORT_EFFECTS_CSS, EffortEffects } from "./effort-effects.js";
import { emptyLanguageSettings, isDisplayLanguage, LANGUAGE_OPTIONS, resolveDisplayLanguage, type DisplayLanguage } from "./language-settings.js";
import { MESSAGES, type MessageKey, type Messages } from "./i18n.js";
import { englishEffortLabel, localizedEffortLabel } from "./effort-labels.js";

const ROOT_FLAG = "__chatgptDefaultModelEffortExtension";
const REFRESH_TIMEOUT_MS = 1800;
const MENU_OPEN_TIMEOUT_MS = 5000;
const AUTOMATIC_MENU_RETRY_DELAY_MS = 1000;
const HOST_HIDE_DELAY_MS = 1450;
const CAPABILITY_SCOPE_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const NATIVE_ADJUSTMENT_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " "]);

type StatusTone = "quiet" | "working" | "success" | "warning";

interface CurrentPageSelection {
  modelId: string;
  modelLabel: string;
  effortLabel: string | null;
}

class ExtensionController {
  private readonly adapter = new ChatGPTAdapter(document);
  private readonly operations = new OperationQueue();
  private readonly effortEffects = new EffortEffects(document);
  private readonly host = document.createElement("div");
  private readonly shadow: ShadowRoot;
  private readonly bubble: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly observer: MutationObserver;
  private readonly removeStorageListener: () => void;
  private preferences: Preferences = emptyPreferences();
  private languageSettings = emptyLanguageSettings();
  private languageSaveGeneration = 0;
  private capabilities: CapabilitiesCache = emptyCapabilities();
  private pageTheme: PageTheme | null = null;
  private savedPageTheme: PageTheme | null = null;
  private currentPageSelection: CurrentPageSelection | null = null;
  private storageReady = false;
  private panelOpen = false;
  private panelView: "main" | "settings" = "main";
  private modelMenuOpen = false;
  private languageMenuOpen = false;
  private modelSearch = "";
  private modelSearchAt = 0;
  private panelStructureKey = "";
  private modelOptionsKey = "";
  private pendingRange: HTMLInputElement | null = null;
  private rangeBinding: { input: HTMLInputElement; options: EffortOption[] } | null = null;
  private currentSnapshot: ChatPageSnapshot = this.adapter.readPageSnapshot();
  private pageBase = "";
  private pagePath = "";
  private pageComposer: HTMLElement | null = null;
  private navigationRequested = false;
  private autoScheduleTimer: number | null = null;
  private pageEpoch = 0;
  private pageAutoScheduled = -1;
  private takenOverEpoch = -1;
  private pendingAutomaticApplyEpoch = -1;
  private automaticApplyGeneration = 0;
  private deferredAutomaticApplyEpoch = -1;
  private preferenceSaveGeneration = 0;
  private statusTone: StatusTone = "quiet";
  private toolbarBusy = false;
  private statusKey: MessageKey | null = null;
  private statusSelection: { modelLabel: string; effortLabel?: string } | null = null;
  private updateTimer: number | null = null;
  private hostHideTimer: number | null = null;
  private positionTimer: number | null = null;
  private nativeEnforcementTimer: number | null = null;
  private passiveReadTimer: number | null = null;
  private themeReadTimer: number | null = null;

  constructor() {
    this.host.id = "chatgpt-default-model-effort-host";
    this.host.dataset.build = "20261026-automatic-menu-retry-once";
    this.host.style.display = "none";
    this.host.style.position = "fixed";
    this.host.style.zIndex = "2147483647";
    this.host.style.top = "12px";
    this.host.style.left = "12px";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = this.createShellMarkup();
    this.bubble = this.shadow.querySelector<HTMLButtonElement>("[data-role='bubble']")!;
    this.panel = this.shadow.querySelector<HTMLElement>("[data-role='panel']")!;
    this.panelBody = this.shadow.querySelector<HTMLElement>("[data-role='panel-body']")!;
    this.statusLine = this.shadow.querySelector<HTMLElement>("[data-role='status']")!;
    this.bubble.addEventListener("click", () => this.setPanelOpen(!this.panelOpen));
    this.panel.addEventListener("click", (event) => this.onPanelClick(event));
    this.panel.addEventListener("change", (event) => void this.onPanelChange(event));
    this.panel.addEventListener("input", (event) => this.onPanelInput(event));
    this.panel.addEventListener("focusout", () => window.setTimeout(() => {
      if (this.modelMenuOpen && !this.shadow.activeElement?.closest(".model-picker")) this.closeModelMenu();
      if (this.languageMenuOpen && !this.shadow.activeElement?.closest(".language-picker")) this.closeLanguageMenu();
      if (this.pendingRange && this.shadow.activeElement !== this.pendingRange) this.pendingRange = null;
      this.renderPanel();
    }, 0));
    this.panel.addEventListener("scroll", () => {
      this.positionModelMenu();
      this.positionLanguageMenu();
    }, true);
    this.shadow.addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (this.onLanguagePickerKeydown(keyboardEvent)) return;
      if (this.onModelPickerKeydown(keyboardEvent)) return;
      if (keyboardEvent.key === "Escape" && this.panelOpen) {
        keyboardEvent.preventDefault();
        if (this.panelView === "settings") this.setPanelView("main");
        else this.setPanelOpen(false);
      }
    });

    this.removeStorageListener = subscribeToStorageChanges((changes) => {
      if (changes.languageSettings) {
        this.languageSettings = changes.languageSettings.value;
        this.languageSaveGeneration += 1;
        this.renderPanel();
      }
      if (changes.preferences?.kind === "valid" && !preferencesEqual(this.preferences, changes.preferences.value)) {
        this.preferences = changes.preferences.value;
        this.pendingRange = null;
        this.operations.preferencesChanged();
        this.resetAutomaticSchedule();
        this.renderPanel();
        this.schedulePageUpdate(0);
      }
      if (changes.capabilities?.kind === "valid") {
        this.capabilities = changes.capabilities.value;
        this.renderPanel();
      }
      if (changes.pageTheme?.kind === "valid" && changes.pageTheme.value?.scopeKey === this.adapter.scopeKey()) {
        this.savedPageTheme = changes.pageTheme.value;
        this.applyPageTheme(readPageTheme(document) ?? changes.pageTheme.value);
      }
    });

    this.observer = new MutationObserver((records) => {
      if (!this.host.isConnected) this.schedulePageUpdate(0);
      else if (records.some((record) => this.mutationMayChangePageState(record))) {
        // Start/cancel the visibility grace period at detection, independently of page debounce.
        this.syncHostVisibility();
        this.schedulePageUpdate();
      }
      if (records.some((record) => this.adapter.mutationTouchesModelMenu(record))) this.schedulePassiveRead();
      if (records.some((record) => mutationTouchesPageTheme(record, document))) this.scheduleThemeRead();
    });
    if (document.documentElement) {
      this.observer.observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "aria-expanded", "aria-checked", "aria-selected", "checked", "aria-valuenow", "href", "data-talvt-turn-state", "style", "class", "data-theme", "hidden", "aria-hidden", "inert", "disabled", "aria-disabled"]
      });
    }
    document.addEventListener("click", (event) => this.onDocumentClick(event), true);
    document.addEventListener("pointerdown", (event) => this.onDocumentPointerDown(event), true);
    document.addEventListener("input", (event) => this.onDocumentInput(event), true);
    document.addEventListener("keydown", (event) => this.onDocumentKeydown(event), true);
    window.addEventListener("popstate", () => {
      this.navigationRequested = true;
      this.schedulePageUpdate();
    });
    window.addEventListener("hashchange", () => this.schedulePageUpdate());
    document.addEventListener("visibilitychange", () => {
      this.syncEffortEffectsVisibility();
      this.schedulePageUpdate(0);
    });
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLLinkElement && event.target.relList.contains("stylesheet")) this.scheduleThemeRead();
    }, true);
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => this.scheduleThemeRead());
    window.addEventListener("languagechange", () => this.renderPanel());
    window.addEventListener("resize", () => this.positionHost());
    window.addEventListener("scroll", () => this.positionHost(), true);

    if (document.body) document.body.append(this.host);
    this.positionHost();
    this.syncPage();
    void this.initializeStorage();
  }

  private createShellMarkup(): string {
    return "<style>" +
      ":host{all:initial;--extension-accent:#10a37f;--extension-accent-text:#0d866b;--extension-on-accent:#ffffff;color:#202123;font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
      "*{box-sizing:border-box}.bubble{width:46px;height:46px;border:1px solid #ffffff88;border-radius:50%;background:#202123;color:white;opacity:.58;box-shadow:0 3px 14px #0003;cursor:pointer;transition:opacity .15s,transform .15s;font-weight:700;font-size:12px;letter-spacing:-.4px}.bubble:hover,.bubble:focus-visible{opacity:1;transform:scale(1.04);outline:2px solid var(--extension-accent);outline-offset:2px}" +
      ".panel{position:absolute;top:54px;left:0;width:min(328px,calc(100vw - 24px));max-height:min(74vh,640px);overflow:auto;border:1px solid #0002;border-radius:14px;background:#fff;color:#202123;box-shadow:0 12px 40px #0003;padding:14px;display:none}.panel[data-open='true']{display:block}.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.title{font-size:15px;font-weight:650}.close{border:0;background:transparent;color:#666;font-size:20px;line-height:1;cursor:pointer}.field{display:grid;gap:6px;margin:12px 0}.label{font-size:12px;font-weight:600;color:#444}.select{width:100%;min-height:38px;border:1px solid #0002;border-radius:9px;background:#fff;padding:7px 9px;color:inherit;font:inherit}#default-model-select{width:calc(100% - 20px)}.toolbar{display:flex;gap:8px;align-items:center;margin-top:14px}.button{border:1px solid #0002;border-radius:9px;padding:8px 10px;background:#fff;color:inherit;font:inherit;cursor:pointer}.button.primary{background:var(--extension-accent);color:var(--extension-on-accent);border-color:var(--extension-accent)}.button:disabled{opacity:.6;cursor:wait}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0;width:calc(100% - 20px)}.toggle{position:relative;flex:none;width:28px;height:16px;margin:0;padding:0;border:0;border-radius:999px;appearance:none;-webkit-appearance:none;background:#b0b0b0;cursor:pointer;transition:background-color 150ms ease}.toggle:before{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform 150ms cubic-bezier(.2,.8,.2,1)}.toggle:checked{background:var(--extension-accent)}.toggle:checked:before{transform:translateX(12px)}.toggle:focus-visible{outline:2px solid var(--extension-accent);outline-offset:3px}.hint{color:#6b6b6b;font-size:11px;margin-top:5px}.hint.cache-info{font-size:9px;line-height:1.35;margin-top:4px}.status{margin-top:8px;min-height:14px;color:#646464;font-size:9px;line-height:1.35}.status[data-tone='success']{color:#13795b}.status[data-tone='warning']{color:#a15c00}.status[data-tone='working']{color:#555}.empty{border-radius:9px;background:#f6f6f6;padding:10px;color:#666;font-size:12px}.footer{border-top:1px solid #0001;margin-top:8px;padding-top:6px;color:#777;font-size:9px;line-height:1.35}" +
      ".effort-card{--effort-accent:var(--extension-accent);--effort-rest:color-mix(in srgb,var(--extension-accent) 18%,#fff);width:calc(100% - 20px);display:grid;gap:12px;padding:11px 12px 12px;border:1px solid #dedee3;border-radius:18px;background:#fff;box-shadow:0 4px 12px #00000005}.range-value{display:block;min-width:0;text-align:center;font-size:16px;line-height:1.35;font-weight:600;color:var(--extension-accent-text)}.range-shell{position:relative;height:32px;min-width:0}.range-track{position:absolute;inset:4px 0;height:24px;border-radius:999px;background:var(--effort-rest);overflow:hidden;pointer-events:none}.range-fill{position:absolute;inset:0 auto 0 0;width:var(--range-progress);border-radius:inherit;background:var(--effort-accent);transition:width 220ms cubic-bezier(.2,.8,.2,1)}.range-dots{position:absolute;inset:0 14px}.range-dot{position:absolute;top:50%;width:4px;height:4px;border-radius:50%;background:color-mix(in srgb,var(--effort-accent) 55%,var(--effort-rest));transform:translate(-50%,-50%);transition:background-color 160ms ease,transform 150ms ease}.range-dot[data-passed='true']{background:#ffffff65}.range-dot[data-hovered='true']{transform:translate(-50%,-50%) scale(1.5)}" +
      ".range-thumb{position:absolute;z-index:1;top:50%;left:var(--range-progress);width:28px;height:28px;border:1px solid #e1e1e6;border-radius:50%;background:#fff;box-shadow:0 1px 4px #00000012;transform:translate(-50%,-50%);pointer-events:none;transition:left 220ms cubic-bezier(.2,.8,.2,1),transform 150ms ease}.effort-card:hover .range-thumb,.effort-card:has(.range:focus-visible) .range-thumb{transform:translate(-50%,-50%) scale(1.08)}.range{position:absolute;z-index:2;inset:0;width:100%;height:32px;margin:0;padding:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer;border:0;border-radius:999px;outline:none}.range::-webkit-slider-runnable-track{height:24px;border:0;border-radius:999px;background:transparent}.range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:28px;height:28px;margin-top:-2px;border:0;border-radius:50%;background:transparent}.range::-moz-range-track{height:24px;border:0;border-radius:999px;background:transparent}.range::-moz-range-thumb{box-sizing:border-box;width:28px;height:28px;border:0;border-radius:50%;background:transparent}.range:focus-visible{outline:2px solid var(--effort-accent);outline-offset:3px}@media(prefers-reduced-motion:reduce){.range-thumb,.range-fill,.range-dot,.toggle,.toggle:before{transition:none}}" +
      ".model-picker{position:relative;width:calc(100% - 20px);min-width:0}.model-picker #default-model-select{display:block;width:100%;padding-right:36px;appearance:none;-webkit-appearance:none;pointer-events:none}.model-trigger{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;width:100%;padding:0 11px;border:0;border-radius:9px;background:transparent;color:inherit;cursor:pointer}.model-trigger:focus-visible{outline:2px solid var(--extension-accent);outline-offset:2px}.model-chevron{display:block;flex:none;width:16px;height:16px;color:inherit}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}" +
      ".language-picker{position:relative;width:calc(100% - 20px);min-width:0}.language-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:38px;padding:7px 9px;border:1px solid #0002;border-radius:9px;background:#fff;color:inherit;text-align:left;font:inherit;cursor:pointer}.language-trigger .model-chevron{margin-left:12px}.language-trigger:focus-visible{outline:2px solid var(--extension-accent);outline-offset:2px}.language-trigger:disabled{background:#f2f2f4;color:#999;border-color:#e1e1e5;cursor:not-allowed;opacity:1}@media(prefers-color-scheme:dark){.language-trigger:disabled{background:#303136;color:#85858b;border-color:#ffffff15}}" +
      ".model-menu{position:fixed;inset:auto;margin:0;padding:3px;min-width:0;border:1px solid #c9c9ce;border-radius:16px;background:#fff;color:#202123;box-shadow:0 6px 18px #0000000d;font:inherit;overflow:auto;overscroll-behavior:contain;opacity:0;transform:translateY(-4px);transition:opacity 140ms ease-out,transform 140ms ease-out}.model-menu:popover-open{opacity:1;transform:translateY(0)}@starting-style{.model-menu:popover-open{opacity:0;transform:translateY(-4px)}}.model-option{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:38px;padding:9px 11px;border:0;border-radius:12px;background:transparent;color:inherit;text-align:left;font:inherit;font-size:14px;line-height:1.4;cursor:pointer}.model-option:hover:not(:disabled),.model-option:focus-visible{background:#f4f4f5;outline:none}.model-option:disabled{opacity:.45;cursor:not-allowed}.model-name{min-width:0;overflow-wrap:anywhere}.model-check{display:inline-flex;flex:none;align-items:center;justify-content:center;width:18px;height:18px;color:#555;visibility:hidden}.model-check svg{display:block;width:18px;height:18px}.model-option[aria-selected='true'] .model-check{visibility:visible}" +
      ".hint{white-space:pre-line}[hidden]{display:none!important}.head-title{display:flex;align-items:center;gap:6px;min-width:0}.back{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin-left:-4px;padding:4px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.back svg{display:block;width:20px;height:20px}.back:hover{background:#f2f2f4}.back:focus-visible,.settings-card:focus-visible{outline:2px solid var(--extension-accent);outline-offset:3px}.settings-card{display:flex;align-items:center;gap:10px;width:calc(100% - 20px);min-height:50px;margin:14px 0 0;padding:12px;border:1px solid #dedee3;border-radius:18px;background:#fff;color:inherit;box-shadow:0 4px 12px #00000005;text-align:left;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background-color 150ms ease,border-color 150ms ease}.settings-card:hover{background:#f6f6f8;border-color:#cfcfd6}.settings-icon{display:block;flex:none;width:22px;height:22px}.settings-card-label{flex:1;min-width:0}.settings-arrow{display:block;flex:none;width:16px;height:16px;color:#8b8b90}@media(prefers-reduced-motion:reduce){.settings-card{transition:none}}@media(prefers-color-scheme:dark){.settings-card{background:#303136;border-color:#ffffff22;box-shadow:none}.settings-card:hover,.back:hover{background:#3c3d42}.settings-card:hover{border-color:#ffffff38}.settings-arrow{color:#aaa}}" +
      ".bubble{position:relative}.bubble:after{content:'';position:absolute;right:3px;top:3px;width:8px;height:8px;border-radius:50%;background:#a0a0a0;border:1px solid #fff}.bubble[data-tone='success']:after{background:#24b47e}.bubble[data-tone='working']:after{background:#f3b340}.bubble[data-tone='warning']:after{background:#e55353}" +
      "@media(prefers-reduced-motion:reduce){.model-menu{transition:none}}@media(prefers-color-scheme:dark){.panel{background:#292a2d;color:#f4f4f4;border-color:#ffffff20}.label,.close{color:#ddd}.select,.button,.language-trigger{background:#343539;color:#f4f4f4;border-color:#ffffff22}.model-menu{background:#303136;color:#f4f4f4;border-color:#ffffff30}.model-option:hover:not(:disabled),.model-option:focus-visible{background:#3c3d42}.model-check{color:#ddd}.toggle{background:#686a73}.effort-card{--effort-rest:color-mix(in srgb,var(--extension-accent) 24%,#303136);background:#303136;border-color:#ffffff22;box-shadow:none}.empty{background:#343539;color:#bbb}.footer{border-color:#ffffff18}.hint,.status{color:#aaa}.status[data-tone='success']{color:#65c99b}.status[data-tone='warning']{color:#f2bc68}}" + EFFORT_EFFECTS_CSS + "</style>" +
      "<button class='bubble' data-role='bubble' type='button' aria-label='设置默认模型与推理强度' title='默认模型与推理强度'>GPT</button>" +
      "<section class='panel' data-role='panel' data-open='false' aria-label='默认模型与推理强度设置' aria-hidden='true'>" +
      "<div class='head'><div class='head-title'><button class='back' type='button' data-action='back' hidden aria-label='返回'><svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' focusable='false'><path d='m12.5 4.5-5.5 5.5 5.5 5.5'/></svg></button><div class='title' data-role='title'></div></div><button class='close' type='button' data-action='close' aria-label='关闭'>×</button></div>" +
      "<div data-role='panel-body'></div><div data-role='settings-feedback' hidden><div class='status' data-role='status' role='status' aria-live='polite'></div>" +
      "<div class='footer' data-role='footer'></div></div></section>";
  }

  private async initializeStorage(): Promise<void> {
    try {
      const loaded = await loadStorage();
      this.languageSettings = loaded.languageSettings.value;
      if (loaded.preferences.kind === "valid") this.preferences = loaded.preferences.value;
      if (loaded.capabilities.kind === "valid") this.capabilities = loaded.capabilities.value;
      if (loaded.pageTheme.kind === "valid" && loaded.pageTheme.value?.scopeKey === this.adapter.scopeKey()) {
        this.savedPageTheme = loaded.pageTheme.value;
        if (!this.pageTheme) this.applyPageTheme(loaded.pageTheme.value);
      }
      this.storageReady = true;
      this.refreshPageTheme();
      this.renderPanel();
      this.schedulePageUpdate(0);
    } catch {
      this.storageReady = true;
      this.refreshPageTheme();
      this.setStatus("warning", "storageError");
      this.renderPanel();
    }
  }

  private applyPageTheme(theme: PageTheme): void {
    if (pageThemesEqual(this.pageTheme, theme)) return;
    this.pageTheme = theme;
    this.host.style.setProperty("--extension-accent", theme.accent);
    this.host.style.setProperty("--extension-accent-text", theme.textAccent);
    this.host.style.setProperty("--extension-on-accent", theme.onAccent);
    this.effortEffects.setTheme(resolveThemeId(theme));
  }

  private refreshPageTheme(): void {
    const theme = readPageTheme(document);
    if (!theme) return;
    this.applyPageTheme(theme);
    if (!this.storageReady || pageThemesEqual(this.savedPageTheme, theme)) return;
    this.savedPageTheme = theme;
    void savePageTheme(theme, () => pageThemesEqual(this.pageTheme, theme) && theme.scopeKey === this.adapter.scopeKey())
      .catch(() => {
        if (pageThemesEqual(this.savedPageTheme, theme)) this.savedPageTheme = null;
      });
  }

  private scheduleThemeRead(): void {
    if (this.themeReadTimer !== null) window.clearTimeout(this.themeReadTimer);
    this.themeReadTimer = window.setTimeout(() => {
      this.themeReadTimer = null;
      this.refreshPageTheme();
    }, 120);
  }

  private uiLanguage(): DisplayLanguage {
    let browserUiLanguage = "";
    try { browserUiLanguage = chrome.i18n?.getUILanguage() ?? ""; } catch { /* Older contexts can lose API access. */ }
    return resolveDisplayLanguage(this.languageSettings, [...navigator.languages, navigator.language, browserUiLanguage]);
  }

  private copy(): Messages {
    return MESSAGES[this.uiLanguage()];
  }

  private get statusMessage(): string {
    if (!this.statusKey) return "";
    const text = this.copy()[this.statusKey];
    const selection = this.statusSelection;
    if (!selection) return text;
    return text + " " + selection.modelLabel + (selection.effortLabel
      ? " / " + localizedEffortLabel({ label: selection.effortLabel }, this.uiLanguage()) : "");
  }

  private setPanelOpen(open: boolean): void {
    if (!open) {
      this.closeModelMenu();
      this.closeLanguageMenu();
      this.pendingRange = null;
    }
    if (open && !this.panelOpen) this.panelView = "main";
    this.panelOpen = open;
    this.panel.dataset.open = String(open);
    this.panel.setAttribute("aria-hidden", String(!open));
    if (open) {
      this.renderPanel();
      this.panel.scrollTop = 0;
      this.panelBody.querySelector<HTMLElement>("[data-role='model-trigger'],[data-role='settings-entry']")?.focus({ preventScroll: true });
    } else {
      this.bubble.focus({ preventScroll: true });
    }
    this.syncEffortEffectsVisibility();
  }

  private syncEffortEffectsVisibility(): void {
    this.effortEffects.setVisible(this.panelOpen && this.panelView === "main" && document.visibilityState === "visible" && this.host.style.display !== "none");
  }

  private setPanelView(view: "main" | "settings"): void {
    if (this.panelView === view) return;
    this.closeModelMenu();
    this.closeLanguageMenu();
    this.pendingRange = null;
    this.panelView = view;
    this.renderPanel();
    this.panel.scrollTop = 0;
    const target = view === "settings" ? "[data-action='back']" : "[data-role='settings-entry']";
    this.panel.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  }

  private syncPanelView(): void {
    const settings = this.panelView === "settings";
    this.panel.dataset.view = this.panelView;
    const mainView = this.panelBody.querySelector<HTMLElement>("[data-role='main-view']");
    const settingsView = this.panelBody.querySelector<HTMLElement>("[data-role='settings-view']");
    const feedback = this.shadow.querySelector<HTMLElement>("[data-role='settings-feedback']");
    const back = this.panel.querySelector<HTMLButtonElement>("[data-action='back']");
    if (mainView) mainView.hidden = settings;
    if (settingsView) settingsView.hidden = !settings;
    if (feedback) feedback.hidden = !settings;
    if (back) back.hidden = !settings;
  }

  private getPanelStructureKey(): string {
    const capabilities = this.getCurrentCapabilities();
    const selected = capabilities.models.find((model) => model.id === this.preferences.modelId);
    // Status, timestamps, theme colors and ordered range values update in place.
    return JSON.stringify([this.storageReady, this.uiLanguage(), this.preferences.modelId,
      capabilities.models.length > 0, selected ? [selected.effortState, selected.efforts] : null,
      selected && !this.orderedEfforts(selected)
        ? this.preferences.effortByModel[selected.id] ?? null : null]);
  }

  private renderPanel(forceBody = false): void {
    const copy = this.copy();
    const title = this.shadow.querySelector<HTMLElement>("[data-role='title']");
    const footer = this.shadow.querySelector<HTMLElement>("[data-role='footer']");
    if (title) title.textContent = this.panelView === "settings" ? copy.settings : copy.title;
    if (footer) footer.textContent = copy.footer;
    this.panel.setAttribute("aria-label", this.panelView === "settings" ? copy.settings : copy.title);
    this.panel.querySelector("[data-action='back']")?.setAttribute("aria-label", copy.back);
    this.panel.querySelector("[data-action='close']")?.setAttribute("aria-label", copy.close);
    this.host.lang = this.uiLanguage();
    this.host.translate = false;
    const bubbleLabel = copy.bubbleLabel;
    this.bubble.dataset.tone = this.statusTone;
    this.bubble.title = this.statusMessage ? bubbleLabel + ": " + this.statusMessage : bubbleLabel;
    this.bubble.setAttribute("aria-label", this.bubble.title);
    const editing = this.modelMenuOpen || this.languageMenuOpen || this.pendingRange !== null;
    const structureKey = this.getPanelStructureKey();
    if (this.panelOpen && (forceBody || (!editing && this.panelStructureKey !== structureKey))) {
      const focused = this.shadow.activeElement instanceof HTMLElement && this.panelBody.contains(this.shadow.activeElement)
        ? this.shadow.activeElement : null;
      const focusAttribute = ["data-preference", "data-role", "data-action", "data-language"].find((attribute) => focused?.hasAttribute(attribute));
      const focusValue = focusAttribute ? focused?.getAttribute(focusAttribute) : null;
      this.buildPanelBody(copy);
      this.panelStructureKey = structureKey;
      this.syncPanelView();
      if (focusAttribute && focusValue) {
        let target = Array.from(this.panelBody.querySelectorAll<HTMLElement>("[" + focusAttribute + "]"))
          .find((element) => element.getAttribute(focusAttribute) === focusValue);
        if (target instanceof HTMLSelectElement && target.id === "manual-language-select" && target.disabled) {
          target = this.panelBody.querySelector<HTMLInputElement>("[data-preference='follow-browser-language']") ?? undefined;
        }
        target?.focus({ preventScroll: true });
      }
    }
    if (this.panelOpen && this.panelStructureKey === structureKey) this.updatePanelValues(copy);
    this.panelBody.querySelectorAll<HTMLButtonElement>(".toolbar button[data-action]").forEach((button) => {
      button.disabled = this.toolbarBusy;
    });
    this.statusLine.textContent = this.statusMessage || (this.storageReady ? "" : copy.refreshWorking);
    this.statusLine.dataset.tone = this.statusTone;
    this.syncPanelView();
    this.syncEffortEffectsVisibility();
  }

  private buildPanelBody(copy: Record<string, string>): void {
    this.closeModelMenu();
    this.closeLanguageMenu();
    this.effortEffects.detach();
    this.pendingRange = null;
    this.rangeBinding = null;
    this.panelBody.replaceChildren();
    this.modelOptionsKey = "";
    const mainView = this.make("div", "panel-view");
    mainView.dataset.role = "main-view";
    const settingsView = this.make("div", "panel-view");
    settingsView.dataset.role = "settings-view";
    settingsView.hidden = true;
    this.panelBody.append(mainView, settingsView);
    if (!this.storageReady) {
      const empty = this.make("div", "empty");
      empty.textContent = copy.refreshWorking;
      mainView.append(empty, this.createSettingsEntry(copy));
      return;
    }

    const capabilities = this.getCurrentCapabilities();
    if (capabilities.models.length === 0) {
      const empty = this.make("div", "empty");
      empty.textContent = copy.noModels;
      mainView.append(empty);
    } else {
      const modelField = this.make("div", "field");
      const modelLabel = this.make("label", "label");
      modelLabel.textContent = copy.model;
      modelLabel.id = "default-model-label";
      modelLabel.htmlFor = "default-model-trigger";
      const picker = this.make("div", "model-picker");
      const select = this.make("select", "select") as HTMLSelectElement;
      select.id = "default-model-select";
      select.dataset.preference = "model";
      select.tabIndex = -1;
      select.setAttribute("aria-hidden", "true");
      const placeholder = this.make("option") as HTMLOptionElement;
      placeholder.value = "";
      placeholder.textContent = copy.modelPlaceholder;
      select.append(placeholder);
      for (const model of capabilities.models) {
        const option = this.make("option") as HTMLOptionElement;
        option.value = model.id;
        option.textContent = model.label;
        option.disabled = model.availability === "disabled";
        select.append(option);
      }
      select.value = this.preferences.modelId ?? "";
      const trigger = this.make("button", "model-trigger") as HTMLButtonElement;
      trigger.id = "default-model-trigger";
      trigger.type = "button";
      trigger.dataset.role = "model-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", "default-model-menu");
      trigger.setAttribute("aria-labelledby", modelLabel.id + " default-model-value");
      const chevron = this.make("span", "model-chevron");
      chevron.setAttribute("aria-hidden", "true");
      chevron.innerHTML = "<svg viewBox='0 0 16 16' aria-hidden='true' focusable='false'><path d='M4 6.5 8 10.5 12 6.5' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='square' stroke-linejoin='miter'/></svg>";
      const currentValue = this.make("span", "visually-hidden");
      currentValue.id = "default-model-value";
      currentValue.textContent = select.selectedOptions[0]?.textContent ?? copy.modelPlaceholder;
      trigger.append(currentValue, chevron);
      const menu = this.make("div", "model-menu");
      menu.id = "default-model-menu";
      menu.setAttribute("popover", "auto");
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-labelledby", modelLabel.id);
      for (const model of capabilities.models) {
        menu.append(this.createModelOption(model));
      }
      this.modelOptionsKey = JSON.stringify(capabilities.models.map((model) => [model.id, model.label, model.availability]));
      menu.addEventListener("toggle", () => {
        if (this.panelBody.querySelector("#default-model-menu") !== menu) return;
        this.modelMenuOpen = menu.matches(":popover-open");
        trigger.setAttribute("aria-expanded", String(this.modelMenuOpen));
      });
      picker.append(select, trigger, menu);
      modelField.append(modelLabel, picker);
      mainView.append(modelField);

      const selectedModel = capabilities.models.find((model) => model.id === this.preferences.modelId);
      if (selectedModel) this.renderEffortControl(selectedModel, copy, mainView);
    }

    mainView.append(this.createSettingsEntry(copy));

    const currentPage = this.make("div", "hint");
    currentPage.dataset.role = "current-page";
    currentPage.textContent = this.currentPageSelection
      ? copy.currentPage + " " + this.currentPageSelection.modelLabel +
        (this.currentPageSelection.effortLabel ? " / " + localizedEffortLabel({ label: this.currentPageSelection.effortLabel }, this.uiLanguage()) : " · " + copy.currentModelOnly)
      : copy.currentNotRead;
    settingsView.append(currentPage);

    for (const setting of [
      { key: "auto-apply", label: copy.autoApply, checked: this.preferences.autoApply },
      { key: "apply-with-native-menu-open", label: copy.applyWithNativeMenuOpen, checked: this.preferences.applyWithNativeMenuOpen },
      { key: "apply-in-history", label: copy.applyInHistory, checked: this.preferences.applyInHistory },
      { key: "follow-browser-language", label: copy.followBrowserLanguage, checked: this.languageSettings.followBrowser }
    ]) {
      const toggleRow = this.make("label", "toggle-row");
      const toggleText = this.make("span", "label");
      toggleText.textContent = setting.label;
      const toggle = this.make("input", "toggle") as HTMLInputElement;
      toggle.type = "checkbox";
      toggle.setAttribute("role", "switch");
      toggle.checked = setting.checked;
      toggle.dataset.preference = setting.key;
      toggleRow.append(toggleText, toggle);
      settingsView.append(toggleRow);
    }

    const languageField = this.make("div", "field");
    const languageLabel = this.make("label", "label");
    languageLabel.textContent = copy.language;
    languageLabel.htmlFor = "manual-language-trigger";
    const languagePicker = this.make("div", "language-picker");
    const languageSelect = this.make("select", "select visually-hidden") as HTMLSelectElement;
    languageSelect.id = "manual-language-select";
    languageSelect.dataset.preference = "manual-language";
    languageSelect.tabIndex = -1;
    languageSelect.setAttribute("aria-hidden", "true");
    for (const { value, label } of LANGUAGE_OPTIONS) {
      const option = this.make("option") as HTMLOptionElement;
      option.value = value;
      option.textContent = label;
      languageSelect.append(option);
    }
    languageSelect.value = this.languageSettings.followBrowser ? this.uiLanguage() : this.languageSettings.manualLanguage;
    languageSelect.disabled = this.languageSettings.followBrowser;
    const languageTrigger = this.make("button", "language-trigger") as HTMLButtonElement;
    languageTrigger.id = "manual-language-trigger";
    languageTrigger.type = "button";
    languageTrigger.dataset.role = "language-trigger";
    languageTrigger.setAttribute("aria-haspopup", "listbox");
    languageTrigger.setAttribute("aria-expanded", "false");
    languageTrigger.setAttribute("aria-controls", "manual-language-menu");
    languageTrigger.setAttribute("aria-labelledby", languageLabel.id + " manual-language-value");
    languageTrigger.disabled = languageSelect.disabled;
    const languageCurrentValue = this.make("span", "language-current-value");
    languageCurrentValue.id = "manual-language-value";
    languageCurrentValue.textContent = LANGUAGE_OPTIONS.find(({ value }) => value === languageSelect.value)?.label ?? "English";
    const chevron = this.make("span", "model-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = "<svg viewBox='0 0 16 16'><path d='M4 6.5 8 10.5 12 6.5' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='square' stroke-linejoin='miter'/></svg>";
    languageTrigger.append(languageCurrentValue, chevron);
    const languageMenu = this.make("div", "model-menu language-menu");
    languageMenu.id = "manual-language-menu";
    languageMenu.setAttribute("popover", "auto");
    languageMenu.setAttribute("role", "listbox");
    languageMenu.setAttribute("aria-labelledby", languageLabel.id);
    for (const { value, label } of LANGUAGE_OPTIONS) languageMenu.append(this.createLanguageOption(value, label));
    languageMenu.addEventListener("toggle", () => {
      if (this.panelBody.querySelector("#manual-language-menu") !== languageMenu) return;
      this.languageMenuOpen = languageMenu.matches(":popover-open");
      languageTrigger.setAttribute("aria-expanded", String(this.languageMenuOpen));
    });
    languagePicker.append(languageSelect, languageTrigger, languageMenu);
    languageField.append(languageLabel, languagePicker);
    settingsView.append(languageField);

    const toolbar = this.make("div", "toolbar");
    const refresh = this.make("button", "button primary") as HTMLButtonElement;
    refresh.type = "button";
    refresh.dataset.action = "refresh";
    refresh.textContent = copy.refresh;
    refresh.disabled = this.toolbarBusy;
    toolbar.append(refresh);
    const apply = this.make("button", "button") as HTMLButtonElement;
    apply.type = "button";
    apply.dataset.action = "apply";
    apply.textContent = copy.applyNow;
    apply.disabled = this.toolbarBusy;
    toolbar.append(apply);
    settingsView.append(toolbar);

    const hint = this.make("div", "hint cache-info");
    hint.dataset.role = "cache-info";
    const lastRead = capabilities.lastSuccessfulReadAt === null
      ? copy.neverRead
      : copy.lastRead + new Intl.DateTimeFormat(this.uiLanguage(), {
        dateStyle: "short",
        timeStyle: "short"
      }).format(capabilities.lastSuccessfulReadAt);
    hint.textContent = [copy.cacheTime, lastRead].join("\n");
    settingsView.append(hint);
  }

  private createSettingsEntry(copy: Record<string, string>): HTMLButtonElement {
    const entry = this.make("button", "settings-card");
    entry.type = "button";
    entry.dataset.action = "open-settings";
    entry.dataset.role = "settings-entry";
    const icon = this.make("span", "settings-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' focusable='false'><path d='M10 2h4l.7 2.4 2.1 1.2 2.4-.6 2 3.5-1.7 1.8v3.4l1.7 1.8-2 3.5-2.4-.6-2.1 1.2L14 22h-4l-.7-2.4-2.1-1.2-2.4.6-2-3.5 1.7-1.8v-3.4L2.8 8.5l2-3.5 2.4.6 2.1-1.2Z'/><circle cx='12' cy='12' r='3.2'/></svg>";
    const label = this.make("span", "settings-card-label");
    label.textContent = copy.settings;
    const arrow = this.make("span", "settings-arrow");
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true' focusable='false'><path d='m6 4 4 4-4 4'/></svg>";
    entry.append(icon, label, arrow);
    return entry;
  }

  private updatePanelValues(copy: Record<string, string>): void {
    this.updateModelOptions(copy);
    const currentPage = this.panelBody.querySelector<HTMLElement>("[data-role='current-page']");
    if (currentPage) currentPage.textContent = this.currentPageSelection
      ? copy.currentPage + " " + this.currentPageSelection.modelLabel +
        (this.currentPageSelection.effortLabel ? " / " + localizedEffortLabel({ label: this.currentPageSelection.effortLabel }, this.uiLanguage()) : " · " + copy.currentModelOnly)
      : copy.currentNotRead;
    const toggle = this.panelBody.querySelector<HTMLInputElement>("[data-preference='auto-apply']");
    if (toggle) toggle.checked = this.preferences.autoApply;
    const nativeMenuToggle = this.panelBody.querySelector<HTMLInputElement>("[data-preference='apply-with-native-menu-open']");
    if (nativeMenuToggle) nativeMenuToggle.checked = this.preferences.applyWithNativeMenuOpen;
    const historyToggle = this.panelBody.querySelector<HTMLInputElement>("[data-preference='apply-in-history']");
    if (historyToggle) historyToggle.checked = this.preferences.applyInHistory;
    const languageToggle = this.panelBody.querySelector<HTMLInputElement>("[data-preference='follow-browser-language']");
    if (languageToggle) languageToggle.checked = this.languageSettings.followBrowser;
    const languageSelect = this.panelBody.querySelector<HTMLSelectElement>("#manual-language-select");
    if (languageSelect) {
      if (this.languageSettings.followBrowser && this.shadow.activeElement === languageSelect) languageToggle?.focus({ preventScroll: true });
      languageSelect.value = this.languageSettings.followBrowser ? this.uiLanguage() : this.languageSettings.manualLanguage;
      languageSelect.disabled = this.languageSettings.followBrowser;
      const language = LANGUAGE_OPTIONS.find(({ value }) => value === languageSelect.value) ?? LANGUAGE_OPTIONS[4];
      const trigger = this.panelBody.querySelector<HTMLButtonElement>("[data-role='language-trigger']");
      const currentValue = this.panelBody.querySelector<HTMLElement>("#manual-language-value");
      if (currentValue) currentValue.textContent = language.label;
      if (trigger) {
        trigger.disabled = languageSelect.disabled;
        trigger.setAttribute("aria-expanded", String(this.languageMenuOpen));
      }
      this.panelBody.querySelectorAll<HTMLElement>("[data-role='language-option']").forEach((option) => {
        option.setAttribute("aria-selected", String(option.dataset.language === languageSelect.value));
      });
      if (languageSelect.disabled && this.languageMenuOpen) this.closeLanguageMenu();
    }
    const capabilities = this.getCurrentCapabilities();
    const cacheInfo = this.panelBody.querySelector<HTMLElement>("[data-role='cache-info']");
    if (cacheInfo) {
      const lastRead = capabilities.lastSuccessfulReadAt === null ? copy.neverRead
        : copy.lastRead + new Intl.DateTimeFormat(this.uiLanguage(), {
          dateStyle: "short", timeStyle: "short"
        }).format(capabilities.lastSuccessfulReadAt);
      cacheInfo.textContent = [copy.cacheTime, lastRead].join("\n");
    }
    const range = this.panelBody.querySelector<HTMLInputElement>("[data-preference='effort-range']");
    if (!range || this.pendingRange === range) return;
    const model = capabilities.models.find((item) => item.id === range.dataset.modelId);
    const ordered = model ? this.orderedEfforts(model) : null;
    if (!model || !ordered) return;
    const savedId = this.preferences.effortByModel[model.id] ?? null;
    const index = ordered.findIndex((effort) => effort.id === savedId);
    const nextValue = String(index >= 0 ? index : Math.floor((ordered.length - 1) / 2));
    if (range.value !== nextValue) {
      range.value = nextValue;
      this.updateEffortRangeVisual(range);
    }
    const output = this.panelBody.querySelector<HTMLElement>("[data-role='effort-value']");
    if (output) {
      output.textContent = index >= 0 ? englishEffortLabel(ordered[index], index)
        : savedId ? MESSAGES.en.effortUnavailable : MESSAGES.en.effortUnset;
      range.setAttribute("aria-valuetext", output.textContent);
    }
    const hint = this.panelBody.querySelector<HTMLElement>("[data-role='effort-unavailable']");
    if (hint) hint.hidden = !savedId || index >= 0;
    this.effortEffects.setHighest(ordered.length >= 2 && index === ordered.length - 1, "restore");
  }

  private updateModelOptions(copy: Record<string, string>): void {
    if (this.modelMenuOpen) return;
    const models = this.getCurrentCapabilities().models;
    const key = JSON.stringify(models.map((model) => [model.id, model.label, model.availability]));
    if (this.modelOptionsKey === key) return;
    const select = this.panelBody.querySelector<HTMLSelectElement>("#default-model-select");
    const menu = this.panelBody.querySelector<HTMLElement>("#default-model-menu");
    if (!select || !menu) return;
    this.modelOptionsKey = key;
    const placeholder = this.make("option");
    placeholder.value = "";
    placeholder.textContent = copy.modelPlaceholder;
    select.replaceChildren(placeholder);
    const existing = new Map(Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-role='model-option']"))
      .map((option) => [option.dataset.modelId, option]));
    for (const model of models) {
      const nativeOption = this.make("option");
      nativeOption.value = model.id;
      nativeOption.textContent = model.label;
      nativeOption.disabled = model.availability === "disabled";
      select.append(nativeOption);
      let option = existing.get(model.id);
      if (!option) option = this.createModelOption(model);
      option.dataset.modelLabel = model.label;
      option.disabled = nativeOption.disabled;
      option.setAttribute("aria-disabled", String(option.disabled));
      option.setAttribute("aria-selected", String(model.id === this.preferences.modelId));
      option.querySelector<HTMLElement>(".model-name")!.textContent = model.label;
      menu.append(option);
      existing.delete(model.id);
    }
    for (const option of existing.values()) option.remove();
    select.value = this.preferences.modelId ?? "";
    const label = this.panelBody.querySelector<HTMLElement>("#default-model-value");
    if (label) label.textContent = select.selectedOptions[0]?.textContent ?? copy.modelPlaceholder;
  }

  private createModelOption(model: ModelCapability): HTMLButtonElement {
    const option = this.make("button", "model-option");
    option.type = "button";
    option.tabIndex = -1;
    option.dataset.role = "model-option";
    option.dataset.modelId = model.id;
    option.dataset.modelLabel = model.label;
    option.disabled = model.availability === "disabled";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === this.preferences.modelId));
    option.setAttribute("aria-disabled", String(option.disabled));
    const name = this.make("span", "model-name");
    name.textContent = model.label;
    const check = this.make("span", "model-check");
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = "<svg viewBox='0 0 20 20' aria-hidden='true' focusable='false'><path d='M4 10.5 8.25 14.75 16.5 5.5' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='square' stroke-linejoin='miter'/></svg>";
    option.append(name, check);
    return option;
  }

  private orderedEfforts(model: ModelCapability): EffortOption[] | null {
    const efforts = model.efforts.filter((effort) => !effort.disabled);
    if (model.effortState !== "observed" || efforts.length === 0 ||
      !efforts.every((effort) => effort.ordering === "strength" && effort.order !== null && Number.isFinite(effort.order)) ||
      new Set(efforts.map((effort) => effort.order)).size !== efforts.length) return null;
    return [...efforts].sort((left, right) => left.order! - right.order!);
  }

  private renderEffortControl(model: ModelCapability, copy: Record<string, string>, container: HTMLElement): void {
    const field = this.make("div", "field");
    const label = this.make("div", "label");
    label.textContent = copy.effort;
    field.append(label);

    const efforts = model.efforts.filter((effort) => !effort.disabled);
    const savedId = this.preferences.effortByModel[model.id] ?? null;
    if (efforts.length === 0 || model.effortState !== "observed") {
      const empty = this.make("div", "empty");
      empty.textContent = model.effortState === "unsupported" ? copy.effortUnsupported
        : model.effortState === "unknown" ? copy.effortUnknown
          : model.effortState === "observed" ? copy.effortNoneAvailable : copy.noEfforts;
      field.append(empty);
      container.append(field);
      return;
    }

    const ordered = this.orderedEfforts(model);
    if (ordered) {
      const savedIndex = ordered.findIndex((effort) => effort.id === savedId);
      const currentIndex = savedIndex >= 0 ? savedIndex : Math.floor((ordered.length - 1) / 2);
      const card = this.make("div", "effort-card");
      const shell = this.make("div", "range-shell");
      shell.addEventListener("pointermove", (event) => this.updateEffortDotHover(shell, event));
      shell.addEventListener("pointerleave", () => this.updateEffortDotHover(shell));
      shell.addEventListener("pointercancel", () => this.updateEffortDotHover(shell));
      const track = this.make("div", "range-track");
      track.setAttribute("aria-hidden", "true");
      const fill = this.make("div", "range-fill");
      const dots = this.make("div", "range-dots");
      for (let index = 0; index < ordered.length; index += 1) {
        const dot = this.make("span", "range-dot");
        dot.style.left = String(index / Math.max(1, ordered.length - 1) * 100) + "%";
        dots.append(dot);
      }
      track.append(fill, dots);
      const thumb = this.make("div", "range-thumb");
      thumb.setAttribute("aria-hidden", "true");
      const range = this.make("input", "range") as HTMLInputElement;
      range.type = "range";
      range.min = "0";
      range.max = String(ordered.length - 1);
      range.step = "1";
      range.value = String(currentIndex);
      range.dataset.preference = "effort-range";
      range.dataset.modelId = model.id;
      range.setAttribute("aria-label", copy.effort);
      const value = this.make("output", "range-value");
      value.dataset.role = "effort-value";
      value.textContent = savedIndex >= 0 ? englishEffortLabel(ordered[currentIndex], currentIndex) : savedId ? MESSAGES.en.effortUnavailable : MESSAGES.en.effortUnset;
      value.lang = "en";
      value.translate = false;
      range.setAttribute("aria-valuetext", value.textContent);
      this.rangeBinding = { input: range, options: ordered };
      shell.append(track, thumb, range);
      card.append(value, shell);
      field.append(card);
      this.updateEffortRangeVisual(range);
      const hint = this.make("div", "hint");
      hint.dataset.role = "effort-unavailable";
      hint.textContent = copy.effortUnavailableHint;
      hint.hidden = !savedId || savedIndex >= 0;
      field.append(hint);
      container.append(field);
      this.effortEffects.attach(card, track, shell, ordered.length >= 2 && savedIndex === ordered.length - 1);
      return;
    } else {
      const select = this.make("select", "select") as HTMLSelectElement;
      select.dataset.preference = "effort-select";
      select.dataset.modelId = model.id;
      const placeholder = this.make("option") as HTMLOptionElement;
      placeholder.value = "";
      const savedAvailable = Boolean(savedId && efforts.some((effort) => effort.id === savedId));
      placeholder.textContent = savedId && !savedAvailable ? copy.effortUnavailable : copy.effortUnset;
      select.append(placeholder);
      for (const effort of efforts) {
        const option = this.make("option") as HTMLOptionElement;
        option.value = effort.id;
        option.textContent = this.localizedEffortLabel(effort);
        select.append(option);
      }
      select.value = savedAvailable ? savedId! : "";
      field.append(select);
      const hint = this.make("div", "hint");
      hint.textContent = copy.effortNonOrdered;
      field.append(hint);
      if (savedId && !savedAvailable) {
        const missing = this.make("div", "hint");
        missing.textContent = copy.effortUnavailableHint;
        field.append(missing);
      }
    }

    container.append(field);
  }

  private localizedEffortLabel(effort: EffortOption): string {
    return localizedEffortLabel(effort, this.uiLanguage());
  }

  private updateEffortRangeVisual(range: HTMLInputElement): void {
    const shell = range.closest<HTMLElement>(".range-shell");
    if (!shell) return;
    const min = Number(range.min);
    const max = Number(range.max);
    const position = Number(range.value);
    const ratio = max > min ? Math.max(0, Math.min(1, (position - min) / (max - min))) : 0;
    const offset = 14 - 28 * ratio;
    shell.style.setProperty("--range-progress", "calc(" + ratio * 100 + "% " + (offset < 0 ? "- " : "+ ") + Math.abs(offset) + "px)");
    shell.querySelectorAll<HTMLElement>(".range-dot").forEach((dot, index) => {
      dot.dataset.passed = String(index <= position - min);
    });
  }

  private updateEffortDotHover(shell: HTMLElement, event?: PointerEvent): void {
    const dots = shell.querySelectorAll<HTMLElement>(".range-dot");
    let hovered = -1;
    if (event && event.pointerType !== "touch" && dots.length > 0) {
      const rect = shell.getBoundingClientRect();
      const span = Math.max(0, rect.width - 28);
      const last = dots.length - 1;
      const nearest = span > 0 ? Math.max(0, Math.min(last, Math.round((event.clientX - rect.left - 14) / span * last))) : 0;
      const centerX = rect.left + 14 + (last > 0 ? span * nearest / last : 0);
      if (Math.abs(event.clientX - centerX) <= 10 && Math.abs(event.clientY - rect.top - rect.height / 2) <= 12) hovered = nearest;
    }
    dots.forEach((dot, index) => {
      const next = String(index === hovered);
      if (dot.dataset.hovered !== next) dot.dataset.hovered = next;
    });
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  private getCurrentCapabilities(): CapabilitiesCache {
    if (this.capabilities.scopeKey !== this.adapter.scopeKey()) return emptyCapabilities(this.adapter.scopeKey());
    return this.capabilities;
  }

  private openModelMenu(edge?: "first" | "last"): void {
    const menu = this.panelBody.querySelector<HTMLElement>("#default-model-menu");
    const trigger = this.panelBody.querySelector<HTMLElement>("[data-role='model-trigger']");
    if (!menu || !trigger || !this.panelOpen) return;
    this.modelSearch = "";
    this.modelSearchAt = 0;
    this.modelMenuOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    this.positionModelMenu();
    if (!this.modelMenuOpen) return;
    menu.showPopover();
    this.positionModelMenu();
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-role='model-option']:not(:disabled)"));
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    this.focusModelOption(edge === "last" ? options.at(-1) : edge === "first" ? options[0] : selected ?? options[0]);
  }

  private createLanguageOption(value: DisplayLanguage, label: string): HTMLButtonElement {
    const option = this.make("button", "model-option") as HTMLButtonElement;
    option.type = "button";
    option.dataset.role = "language-option";
    option.dataset.language = value;
    option.tabIndex = -1;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const name = this.make("span", "model-name");
    name.textContent = label;
    const check = this.make("span", "model-check");
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true' focusable='false'><path d='m4 10 4 4 8-8' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>";
    option.append(name, check);
    return option;
  }

  private openLanguageMenu(edge?: "first" | "last"): void {
    const menu = this.panelBody.querySelector<HTMLElement>("#manual-language-menu");
    const trigger = this.panelBody.querySelector<HTMLButtonElement>("[data-role='language-trigger']");
    if (!menu || !trigger || trigger.disabled || !this.panelOpen) return;
    this.languageMenuOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    this.positionLanguageMenu();
    if (!this.languageMenuOpen) return;
    menu.showPopover();
    this.positionLanguageMenu();
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-role='language-option']"));
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    this.focusLanguageOption(edge === "last" ? options.at(-1) : edge === "first" ? options[0] : selected ?? options[0]);
  }

  private closeLanguageMenu(returnFocus = false): void {
    const menu = this.panelBody.querySelector<HTMLElement>("#manual-language-menu");
    if (this.languageMenuOpen && menu) menu.hidePopover();
    this.languageMenuOpen = false;
    const trigger = this.panelBody.querySelector<HTMLElement>("[data-role='language-trigger']");
    trigger?.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger?.focus({ preventScroll: true });
  }

  private positionLanguageMenu(): void {
    if (!this.languageMenuOpen) return;
    const menu = this.panelBody.querySelector<HTMLElement>("#manual-language-menu");
    const picker = this.panelBody.querySelector<HTMLElement>(".language-picker");
    if (!menu || !picker) return;
    const rect = picker.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    if (!this.panelOpen || this.panelView !== "settings" || this.host.style.display === "none" ||
      rect.bottom <= panelRect.top || rect.top >= panelRect.bottom) {
      this.closeLanguageMenu();
      return;
    }
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upwards = below < Math.min(menu.scrollHeight || 120, 120) && above > below;
    const maxHeight = Math.max(0, Math.min(260, upwards ? above : below));
    const width = Math.min(rect.width, window.innerWidth - 16);
    menu.style.width = width + "px";
    menu.style.maxHeight = maxHeight + "px";
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
    menu.style.top = (upwards ? Math.max(8, rect.top - 6 - Math.min(menu.scrollHeight, maxHeight)) : rect.bottom + 6) + "px";
  }

  private focusLanguageOption(option: HTMLButtonElement | undefined): void {
    if (!option) return;
    option.focus({ preventScroll: true });
    const menu = option.parentElement!;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }

  private onLanguagePickerKeydown(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".language-picker")) return false;
    if (event.key === "Escape" && this.languageMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.closeLanguageMenu(true);
      return true;
    }
    if (event.key === "Tab") {
      if (this.languageMenuOpen) this.closeLanguageMenu(true);
      return false;
    }
    const trigger = Boolean(target.closest("[data-role='language-trigger']"));
    if (trigger && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (this.languageMenuOpen) this.closeLanguageMenu(true);
      else this.openLanguageMenu();
      return true;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!this.languageMenuOpen) {
        this.openLanguageMenu(event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined);
        return true;
      }
      const options = Array.from(this.panelBody.querySelectorAll<HTMLButtonElement>("[data-role='language-option']"));
      const current = options.findIndex((option) => option === this.shadow.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      this.focusLanguageOption(options[index]);
      return true;
    }
    if (target instanceof HTMLElement && target.dataset.role === "language-option" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (target.dataset.language) this.chooseLanguage(target.dataset.language as DisplayLanguage);
      return true;
    }
    return false;
  }

  private chooseLanguage(language: DisplayLanguage): void {
    const select = this.panelBody.querySelector<HTMLSelectElement>("#manual-language-select");
    if (!select || select.disabled || this.languageSettings.followBrowser) return;
    this.closeLanguageMenu(true);
    if (select.value === language) return;
    select.value = language;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private closeModelMenu(returnFocus = false): void {
    const menu = this.panelBody.querySelector<HTMLElement>("#default-model-menu");
    if (this.modelMenuOpen && menu) menu.hidePopover();
    this.modelMenuOpen = false;
    this.modelSearch = "";
    const trigger = this.panelBody.querySelector<HTMLElement>("[data-role='model-trigger']");
    trigger?.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger?.focus({ preventScroll: true });
  }

  private positionModelMenu(): void {
    if (!this.modelMenuOpen) return;
    const menu = this.panelBody.querySelector<HTMLElement>("#default-model-menu");
    const picker = this.panelBody.querySelector<HTMLElement>(".model-picker");
    if (!menu || !picker) return;
    const rect = picker.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    if (!this.panelOpen || this.host.style.display === "none" || rect.bottom <= panelRect.top || rect.top >= panelRect.bottom) {
      this.closeModelMenu();
      return;
    }
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upwards = below < Math.min(menu.scrollHeight || 120, 120) && above > below;
    const maxHeight = Math.max(0, Math.min(260, upwards ? above : below));
    const width = Math.min(rect.width, window.innerWidth - 16);
    menu.style.width = width + "px";
    menu.style.maxHeight = maxHeight + "px";
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
    menu.style.top = (upwards ? Math.max(8, rect.top - 6 - Math.min(menu.scrollHeight, maxHeight)) : rect.bottom + 6) + "px";
  }

  private focusModelOption(option: HTMLButtonElement | undefined): void {
    if (!option) return;
    option.focus({ preventScroll: true });
    const menu = option.parentElement!;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }

  private onModelPickerKeydown(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".model-picker")) return false;
    if (event.key === "Escape" && this.modelMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.closeModelMenu(true);
      return true;
    }
    if (event.key === "Tab") {
      if (this.modelMenuOpen) this.closeModelMenu(true);
      return false;
    }
    const trigger = Boolean(target.closest("[data-role='model-trigger']"));
    if (trigger && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (this.modelMenuOpen) this.closeModelMenu(true);
      else this.openModelMenu();
      return true;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!this.modelMenuOpen) {
        this.openModelMenu(event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined);
        return true;
      }
      const options = Array.from(this.panelBody.querySelectorAll<HTMLButtonElement>("[data-role='model-option']:not(:disabled)"));
      const current = options.findIndex((option) => option === this.shadow.activeElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      this.focusModelOption(options[index]);
      return true;
    }
    if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!this.modelMenuOpen) this.openModelMenu();
      const now = Date.now();
      this.modelSearch = (now - this.modelSearchAt < 700 ? this.modelSearch : "") + event.key.toLocaleLowerCase();
      this.modelSearchAt = now;
      const options = Array.from(this.panelBody.querySelectorAll<HTMLButtonElement>("[data-role='model-option']:not(:disabled)"));
      this.focusModelOption(options.find((option) => option.dataset.modelLabel?.toLocaleLowerCase().startsWith(this.modelSearch)));
      return true;
    }
    return false;
  }

  private chooseModel(modelId: string): void {
    const model = this.getCurrentCapabilities().models.find((item) => item.id === modelId);
    const select = this.panelBody.querySelector<HTMLSelectElement>("#default-model-select");
    if (!select || !model || model.availability === "disabled") return;
    this.closeModelMenu(true);
    if (select.value === modelId) return;
    select.value = modelId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    this.panelBody.querySelector<HTMLElement>("[data-role='model-trigger']")?.focus({ preventScroll: true });
  }

  private onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-role='language-trigger']")) {
      if (this.languageMenuOpen) this.closeLanguageMenu(true);
      else this.openLanguageMenu();
      return;
    }
    const languageOption = target.closest<HTMLButtonElement>("[data-role='language-option']");
    if (languageOption) {
      if (languageOption.dataset.language) this.chooseLanguage(languageOption.dataset.language as DisplayLanguage);
      return;
    }
    if (target.closest("[data-role='model-trigger']")) {
      if (this.modelMenuOpen) this.closeModelMenu(true);
      else this.openModelMenu();
      return;
    }
    const option = target.closest<HTMLButtonElement>("[data-role='model-option']");
    if (option) {
      if (!option.disabled && option.dataset.modelId) this.chooseModel(option.dataset.modelId);
      return;
    }
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "open-settings") this.setPanelView("settings");
    if (action === "back") this.setPanelView("main");
    if (action === "close") this.setPanelOpen(false);
    if (action === "refresh" || action === "apply") void this.runToolbarAction(action);
  }

  private async runToolbarAction(action: "refresh" | "apply"): Promise<void> {
    if (this.toolbarBusy) return;
    // Background preference application updates status without dimming the toolbar.
    this.toolbarBusy = true;
    this.deferredAutomaticApplyEpoch = -1;
    this.operations.userTookControl();
    this.renderPanel();
    try {
      if (action === "refresh") await this.requestRefresh("manual-refresh", "user", true);
      else await this.enqueueApply("user", true);
    } catch {
      this.setStatus("warning", action === "refresh" ? "refreshFailed" : "applyAttempted");
    } finally {
      this.toolbarBusy = false;
      this.renderPanel();
    }
  }

  private onPanelInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.preference !== "effort-range") return;
    const ordered = this.rangeBinding?.input === target ? this.rangeBinding.options : null;
    const effort = ordered?.[Number(target.value)];
    if (!ordered || !effort) return;
    this.pendingRange = target;
    const output = this.panelBody.querySelector<HTMLElement>("[data-role='effort-value']");
    if (effort && output) {
      output.textContent = englishEffortLabel(effort, Number(target.value));
      target.setAttribute("aria-valuetext", output.textContent);
    }
    this.updateEffortRangeVisual(target);
    this.effortEffects.setHighest(ordered.length >= 2 && Number(target.value) === ordered.length - 1, "user");
    const hint = this.panelBody.querySelector<HTMLElement>("[data-role='effort-unavailable']");
    if (hint) hint.hidden = true;
  }

  private async onPanelChange(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const preferenceType = target.dataset.preference;
    if (!preferenceType) return;
    if (preferenceType === "follow-browser-language" || preferenceType === "manual-language") {
      const next = { ...this.languageSettings };
      if (preferenceType === "follow-browser-language" && target instanceof HTMLInputElement) next.followBrowser = target.checked;
      else if (target instanceof HTMLSelectElement && !target.disabled && !next.followBrowser &&
        isDisplayLanguage(target.value)) next.manualLanguage = target.value;
      else return;
      this.languageSettings = next;
      const generation = ++this.languageSaveGeneration;
      this.renderPanel();
      try {
        await saveLanguageSettings(next);
        if (generation === this.languageSaveGeneration) this.setStatus("success", "languageSettingsSaved");
      } catch {
        if (generation === this.languageSaveGeneration) this.setStatus("warning", "languageSettingsSaveError");
      }
      return;
    }

    const next: Preferences = {
      ...this.preferences,
      effortByModel: { ...this.preferences.effortByModel }
    };
    if (preferenceType === "model" && target instanceof HTMLSelectElement) {
      next.modelId = target.value || null;
    } else if (preferenceType === "auto-apply" && target instanceof HTMLInputElement) {
      next.autoApply = target.checked;
    } else if (preferenceType === "apply-with-native-menu-open" && target instanceof HTMLInputElement) {
      next.applyWithNativeMenuOpen = target.checked;
    } else if (preferenceType === "apply-in-history" && target instanceof HTMLInputElement) {
      next.applyInHistory = target.checked;
    } else if (preferenceType === "effort-range" && target instanceof HTMLInputElement) {
      const modelId = target.dataset.modelId;
      const model = this.getCurrentCapabilities().models.find((item) => item.id === modelId);
      const ordered = this.rangeBinding?.input === target ? this.rangeBinding.options : null;
      const effort = ordered?.[Number(target.value)];
      if (!modelId || !effort || !model?.efforts.some((item) => item.id === effort.id && !item.disabled)) {
        this.pendingRange = null;
        this.renderPanel(true);
        return;
      }
      next.effortByModel[modelId] = effort.id;
    } else if (preferenceType === "effort-select" && target instanceof HTMLSelectElement) {
      const modelId = target.dataset.modelId;
      if (!modelId) return;
      next.effortByModel[modelId] = target.value || null;
    } else {
      return;
    }

    this.preferences = next;
    if (this.pendingRange === target) this.pendingRange = null;
    const saveGeneration = ++this.preferenceSaveGeneration;
    this.operations.preferencesChanged();
    this.resetAutomaticSchedule();
    this.takenOverEpoch = -1;
    this.deferredAutomaticApplyEpoch = -1;
    this.setStatus("success", "preferenceSaved");
    this.renderPanel(preferenceType === "model" || preferenceType === "effort-select");
    try {
      await savePreferences(next);
      if (saveGeneration !== this.preferenceSaveGeneration) return;
      this.scheduleAutoOperations();
    } catch {
      if (saveGeneration === this.preferenceSaveGeneration) this.setStatus("warning", "storageError");
    }
  }

  private onDocumentPointerDown(event: PointerEvent): void {
    if (!event.isTrusted || this.eventInsideExtension(event)) return;
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (!target) return;
    if (this.adapter.isComposerModeTarget(target)) {
      this.operations.userTookControl();
      this.schedulePageUpdate(0);
      return;
    }
    if (this.adapter.isNativeModelTarget(target)) {
      this.currentPageSelection = null;
      this.handleNativeModelInteraction(target);
    }
  }

  private onDocumentClick(event: MouseEvent): void {
    if (!event.isTrusted || this.eventInsideExtension(event)) return;
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    if (!target) return;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link && link.origin === window.location.origin && link.pathname !== window.location.pathname &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey && (!link.target || link.target === "_self")) {
      this.navigationRequested = true;
    }
    if (this.adapter.isComposerModeTarget(target)) {
      this.operations.userTookControl();
      this.schedulePageUpdate(0);
      return;
    }
    if (this.adapter.isNewChatTarget(target)) {
      this.advancePageEpoch();
      this.schedulePageUpdate(200);
      return;
    }

    if (this.adapter.isNativeModelTarget(target)) {
      this.currentPageSelection = null;
      this.renderPanel();
      this.handleNativeModelInteraction(target);
      this.schedulePassiveRead();
      window.setTimeout(() => {
        this.resumeDeferredAutomaticApply();
        void this.tryOpportunisticRefresh();
      }, 700);
      return;
    }
  }

  private onDocumentInput(event: Event): void {
    if (!event.isTrusted || this.eventInsideExtension(event)) return;
    const target = event.target;
    if (target instanceof Element && this.adapter.isComposerModeTarget(target)) {
      this.operations.userTookControl();
      this.schedulePageUpdate(0);
      return;
    }
    if (target instanceof Element && this.adapter.isNativeEffortTarget(target)) {
      this.currentPageSelection = null;
      this.handleNativeModelInteraction(target);
    }
  }

  private onDocumentKeydown(event: KeyboardEvent): void {
    if (!event.isTrusted || this.eventInsideExtension(event)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.adapter.isComposerModeTarget(target)) {
      this.operations.userTookControl();
      this.schedulePageUpdate(0);
      return;
    }
    if (NATIVE_ADJUSTMENT_KEYS.has(event.key) && this.adapter.isNativeModelTarget(target)) {
      this.currentPageSelection = null;
      this.renderPanel();
      this.handleNativeModelInteraction(target);
    }
  }

  private eventInsideExtension(event: Event): boolean {
    return event.composedPath().includes(this.host) || this.host.contains(event.target as Node | null);
  }

  private takeOverCurrentPage(): void {
    this.takenOverEpoch = this.pageEpoch;
    this.deferredAutomaticApplyEpoch = -1;
    this.operations.userTookControl();
    this.setStatus("quiet", "paused");
  }

  private handleNativeModelInteraction(target: Element): void {
    if (this.preferences.applyWithNativeMenuOpen) {
      this.scheduleNativePreferenceEnforcement();
    } else if (this.adapter.isNativeEffortTarget(target)) {
      this.takeOverCurrentPage();
    } else {
      this.deferAutomaticApplyForNativeMenu();
    }
  }

  private scheduleNativePreferenceEnforcement(): void {
    if (!this.pageAllowsAutomaticApply()) return;
    if (this.nativeEnforcementTimer !== null) window.clearTimeout(this.nativeEnforcementTimer);
    const epoch = this.pageEpoch;
    // Let the native selection finish first, then restore the saved model and effort.
    this.nativeEnforcementTimer = window.setTimeout(() => {
      this.nativeEnforcementTimer = null;
      if (epoch !== this.pageEpoch || !this.preferences.applyWithNativeMenuOpen ||
        !this.pageAllowsAutomaticApply() || this.takenOverEpoch === this.pageEpoch) return;
      if (this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") {
        this.deferredAutomaticApplyEpoch = this.pageEpoch;
        return;
      }
      void this.enqueueApply("background");
    }, 240);
  }

  private shouldDeferAutomaticApply(): boolean {
    return !this.preferences.applyWithNativeMenuOpen &&
      this.adapter.findModelTrigger()?.getAttribute("aria-expanded") === "true";
  }

  private pageAllowsAutomaticApply(): boolean {
    return this.preferences.autoApply && (this.currentSnapshot.kind === "new-empty" ||
      (this.currentSnapshot.kind === "history" && this.preferences.applyInHistory));
  }

  private resetAutomaticSchedule(): void {
    if (this.autoScheduleTimer !== null) window.clearTimeout(this.autoScheduleTimer);
    this.autoScheduleTimer = null;
    this.pageAutoScheduled = -1;
  }

  private deferAutomaticApplyForNativeMenu(): void {
    if (this.preferences.applyWithNativeMenuOpen || this.pendingAutomaticApplyEpoch !== this.pageEpoch) return;
    this.deferredAutomaticApplyEpoch = this.pageEpoch;
    this.operations.userTookControl();
    this.setStatus("quiet", "autoApplyMenuWaiting");
  }

  private resumeDeferredAutomaticApply(): void {
    if (this.deferredAutomaticApplyEpoch !== this.pageEpoch) return;
    if (!this.preferences.autoApply || this.takenOverEpoch === this.pageEpoch) {
      this.deferredAutomaticApplyEpoch = -1;
      return;
    }
    if (this.currentSnapshot.kind === "history" && !this.preferences.applyInHistory) {
      this.deferredAutomaticApplyEpoch = -1;
      return;
    }
    if (!this.pageAllowsAutomaticApply() || this.adapter.replyGenerationState(this.currentSnapshot) !== "idle" || document.visibilityState !== "visible" ||
      this.toolbarBusy || this.pendingAutomaticApplyEpoch === this.pageEpoch || this.shouldDeferAutomaticApply()) return;
    this.deferredAutomaticApplyEpoch = -1;
    void this.enqueueApply("background");
  }

  private schedulePageUpdate(delay = 120): void {
    if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = null;
      this.syncPage();
    }, delay);
  }

  private schedulePassiveRead(): void {
    if (this.passiveReadTimer !== null) window.clearTimeout(this.passiveReadTimer);
    this.passiveReadTimer = window.setTimeout(() => {
      this.passiveReadTimer = null;
      if (!this.storageReady) return;
      this.resumeDeferredAutomaticApply();
      if (this.takenOverEpoch === this.pageEpoch) void this.tryOpportunisticRefresh();
      else void this.requestRefresh("passive-refresh", "background", false);
    }, 180);
  }

  private mutationMayChangePageState(record: MutationRecord): boolean {
    if (this.host.contains(record.target)) return false;
    return this.adapter.mutationMayChangePageState(record, this.currentSnapshot.messageCount);
  }

  private syncHostVisibility(triggerPresent = Boolean(this.adapter.findModelTrigger())): void {
    if (triggerPresent) {
      if (this.hostHideTimer !== null) window.clearTimeout(this.hostHideTimer);
      this.hostHideTimer = null;
      this.host.style.display = "block";
      this.syncEffortEffectsVisibility();
      return;
    }
    // Repeated missing-control observations must not push the deadline back.
    if (this.hostHideTimer !== null || this.host.style.display === "none") return;
    this.hostHideTimer = window.setTimeout(() => {
      this.hostHideTimer = null;
      // The button may have returned before its debounced page update runs.
      if (this.adapter.findModelTrigger()) {
        this.syncHostVisibility(true);
        return;
      }
      this.host.style.display = "none";
      this.syncEffortEffectsVisibility();
      this.positionModelMenu();
    }, HOST_HIDE_DELAY_MS);
  }

  private syncPage(): void {
    if (!this.host.isConnected && document.body) document.body.append(this.host);
    this.refreshPageTheme();
    this.currentSnapshot = this.adapter.readPageSnapshot();
    this.syncHostVisibility(Boolean(this.currentSnapshot.modelTrigger));
    this.positionHost();

    const messageBearing = this.currentSnapshot.messageCount > 0 || this.currentSnapshot.kind === "history";
    const base = window.location.pathname + (this.currentSnapshot.kind === "unsupported" ? "|unsupported" : "|chat") +
      (messageBearing ? "|conversation" : "|empty");
    if (base !== this.pageBase) {
      // DOM replacement is not a new conversation. Also retain the new-chat state
      // when its existing composer gains a /c/ URL after the first send.
      const sameConversation = this.pagePath === window.location.pathname ||
        (!this.navigationRequested && this.pagePath === "/" && /^\/c\//u.test(window.location.pathname) &&
          this.pageComposer !== null && this.pageComposer === this.currentSnapshot.composer);
      const wasTakenOver = sameConversation && this.takenOverEpoch === this.pageEpoch;
      const wasDeferred = sameConversation && this.deferredAutomaticApplyEpoch === this.pageEpoch;
      const wasScheduled = sameConversation && this.pageAutoScheduled === this.pageEpoch &&
        this.autoScheduleTimer === null && this.pendingAutomaticApplyEpoch !== this.pageEpoch;
      this.resetAutomaticSchedule();
      this.pageBase = base;
      this.pageEpoch += 1;
      this.takenOverEpoch = wasTakenOver ? this.pageEpoch : -1;
      this.pageAutoScheduled = wasScheduled ? this.pageEpoch : -1;
      this.deferredAutomaticApplyEpoch = wasDeferred ? this.pageEpoch : -1;
      this.currentPageSelection = null;
      this.operations.setPage(base + "|" + String(this.pageEpoch));
    }
    if (this.pagePath !== window.location.pathname) this.navigationRequested = false;
    this.pagePath = window.location.pathname;
    if (this.currentSnapshot.composer) this.pageComposer = this.currentSnapshot.composer;
    if (this.storageReady) this.scheduleAutoOperations();
    this.resumeDeferredAutomaticApply();
    this.renderPanel();
  }

  private advancePageEpoch(): void {
    this.resetAutomaticSchedule();
    this.navigationRequested = true;
    this.pageEpoch += 1;
    this.takenOverEpoch = -1;
    this.deferredAutomaticApplyEpoch = -1;
    this.currentPageSelection = null;
    this.operations.setPage(this.pageBase + "|" + String(this.pageEpoch));
    this.pageAutoScheduled = -1;
  }

  private scheduleAutoOperations(): void {
    if (!this.storageReady || !(this.currentSnapshot.kind === "new-empty" || this.pageAllowsAutomaticApply())) return;
    if (document.visibilityState !== "visible") return;
    if (this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") return;
    if (this.pendingAutomaticApplyEpoch === this.pageEpoch || this.deferredAutomaticApplyEpoch === this.pageEpoch) return;
    if (this.pageAutoScheduled === this.pageEpoch || this.takenOverEpoch === this.pageEpoch) return;
    this.pageAutoScheduled = this.pageEpoch;
    const epoch = this.pageEpoch;
    this.autoScheduleTimer = window.setTimeout(() => {
      this.autoScheduleTimer = null;
      if (epoch !== this.pageEpoch || this.takenOverEpoch === this.pageEpoch) return;
      if (document.visibilityState !== "visible" || this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") {
        this.pageAutoScheduled = -1;
        return;
      }
      if (this.pageAllowsAutomaticApply()) void this.enqueueApply("background");
      void this.requestRefresh("passive-refresh", "background", false);
    }, 350);
  }

  private positionHost(): void {
    if (this.positionTimer !== null) window.clearTimeout(this.positionTimer);
    this.positionTimer = window.setTimeout(() => {
      this.positionTimer = null;
      const main = this.adapter.activeMain();
      const rect = main?.getBoundingClientRect();
      const left = rect && rect.width > 0 ? Math.max(12, Math.min(window.innerWidth - 60, rect.left + 12)) : 12;
      this.host.style.left = left + "px";
      this.host.style.top = "12px";
      this.positionModelMenu();
      this.positionLanguageMenu();
    }, 80);
  }

  private async enqueueApply(priority: "background" | "user", explicit = false): Promise<void> {
    if (!this.adapter.isChatMode()) return;
    const automatic = !explicit;
    if (automatic && (!this.pageAllowsAutomaticApply() || this.takenOverEpoch === this.pageEpoch)) return;
    const epoch = this.pageEpoch;
    const generation = automatic ? ++this.automaticApplyGeneration : 0;
    if (automatic) this.pendingAutomaticApplyEpoch = epoch;
    try {
      await this.operations.enqueue("apply", priority, async (context) => {
        context = this.chatOperationContext(context);
        try {
          const applied = await this.applySavedSettings(context, explicit);
          if (context.isCurrent() && !applied && this.statusTone === "working") {
            this.setStatus("quiet", "applyNoControls");
          }
          return applied;
        } catch (error) {
          if (context.isCurrent()) {
            this.host.dataset.failure = error instanceof Error ? error.name : "unknown-error";
            this.setStatus("quiet", "applyAttempted");
          }
          return false;
        }
      });
    } finally {
      if (automatic && generation === this.automaticApplyGeneration) {
        this.pendingAutomaticApplyEpoch = -1;
        if (epoch === this.pageEpoch && this.pageAllowsAutomaticApply() && this.takenOverEpoch !== this.pageEpoch &&
          this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") {
          this.deferredAutomaticApplyEpoch = this.pageEpoch;
        }
        this.resumeDeferredAutomaticApply();
      }
    }
  }

  private async applySavedSettings(context: OperationContext, explicit: boolean): Promise<boolean> {
    this.currentSnapshot = this.adapter.readPageSnapshot();
    if (this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") {
      if (context.isCurrent() && explicit) this.setStatus("warning", "busy");
      if (context.isCurrent() && !explicit && this.pageAllowsAutomaticApply()) this.deferredAutomaticApplyEpoch = this.pageEpoch;
      return false;
    }
    context = this.nativeInteractionContext(context);
    // Let the native outside-click handler finish closing its previous menu first.
    if (!(await this.adapter.settlePageInput(context))) return false;
    const copy = this.copy();
    if (!context.isCurrent()) return false;
    const pageAllowsApply = explicit
      ? this.currentSnapshot.kind === "new-empty" || this.currentSnapshot.kind === "history"
      : this.pageAllowsAutomaticApply();
    if (!pageAllowsApply) {
      if (explicit) this.setStatus("warning", "applyPageUnavailable");
      return false;
    }
    if (!explicit && !this.preferences.autoApply) return false;
    if (!this.preferences.modelId) {
      this.setStatus("quiet", "applyReady");
      return false;
    }
    if (!explicit) {
      if (this.takenOverEpoch === this.pageEpoch) return false;
      if (this.shouldDeferAutomaticApply()) {
        this.deferredAutomaticApplyEpoch = this.pageEpoch;
        this.setStatus("quiet", "autoApplyMenuWaiting");
        return false;
      }
      this.deferredAutomaticApplyEpoch = -1;
    }

    this.setStatus("working", "refreshWorking");
    this.host.dataset.step = "open-menu";
    let trigger = this.adapter.findModelTrigger();
    const menuWasOpen = trigger?.getAttribute("aria-expanded") === "true";
    const preexistingMenu = menuWasOpen ? this.adapter.findMenu(trigger) : null;
    const previousView = preexistingMenu ? this.adapter.menuView(preexistingMenu) : "unknown";
    let menu = trigger ? await this.adapter.ensureMenuOpen(trigger, context, MENU_OPEN_TIMEOUT_MS) : null;
    if (!menu && !explicit && await this.waitForAutomaticMenuRetry(context)) {
      // Only menu readiness gets one extra chance; model/effort application still runs once.
      this.host.dataset.step = "retry-open-menu";
      trigger = this.adapter.findModelTrigger();
      if (trigger) menu = await this.adapter.ensureMenuOpen(trigger, context, MENU_OPEN_TIMEOUT_MS);
    }
    if (!menu || !trigger || !context.isCurrent()) {
      if (context.isCurrent() && !menuWasOpen) {
        this.host.dataset.nativeResult = "trigger-connected:" + Boolean(trigger?.isConnected) + ";expanded:" + trigger?.getAttribute("aria-expanded") + ";" + this.adapter.menuReadinessDiagnostic;
        const opened = trigger ? this.adapter.findMenu(trigger) : null;
        if (opened && trigger) this.closeMenu(trigger, opened);
      }
      return false;
    }

    // Each stage is best effort. Missing confirmation does not gate the next stage,
    // and this operation never schedules another whole application attempt.
    const attempt = async <T>(action: () => T | Promise<T>): Promise<T | null> => {
      if (!context.isCurrent()) return null;
      try {
        return await action();
      } catch (error) {
        this.host.dataset.failure = error instanceof Error ? error.name : "unknown-error";
        return null;
      }
    };
    try {
      const targetId = this.preferences.modelId;
      this.host.dataset.step = "read-model-list";
      await attempt(() => this.adapter.showModelList(menu, context));
      if (!context.isCurrent()) return false;
      const listing = await attempt(() => this.adapter.readModelOptions(menu));
      const listed = listing ?? [];
      if (listed.length > 0) {
        const observed = await attempt(() => mergeAndSaveCapabilities({
          scopeKey: this.adapter.scopeKey(),
          completeness: "partial",
          models: listed.map((option) => this.adapter.toModelCapability(option))
        }, context.isCurrent));
        if (!context.isCurrent()) return false;
        if (observed) this.capabilities = observed;
      }
      const targetOption = listed.find((option) => option.id === targetId && option.availability === "available");
      let cached = this.getCurrentCapabilities().models.find((model) => model.id === targetId);
      const targetLabel = targetOption?.label ?? cached?.label ?? targetId;

      this.host.dataset.step = "select-model";
      // Issue a single model selection; do not reopen the list to verify the click.
      if (targetOption && targetOption.selected !== true) await attempt(() => targetOption.element.click());
      if (!context.isCurrent()) return false;

      this.host.dataset.step = "read-effort";
      await attempt(() => this.adapter.showEffortControl(menu, context));
      if (!context.isCurrent()) return false;
      const beforeDiscovery = await attempt(() => this.adapter.readRetainedModelOptions(menu));
      const selectedBeforeDiscovery = beforeDiscovery?.filter((option) => option.selected === true) ?? [];
      // Unconfirmed model selection must not associate another model's levels with the saved target.
      // Skip cache discovery in that case, while still attempting the saved effort below.
      if ((!cached || cached.effortState === "not-read" || cached.effortState === "unknown") && targetOption &&
        selectedBeforeDiscovery.length === 1 && selectedBeforeDiscovery[0].id === targetId) {
        this.host.dataset.step = "discover-efforts";
        const efforts = await attempt(() => this.adapter.enumerateEfforts(menu, context, REFRESH_TIMEOUT_MS));
        if (!context.isCurrent()) return false;
        if (efforts) {
          const merged = await attempt(() => mergeAndSaveCapabilities({
            scopeKey: this.adapter.scopeKey(),
            completeness: "partial",
            models: [this.adapter.toModelCapability(targetOption, efforts)]
          }, context.isCurrent));
          if (!context.isCurrent()) return false;
          if (merged) {
            this.capabilities = merged;
            cached = merged.models.find((model) => model.id === targetId);
          }
        }
      }

      const effortId = this.preferences.effortByModel[targetId] ?? null;
      const selectedEffort = cached?.efforts.find((effort) => effort.id === effortId && !effort.disabled);
      const fallbackIndex = cached?.efforts.findIndex((effort) => effort.id === effortId);
      const targetIndex = selectedEffort?.ordering === "strength" && selectedEffort.order !== null
        ? selectedEffort.order + 1
        : selectedEffort?.order === null && fallbackIndex !== undefined && fallbackIndex >= 0
          ? fallbackIndex + 1
          : null;
      if (effortId && targetIndex !== null && targetIndex >= 1) {
        this.host.dataset.step = "set-effort";
        await attempt(() => this.adapter.setEffortIndex(menu, targetIndex, context, REFRESH_TIMEOUT_MS));
      }
      if (!context.isCurrent()) return false;

      // Readback only controls feedback; it never aborts or restarts the sequence.
      const reading = await attempt(() => this.adapter.readEffort(menu));
      const currentListing = await attempt(() => this.adapter.menuView(menu) === "models"
        ? this.adapter.readModelOptions(menu) : this.adapter.readRetainedModelOptions(menu));
      if (!context.isCurrent()) return false;
      const selectedModels = currentListing?.filter((option) => option.selected === true) ?? [];
      const observedModel = selectedModels.length === 1 ? selectedModels[0] : null;
      this.currentPageSelection = observedModel ? {
        modelId: observedModel.id,
        modelLabel: observedModel.label,
        effortLabel: reading?.label ?? null
      } : null;
      this.host.dataset.nativeResult = reading ? reading.label + ":" + reading.index + "/" + reading.total : "unreadable";
      const modelConfirmed = observedModel?.id === targetId;
      const effortConfirmed = selectedEffort && targetIndex !== null && reading &&
        matchesEffortOption(reading, selectedEffort, targetIndex, cached?.efforts.length ?? 0);
      if (modelConfirmed && (!effortId || effortConfirmed)) {
        this.setStatus("success", !effortId ? "applyModelOnly" : "applySuccess",
          { modelLabel: targetLabel, effortLabel: effortId ? reading!.label : undefined });
        this.host.dataset.step = "verified";
      } else {
        this.setStatus("quiet", "applyAttempted");
        this.host.dataset.step = "attempted";
      }
      return true;
    } finally {
      if (context.isCurrent() && !menuWasOpen) this.closeMenu(trigger, menu);
      else if (context.isCurrent() && previousView === "models") await this.adapter.showModelList(menu, context);
    }
  }

  private async waitForAutomaticMenuRetry(context: OperationContext): Promise<boolean> {
    if (!context.isCurrent() || document.visibilityState !== "visible") return false;
    this.host.dataset.step = "wait-menu-retry";
    await new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        context.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, AUTOMATIC_MENU_RETRY_DELAY_MS);
      context.signal.addEventListener("abort", finish, { once: true });
      if (context.signal.aborted) finish();
    });
    this.currentSnapshot = this.adapter.readPageSnapshot();
    return context.isCurrent() && this.pageAllowsAutomaticApply() && this.takenOverEpoch !== this.pageEpoch &&
      document.visibilityState === "visible" && this.adapter.replyGenerationState(this.currentSnapshot) === "idle";
  }

  private async requestRefresh(kind: OperationKind, priority: "background" | "user", allowSwitch: boolean): Promise<void> {
    this.refreshPageTheme();
    if (!this.adapter.isChatMode()) return;
    if (priority === "background" && this.takenOverEpoch === this.pageEpoch) return;
    await this.operations.enqueue(kind, priority, async (context) => {
      context = this.chatOperationContext(context);
      if (!context.isCurrent()) return false;
      const visibleProgress = priority === "user";
      if (visibleProgress) this.setStatus("working", "refreshWorking");
      try {
        const refreshed = await this.refreshFromPage(context, allowSwitch);
        if (visibleProgress && context.isCurrent()) {
          this.setStatus(refreshed ? "success" : "warning", refreshed ? "refreshSuccess" : "refreshFailed");
        }
        return refreshed;
      } catch {
        if (visibleProgress && context.isCurrent()) this.setStatus("warning", "refreshFailed");
        return false;
      }
    });
  }

  private async refreshFromPage(context: OperationContext, allowSwitch: boolean): Promise<boolean> {
    if (allowSwitch) context = this.nativeInteractionContext(context);
    if (allowSwitch && !(await this.adapter.settlePageInput(context))) return false;
    if (!context.isCurrent()) return false;
    const trigger = this.adapter.findModelTrigger();
    if (!trigger) return false;
    if (!allowSwitch) return this.readExistingElements(context, trigger);
    if (this.currentSnapshot.kind === "history") {
      if (this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") return false;
      return this.refreshHistoryMenu(context, trigger);
    }
    if (this.currentSnapshot.kind !== "new-empty") return false;
    const menuWasOpen = trigger.getAttribute("aria-expanded") === "true";
    const previousMenu = menuWasOpen ? this.adapter.findMenu(trigger) : null;
    const previousView = previousMenu ? this.adapter.menuView(previousMenu) : "unknown";
    this.host.dataset.step = "refresh-open-menu";
    const menu = await this.adapter.ensureMenuOpen(trigger, context, MENU_OPEN_TIMEOUT_MS);
    if (!menu || !context.isCurrent()) {
      if (context.isCurrent() && !menuWasOpen) {
        this.host.dataset.nativeResult = this.adapter.menuReadinessDiagnostic;
        const opened = this.adapter.findMenu(trigger);
        if (opened) this.closeMenu(trigger, opened);
      }
      return false;
    }

    let originalModel: ModelMenuOption | null = null;
    let originalEffort: number | null = null;
    let resultSnapshot: CapabilitiesSnapshot | null = null;
    try {
      if (!(await this.adapter.showModelList(menu, context))) return false;
      const listing = this.adapter.readModelOptions(menu);
      if (listing.length === 0) return false;
      originalModel = this.adapter.currentModel(menu);
      if (!originalModel) return false;
      const observed = new Map<string, ModelCapability>();
      for (const option of listing) {
        observed.set(option.id, this.adapter.toModelCapability(option));
      }

      if (!(await this.switchNativeModel(menu, originalModel.id, context))) return false;
      const originalReading = this.adapter.readEffort(menu);
      if (originalReading) originalEffort = originalReading.index;
      this.currentPageSelection = {
        modelId: originalModel.id,
        modelLabel: originalModel.label,
        effortLabel: originalReading?.label ?? null
      };

      if (originalReading && originalModel.availability === "available") {
        const efforts = await this.adapter.enumerateEfforts(menu, context, REFRESH_TIMEOUT_MS);
        if (efforts && context.isCurrent()) {
          observed.set(originalModel.id, this.adapter.toModelCapability(originalModel, efforts));
        }
      }

      resultSnapshot = {
        scopeKey: this.adapter.scopeKey(),
        completeness: "partial",
        models: [...observed.values()]
      };
    } finally {
      if (context.isCurrent()) {
        if (originalModel) {
          await this.switchNativeModel(menu, originalModel.id, context);
          if (originalEffort !== null) await this.adapter.setEffortIndex(menu, originalEffort, context, REFRESH_TIMEOUT_MS);
        }
        if (!context.isCurrent()) return false;
        if (allowSwitch && !menuWasOpen) this.closeMenu(trigger, menu);
        else if (previousView === "models") await this.adapter.showModelList(menu, context);
      }
    }

    if (!resultSnapshot || !context.isCurrent()) return false;
    const merged = await mergeAndSaveCapabilities(resultSnapshot, context.isCurrent);
    if (!merged || !context.isCurrent()) return false;
    this.capabilities = merged;
    this.renderPanel();
    return this.capabilities.models.length > 0;
  }

  private async refreshHistoryMenu(
    context: OperationContext,
    trigger: HTMLElement
  ): Promise<boolean> {
    const wasOpen = trigger.getAttribute("aria-expanded") === "true";
    const previousMenu = wasOpen ? this.adapter.findMenu(trigger) : null;
    const previousView = previousMenu ? this.adapter.menuView(previousMenu) : "unknown";
    let originalEffort: number | null = null;
    const menu = await this.adapter.ensureMenuOpen(trigger, context, MENU_OPEN_TIMEOUT_MS);
    if (!menu || !context.isCurrent() || this.adapter.replyGenerationState(this.currentSnapshot) !== "idle") return false;
    try {
      if (!(await this.adapter.showModelList(menu, context))) return false;
      const listing = this.adapter.readModelOptions(menu);
      if (listing.length === 0 || !context.isCurrent()) return false;
      const observedModels = listing.map((option) => this.adapter.toModelCapability(option));
      const currentModel = this.adapter.currentModel(menu);
      const currentOption = currentModel && listing.find((option) => option.id === currentModel.id);
      if (currentModel && currentOption?.availability === "available" &&
        this.adapter.replyGenerationState(this.currentSnapshot) === "idle" &&
        await this.switchNativeModel(menu, currentModel.id, context)) {
        const reading = this.adapter.readEffort(menu);
        if (reading) {
          originalEffort = reading.index;
          this.currentPageSelection = {
            modelId: currentModel.id,
            modelLabel: currentOption.label,
            effortLabel: reading.label
          };
          const efforts = await this.adapter.enumerateEfforts(menu, context, REFRESH_TIMEOUT_MS);
          if (efforts && context.isCurrent() && this.adapter.replyGenerationState(this.currentSnapshot) === "idle") {
            const index = observedModels.findIndex((model) => model.id === currentModel.id);
            if (index >= 0) observedModels[index] = this.adapter.toModelCapability(currentOption, efforts);
          }
        }
      } else if (currentModel && currentOption) {
        this.currentPageSelection = {
          modelId: currentModel.id,
          modelLabel: currentOption.label,
          effortLabel: null
        };
      }

      const snapshot: CapabilitiesSnapshot = {
        scopeKey: this.adapter.scopeKey(),
        completeness: "partial",
        models: observedModels
      };
      const merged = await mergeAndSaveCapabilities(snapshot, context.isCurrent);
      if (!merged || !context.isCurrent()) return false;
      this.capabilities = merged;
      this.renderPanel();
      return this.capabilities.models.length > 0;
    } finally {
      if (context.isCurrent() && !wasOpen) {
        this.closeMenu(trigger, menu);
      } else if (context.isCurrent() && previousView === "effort") {
        const selected = await this.ensureModelsView(menu, context);
        const current = selected ? this.adapter.currentModel(selected) : null;
        if (current) {
          await this.switchNativeModel(menu, current.id, context);
          if (originalEffort !== null) await this.adapter.setEffortIndex(menu, originalEffort, context, REFRESH_TIMEOUT_MS);
        }
      } else if (context.isCurrent() && previousView === "models") {
        await this.adapter.showModelList(menu, context);
      }
    }
  }

  private async readExistingElements(
    context: OperationContext,
    trigger: HTMLElement
  ): Promise<boolean> {
    // Both visible and retained native rows are read-only observations of this associated menu.
    const menu = this.adapter.findMenu(trigger);
    if (!menu || !context.isCurrent()) return false;
    const view = this.adapter.menuView(menu);
    const listing = view === "models"
      ? this.adapter.readModelOptions(menu)
      : this.adapter.readRetainedModelOptions(menu);
    if (listing.length === 0 || !context.isCurrent()) return false;
    const selected = listing.filter((option) => option.selected === true);
    const reading = view === "effort" ? this.adapter.readEffort(menu) : null;
    if (selected.length === 1) {
      this.currentPageSelection = {
        modelId: selected[0].id,
        modelLabel: selected[0].label,
        effortLabel: reading?.label ?? null
      };
    }
    const observedModels = listing.map((option) => {
      const observed = this.adapter.toModelCapability(option);
      const cached = this.getCurrentCapabilities().models.find((model) => model.id === option.id);
      if (selected.length === 1 && selected[0].id === option.id && reading?.ordered && reading.nativeId &&
        cached?.effortState === "observed" && cached.efforts.length === reading.total) {
        const matching = cached.efforts.find((effort) => effort.id === "native:" + reading.nativeId);
        if (matching?.order === reading.index - 1) {
          return { ...observed, effortState: cached.effortState, efforts: cached.efforts.map((effort) =>
            effort.id === matching.id ? { ...effort, label: reading.label } : effort) };
        }
      }
      return observed;
    });
    const snapshot: CapabilitiesSnapshot = {
      scopeKey: this.adapter.scopeKey(),
      completeness: "partial",
      models: observedModels
    };
    const merged = await mergeAndSaveCapabilities(snapshot, context.isCurrent);
    if (!merged || !context.isCurrent()) return false;
    this.capabilities = merged;
    this.renderPanel();
    return context.isCurrent() && this.capabilities.models.length > 0;
  }

  private async ensureModelsView(menu: HTMLElement, context: OperationContext): Promise<HTMLElement | null> {
    if (await this.adapter.showModelList(menu, context)) return menu;
    return null;
  }

  private async switchNativeModel(
    menu: HTMLElement,
    modelId: string,
    context: OperationContext
  ): Promise<boolean> {
    if (!context.isCurrent() || !(await this.adapter.showModelList(menu, context))) return false;
    const selected = this.adapter.currentModel(menu);
    if (selected?.id === modelId) return this.adapter.showEffortControl(menu, context);
    const target = this.adapter.readModelOptions(menu).find((option) => option.id === modelId);
    if (!target || target.availability !== "available") return false;
    target.element.click();
    const started = Date.now();
    while (context.isCurrent() && Date.now() - started <= REFRESH_TIMEOUT_MS) {
      if (this.adapter.menuView(menu) === "effort") return true;
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    return false;
  }

  private closeMenu(trigger: HTMLElement, menu: HTMLElement): void {
    if (!trigger.isConnected) trigger = this.adapter.findModelTrigger() ?? trigger;
    if (!trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true") return;
    trigger.focus({ preventScroll: true });
    // A single close action avoids reopening a menu while an Escape update is still pending.
    if (this.adapter.findMenu(trigger) === menu || !menu.isConnected) trigger.click();
  }

  private async tryOpportunisticRefresh(): Promise<void> {
    this.refreshPageTheme();
    if (!this.adapter.isChatMode()) return;
    if (this.takenOverEpoch !== this.pageEpoch) return;
    const trigger = this.adapter.findModelTrigger();
    if (!trigger) return;
    const menu = this.adapter.findMenu(trigger);
    if (!menu) return;
    try {
      await this.operations.enqueue("opportunistic-read", "background", async (context) => {
        context = this.chatOperationContext(context);
        if (!context.isCurrent() || this.adapter.findMenu(trigger) !== menu) return false;
        return this.readExistingElements(context, trigger);
      });
    } catch {
      // A passive page read is best effort; the settings button remains available for a manual retry.
    }
  }

  private setStatus(tone: StatusTone, key: MessageKey, selection: { modelLabel: string; effortLabel?: string } | null = null): void {
    if (this.statusTone === tone && this.statusKey === key &&
      this.statusSelection?.modelLabel === selection?.modelLabel && this.statusSelection?.effortLabel === selection?.effortLabel) return;
    this.statusTone = tone;
    this.statusKey = key;
    this.statusSelection = selection;
    this.renderPanel();
  }

  private chatOperationContext(context: OperationContext): OperationContext {
    const isCurrent = () => context.isCurrent() && this.adapter.isChatMode();
    return {
      signal: context.signal,
      isCurrent,
      assertCurrent: () => { if (!isCurrent()) throw new OperationCancelledError(); }
    };
  }

  private nativeInteractionContext(context: OperationContext): OperationContext {
    context = this.chatOperationContext(context);
    const isCurrent = () => context.isCurrent() && this.adapter.replyGenerationState(this.currentSnapshot) === "idle";
    return {
      signal: context.signal,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new OperationCancelledError();
      }
    };
  }
}

const scope = window as Window & { [ROOT_FLAG]?: boolean };
if (!scope[ROOT_FLAG] && CAPABILITY_SCOPE_HOSTS.has(window.location.hostname)) {
  scope[ROOT_FLAG] = true;
  new ExtensionController();
}
