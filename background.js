// Background service worker for Auto Media Downloader

// Surfaces a real OS/browser notification - the recording-based download can run
// for as long as the video's duration, and the popup that started it is very likely
// closed by the time it finishes, so this is the only reliable way to tell the user
// whether it actually landed.
function notify(title, message) {
  try {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title,
      message: message || ''
    });
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

// Fixed ID so repeated calls update the same notification instead of stacking new
// ones - Chrome's downloads.download() can't show real transfer progress during the
// recording phase (there's no file yet, so nothing for its network-based progress UI
// to track), but a native progress notification can, driven straight from the tab
// so it keeps updating after the popup/preview modal closes.
const RECORDING_NOTIFICATION_ID = 'amd-recording-progress';

function updateRecordingProgress(progress) {
  const opts = {
    type: 'progress',
    iconUrl: '/icons/icon128.png',
    title: 'Recording video for download',
    message: 'Playing back in the tab to capture it - keep the tab open.',
    progress: Math.max(0, Math.min(100, progress))
  };
  try {
    chrome.notifications.update(RECORDING_NOTIFICATION_ID, opts, (wasUpdated) => {
      if (!wasUpdated) chrome.notifications.create(RECORDING_NOTIFICATION_ID, opts);
    });
  } catch (e) {
    console.warn('Progress notification failed:', e);
  }
}

// Register context menu items on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Auto Media Downloader extension installed.');

  // onInstalled also fires on update/reload, when the item may still exist -
  // clear first so create() doesn't fail with "duplicate id".
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "download-media",
      title: "Download Media with Auto Downloader",
      contexts: ["image", "video", "audio", "link", "page"]
    });
  });
});

// Anything at or below this size is not real media - e.g. YouTube's SABR/UMP
// handshake that a plain GET of some googlevideo URLs returns (verified: 31 bytes).
const MIN_VALID_MEDIA_BYTES = 20000;

// Service workers have no URL.createObjectURL, and data: URLs passed to
// chrome.downloads are capped at ~2 MB, so large fetched files are turned into a
// blob: URL inside an offscreen document (an extension page, so its blob URLs are
// downloadable from here) - see offscreen.js.
let offscreenReady = null;
async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Turn fetched video data into a blob: URL that chrome.downloads can save'
      });
    } catch (e) {
      // "Only a single offscreen document may be created" -> it already exists
      if (!/single offscreen/i.test(e?.message || '')) {
        offscreenReady = null;
        throw e;
      }
    }
  })();
  return offscreenReady;
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// Video id shown by a YouTube tab URL (watch or shorts), or null
function videoIdFromTabUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('v') ||
      (u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/) || [])[1] || null;
  } catch (_) {
    return null;
  }
}

async function tabShowsVideo(tabId, videoId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab?.url && videoIdFromTabUrl(tab.url) === videoId;
  } catch (_) {
    return false;
  }
}

// Handle YouTube video download requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === 'offscreen') return; // meant for offscreen.js, not us
  if (request.action === 'download-youtube-video') {
    handleYouTubeDownload(request, sendResponse);
    return true; // Keep message channel open for async
  }
  if (request.action === 'fetch-stream-buffer') {
    handleFetchStreamBuffer(request, sendResponse);
    return true; // Keep message channel open for async
  }
  if (request.action === 'recording-progress') {
    updateRecordingProgress(request.progress);
    sendResponse({ received: true }); // reply so the tab's sendMessage promise doesn't reject
    return;
  }
  if (request.action === 'resolve-youtube-stream') {
    const watchUrl = request.watchUrl || (request.isShorts
      ? `https://www.youtube.com/shorts/${request.videoId}`
      : `https://www.youtube.com/watch?v=${request.videoId}`);
    resolveStreamViaHiddenTab(request.videoId, watchUrl)
      .then((streamUrl) => sendResponse({ success: !!streamUrl, streamUrl }));
    return true; // Keep message channel open for async
  }
  // Pushed by the tab once a real-time recording finishes (see recordActiveTabVideo
  // in popup.js). The tab saves the file itself via a blob: URL + <a download> -
  // shipping the bytes here hit the ~64 MB message limit and the ~2 MB data: URL
  // limit of chrome.downloads - so this only has to update the notifications, which
  // still works even if the popup was closed while the video played out.
  if (request.action === 'recording-complete') {
    chrome.notifications.clear(RECORDING_NOTIFICATION_ID);
    const sizeMb = request.size ? ` (${(request.size / (1024 * 1024)).toFixed(1)} MB)` : '';
    notify('Video saved', `${request.filename || 'Recorded video'}${sizeMb}`);
    sendResponse({ received: true });
    return;
  }
  if (request.action === 'recording-failed') {
    chrome.notifications.clear(RECORDING_NOTIFICATION_ID);
    notify('Recording failed', request.error || 'Could not save the recorded video.');
    sendResponse({ received: true });
    return;
  }
});

