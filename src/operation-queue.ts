export type OperationKind = "apply" | "passive-refresh" | "opportunistic-read" | "manual-refresh";
export type OperationPriority = "background" | "user";

export type OperationResult<T> = { status: "completed"; value: T } | { status: "cancelled" };

export class OperationCancelledError extends Error {
  constructor() {
    super("Operation is no longer current.");
    this.name = "OperationCancelledError";
  }
}

export interface OperationContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}

interface Stamp {
  pageGeneration: number;
  preferenceVersion: number;
  takeoverVersion: number;
}

interface QueueItem<T> {
  id: number;
  kind: OperationKind;
  priority: OperationPriority;
  sequence: number;
  stamp: Stamp;
  execute(context: OperationContext): Promise<T> | T;
  resolve(result: OperationResult<T>): void;
  reject(reason: unknown): void;
  promise: Promise<OperationResult<T>>;
}

interface PendingItem {
  stamp: Stamp;
  promise: Promise<OperationResult<unknown>>;
}

interface ActiveItem {
  id: number;
  controller: AbortController;
}

/** Serializes native-control work and invalidates tasks tied to stale page or preference state. */
export class OperationQueue {
  private pageKey = "";
  private pageGeneration = 0;
  private preferenceVersion = 0;
  private takeoverVersion = 0;
  private nextId = 1;
  private nextSequence = 1;
  private pumping = false;
  private active: ActiveItem | undefined;
  private readonly queued: QueueItem<unknown>[] = [];
  private readonly pendingByKind = new Map<OperationKind, PendingItem>();

  setPage(pageKey: string): void {
    if (pageKey === this.pageKey) return;
    this.pageKey = pageKey;
    this.pageGeneration += 1;
    this.abortActive();
  }

  preferencesChanged(): void {
    this.preferenceVersion += 1;
    this.abortActive();
  }

  userTookControl(): void {
    this.takeoverVersion += 1;
    this.abortActive();
  }

  enqueue<T>(
    kind: OperationKind,
    priority: OperationPriority,
    execute: (context: OperationContext) => Promise<T> | T
  ): Promise<OperationResult<T>> {
    const stamp = this.snapshot();
    const existing = this.pendingByKind.get(kind);
    if (existing && sameStamp(existing.stamp, stamp)) {
      return existing.promise as Promise<OperationResult<T>>;
    }

    let resolve!: (result: OperationResult<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<OperationResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: QueueItem<T> = {
      id: this.nextId++,
      kind,
      priority,
      sequence: this.nextSequence++,
      stamp,
      execute,
      resolve,
      reject,
      promise
    };

    this.pendingByKind.set(kind, { stamp, promise: promise as Promise<OperationResult<unknown>> });
    this.queued.push(item as QueueItem<unknown>);
    void this.pump();
    return promise;
  }

  private snapshot(): Stamp {
    return {
      pageGeneration: this.pageGeneration,
      preferenceVersion: this.preferenceVersion,
      takeoverVersion: this.takeoverVersion
    };
  }

  private isCurrent(stamp: Stamp): boolean {
    return sameStamp(stamp, this.snapshot());
  }

  private abortActive(): void {
    this.active?.controller.abort();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queued.length > 0) {
        this.queued.sort((left, right) => {
          const priority = priorityRank(right.priority) - priorityRank(left.priority);
          return priority || left.sequence - right.sequence;
        });
        const item = this.queued.shift();
        if (!item) continue;
        if (!this.isCurrent(item.stamp)) {
          item.resolve({ status: "cancelled" });
          this.clearPending(item);
          continue;
        }

        const controller = new AbortController();
        this.active = { id: item.id, controller };
        const context: OperationContext = {
          signal: controller.signal,
          isCurrent: () => !controller.signal.aborted && this.isCurrent(item.stamp),
          assertCurrent: () => {
            if (controller.signal.aborted || !this.isCurrent(item.stamp)) {
              throw new OperationCancelledError();
            }
          }
        };

        try {
          const value = await item.execute(context);
          item.resolve(context.isCurrent() ? { status: "completed", value } : { status: "cancelled" });
        } catch (error) {
          if (!context.isCurrent() || error instanceof OperationCancelledError) {
            item.resolve({ status: "cancelled" });
          } else {
            item.reject(error);
          }
        } finally {
          if (this.active?.id === item.id) this.active = undefined;
          this.clearPending(item);
        }
      }
    } finally {
      this.pumping = false;
      if (this.queued.length > 0) void this.pump();
    }
  }

  private clearPending(item: QueueItem<unknown>): void {
    const pending = this.pendingByKind.get(item.kind);
    if (pending?.promise === item.promise) this.pendingByKind.delete(item.kind);
  }
}

function priorityRank(priority: OperationPriority): number {
  return priority === "user" ? 1 : 0;
}

function sameStamp(left: Stamp, right: Stamp): boolean {
  return (
    left.pageGeneration === right.pageGeneration &&
    left.preferenceVersion === right.preferenceVersion &&
    left.takeoverVersion === right.takeoverVersion
  );
}
