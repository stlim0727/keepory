import { normalizeUrl } from './urls.ts';

export interface SmartInput {
  mode: 'link' | 'note';
  url: string;
  title: string;
  notes: string;
}

/** Peel prose punctuation and unmatched wrappers without changing balanced URL paths. */
function cleanUrlToken(input: string): string {
  let raw = input;
  // Peel sentence punctuation and unmatched wrappers, retaining balanced URL paths.
  while (raw) {
    const last = raw.at(-1)!;
    const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null;
    if (/[.,;:!?"'<>]/.test(last) || (opener &&
      raw.split(last).length > raw.split(opener).length)) raw = raw.slice(0, -1);
    else break;
  }
  return raw;
}

/** Deterministic capture parsing. Match original spans before URL normalization. */
export function parseSmartInput(text: string): SmartInput {
  const trimmed = text.trim();
  const direct = /\s/.test(trimmed) ? null : normalizeUrl(cleanUrlToken(trimmed));
  if (direct) return { mode: 'link', url: direct, title: '', notes: '' };
  for (const match of text.matchAll(/https?:\/\/[^\s]+/gi)) {
    const raw = cleanUrlToken(match[0]);
    const url = normalizeUrl(raw);
    if (!url) continue;
    let start = match.index!;
    let end = start + raw.length;
    // Remove a wrapper around the link, never brackets around meaningful text.
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
    if (start > 0 && pairs[text[start - 1]] === text[end]) { start--; end++; }
    const lines = (text.slice(0, start) + text.slice(end)).split(/\r?\n/);
    const titleIndex = lines.findIndex((line) => line.trim());
    const notes = titleIndex < 0 ? [] : lines.slice(titleIndex + 1);
    // Remove outer separator lines, preserving authored indentation, paragraph
    // gaps, and Markdown hard-break spaces inside the note itself.
    while (notes.length && !notes[0].trim()) notes.shift();
    while (notes.length && !notes.at(-1)!.trim()) notes.pop();
    return { mode: 'link', url, title: titleIndex < 0 ? '' : lines[titleIndex].trim(), notes: notes.join('\n') };
  }
  return { mode: 'note', url: '', title: '', notes: text };
}
