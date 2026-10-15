import { useEffect } from 'react';
import { imageFromBlob } from '@/share/smart-clipboard';
import { parseSmartInput } from '@/domain/smart-parse';
import type { SharedImage } from '@/domain/image-share';
export function useImagePaste(ref: React.RefObject<unknown>, receive: (read: () => Promise<SharedImage>, text: string) => void, receiveText?: (text: string) => void) {
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (!node?.addEventListener) return;
    function accept(event: ClipboardEvent | DragEvent) {
      const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer;
      const file = Array.from(data?.files ?? []).find((value) => value.type.startsWith('image/'));
      const text = data?.getData('text/plain') ?? '';
      if (file) {
        event.preventDefault();
        receive(() => imageFromBlob(file), text);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (receiveText && target?.getAttribute('data-testid') === 'add-url') {
        const parsed = parseSmartInput(text);
        if (parsed.mode === 'link' && (parsed.title || parsed.notes)) {
          event.preventDefault();
          receiveText(text);
        }
      }
    }
    const paste = (event: Event) => accept(event as ClipboardEvent);
    const drop = (event: Event) => accept(event as DragEvent);
    const drag = (event: DragEvent) => { if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.type.startsWith('image/'))) event.preventDefault(); };
    node.addEventListener('paste', paste); node.addEventListener('drop', drop); node.addEventListener('dragover', drag);
    return () => { node.removeEventListener('paste', paste); node.removeEventListener('drop', drop); node.removeEventListener('dragover', drag); };
  }, [ref, receive, receiveText]);
}
