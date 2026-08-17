import "./style.css";
import { UiOrchestrator } from "./app/ui-orchestrator.js";
import { VoiceRuntimeAdapter } from "./app/voice-runtime-adapter.js";
import { requireServiceWorker } from "./app/service-worker-required.js";
import { initializeModelProfileUi } from "./app/model-profile-ui.js";
import { TutorialController } from "./app/tutorial.js";

await requireServiceWorker({ reloadKey: "typed-voice-app-coi-reloaded" });
const voiceStatus = document.querySelector("#voice-status");
const manifestUrl = new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
const voiceRuntime = new VoiceRuntimeAdapter({
  manifestUrl,
  onStatus(message) {
    voiceStatus.textContent = message;
  },
});
const modelProfileUi = initializeModelProfileUi(document);
const app = new UiOrchestrator(document, { voiceRuntime });
await app.initialize();
new TutorialController(document, { modelProfileUi }).initialize();