// Upper bound for the popup preview, whose bytes travel back through a runtime
// message as base64 (+33%) - messages are capped at ~64 MB.
const MAX_PREVIEW_BYTES = 40 * 1024 * 1024;

// Fetch a googlevideo stream with a spoofed YouTube referrer (required by the CDN)
// and hand the raw bytes back so the popup can play it from a same-origin blob: URL -
// a direct <video src="https://...googlevideo.com/..."> from the popup gets rejected
// because the request's origin is chrome-extension://, not youtube.com.
async function handleFetchStreamBuffer(request, sendResponse) {
  try {
    const { url } = request;
    if (!url) {
      sendResponse({ success: false, error: 'No URL provided' });
      return;
    }
    const response = await fetch(url, {
      headers: {
        'Referer': 'https://www.youtube.com/',
        'User-Agent': navigator.userAgent
      }
    });
    if (!response.ok) {
      sendResponse({ success: false, error: `HTTP ${response.status}` });
      return;
    }
    const declaredLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (declaredLength > MAX_PREVIEW_BYTES) {
      sendResponse({ success: false, error: 'Video too large for inline preview' });
      return;
    }
    const blob = await response.blob();
    if (blob.size > MAX_PREVIEW_BYTES) {
      sendResponse({ success: false, error: 'Video too large for inline preview' });
      return;
    }
    // chrome.runtime.sendMessage/sendResponse serializes payloads as if via JSON -
    // an ArrayBuffer arrives on the other end as an empty object (verified: all byte
    // data silently lost). A base64 string survives intact, so encode here instead.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000; // avoid a call-stack overflow from spreading a huge array
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    sendResponse({ success: true, base64: btoa(binary), mimeType: blob.type || 'video/mp4' });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// YouTube no longer reliably embeds a usable url/signatureCipher on adaptiveFormats in
// the static ytInitialPlayerResponse (verified against a real video - every format came
// back with neither field present). Reading the page's own performance.getEntriesByType
// ('resource') afterward is also unreliable for cross-origin requests - verified a real
// googlevideo request fire (confirmed at the network level) that simply never showed up
// in that page's own resource-timing buffer. chrome.webRequest observes the network
// directly and isn't subject to either limitation, so it's the primary mechanism here.
function captureGooglevideoUrl(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let anyHit = null;
    let settled = false;
    let timer = null; // declared before finish() can reference it
    const finish = (url) => {
      if (settled) return;
      settled = true;
      chrome.webRequest.onBeforeRequest.removeListener(listener);
      clearTimeout(timer);
      resolve(url);
    };
    function listener(details) {
      if (details.tabId !== tabId || !/googlevideo\.com\/videoplayback/i.test(details.url)) return;
      // Prefer a classic progressive format (has an explicit itag) - that's a complete,
      // directly-downloadable file. Plain videoplayback hits without an itag are often
      // YouTube's newer SABR/UMP negotiation requests, which return a tiny protocol
      // envelope instead of actual media bytes if downloaded as-is (verified: a
      // "successful" 31-byte download of application/vnd.yt-ump).
      if (/itag=\d+/i.test(details.url)) finish(details.url);
      else if (!anyHit) anyHit = details.url;
    }
    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: ['*://*.googlevideo.com/*'] });
    timer = setTimeout(() => finish(anyHit), timeoutMs);
  });
}

