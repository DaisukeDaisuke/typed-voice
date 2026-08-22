async function reloadTypedVoiceWindows() {
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
}

const QUICK_FIXES = Object.freeze([
  Object.freeze({ version: "2026-08-21-1", apply: reloadTypedVoiceWindows }),
  Object.freeze({ version: "2026-08-22-1", apply: reloadTypedVoiceWindows }),
]);
self.__typedVoiceQuickFixVersions = Object.freeze(QUICK_FIXES.map(({ version }) => version));

self.__typedVoiceQuickFixActivate = async (knownVersions = []) => {
  for (const fix of QUICK_FIXES) {
    if (knownVersions.includes(fix.version)) continue;
    await fix.apply();
    knownVersions.push(fix.version);
  }
};
