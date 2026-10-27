import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyCapabilities,
  emptyPreferences,
  preferencesEqual,
  capabilityDataEqual,
  mergeCapabilities,
  readCapabilities,
  readPreferences
} from "../src/domain.ts";

const model = (id, overrides = {}) => ({
  id,
  label: id,
  availability: "available",
  effortState: "not-read",
  efforts: [],
  ...overrides
});

const effort = (id, order) => ({
  id,
  label: id,
  ordering: "strength",
  order,
  disabled: false
});

test("malformed stored preferences are rejected without being treated as an empty saved value", () => {
  const result = readPreferences({ schemaVersion: 99, modelId: "old-choice" });
  assert.equal(result.kind, "invalid");
  assert.deepEqual(result.value, emptyPreferences());
});

test("native-menu preference defaults off for old settings and validates the stored switch", () => {
  const legacy = { schemaVersion: 1, modelId: "saved-model", effortByModel: { "saved-model": "high" }, autoApply: true };
  assert.deepEqual(readPreferences(legacy), { kind: "valid", value: { ...legacy, applyWithNativeMenuOpen: false, applyInHistory: false } });
  assert.equal(readPreferences({ ...legacy, applyWithNativeMenuOpen: true }).value.applyWithNativeMenuOpen, true);
  assert.equal(readPreferences({ ...legacy, applyWithNativeMenuOpen: "true" }).kind, "invalid");
  assert.equal(readPreferences({ ...legacy, applyInHistory: true }).value.applyInHistory, true);
  assert.equal(readPreferences({ ...legacy, applyInHistory: "true" }).kind, "invalid");
});

test("observations merge models and preserve unobserved effort data", () => {
  const previous = {
    ...emptyCapabilities("chatgpt.com:zh-CN"),
    lastSuccessfulReadAt: 100,
    models: [
      model("alpha", { effortState: "observed", efforts: [effort("low", 0)] }),
      model("beta")
    ]
  };

  const merged = mergeCapabilities(
    previous,
    { scopeKey: previous.scopeKey, completeness: "partial", models: [model("alpha")] },
    200
  );

  assert.deepEqual(merged.models.map((entry) => entry.id), ["alpha", "beta"]);
  assert.equal(merged.completeness, "partial");
  assert.equal(merged.models[0].efforts[0].id, "low");
  assert.equal(merged.lastSuccessfulReadAt, 200);
});

test("an empty observation does not erase valid cached choices or claim a refresh", () => {
  const previous = {
    ...emptyCapabilities("chatgpt.com:en"),
    lastSuccessfulReadAt: 100,
    models: [model("alpha")]
  };

  const merged = mergeCapabilities(
    previous,
    { scopeKey: previous.scopeKey, completeness: "partial", models: [] },
    200
  );

  assert.deepEqual(merged, previous);
});

test("legacy completeness statuses are normalized and never prune cached models", () => {
  const previous = {
    ...emptyCapabilities("chatgpt.com:en"),
    completeness: "complete",
    lastSuccessfulReadAt: 100,
    models: [model("alpha"), model("beta")]
  };

  const merged = mergeCapabilities(
    previous,
    { scopeKey: previous.scopeKey, completeness: "complete", models: [model("alpha")] },
    200
  );
  assert.deepEqual(merged.models.map((entry) => entry.id), ["alpha", "beta"]);
  assert.equal(merged.completeness, "partial");

  const newScope = mergeCapabilities(
    previous,
    { scopeKey: "chatgpt.com:zh-CN", completeness: "partial", models: [model("gamma")] },
    300
  );
  assert.equal(newScope.scopeKey, "chatgpt.com:zh-CN");
  assert.deepEqual(newScope.models.map((entry) => entry.id), ["gamma"]);

  for (const legacyStatus of ["complete", "partial", "unknown", undefined]) {
    const cached = { ...emptyCapabilities("chatgpt.com:en"), models: [model("alpha")] };
    if (legacyStatus !== undefined) cached.completeness = legacyStatus;
    else delete cached.completeness;
    const parsed = readCapabilities(cached);
    assert.equal(parsed.kind, "valid");
    assert.equal(parsed.value.completeness, "partial");
  }
});

test("an explicitly unsupported reasoning control clears only that model's stale effort list", () => {
  const previous = {
    ...emptyCapabilities("chatgpt.com:en"),
    completeness: "partial",
    lastSuccessfulReadAt: 100,
    models: [model("alpha", { effortState: "observed", efforts: [effort("high", 2)] })]
  };

  const merged = mergeCapabilities(
    previous,
    {
      scopeKey: previous.scopeKey,
      completeness: "partial",
      models: [model("alpha", { effortState: "unsupported" })]
    },
    200
  );

  assert.equal(merged.models[0].effortState, "unsupported");
  assert.deepEqual(merged.models[0].efforts, []);
});

test("partial updates keep existing model order and unchanged observations compare without timestamps", () => {
  const previous = { ...emptyCapabilities("chatgpt.com"), completeness: "partial", lastSuccessfulReadAt: 100,
    models: [model("alpha"), model("beta")] };
  const same = mergeCapabilities(previous, { scopeKey: previous.scopeKey, completeness: "partial", models: [model("beta")] }, 200);
  assert.deepEqual(same.models.map((entry) => entry.id), ["alpha", "beta"]);
  assert.equal(capabilityDataEqual(previous, same), true);
  const changed = mergeCapabilities(same, { scopeKey: previous.scopeKey, completeness: "partial", models: [model("gamma")] }, 300);
  assert.deepEqual(changed.models.map((entry) => entry.id), ["alpha", "beta", "gamma"]);
  assert.equal(capabilityDataEqual(same, changed), false);
});

test("preference equality ignores key order and missing unset entries but detects a changed target", () => {
  const left = { ...emptyPreferences(), effortByModel: { a: "label:High", b: null } };
  const right = { ...emptyPreferences(), effortByModel: { a: "label:High" } };
  assert.equal(preferencesEqual(left, right), true);
  assert.equal(preferencesEqual(left, { ...right, modelId: "a" }), false);
  assert.equal(preferencesEqual(left, { ...right, applyWithNativeMenuOpen: true }), false);
  assert.equal(preferencesEqual(left, { ...right, applyInHistory: true }), false);
  assert.equal(preferencesEqual(left, { ...right, effortByModel: { a: "label:Medium" } }), false);
});
