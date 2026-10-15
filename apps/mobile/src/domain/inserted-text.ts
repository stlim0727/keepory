/** Recover the inserted span from a controlled native input change. */
export function insertedText(previous: string, next: string, selection: { start: number; end: number } | null): string {
  if (selection && selection.start >= 0 && selection.end >= selection.start && selection.end <= previous.length) {
    const length = next.length - previous.length + selection.end - selection.start;
    if (length >= 0 && next.startsWith(previous.slice(0, selection.start)) && next.endsWith(previous.slice(selection.end))) {
      return next.slice(selection.start, selection.start + length);
    }
  }
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = 0;
  while (end < previous.length - start && end < next.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++;
  return next.slice(start, next.length - end);
}
