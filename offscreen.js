// Offscreen document for background.js.
// The MV3 service worker has no URL.createObjectURL, and data: URLs handed to
// chrome.downloads are capped at ~2 MB - so when a file has to be fetched first
// (instead of letting chrome.downloads stream it), it's fetched here and exposed as
// a blob: URL owned by this extension page, which chrome.downloads can save.

const liveBlobUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Every runtime message reaches every extension page - only handle ours
  if (!message || message.target !== 'offscreen') return;

  if (message.action === 'fetch-to-blob-url') {
    (async () => {
      try {
        const response = await fetch(message.url);
        if (!response.ok) {
          sendResponse({ success: false, error: `HTTP ${response.status}` });
          return;
        }
        const blob = await response.blob();
        if (/vnd\.yt-ump|text\/html/i.test(blob.type || '') || blob.size <= (message.minBytes || 0)) {
          sendResponse({ success: false, error: `Not real media (${blob.size} bytes, ${blob.type || 'unknown type'})` });
          return;
        }
        const blobUrl = URL.createObjectURL(blob);
        liveBlobUrls.add(blobUrl);
        sendResponse({ success: true, blobUrl, size: blob.size, mimeType: blob.type });
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  }

  if (message.action === 'revoke-blob-url') {
    if (liveBlobUrls.delete(message.blobUrl)) URL.revokeObjectURL(message.blobUrl);
    sendResponse({ success: true });
    return;
  }
});
