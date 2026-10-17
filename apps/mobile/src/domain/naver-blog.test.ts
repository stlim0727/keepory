import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNaverBlogUrl,
  isNaverBlogPostUrl,
  naverBlogPreviewUrl,
  extractNaverBlogIframeUrl,
  isGenericNaverBlogTitle,
} from './naver-blog.ts';

test('isNaverBlogUrl recognizes desktop and mobile blog URLs', () => {
  assert.equal(isNaverBlogUrl('https://blog.naver.com/someblog/12345'), true);
  assert.equal(isNaverBlogUrl('https://m.blog.naver.com/someblog/12345'), true);
  assert.equal(isNaverBlogUrl('https://blog.naver.com/PostView.naver?blogId=abc&logNo=123'), true);
  assert.equal(isNaverBlogUrl('https://map.naver.com/p/entry/place/123'), false);
  assert.equal(isNaverBlogUrl('https://example.com/blog'), false);
  assert.equal(isNaverBlogUrl('invalid-url'), false);
});

test('isNaverBlogPostUrl identifies post URLs with numeric logNo', () => {
  assert.equal(isNaverBlogPostUrl('https://blog.naver.com/j342162/224125772417'), true);
  assert.equal(isNaverBlogPostUrl('https://m.blog.naver.com/j342162/224125772417'), true);
  assert.equal(isNaverBlogPostUrl('https://blog.naver.com/PostView.naver?blogId=j342162&logNo=224125772417'), true);
  // Blog home (no logNo) is not a specific post
  assert.equal(isNaverBlogPostUrl('https://blog.naver.com/j342162'), false);
  assert.equal(isNaverBlogPostUrl('https://m.blog.naver.com/j342162'), false);
  assert.equal(isNaverBlogPostUrl('https://example.com/123'), false);
});

test('naverBlogPreviewUrl maps desktop post URLs to mobile sibling', () => {
  assert.equal(
    naverBlogPreviewUrl('https://blog.naver.com/j342162/224125772417'),
    'https://m.blog.naver.com/j342162/224125772417',
  );
  assert.equal(
    naverBlogPreviewUrl('https://blog.naver.com/PostView.naver?blogId=j342162&logNo=224125772417'),
    'https://m.blog.naver.com/j342162/224125772417',
  );
  assert.equal(
    naverBlogPreviewUrl('https://blog.naver.com/PostView.nhn?blogId=j342162&logNo=224125772417'),
    'https://m.blog.naver.com/j342162/224125772417',
  );
  assert.equal(
    naverBlogPreviewUrl('https://blog.naver.com/j342162'),
    'https://m.blog.naver.com/j342162',
  );
  // Already mobile returns null
  assert.equal(naverBlogPreviewUrl('https://m.blog.naver.com/j342162/224125772417'), null);
  // Non-blog returns null
  assert.equal(naverBlogPreviewUrl('https://map.naver.com/p/entry/place/123'), null);
  assert.equal(naverBlogPreviewUrl('https://blog.naver.com/login.naver'), null);
});

test('extractNaverBlogIframeUrl extracts inner PostView iframe from desktop HTML shell', () => {
  const html = `
    <html>
      <head><title>블로그</title></head>
      <body>
        <iframe id="mainFrame" name="mainFrame" src="/PostView.naver?blogId=j342162&logNo=224125772417&redirect=Dlog"></iframe>
      </body>
    </html>
  `;
  assert.equal(
    extractNaverBlogIframeUrl(html, 'https://blog.naver.com/j342162/224125772417'),
    'https://m.blog.naver.com/j342162/224125772417',
  );

  assert.equal(extractNaverBlogIframeUrl('<html><body>no iframe</body></html>', 'https://blog.naver.com/'), null);
});

test('isGenericNaverBlogTitle recognizes generic blog platform titles', () => {
  assert.equal(isGenericNaverBlogTitle(undefined), true);
  assert.equal(isGenericNaverBlogTitle(''), true);
  assert.equal(isGenericNaverBlogTitle('네이버 블로그'), true);
  assert.equal(isGenericNaverBlogTitle('NAVER Blog'), true);
  assert.equal(isGenericNaverBlogTitle('하노이 키자니아 후기 : 네이버 블로그'), false);
  assert.equal(isGenericNaverBlogTitle('네이버 블로그', 'https://example.com'), false);
});
