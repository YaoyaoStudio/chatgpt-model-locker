import assert from "node:assert/strict";
import test from "node:test";
import { OperationQueue } from "../src/operation-queue.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
};

test("native UI operations run one at a time and user work jumps queued background work", async () => {
  const queue = new OperationQueue();
  queue.setPage("new-chat");
  const gate = deferred();
  const order = [];

  const active = queue.enqueue("apply", "background", async () => {
    order.push("active-start");
    await gate.promise;
    order.push("active-end");
    return "done";
  });
  const passive = queue.enqueue("passive-refresh", "background", () => order.push("passive"));
  const manual = queue.enqueue("manual-refresh", "user", () => order.push("manual"));
  gate.resolve();

  await Promise.all([active, passive, manual]);
  assert.deepEqual(order, ["active-start", "active-end", "manual", "passive"]);
});

test("old queued work is cancelled after navigation without invoking its callback", async () => {
  const queue = new OperationQueue();
  queue.setPage("new-chat");
  const gate = deferred();
  let staleSideEffect = false;
  const active = queue.enqueue("apply", "background", () => gate.promise);
  const stale = queue.enqueue("passive-refresh", "background", () => {
    staleSideEffect = true;
  });
  queue.setPage("another-new-chat");
  gate.resolve("finished");

  assert.deepEqual(await active, { status: "cancelled" });
  assert.deepEqual(await stale, { status: "cancelled" });
  assert.equal(staleSideEffect, false);
});

test("repeated requests of the same kind and context are coalesced", async () => {
  const queue = new OperationQueue();
  const gate = deferred();
  let calls = 0;
  const run = () =>
    queue.enqueue("manual-refresh", "user", async () => {
      calls += 1;
      await gate.promise;
      return calls;
    });
  const first = run();
  const second = run();
  gate.resolve();

  assert.deepEqual(await first, { status: "completed", value: 1 });
  assert.deepEqual(await second, { status: "completed", value: 1 });
  assert.equal(calls, 1);
});

test("preference changes abort the active context and prevent its result from committing", async () => {
  const queue = new OperationQueue();
  let finished = false;
  const run = queue.enqueue("apply", "background", async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    finished = true;
    return "stale";
  });
  queue.preferencesChanged();

  assert.deepEqual(await run, { status: "cancelled" });
  assert.equal(finished, true);
});