// Fire-and-forget: retries play() for a while since YouTube's SPA UI mounts the
// <video> element progressively, so it may not exist yet right after navigation.
// `mute` is only used for our own hidden tab - the user's visible tab is left as is.
function nudgePlayback(tabId, mute) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [!!mute],
    func: async (mute) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const video = document.querySelector('video');
        if (video) {
          try {
            if (mute) video.muted = true;
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
            return;
          } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }).catch(() => {});
}

// Fast, cheap fallback for the rare video/client that still populates it directly.
// Only accepts a player response that belongs to `videoId` (ytInitialPlayerResponse
// goes stale after YouTube's SPA navigation and would yield a different video).
async function extractStaticStreamUrl(tabId, videoId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [videoId || null],
      func: (videoId) => {
        function extractUrl(f) {
          if (f.url) return f.url;
          const cs = f.signatureCipher || f.cipher;
          if (!cs) return null;
          try {
            const p = new URLSearchParams(cs);
            const u = p.get('url');
            const sp = p.get('sp') || 'signature';
            const s = p.get('s');
            if (u) {
              const o = new URL(decodeURIComponent(u));
              if (s) o.searchParams.set(sp, s);
              return o.toString();
            }
          } catch (_) {}
          return null;
        }
        try {
          const candidates = [];
          try {
            const player = document.querySelector('#movie_player');
            if (player && typeof player.getPlayerResponse === 'function') {
              candidates.push(player.getPlayerResponse());
            }
          } catch (_) {}
          candidates.push(window.ytInitialPlayerResponse);
          const pr = candidates.find(c => c?.streamingData &&
            (!videoId || c.videoDetails?.videoId === videoId));
          if (!pr) return null;
          const formats = [
            ...(pr.streamingData.formats || []),
            ...(pr.streamingData.adaptiveFormats || [])
          ];
          for (const f of formats) {
            const url = extractUrl(f);
            if (url && /googlevideo/.test(url)) return url;
          }
        } catch (_) {}
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

// Pulls a real, directly-downloadable googlevideo stream URL out of whatever tab is
// passed in, nudging playback along and watching the network for the resulting request.
// Callers must make sure the tab is actually showing `videoId` - network requests
// carry no video id, so this captures whatever that tab plays.
async function extractStreamFromTab(tabId, timeoutMs, videoId, mute) {
  const capture = captureGooglevideoUrl(tabId, timeoutMs);
  nudgePlayback(tabId, mute);
  const networkUrl = await capture;
  if (networkUrl) return networkUrl;
  return await extractStaticStreamUrl(tabId, videoId);
}

// Thumbnails scraped from a feed only carry a videoId - the real streaming formats
// only exist on that video's own watch page. Load it in a background (non-active) tab
// so nothing visibly changes for the user, pull the stream, then close the tab.
async function resolveStreamViaHiddenTab(videoId, watchUrl) {
  let hiddenTabId = null;
  try {
    const tab = await chrome.tabs.create({ url: watchUrl, active: false });
    hiddenTabId = tab.id;
    if (!hiddenTabId) return null;
    // Mute at the tab level right away - YouTube may autoplay with sound before
    // nudgePlayback's element-level mute gets a chance to run.
    chrome.tabs.update(hiddenTabId, { muted: true }).catch(() => {});

    // webRequest observation is attached before playback even has a chance to start
    // (extractStreamFromTab does this immediately), so there's no need to wait for
    // the tab's 'complete' status first.
    return await extractStreamFromTab(hiddenTabId, 9000, videoId, true);
  } catch (e) {
    console.warn('Hidden-tab stream resolve failed:', e);
    return null;
  } finally {
    if (hiddenTabId) {
      try { await chrome.tabs.remove(hiddenTabId); } catch (_) {}
    }
  }
}

// chrome.downloads.download()'s callback only confirms the download was *queued* -
// a rejected/expired googlevideo URL still gets a downloadId back and then fails
// moments later ("File wasn't available on site"), and a SABR/UMP URL "completes"
// with a 31-byte file. So poll the item until it proves itself:
//   - interrupted, or a UMP/HTML payload            -> false
//   - complete                                       -> true only if big enough
//   - still in progress but already past the minimum -> true (real data flowing)
// The old check waited for 'complete' within 8s, so any normal-sized video was
// treated as failed, erased mid-transfer and downloaded a second time.
function verifyDownload(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results && results[0];
        if (!item || item.state === 'interrupted') return resolve(false);
        if (/vnd\.yt-ump|text\/html/i.test(item.mime || '')) return resolve(false);
        if (item.state === 'complete') {
          return resolve((item.fileSize || item.bytesReceived || 0) > MIN_VALID_MEDIA_BYTES);
        }
        if ((item.bytesReceived || 0) > MIN_VALID_MEDIA_BYTES) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(check, 500);
      });
    };
    check();
  });
}

