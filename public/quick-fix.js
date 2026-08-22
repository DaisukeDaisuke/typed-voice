const QUICK_FIXES = Object.freeze([
  Object.freeze({ version: "2026-08-21-1", apply: self.reloadTypedVoiceWindows }),
  Object.freeze({ version: "2026-08-22-1", apply: self.reloadTypedVoiceWindows }),
]);
self.__typedVoiceQuickFixVersions = Object.freeze(QUICK_FIXES.map(({ version }) => version));

self.__typedVoiceQuickFixActivate = async (knownVersions = []) => {
  for (const fix of QUICK_FIXES) {
    if (knownVersions.includes(fix.version)) continue;
    await fix.apply();
    knownVersions.push(fix.version);
  }
};
