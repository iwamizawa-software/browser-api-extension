// MAIN world, document_start: timer replacement.
import { connectBridge, type MainBridge } from "./bridge";
import { installTimers } from "./timers/install";

let bridge: MainBridge | null = null;
const timers = installTimers(() => bridge);
bridge = connectBridge("timers", (msg) => timers.onBridgeMessage(msg));
