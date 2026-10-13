import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSmartInput } from './smart-parse.ts';

test('commerce paste separates a normalized link using the original span', () => {
  assert.deepEqual(parseSmartInput('[특가] 하루낫또 46% 할인 6,990원 https://item.gmarket.co.kr/item?goodscode=123&utm_source=share'), {
    mode: 'link', url: 'https://item.gmarket.co.kr/item?goodscode=123&utm_source=share',
    title: '[특가] 하루낫또 46% 할인 6,990원', notes: '',
  });
  assert.deepEqual(parseSmartInput('Title\n(HTTPS://EXAMPLE.COM)\nBody'), {
    mode: 'link', url: 'https://example.com/', title: 'Title', notes: 'Body',
  });
});
test('balanced URL paths and meaningful text brackets survive wrapper removal', () => {
  const input = '[Read this] (https://en.wikipedia.org/wiki/Bird_(disambiguation)).\nMore';
  const parsed = parseSmartInput(input);
  assert.equal(parsed.url, 'https://en.wikipedia.org/wiki/Bird_(disambiguation)');
  assert.equal(parsed.title, '[Read this] .');
  assert.equal(parsed.notes, 'More');
});
test('additional URLs remain in notes and invalid matches do not mask valid later URLs', () => {
  const parsed = parseSmartInput('Title\nhttps://example.com/first\nSee https://example.org/second');
  assert.equal(parsed.title, 'Title');
  assert.equal(parsed.notes, 'See https://example.org/second');
  assert.equal(parseSmartInput('https://invalid hello https://example.com').url, 'https://example.com/');
});
test('bare domains and URL-only paste need no fabricated title', () => {
  assert.deepEqual(parseSmartInput('  example.com  '), { mode: 'link', url: 'https://example.com/', title: '', notes: '' });
  assert.equal(parseSmartInput('https://example.com/?x=a%20b&y=1').url, 'https://example.com/?x=a%20b&y=1');
});
test('plain notes preserve raw body, including whitespace and unsupported schemes', () => {
  for (const text of ['', '  # 내 메모\n*literal*\n', 'ftp://example.com']) {
    assert.deepEqual(parseSmartInput(text), { mode: 'note', url: '', title: '', notes: text });
  }
});
test('mixed clipboard notes preserve indentation, paragraphs, and hard-break spaces', () => {
  assert.deepEqual(parseSmartInput('  Title\nhttps://example.com/code\n\n    const value = 1;\n    console.log(value);\n\nSecond paragraph  \n\n'), {
    mode: 'link', url: 'https://example.com/code', title: 'Title',
    notes: '    const value = 1;\n    console.log(value);\n\nSecond paragraph  ',
  });
  assert.equal(parseSmartInput('https://example.com\r\nTitle\r\n\r\n  Nested list\r\n\r\nAnother paragraph').notes,
    '  Nested list\n\nAnother paragraph');
});
