import { normalizeUrl } from './urls.ts';

export interface SmartInput {
  mode: 'link' | 'note';
  url: string;
  title: string;
  notes: string;
}

/** Deterministic capture parsing. Match original spans before URL normalization. */
export function parseSmartInput(text: string): SmartInput {
  const direct = normalizeUrl(text);
  if (direct) return { mode: 'link', url: direct, title: '', notes: '' };
  for (const match of text.matchAll(/https?:\/\/[^\s]+/gi)) {
    let raw = match[0];
    // Peel sentence punctuation and unmatched wrappers, retaining balanced URL paths.
    while (raw) {
      const last = raw.at(-1)!;
      const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null;
      if (/[.,;:!?"'<>]/.test(last) || (opener &&
        raw.split(last).length > raw.split(opener).length)) raw = raw.slice(0, -1);
      else break;
    }
    const url = normalizeUrl(raw);
    if (!url) continue;
    let start = match.index!;
    let end = start + raw.length;
    // Remove a wrapper around the link, never brackets around meaningful text.
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
    if (start > 0 && pairs[text[start - 1]] === text[end]) { start--; end++; }
    const remainder = (text.slice(0, start) + text.slice(end)).trim();
    const lines = remainder.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { mode: 'link', url, title: lines.shift() ?? '', notes: lines.join('\n') };
  }
  return { mode: 'note', url: '', title: '', notes: text };
}
