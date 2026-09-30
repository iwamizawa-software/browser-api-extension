// Offscreen side of the timer wake-up path: one worker timer per content
// script port; the port's disconnect (frame closed/navigated, bfcache) cleans up.

import { isTimerUp } from "../shared/protocol";

export class TimerHost {
  private worker: Worker;
  private readonly ports = new Map<number, chrome.runtime.Port>();
  private nextKey = 0;

  constructor(private readonly workerUrl: string) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (ev: MessageEvent<{ key: number; seq: number }>) => {
      const port = this.ports.get(ev.data.key);
      if (!port) return;
      try {
        port.postMessage({ t: "wake", seq: ev.data.seq });
      } catch {
        this.ports.delete(ev.data.key);
      }
    };
    worker.onerror = (e) => {
      console.error("timer worker error; respawning", e.message);
      worker.terminate();
      this.worker = this.spawn();
      // Pending wake-ups were lost; ask every frame to re-arm.
      for (const port of this.ports.values()) {
        try {
          port.postMessage({ t: "reset" });
        } catch {
          /* ignore */
        }
      }
    };
    return worker;
  }

  get portCount(): number {
    return this.ports.size;
  }

  attach(port: chrome.runtime.Port): void {
    const key = ++this.nextKey;
    this.ports.set(key, port);
    port.onMessage.addListener((msg: unknown) => {
      if (!isTimerUp(msg)) return;
      if (msg.t === "arm") this.worker.postMessage({ op: "arm", key, seq: msg.seq, delay: msg.delay });
      else this.worker.postMessage({ op: "disarm", key });
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.ports.delete(key);
      this.worker.postMessage({ op: "disarm", key });
    });
  }
}
