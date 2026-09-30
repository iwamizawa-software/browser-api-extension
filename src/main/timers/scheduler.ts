// Pure timer bookkeeping that mirrors Chromium's DOMTimer / TimerBase:
//   third_party/blink/renderer/core/scheduler/dom_timer.cc
//   third_party/blink/renderer/platform/timer.cc
//
// It knows nothing about how it is woken up. The host provides a clock and an
// `invoke` function, calls `runNextDue()` whenever it gets a chance, and is
// told via `onChange` whenever the earliest deadline may have changed.

import { MinHeap } from "./heap";

/** Chromium: kSpecCompliantMaxTimerNestingLevel (counters start at 1). */
export const MAX_NESTING_LEVEL = 6;
/** Chromium: kMinimumInterval. */
export const MINIMUM_INTERVAL_MS = 4;
export const MAX_TIMER_ID = 0x7fffffff;

export interface SchedulerHost {
  now(): number;
  /** Runs a handler. Must not throw (report errors instead). */
  invoke(handler: unknown, args: readonly unknown[]): void;
  /** The earliest deadline may have changed. */
  onChange(): void;
}

interface Timer {
  id: number;
  handler: unknown;
  args: readonly unknown[];
  repeat: boolean;
  interval: number;
  nesting: number;
  /** Scheduled fire time for the current heap entry. */
  deadline: number;
  /** Sequence number of the current heap entry; stale entries are skipped. */
  seq: number;
}

interface Entry {
  deadline: number;
  seq: number;
  timer: Timer;
}

/**
 * base::TimeTicks::SnappedToNextTick: the first `phase + k * interval`
 * (k integer) that is >= `t`.
 */
export function snappedToNextTick(t: number, phase: number, interval: number): number {
  let offset = (phase - t) % interval;
  if (offset !== 0 && phase < t) offset += interval;
  return t + offset;
}

function clampAdd1(n: number): number {
  return n >= MAX_TIMER_ID ? MAX_TIMER_ID : n + 1;
}

export class TimerScheduler {
  private readonly timers = new Map<number, Timer>();
  private readonly heap = new MinHeap<Entry>();
  private lastId = 0;
  private seqCounter = 0;
  /** Nesting level of the currently running timer (0 = not inside a timer). */
  private currentNesting = 0;

  constructor(private readonly host: SchedulerHost) {}

  get activeCount(): number {
    return this.timers.size;
  }

  /**
   * `timeout` must already be converted with WebIDL `long` semantics.
   * Returns the new ID (shared by setTimeout and setInterval).
   */
  add(handler: unknown, timeout: number, args: readonly unknown[], repeat: boolean): number {
    const id = this.nextId();
    const nesting = clampAdd1(this.currentNesting);
    let t = timeout < 0 ? 0 : timeout;
    if (nesting > MAX_NESTING_LEVEL && t < MINIMUM_INTERVAL_MS) t = MINIMUM_INTERVAL_MS;
    // Note: no 1ms clamp for setInterval (Chromium kSetIntervalWithoutClamp is
    // enabled by default) and none for setTimeout either.
    const now = this.host.now();
    const timer: Timer = { id, handler, args, repeat, interval: t, nesting, deadline: now + t, seq: 0 };
    this.timers.set(id, timer);
    this.schedule(timer, now + t);
    this.host.onChange();
    return id;
  }

  clear(id: number): void {
    if (id <= 0) return;
    if (this.timers.delete(id)) {
      this.maybeCompact();
      this.host.onChange();
    }
  }

  /** Earliest pending deadline, or null when nothing is scheduled. */
  nextDeadline(): number | null {
    const top = this.peekValid();
    return top ? top.deadline : null;
  }

  hasDue(): boolean {
    const top = this.peekValid();
    return top !== undefined && top.deadline <= this.host.now();
  }

  /**
   * Runs the single earliest timer if it is due. The host should call this
   * once per task so that microtasks run between timer callbacks, just like
   * native timers each run in their own task.
   */
  runNextDue(): boolean {
    const top = this.peekValid();
    if (!top) return false;
    const now = this.host.now();
    if (top.deadline > now) return false;
    this.heap.pop();
    const timer = top.timer;
    // Chromium sets the coordinator nesting level before incrementing the
    // interval's own level (DOMTimer::Fired).
    const levelDuringCallback = timer.nesting;
    if (timer.repeat) {
      this.reschedule(timer, now);
    } else {
      // One-shot timers are unregistered before the callback runs.
      this.timers.delete(timer.id);
    }
    this.currentNesting = levelDuringCallback;
    try {
      this.host.invoke(timer.handler, timer.args);
    } finally {
      this.currentNesting = 0;
    }
    this.host.onChange();
    return true;
  }

  private reschedule(timer: Timer, now: number): void {
    // TimerBase::RunInternal computes the next fire time *before* running.
    const wasImmediate = timer.interval === 0;
    let next = wasImmediate
      ? now
      : snappedToNextTick(now + timer.interval / 20, timer.deadline, timer.interval);
    // DOMTimer::Fired: IncrementNestingLevel, then AugmentRepeatInterval when
    // the level reaches kMaxTimerNestingLevel + 1.
    timer.nesting = clampAdd1(timer.nesting);
    if (timer.nesting === MAX_NESTING_LEVEL + 1 && timer.interval < MINIMUM_INTERVAL_MS) {
      const delta = MINIMUM_INTERVAL_MS - timer.interval;
      next = wasImmediate ? now + delta : next + delta;
      timer.interval += delta;
    }
    this.schedule(timer, next);
  }

  private schedule(timer: Timer, deadline: number): void {
    timer.deadline = deadline;
    timer.seq = ++this.seqCounter;
    this.heap.push({ deadline, seq: timer.seq, timer });
  }

  private isValid(e: Entry): boolean {
    return this.timers.get(e.timer.id) === e.timer && e.timer.seq === e.seq;
  }

  private peekValid(): Entry | undefined {
    for (;;) {
      const top = this.heap.peek();
      if (!top || this.isValid(top)) return top;
      this.heap.pop();
    }
  }

  private maybeCompact(): void {
    // Lazy deletion leaves stale entries behind (e.g. debounce patterns that
    // keep clearing long timeouts). Rebuild when they dominate.
    if (this.heap.size > 64 && this.heap.size > 2 * this.timers.size) {
      this.heap.filter((e) => this.isValid(e));
    }
  }

  /** DOMTimerCoordinator::NextID: circular, skipping IDs still in use. */
  private nextId(): number {
    for (;;) {
      this.lastId = this.lastId >= MAX_TIMER_ID ? 1 : this.lastId + 1;
      if (!this.timers.has(this.lastId)) return this.lastId;
    }
  }

  /** Test hook: forces the ID counter (to exercise wrap-around). */
  setLastIdForTesting(id: number): void {
    this.lastId = id;
  }
}
