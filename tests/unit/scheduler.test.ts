import { beforeEach, describe, expect, it } from "vitest";
import { MAX_TIMER_ID, TimerScheduler, snappedToNextTick } from "../../src/main/timers/scheduler";
import { MinHeap } from "../../src/main/timers/heap";
import { toLong, toTimerHandler } from "../../src/main/timers/webidl";

class Harness {
  t = 0;
  log: string[] = [];
  changes = 0;
  errors: unknown[] = [];
  s = new TimerScheduler({
    now: () => this.t,
    invoke: (handler, args) => {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (e) {
        this.errors.push(e);
      }
    },
    onChange: () => {
      this.changes++;
    },
  });

  /** Runs every due timer, one per "task", in order. */
  flush(): void {
    while (this.s.runNextDue()) {
      /* keep going */
    }
  }

  /** Advances the clock to `to`, firing timers at their deadlines. */
  advanceTo(to: number): void {
    for (;;) {
      const d = this.s.nextDeadline();
      if (d === null || d > to) break;
      if (d > this.t) this.t = d;
      this.s.runNextDue();
    }
    this.t = to;
  }

  fn(label: string) {
    return () => {
      this.log.push(`${label}@${this.t}`);
    };
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe("MinHeap", () => {
  it("orders by deadline then seq", () => {
    const heap = new MinHeap<{ deadline: number; seq: number }>();
    const items = [
      { deadline: 5, seq: 3 },
      { deadline: 1, seq: 9 },
      { deadline: 5, seq: 1 },
      { deadline: 0, seq: 7 },
      { deadline: 1, seq: 2 },
    ];
    for (const i of items) heap.push(i);
    const out: string[] = [];
    while (heap.size) {
      const x = heap.pop()!;
      out.push(`${x.deadline}/${x.seq}`);
    }
    expect(out).toEqual(["0/7", "1/2", "1/9", "5/1", "5/3"]);
  });

  it("filter keeps heap property", () => {
    const heap = new MinHeap<{ deadline: number; seq: number }>();
    for (let i = 0; i < 100; i++) heap.push({ deadline: (i * 37) % 101, seq: i });
    heap.filter((x) => x.seq % 2 === 0);
    let prev = -1;
    let n = 0;
    while (heap.size) {
      const x = heap.pop()!;
      expect(x.deadline).toBeGreaterThanOrEqual(prev);
      prev = x.deadline;
      n++;
    }
    expect(n).toBe(50);
  });
});

describe("WebIDL conversions", () => {
  it("toLong behaves like ToInt32", () => {
    expect(toLong(undefined)).toBe(0);
    expect(toLong(null)).toBe(0);
    expect(toLong(NaN)).toBe(0);
    expect(toLong(Infinity)).toBe(0);
    expect(toLong(-Infinity)).toBe(0);
    expect(toLong("100")).toBe(100);
    expect(toLong("abc")).toBe(0);
    expect(toLong(12.9)).toBe(12);
    expect(toLong(-12.9)).toBe(-12);
    expect(toLong(2 ** 31)).toBe(-(2 ** 31));
    expect(toLong(2 ** 31 - 1)).toBe(2 ** 31 - 1);
    expect(toLong(2 ** 32 + 5)).toBe(5);
    expect(toLong({ valueOf: () => 7 })).toBe(7);
    expect(() => toLong(Symbol("x"))).toThrow(TypeError);
    expect(() => toLong(1n)).toThrow(TypeError);
  });

  it("toTimerHandler keeps functions and stringifies the rest", () => {
    const f = () => {};
    expect(toTimerHandler(f)).toBe(f);
    expect(toTimerHandler(123)).toBe("123");
    expect(toTimerHandler(undefined)).toBe("undefined");
    expect(toTimerHandler({ toString: () => "x()" })).toBe("x()");
    expect(() => toTimerHandler(Symbol("s"))).toThrow(TypeError);
  });
});

describe("TimerScheduler", () => {
  it("shares one ID space between timeouts and intervals, starting at 1", () => {
    const a = h.s.add(h.fn("a"), 10, [], false);
    const b = h.s.add(h.fn("b"), 10, [], true);
    const c = h.s.add(h.fn("c"), 10, [], false);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  it("clear works across kinds and ignores junk IDs", () => {
    const a = h.s.add(h.fn("a"), 10, [], false);
    const b = h.s.add(h.fn("b"), 10, [], true);
    h.s.clear(b); // "clearTimeout" on an interval
    h.s.clear(0);
    h.s.clear(-5);
    h.s.clear(999);
    h.advanceTo(100);
    expect(h.log).toEqual(["a@10"]);
    h.s.clear(a); // already fired: no-op
    expect(h.s.activeCount).toBe(0);
  });

  it("negative timeouts become 0 and ordering is deadline then registration", () => {
    h.s.add(h.fn("late"), 5, [], false);
    h.s.add(h.fn("neg"), -100, [], false);
    h.s.add(h.fn("zero1"), 0, [], false);
    h.s.add(h.fn("zero2"), 0, [], false);
    h.s.add(h.fn("late2"), 5, [], false);
    h.advanceTo(10);
    expect(h.log).toEqual(["neg@0", "zero1@0", "zero2@0", "late@5", "late2@5"]);
  });

  it("passes extra arguments", () => {
    const got: unknown[] = [];
    h.s.add((...a: unknown[]) => got.push(a), 0, [1, "x", null], false);
    h.flush();
    expect(got).toEqual([[1, "x", null]]);
  });

  it("clamps nested timers to 4ms only above nesting level 6", () => {
    const fired: number[] = [];
    let depth = 0;
    const step = () => {
      fired.push(h.t);
      depth++;
      if (depth < 10) h.s.add(step, 0, [], false);
    };
    h.s.add(step, 0, [], false); // nesting level 1
    h.advanceTo(1000);
    // Levels 1..6 run immediately; level 7+ get 4ms.
    expect(fired).toEqual([0, 0, 0, 0, 0, 0, 4, 8, 12, 16]);
  });

  it("does not clamp timeouts >= 4ms or top-level timers", () => {
    for (let i = 0; i < 20; i++) h.s.add(h.fn(`t${i}`), 1, [], false);
    h.advanceTo(1);
    expect(h.log.every((l) => l.endsWith("@1"))).toBe(true);
  });

  it("setInterval reschedules drift-free before running and clamps at level 7", () => {
    const times: number[] = [];
    const id = h.s.add(() => times.push(h.t), 0, [], true);
    h.advanceTo(30);
    h.s.clear(id);
    // Levels 1..6 at t=0 (6 runs), then interval augmented to 4ms.
    expect(times.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(times.slice(6, 10)).toEqual([4, 8, 12, 16]);
  });

  it("interval with positive period uses snapped ticks", () => {
    const times: number[] = [];
    h.s.add(() => times.push(h.t), 100, [], true);
    h.advanceTo(100);
    // Simulate a late wake (busy thread): the next tick stays on the grid.
    h.t = 250;
    h.s.runNextDue();
    h.advanceTo(400);
    expect(times).toEqual([100, 250, 300, 400]);
  });

  it("snappedToNextTick matches base::TimeTicks semantics", () => {
    expect(snappedToNextTick(105, 100, 100)).toBe(200);
    expect(snappedToNextTick(100, 100, 100)).toBe(100);
    expect(snappedToNextTick(95, 100, 100)).toBe(100);
    expect(snappedToNextTick(350, 100, 100)).toBe(400);
  });

  it("clearInterval inside its own callback stops it", () => {
    let n = 0;
    const id = h.s.add(() => {
      n++;
      h.s.clear(id);
    }, 10, [], true);
    h.advanceTo(100);
    expect(n).toBe(1);
    expect(h.s.nextDeadline()).toBeNull();
  });

  it("a one-shot is unregistered before its callback (clear inside is a no-op)", () => {
    let id = 0;
    let active = -1;
    id = h.s.add(() => {
      active = h.s.activeCount;
      h.s.clear(id);
    }, 0, [], false);
    h.flush();
    expect(active).toBe(0);
  });

  it("errors are reported and do not stop other timers", () => {
    h.s.add(() => {
      throw new Error("boom");
    }, 0, [], false);
    h.s.add(h.fn("after"), 0, [], false);
    h.flush();
    expect(h.errors).toHaveLength(1);
    expect(h.log).toEqual(["after@0"]);
  });

  it("runs only one timer per runNextDue call", () => {
    h.s.add(h.fn("a"), 0, [], false);
    h.s.add(h.fn("b"), 0, [], false);
    expect(h.s.runNextDue()).toBe(true);
    expect(h.log).toEqual(["a@0"]);
    expect(h.s.hasDue()).toBe(true);
  });

  it("nextDeadline tracks the earliest valid timer", () => {
    const a = h.s.add(h.fn("a"), 50, [], false);
    h.s.add(h.fn("b"), 80, [], false);
    expect(h.s.nextDeadline()).toBe(50);
    h.s.clear(a);
    expect(h.s.nextDeadline()).toBe(80);
  });

  it("IDs wrap around at 2^31-1 and skip IDs still in use", () => {
    h.s.add(h.fn("one"), 1000, [], false); // id 1 stays active
    h.s.setLastIdForTesting(MAX_TIMER_ID - 1);
    expect(h.s.add(h.fn("x"), 1000, [], false)).toBe(MAX_TIMER_ID);
    expect(h.s.add(h.fn("y"), 1000, [], false)).toBe(2);
  });

  it("compacts stale heap entries from clear-heavy workloads", () => {
    for (let i = 0; i < 10_000; i++) {
      const id = h.s.add(h.fn("x"), 60_000, [], false);
      h.s.clear(id);
    }
    const heapSize = (h.s as unknown as { heap: MinHeap<never> }).heap.size;
    expect(heapSize).toBeLessThan(200);
  });

  it("notifies the host on changes", () => {
    const before = h.changes;
    const id = h.s.add(h.fn("a"), 10, [], false);
    h.s.clear(id);
    expect(h.changes).toBe(before + 2);
  });
});
