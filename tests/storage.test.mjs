import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/storage.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false
});
const storageModule = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const { loadStorage, mergeAndSaveCapabilities } = storageModule;

const snapshot = {
  scopeKey: "chatgpt.com",
  completeness: "partial",
  models: [{
    id: "label:GPT-6",
    label: "GPT-6",
    availability: "available",
    effortState: "not-read",
    efforts: []
  }]
};

test("ignores mixed legacy model cache while preserving preferences and writing only chat cache", async () => {
  const preferences = { schemaVersion: 1, modelId: "label:GPT-6", effortByModel: {}, autoApply: true };
  let state = {
    preferences,
    capabilities: { ...snapshot, schemaVersion: 1, lastSuccessfulReadAt: 1,
      models: [{ ...snapshot.models[0], id: "label:Work-only", label: "Work-only" }] }
  };
  const legacy = state.capabilities;
  globalThis.chrome = { storage: { local: {
    get: async () => state,
    set: async (value) => { state = { ...state, ...value }; }
  } } };
  try {
    const loaded = await storageModule.loadStorage();
    assert.equal(loaded.capabilities.kind, "missing");
    assert.deepEqual(loaded.preferences.value, { ...preferences, applyWithNativeMenuOpen: false, applyInHistory: false });
    await mergeAndSaveCapabilities(snapshot);
    assert.equal(state.capabilities, legacy);
    assert.deepEqual(state.chatCapabilities.models.map((model) => model.label), ["GPT-6"]);
    assert.deepEqual(state.preferences, preferences);
  } finally {
    delete globalThis.chrome;
  }
});

test("discards an automatic refresh if its operation becomes stale while storage is being read", async () => {
  let current = true;
  let writes = 0;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => {
          current = false;
          return {};
        },
        set: async () => { writes += 1; }
      }
    }
  };

  const result = await mergeAndSaveCapabilities(snapshot, () => current);
  assert.equal(result, null);
  assert.equal(writes, 0);
  delete globalThis.chrome;
});

test("persists a useful partial observation only while its operation remains current", async () => {
  let writes = 0;
  let stored;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async (value) => {
          writes += 1;
          stored = value.chatCapabilities;
        }
      }
    }
  };

  const result = await mergeAndSaveCapabilities(snapshot, () => true);
  assert.equal(writes, 1);
  assert.equal(result?.models[0].id, "label:GPT-6");
  assert.deepEqual(stored, result);
  delete globalThis.chrome;
});

test("normalizes legacy completeness values to partial in memory and storage", async () => {
  let state = {
    chatCapabilities: {
      ...snapshot,
      schemaVersion: 1,
      completeness: "unknown",
      lastSuccessfulReadAt: 1
    }
  };
  globalThis.chrome = { storage: { local: {
    get: async () => state,
    set: async (value) => { state = { ...state, ...value }; }
  } } };
  try {
    const loaded = await loadStorage();
    assert.equal(loaded.capabilities.kind, "valid");
    assert.equal(loaded.capabilities.value.completeness, "partial");
    assert.equal(state.chatCapabilities.completeness, "partial");
  } finally {
    delete globalThis.chrome;
  }
});

test("passive identical observations avoid a storage write while manual reads record their time", async () => {
  let writes = 0;
  let state = {};
  globalThis.chrome = { storage: { local: {
    get: async () => state,
    set: async (value) => { writes += 1; state = { ...state, ...value }; }
  } } };
  await mergeAndSaveCapabilities(snapshot, () => true, { onlyIfChanged: true });
  const first = state.chatCapabilities;
  await mergeAndSaveCapabilities(snapshot, () => true, { onlyIfChanged: true });
  assert.equal(writes, 1);
  assert.equal(state.chatCapabilities, first);
  await mergeAndSaveCapabilities(snapshot);
  assert.equal(writes, 2);
  delete globalThis.chrome;
});

test("delayed preference notifications from this page cannot cancel its apply; external changes still notify", async () => {
  let callback;
  let saved;
  globalThis.chrome = { storage: {
    local: { set: async (value) => { saved = value.preferences; } },
    onChanged: { addListener: (fn) => { callback = fn; }, removeListener: () => {} }
  } };
  const seen = [];
  const unsubscribe = storageModule.subscribeToStorageChanges((change) => seen.push(change));
  await storageModule.savePreferences({ schemaVersion: 1, modelId: "label:GPT-6", effortByModel: {}, autoApply: true });
  callback({ preferences: { newValue: saved } }, "local");
  assert.equal(seen.length, 0);
  callback({ preferences: { newValue: { ...saved, _writeOrigin: "another-tab", modelId: "other" } } }, "local");
  assert.equal(seen[0].preferences.value.modelId, "other");
  unsubscribe();
  delete globalThis.chrome;
});
