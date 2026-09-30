// Binary min-heap ordered by (deadline, seq). Written without Array.prototype
// methods on purpose: this code runs in the page's MAIN world, and page
// scripts may (accidentally or not) patch built-in prototypes later on.

export interface HeapEntry {
  deadline: number;
  seq: number;
}

function less(a: HeapEntry, b: HeapEntry): boolean {
  return a.deadline < b.deadline || (a.deadline === b.deadline && a.seq < b.seq);
}

export class MinHeap<T extends HeapEntry> {
  private items: T[] = [];
  private n = 0;

  get size(): number {
    return this.n;
  }

  peek(): T | undefined {
    return this.n > 0 ? this.items[0] : undefined;
  }

  push(item: T): void {
    let i = this.n++;
    this.items[i] = item;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = this.items[parent]!;
      if (!less(item, p)) break;
      this.items[i] = p;
      i = parent;
    }
    this.items[i] = item;
  }

  pop(): T | undefined {
    if (this.n === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items[--this.n]!;
    this.items[this.n] = undefined as unknown as T;
    if (this.n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this.n) break;
        const r = l + 1;
        const c = r < this.n && less(this.items[r]!, this.items[l]!) ? r : l;
        if (!less(this.items[c]!, last)) break;
        this.items[i] = this.items[c]!;
        i = c;
      }
      this.items[i] = last;
    }
    return top;
  }

  /** Rebuilds the heap keeping only entries for which `keep` returns true. */
  filter(keep: (item: T) => boolean): void {
    const old = this.items;
    const count = this.n;
    this.items = [];
    this.n = 0;
    for (let i = 0; i < count; i++) {
      const it = old[i]!;
      if (keep(it)) this.push(it);
    }
  }
}