function discardDownload(downloadId) {
  chrome.downloads.cancel(downloadId, () => {
    void chrome.runtime.lastError; // already finished/failed - nothing to cancel
    chrome.downloads.erase({ id: downloadId }, () => void chrome.runtime.lastError);
  });
}

function queueDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        reject(new Error(chrome.runtime.lastError?.message || 'Download did not start'));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// Fallback when the browser's own download of the URL is rejected: fetch it from
// the offscreen document (extension origin + host permissions, so no CORS issue),
// which hands back a blob: URL that chrome.downloads can save.
async function downloadViaOffscreen(url, filename) {
  const request = { action: 'fetch-to-blob-url', url, minBytes: MIN_VALID_MEDIA_BYTES };
  await ensureOffscreenDocument();
  let result;
  try {
    result = await sendToOffscreen(request);
  } catch (e) {
    // The cached "ready" promise can outlive the document (closed by Chrome or
    // DevTools) -> "Receiving end does not exist". Recreate it once and retry.
    offscreenReady = null;
    await ensureOffscreenDocument();
    result = await sendToOffscreen(request);
  }
  if (!result?.success || !result.blobUrl) {
    console.warn('Offscreen fetch failed:', result?.error);
    return null;
  }
  const revoke = () => sendToOffscreen({ action: 'revoke-blob-url', blobUrl: result.blobUrl }).catch(() => {});
  try {
    const downloadId = await queueDownload(result.blobUrl, filename);
    // Local blob - should finish fast; keep the blob alive until it has
    const ok = await verifyDownload(downloadId, 60000);
    if (!ok) {
      discardDownload(downloadId);
      revoke();
      return null;
    }
    waitForDownloadEnd(downloadId, 10 * 60 * 1000).then(revoke);
    return downloadId;
  } catch (e) {
    revoke();
    throw e;
  }
}

function waitForDownloadEnd(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (!item || item.state !== 'in_progress' || Date.now() >= deadline) return resolve();
      setTimeout(check, 1000);
    });
    check();
  });
}

// Downloads a resolved googlevideo stream: tries the browser's own download
// pipeline first (fastest, streams to disk), then falls back to the offscreen fetch.
async function downloadStreamUrl(streamUrl, filename) {
  try {
    const downloadId = await queueDownload(streamUrl, filename);
    if (await verifyDownload(downloadId, 20000)) return downloadId;
    discardDownload(downloadId);
  } catch (e) {
    console.warn('Direct stream download failed, trying offscreen fetch:', e);
  }

  try {
    return await downloadViaOffscreen(streamUrl, filename);
  } catch (e) {
    console.warn('Offscreen YouTube download failed:', e);
    return null;
  }
}

