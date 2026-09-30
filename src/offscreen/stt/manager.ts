export class SpeechManager {
  attach(port: chrome.runtime.Port, _sender: chrome.runtime.MessageSender): void {
    port.onMessage.addListener(() => {});
  }
}
