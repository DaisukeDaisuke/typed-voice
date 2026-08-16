import "./style.css";
import { UiOrchestrator } from "./app/ui-orchestrator.js";

await registerServiceWorker();
const app = new UiOrchestrator(document);
await app.initialize();

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const serviceWorkerUrl = new URL(`${import.meta.env.BASE_URL}app-service-worker.js`, document.baseURI);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");
  await navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });
}