async function handleYouTubeDownload(request, sendResponse) {
  try {
    const { videoId, filename, tabId, watchUrl, isShorts, streamUrl: knownStreamUrl } = request;
    if (!videoId) {
      sendResponse({ success: false, error: 'No video ID provided' });
      return;
    }
    const finalFilename = filename || `yt_${videoId}.mp4`;

    const tried = new Set();
    let foundAnyStream = false;
    const attempt = async (url) => {
      if (!url || !/googlevideo/i.test(url) || tried.has(url)) return null;
      tried.add(url);
      foundAnyStream = true;
      return downloadStreamUrl(url, finalFilename);
    };

    // 1. A stream the popup already resolved for exactly this video
    let downloadId = await attempt(knownStreamUrl);

    // 2. The user's tab - but only if it is actually showing this video. Its network
    //    traffic carries no video id, so a feed/other video would be captured instead.
    if (!downloadId && tabId && await tabShowsVideo(tabId, videoId)) {
      downloadId = await attempt(await extractStreamFromTab(tabId, 5000, videoId, false));
    }

    // 3. Load the video's own watch page in a hidden background tab
    if (!downloadId) {
      const resolvedWatchUrl = watchUrl || (isShorts
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`);
      downloadId = await attempt(await resolveStreamViaHiddenTab(videoId, resolvedWatchUrl));
    }

    if (downloadId) {
      sendResponse({ success: true, downloadId });
      return;
    }

    if (foundAnyStream) {
      // A stream URL was found but produced no usable file - this happens when
      // YouTube only offers its newer SABR/UMP delivery for this video, which needs
      // the player's own chunk-negotiation protocol rather than a single GET request.
      sendResponse({ success: false, error: 'Found a stream but could not download real video data from it (this video may only be available via YouTube\'s newer streaming protocol). Open the video in the tab and download again to record it instead.' });
      return;
    }

    sendResponse({ success: false, error: 'Could not find a valid stream URL for this YouTube video. Try refreshing the YouTube page and opening the popup again.' });
  } catch (e) {
    console.error('YouTube download handler error:', e);
    sendResponse({ success: false, error: e.message });
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "download-media") {
    // Smart URL detection: only fallback to linkUrl or tabUrl if they contain a valid media extension
    let mediaUrl = info.srcUrl;
    const mediaRegex = /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff|avif|heic|mp4|webm|mov|avi|mp3|wav|ogg|flac|m4a)(?:[\?#]|$)/i;
    
    if (!mediaUrl && info.linkUrl && mediaRegex.test(info.linkUrl)) {
      mediaUrl = info.linkUrl;
    }
    
    if (!mediaUrl && tab && tab.url && mediaRegex.test(tab.url)) {
      mediaUrl = tab.url;
    }

    if (mediaUrl) {
      const guessedExt = info.mediaType === 'image' ? '.jpg'
        : info.mediaType === 'video' ? '.mp4'
        : info.mediaType === 'audio' ? '.mp3' : '';

      // Blob URLs are scoped to the tab's document - save them from inside the tab.
      // (Converting to a data: URL and downloading from here breaks for anything
      // over ~2 MB, i.e. practically every blob video.)
      // tab.id is -1 (TAB_ID_NONE) for e.g. the PDF viewer - can't inject there
      if (mediaUrl.startsWith('blob:') && tab && tab.id > 0) {
        await downloadBlobInTab(tab.id, mediaUrl, `media-${Date.now()}${guessedExt || '.bin'}`);
        return;
      }

      // Convert to original high-resolution URL
      mediaUrl = getHighResUrl(mediaUrl);

      // Determine file name - data: URLs have no path, so name them from their MIME type
      const filename = mediaUrl.startsWith('data:')
        ? `media-${Date.now()}${extFromDataUrl(mediaUrl) || guessedExt || '.bin'}`
        : filenameFromUrl(mediaUrl, guessedExt);

      // Download the media file
      chrome.downloads.download({
        url: mediaUrl,
        filename: filename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('Download failed from context menu:', chrome.runtime.lastError);
        } else {
          console.log(`Download started with ID: ${downloadId}`);
        }
      });
    } else {
      // ---------------------------------------------------------------------
      // FALLBACK: When right-clicking on protected elements (e.g. Instagram 
      // transparent div), mediaUrl is undefined. We will fetch the post URL 
      // to extract OpenGraph tags, or inject a script to find the largest media.
      // ---------------------------------------------------------------------
      const postUrl = info.linkUrl || info.pageUrl || (tab ? tab.url : null);
      
      const downloadFallbackMedia = (url, type) => {
        if (!url) return;
        const ext = type === 'video' ? '.mp4' : '.jpg';
        const filename = url.startsWith('data:')
          ? `media-${Date.now()}${extFromDataUrl(url) || ext}`
          : filenameFromUrl(url, ext);
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false,
          conflictAction: 'uniquify'
        }, () => {
          if (chrome.runtime.lastError) {
            console.error('Fallback download failed:', chrome.runtime.lastError.message);
          }
        });
      };

      if (postUrl && postUrl.startsWith('http')) {
        try {
          const response = await fetch(postUrl);
          const html = await response.text();
          // Unescape JSON-in-HTML: "&" -> "&" and "https:\/\/x\/a.mp4" -> "https://x/a.mp4".
          // (These used to match a *double* backslash, so the common single-backslash
          // form was never unescaped and step 3 below could not find escaped URLs.)
          const cleanHtml = html
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
            .replace(/\\\//g, '/');

          let extractedUrl = null;
          let type = 'image';

          // 1. Try OpenGraph video (og:video, og:video:url, og:video:secure_url).
          //    Content must be a URL - og:video:type / :width also match the name.
          const ogVideoMatch = html.match(/<meta\s+(?:property|name)=["']og:video(?::(?:url|secure_url))?["']\s+content=["'](https?:[^"']+)["']/i) ||
                               html.match(/<meta\s+content=["'](https?:[^"']+)["']\s+(?:property|name)=["']og:video(?::(?:url|secure_url))?["']/i);
          if (ogVideoMatch && ogVideoMatch[1]) {
            extractedUrl = ogVideoMatch[1];
            type = 'video';
          }

          // 2. Try OpenGraph image (if not a generic profile pic)
          if (!extractedUrl) {
            const ogImageMatch = html.match(/<meta\s+(?:property|name)=["']og:image(?::(?:url|secure_url))?["']\s+content=["'](https?:[^"']+)["']/i) ||
                                 html.match(/<meta\s+content=["'](https?:[^"']+)["']\s+(?:property|name)=["']og:image(?::(?:url|secure_url))?["']/i);
            if (ogImageMatch && ogImageMatch[1] && !ogImageMatch[1].includes('profile_pic')) {
              extractedUrl = ogImageMatch[1];
              type = 'image';
            }
          }
          
          // 3. Try scraping raw HTML for .mp4 or .jpg
          if (!extractedUrl) {
            const mp4Match = cleanHtml.match(/(https?:\/\/[^\s"'<>]+?\.mp4[^\s"'<>]*)/i);
            if (mp4Match && mp4Match[1]) {
              extractedUrl = mp4Match[1];
              type = 'video';
            } else {
              const jpgMatch = cleanHtml.match(/(https?:\/\/[^\s"'<>]+\/[^\s"'<>]+?\.jpg[^\s"'<>]*)/ig);
              if (jpgMatch && jpgMatch.length > 0) {
                extractedUrl = jpgMatch[0]; // Usually first is highest res in JSON state
                type = 'image';
              }
            }
          }
          
          if (extractedUrl) {
            // og: meta content is HTML-escaped (&amp;), JSON blobs use & / \x26
            extractedUrl = extractedUrl
              .replace(/&amp;/g, '&')
              .replace(/\\?u0026/g, '&')
              .replace(/\\?x26/g, '&');
            downloadFallbackMedia(extractedUrl, type);
            return; // Success
          }
        } catch (e) {
          console.error("Background fetch for OpenGraph failed:", e);
        }
      }
      
      // 4. In-page script fallback if fetch fails or URL is unreachable
      if (tab && tab.id > 0) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Find largest video
            const videos = Array.from(document.querySelectorAll('video'));
            if (videos.length > 0) {
              let largest = videos[0];
              let maxArea = 0;
              videos.forEach(v => {
                const rect = v.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area > maxArea) { maxArea = area; largest = v; }
              });
              return { url: largest.src || largest.currentSrc, type: 'video' };
            }
            // Find largest image in viewport
            const images = Array.from(document.querySelectorAll('img')).filter(img => {
              const rect = img.getBoundingClientRect();
              return rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
            });
            if (images.length > 0) {
              let largest = images[0];
              let maxArea = 0;
              images.forEach(i => {
                const rect = i.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area > maxArea) { maxArea = area; largest = i; }
              });
              
              // Pick the biggest srcset candidate by its descriptor. Splitting on ","
              // broke URLs that contain commas (e.g. ".../w_800,h_600/x.jpg"), and the
              // candidate can be relative, so resolve it against the page.
              let bestUrl = largest.currentSrc || largest.src;
              if (largest.srcset) {
                let bestSize = 0;
                const re = /(\S+)\s+(\d+(?:\.\d+)?)([wx])(?:,|$)/g;
                let m;
                while ((m = re.exec(largest.srcset)) !== null) {
                  const size = parseFloat(m[2]) * (m[3] === 'x' ? 10000 : 1);
                  if (size > bestSize) { bestSize = size; bestUrl = m[1]; }
                }
              }
              try { bestUrl = new URL(bestUrl, location.href).href; } catch (_) {}
              return { url: bestUrl, type: 'image' };
            }
            return null;
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            console.error('In-page media lookup failed:', chrome.runtime.lastError.message);
            return;
          }
          if (results && results[0] && results[0].result && results[0].result.url) {
            const media = results[0].result;
            if (media.url.startsWith('blob:')) {
              const ext = media.type === 'video' ? '.mp4' : '.jpg';
              downloadBlobInTab(tab.id, media.url, `media-${Date.now()}${ext}`);
              return;
            }
            downloadFallbackMedia(media.url, media.type);
          } else {
            chrome.scripting.executeScript({
               target: { tabId: tab.id },
               func: () => alert('Auto Downloader could not find a media file to download here. Try using the Extension Popup.')
            });
          }
        });
      }
    }
  }
});

// A blob: URL only resolves inside the document that created it, so trigger the save
// from that tab with an <a download> click (no size limit, unlike a data: URL).
async function downloadBlobInTab(tabId, blobUrl, filename) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url, name) => {
        try {
          // Fetching it first proves the blob is still alive (revoked ones throw)
          const blob = await (await fetch(url)).blob();
          if (!blob.size) return { error: 'Empty blob' };
          // MediaSource-backed players (most social video) expose blob: URLs that
          // can't be fetched as a file - those throw above.
          const localUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = localUrl;
          a.download = name;
          a.style.display = 'none';
          document.documentElement.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(localUrl), 120000);
          return { ok: true };
        } catch (e) {
          return { error: e.message || String(e) };
        }
      },
      args: [blobUrl, filename]
    });
    const outcome = result && result[0] && result[0].result;
    if (!outcome?.ok) {
      notify('Download failed', 'This video is streamed (blob/MediaSource) - open the Auto Downloader popup to record it instead.');
    }
  } catch (e) {
    console.error('Failed to download blob URL from context menu:', e);
    notify('Download failed', e.message);
  }
}

// Extension (".png") for a data: URL from its MIME type, or ''
function extFromDataUrl(dataUrl) {
  const m = /^data:([a-z]+)\/([a-z0-9.+-]+)/i.exec(dataUrl || '');
  if (!m) return '';
  const sub = m[2].toLowerCase();
  const map = { jpeg: '.jpg', 'svg+xml': '.svg', quicktime: '.mov', mpeg: m[1] === 'audio' ? '.mp3' : '.mpeg', 'x-icon': '.ico' };
  return map[sub] || `.${sub.replace(/[^a-z0-9]/g, '')}`;
}

// Safe download filename from a URL's last path segment, with a fallback extension
function filenameFromUrl(url, fallbackExt) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch (_) {
    name = (url.split('/').pop() || '').split('?')[0];
  }
  // chrome.downloads rejects names with reserved characters or a leading dot
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  if (!name) name = `media-${Date.now()}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += fallbackExt || '';
  return name;
}

// Get original/high-resolution URL by removing sizing parameters and CDN suffixes
function getHighResUrl(url) {
  if (!url || typeof url !== 'string') {
    return url;
  }
  
  // Helper to unescape JSON Unicode escapes and backslashes
  // Same single-backslash rules as popup.js (the old double-backslash patterns never
  // matched a normal "&" / "\/" escape)
  const unescapeUrl = (u) => {
    if (!u || typeof u !== 'string') return u;
    return u
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
      .replace(/\\/g, '')
      .trim();
  };

  // Clean and unescape backslashes (frequent in JSON-escaped strings)
  let cleanUrl = unescapeUrl(url);
  if (cleanUrl.startsWith('data:') || cleanUrl.startsWith('blob:')) {
    return cleanUrl;
  }
  try {
    let parsedUrl = new URL(cleanUrl);
    let pathname = parsedUrl.pathname;
    let search = parsedUrl.search;
    
    // 1. Shopify resizing pattern removal
    const shopifyRegex = /_(?:[0-9]+x[0-9]*|[0-9]*x[0-9]+|small|thumb|medium|large|grande|compact|master)(?=\.[a-z]{3,4}$)/i;
    if (shopifyRegex.test(pathname)) {
      pathname = pathname.replace(shopifyRegex, '');
    }
    
    // 2. WordPress image sizes pattern removal
    const wordpressRegex = /-[0-9]+x[0-9]+(?=\.[a-z]{3,4}$)/i;
    if (wordpressRegex.test(pathname)) {
      pathname = pathname.replace(wordpressRegex, '');
    }

    // 3. Squarespace & generic width params removal
    const params = new URLSearchParams(search);
    let hasChanged = false;
    
    if (params.has('format')) {
      const formatVal = params.get('format');
      if (/[0-9]+w/i.test(formatVal)) {
        params.delete('format');
        hasChanged = true;
      }
    }
    
    const paramsToDelete = ['width', 'height', 'w', 'h', 'size', 'resize', 'thumb', 'thumbnail', 'maxwidth', 'maxheight'];
    paramsToDelete.forEach(param => {
      if (params.has(param)) {
        params.delete(param);
        hasChanged = true;
      }
    });
    
    // Unsplash specific
    if (parsedUrl.hostname.includes('unsplash.com')) {
      params.delete('w');
      params.delete('h');
      params.delete('crop');
      params.delete('fit');
      hasChanged = true;
    }
    
    // Google / Blogger resizing path s1600 etc.
    const googlePhotoRegex = /\/s[0-9]+-h\//i;
    if (googlePhotoRegex.test(pathname)) {
      pathname = pathname.replace(googlePhotoRegex, '/s0-h/');
    } else {
      const googleSizedRegex = /\/s[0-9]+\/(?=[^\/]+$)/i;
      if (googleSizedRegex.test(pathname)) {
        pathname = pathname.replace(googleSizedRegex, '/s0/');
      }
    }
    
    // Gravatar
    if (parsedUrl.hostname.includes('gravatar.com') && params.has('s')) {
      params.set('s', '2048');
      hasChanged = true;
    }
    
    parsedUrl.pathname = pathname;
    if (hasChanged) {
      parsedUrl.search = params.toString() ? '?' + params.toString() : '';
    }
    
    return parsedUrl.href;
  } catch (e) {
    return url;
  }
}