import { File, Paths } from 'expo-file-system';
import { STARTUP_PREVIEW_MAX_BYTES } from '@/domain/inbox-startup-preview';

let mayExist = true;

function cacheFile(): File {
  return new File(Paths.cache, 'keepory-inbox-startup-preview-v1.json');
}

/** At most one filesystem check per invalidation burst / bulk mutation. */
export function invalidateInboxStartupPreview(): void {
  if (!mayExist) return;
  try {
    const file = cacheFile();
    if (file.exists) file.delete();
    mayExist = false;
  } catch { /* Optional cache. */ }
}

export async function readInboxStartupPreview(): Promise<string | null> {
  try {
    const file = cacheFile();
    if (!file.exists || file.size > STARTUP_PREVIEW_MAX_BYTES) return null;
    return await file.text();
  } catch { return null; }
}

export async function writeInboxStartupPreview(raw: string | null): Promise<void> {
  try {
    const file = cacheFile();
    // File.write/delete are synchronous: later snapshots cannot finish before
    // older writes. A torn file is harmless because the reader rejects it.
    if (raw === null) invalidateInboxStartupPreview();
    else {
      mayExist = true;
      if (!file.exists) file.create();
      file.write(raw);
    }
  } catch { /* Optional cache: storage failure must not affect the library. */ }
}
