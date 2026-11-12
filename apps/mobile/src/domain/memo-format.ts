/**
 * Memo format detection module.
 *
 * Provides heuristics to automatically detect whether text should be treated as
 * Markdown or plain text when saving to the memo field.
 */

/** Heuristic to detect if text should be treated as Markdown format. */
export function detectMemoFormat(text: string): 'markdown' | 'plain' {
  if (!text || !text.trim()) return 'plain';

  // Patterns that suggest markdown
  const markdownPatterns = [
    // ATX headings
    /^\s*#\s+/m,
    /^\s*##\s+/m,
    /^\s*###\s+/m,
    /^\s*####\s+/m,
    /^\s*#####\s+/m,
    /^\s*######\s+/m,
    // Unordered list items
    /^\s*[-*+]\s+/m,
    // Ordered list items
    /^\s*\d+\.\s+/m,
    // Blockquotes
    /^\s*>\s+/m,
    // Fenced code blocks
    /^\s*```/m,
    // Inline code
    /`[^`\n]+`/m,
    // Links
    /\[[^\]]+\]\([^\)]+\)/m,
    // Bold text
    /\*\*[^\*]+\*\*/m,
    /\*[^\*]+\*/m, // Italic
    // Strikethrough
    /~~[^~]+~~/m,
    // Checkbox items
    /^\s*\[-\]/m,
    /^\s*\[x\]/m,
    // Table markers (simple)
    /^\s*\|/m,
    // Horizontal rule
    /^\s*---\s*$/m,
    /^\s*\*\*\*\s*$/m,
    /^\s*___\s*$/m,
  ];

  return markdownPatterns.some(pattern => pattern.test(text)) ? 'markdown' : 'plain';
}
