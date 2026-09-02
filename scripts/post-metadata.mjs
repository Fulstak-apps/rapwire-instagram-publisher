import { sourceCaption } from './video-caption.mjs';

export async function readExactPost(page, requestedUrl, options = {}) {
  const get = property => page.locator(`meta[property="${property}"]`).getAttribute('content', { timeout: 5000 }).catch(() => '');
  const [canonicalUrl, title, description] = await Promise.all([get('og:url'),get('og:title'),get('og:description')]);
  const caption = sourceCaption({ requestedUrl, canonicalUrl, title, description, allowSparse: options.vip === true });
  const visibleVideos = page.locator('video:visible');
  if (!options.video && await visibleVideos.count() !== 1) throw new Error('Exact post does not have one unambiguous visible video');
  const video = options.video || visibleVideos.first();
  const metadata = await video.evaluate(element => ({ duration: element.duration, width: element.videoWidth, height: element.videoHeight }));
  if (!(metadata.duration > 0) || !Number.isFinite(metadata.duration)) throw new Error('Source video duration not available for matching');
  return { source_url: canonicalUrl, source_caption_text: caption, ...metadata };
}
