const KEY = 'keepory.inbox-startup-preview.v1';

export function invalidateInboxStartupPreview(): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY); }
  catch { /* Optional cache. */ }
}

/** Separate from repository initialization so a preview never waits for hydration. */
export async function readInboxStartupPreview(): Promise<string | null> {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY); }
  catch { return null; }
}

export async function writeInboxStartupPreview(raw: string | null): Promise<void> {
  try {
    if (typeof localStorage === 'undefined') return;
    if (raw === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, raw);
  } catch { /* Optional cache: storage failure must not affect the library. */ }
}
