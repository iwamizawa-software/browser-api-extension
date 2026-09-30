// Dedicated Worker inside the offscreen document. It only keeps one relative
// timeout per content-script port ("key") and reports when it expires. Worker
// timers are not subject to background-tab throttling.

interface ArmMsg {
  op: "arm";
  key: number;
  seq: number;
  delay: number;
}
interface DisarmMsg {
  op: "disarm";
  key: number;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<ArmMsg | DisarmMsg>) => void) | null;
  postMessage(msg: unknown): void;
};

const timers = new Map<number, ReturnType<typeof setTimeout>>();

scope.onmessage = (ev) => {
  const m = ev.data;
  const existing = timers.get(m.key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(m.key);
  }
  if (m.op !== "arm") return;
  const { key, seq } = m;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      scope.postMessage({ key, seq });
    }, m.delay),
  );
};
