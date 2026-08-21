const QUICK_FIX_VERSION = "2026-08-21-1";

self.__typedVoiceQuickFixActivate = async (knownVersions = []) => {
  if (Array.isArray(knownVersions) && knownVersions.includes(QUICK_FIX_VERSION)) return;
  const scopeUrl = new URL(self.registration.scope);
  const indexPath = new URL("index.html", scopeUrl).pathname;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  await Promise.all(windows.map(async (client) => {
    try {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin !== scopeUrl.origin) return;
      if (clientUrl.pathname !== scopeUrl.pathname && clientUrl.pathname !== indexPath) return;
      await client.navigate(client.url);
    } catch {
      // Best-effort emergency reload only.
    }
  }));
};
