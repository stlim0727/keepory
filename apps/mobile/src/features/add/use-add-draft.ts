import { useEffect, useRef, useState } from 'react';
import { MAX_ADD_MEMO_LENGTH } from '@/domain/add-draft';
import type { SharedImage } from '@/domain/image-share';
import { parseSmartInput } from '@/domain/smart-parse';
import type { TextFormat } from '@/domain/types';
import { readSmartClipboard, releaseOwnedClipboardImage } from '@/share/smart-clipboard';

export type AddMode = 'link' | 'note' | 'image';
export interface AddDraft { url: string; title: string; titleEdited?: boolean; memo: string; format: TextFormat; image?: SharedImage }
const empty = (): AddDraft => ({ url: '', title: '', memo: '', format: 'plain' });
export function useAddDraft(lockedMode: AddMode | null = null) {
  const [mode, setMode] = useState<AddMode>('link');
  const [drafts, setDrafts] = useState<Record<AddMode, AddDraft>>({ link: empty(), note: empty(), image: empty() });
  const [pending, setPending] = useState<{ mode: AddMode; draft: AddDraft } | null>(null);
  const [status, setStatus] = useState<'reading' | 'empty' | 'denied' | 'imageMissing' | 'savePending' | 'textTooLong' | 'ready' | null>(null);
  const ownedCandidates = useRef(new Set<SharedImage>());
  const retained = useRef(new Map<SharedImage, number>());
  const activeImages = useRef(new Set<SharedImage>());
  activeImages.current = new Set([
    ...Object.values(drafts).flatMap((value) => value.image ? [value.image] : []),
    ...(pending?.draft.image ? [pending.draft.image] : []),
  ]);
  function sweepImages() {
    for (const image of ownedCandidates.current) {
      if (activeImages.current.has(image) || retained.current.has(image)) continue;
      releaseOwnedClipboardImage(image);
      ownedCandidates.current.delete(image);
    }
  }
  // A capture may still be copying after navigation unmounts this editor.
  function retainImage(image?: SharedImage) {
    if (image) retained.current.set(image, (retained.current.get(image) ?? 0) + 1);
    let released = false;
    return () => {
      if (released || !image) return;
      released = true;
      const count = (retained.current.get(image) ?? 1) - 1;
      if (count) retained.current.set(image, count); else retained.current.delete(image);
      sweepImages();
    };
  }
  function releaseImages() { activeImages.current.clear(); sweepImages(); }
  useEffect(() => { sweepImages(); });
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; releaseImages(); }; }, []);
  const draft = drafts[mode];
  function invalidate() { epoch.current++; setPending(null); setStatus(null); }
  function update(patch: Partial<AddDraft>) { invalidate(); setDrafts((prev) => ({ ...prev, [mode]: { ...prev[mode], ...patch } })); }
  function changeMode(next: AddMode) { if (lockedMode && next !== lockedMode) return; invalidate(); setMode(next); }
  function apply(candidate: { mode: AddMode; draft: AddDraft }) {
    epoch.current++;
    setDrafts((prev) => ({ ...prev, [candidate.mode]: candidate.draft }));
    setMode(candidate.mode); setPending(null); setStatus('ready');
  }
  function offer(text: string, image?: SharedImage) {
    if (image) ownedCandidates.current.add(image);
    invalidate();
    if (mode === 'image' && !image) { setStatus('imageMissing'); return; }
    if (!image && !text.trim()) { setStatus('empty'); return; }
    const parsed = parseSmartInput(text);
    const candidate = image
      ? { mode: 'image' as const, draft: { ...empty(), image, memo: text } }
      : { mode: parsed.mode, draft: { ...empty(), url: parsed.url, title: parsed.title, memo: parsed.notes } };
    if (candidate.draft.memo.length > MAX_ADD_MEMO_LENGTH) { setStatus('textTooLong'); return; }
    if (lockedMode && candidate.mode !== lockedMode) { setStatus('savePending'); return; }
    const occupied = (value: AddDraft) => Boolean(value.url || value.title || value.memo || value.image);
    if (occupied(draft) || occupied(drafts[candidate.mode])) { setPending(candidate); setStatus(null); }
    else apply(candidate);
  }
  async function paste() {
    const request = ++epoch.current;
    setStatus('reading'); setPending(null);
    try {
      const result = await readSmartClipboard();
      if (mounted.current && request === epoch.current) offer(result.text, result.image);
      else releaseOwnedClipboardImage(result.image);
    } catch { if (mounted.current && request === epoch.current) setStatus('denied'); }
  }
  async function receiveImage(read: () => Promise<SharedImage>, text: string) {
    const request = ++epoch.current; setStatus('reading'); setPending(null);
    try { const image = await read(); if (mounted.current && request === epoch.current) offer(text, image); else releaseOwnedClipboardImage(image); }
    catch { if (mounted.current && request === epoch.current) setStatus('denied'); }
  }
  return { mode, draft, pending, status, retainImage, releaseImages, update, changeMode, paste, offer, receiveImage,
    replace: () => pending && apply(pending), keep: invalidate, cancel: invalidate };
}
