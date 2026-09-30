// Offscreen document (extension origin, not affected by any page CSP).
// Hosts the timer worker and the speech-to-text pipeline. Only chrome.runtime
// is available here; settings and the API key are fetched from the service
// worker per recognition session.

import { PORT_NAME_PREFIX } from "../shared/protocol";
import { TimerHost } from "./timer-host";
import { SpeechManager } from "./stt/manager";

const timerHost = new TimerHost(chrome.runtime.getURL("timer-worker.js"));
const speech = new SpeechManager();

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  // Only our own content scripts (which always run in a tab).
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || typeof sender.frameId !== "number") {
    port.disconnect();
    return;
  }
  if (port.name === PORT_NAME_PREFIX + "timers") timerHost.attach(port);
  else if (port.name === PORT_NAME_PREFIX + "speech") speech.attach(port, sender);
  else {
    port.disconnect();
    return;
  }
  port.postMessage({ t: "hello" });
});
