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
  
  // Create a context menu option for media files (expanded to link and page contexts)
  chrome.contextMenus.create({
    id: "download-media",
    title: "Download Media with Auto Downloader",
    contexts: ["image", "video", "audio", "link", "page"]
  });
});

// Handle YouTube video download requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
  // Pushed by the content script once a real-time tab recording finishes (see
  // recordActiveTabVideo in popup.js) - handled here rather than in popup.js so the
  // download still lands even if the popup was closed while the video played out.
  if (request.action === 'recording-complete') {
    handleRecordingComplete(request);
    sendResponse({ received: true });
    return true;
  }
});

// Saves a video recorded in real time (via HTMLMediaElement.captureStream() +
// MediaRecorder) from the actual decoded playback - used as the primary YouTube
// download method since it doesn't depend on YouTube's stream-delivery format at all
// (sidesteps the SABR/UMP issue entirely), at the cost of taking real playback time.
async function handleRecordingComplete({ base64, mimeType, filename }) {
  try {
    // Service workers don't have URL.createObjectURL (verified: throws "not a
    // function"), and a blob: URL created elsewhere wouldn't resolve here anyway -
    // blob URLs are scoped to the document that created them. A data: URL is a
    // plain string, so it needs neither. The content script already base64-encoded
    // this (chrome.runtime.sendMessage would otherwise silently empty a raw buffer).
    // Strip any ";codecs=vp9,opus" suffix - data: URLs use comma as a structural
    // delimiter, so a codecs value containing one (verified) corrupts the whole URL.
    const baseMimeType = (mimeType || 'video/webm').split(';')[0];
    const finalFilename = filename || `yt_recording_${Date.now()}.webm`;
    chrome.notifications.clear(RECORDING_NOTIFICATION_ID);
    chrome.downloads.download({
      url: `data:${baseMimeType};base64,${base64}`,
      filename: finalFilename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      // This still lands in Chrome's own download shelf/toolbar icon automatically -
      // the notification here is extra visibility since the popup that started the
      // recording is very likely already closed by the time this fires.
      if (chrome.runtime.lastError || !downloadId) {
        notify('Download failed', chrome.runtime.lastError?.message || 'Could not save the recorded video.');
      } else {
        notify('Video downloaded', finalFilename);
      }
    });
  } catch (e) {
    chrome.notifications.clear(RECORDING_NOTIFICATION_ID);
    notify('Download failed', e.message);
    console.error('Failed to save recorded video:', e);
  }
}

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
    const blob = await response.blob();
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
    const timer = setTimeout(() => finish(anyHit), timeoutMs);
  });
}

// Fire-and-forget: retries play() for a while since YouTube's SPA UI mounts the
// <video> element progressively, so it may not exist yet right after navigation.
function nudgePlayback(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const video = document.querySelector('video');
        if (video) {
          try {
            video.muted = true;
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
async function extractStaticStreamUrl(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
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
          const pr = window.ytInitialPlayerResponse;
          if (!pr?.streamingData) return null;
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
async function extractStreamFromTab(tabId, timeoutMs) {
  const capture = captureGooglevideoUrl(tabId, timeoutMs);
  nudgePlayback(tabId);
  const networkUrl = await capture;
  if (networkUrl) return networkUrl;
  return await extractStaticStreamUrl(tabId);
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

    // webRequest observation is attached before playback even has a chance to start
    // (extractStreamFromTab does this immediately), so there's no need to wait for
    // the tab's 'complete' status first.
    return await extractStreamFromTab(hiddenTabId, 9000);
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
// moments later (shows up in history as "File wasn't available on site"). Wait for
// the actual terminal state before trusting it succeeded.
function waitForDownloadResult(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish(true);
      else if (delta.state.current === 'interrupted') finish(false);
    }
    chrome.downloads.onChanged.addListener(listener);
    // Covers the case where it already completed/failed before the listener attached
    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (item?.state === 'complete') finish(true);
      else if (item?.state === 'interrupted') finish(false);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
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

// A completed download can still be worthless: some googlevideo URLs (YouTube's
// newer SABR/UMP negotiation requests, lacking an explicit itag) return a tiny
// protocol handshake instead of actual media if fetched as a plain file - verified
// directly, one such "successful" download was 31 bytes of application/vnd.yt-ump.
async function isDownloadValid(downloadId) {
  const results = await new Promise((resolve) => chrome.downloads.search({ id: downloadId }, resolve));
  const item = results && results[0];
  return !!item && (item.fileSize || 0) > 20000;
}

// Downloads a resolved googlevideo stream: tries the browser's own download
// pipeline first (fastest, no CORS concerns), then falls back to fetching with a
// spoofed YouTube referrer and downloading the resulting blob if that's rejected.
async function downloadStreamUrl(streamUrl, filename) {
  try {
    const downloadId = await queueDownload(streamUrl, filename);
    if (await waitForDownloadResult(downloadId, 8000) && await isDownloadValid(downloadId)) {
      return downloadId;
    }
    chrome.downloads.erase({ id: downloadId }, () => {});
  } catch (e) {
    console.warn('Direct stream download failed, trying fetch:', e);
  }

  let response;
  try {
    response = await fetch(streamUrl, {
      headers: {
        'Referer': 'https://www.youtube.com/',
        'User-Agent': navigator.userAgent
      }
    });
  } catch (e) {
    console.warn('Fetch-based YouTube download failed:', e);
    return null;
  }
  if (!response.ok) return null;
  const blob = await response.blob();
  if (blob.size <= 20000) return null;
  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await queueDownload(blobUrl, filename);
    if (await waitForDownloadResult(downloadId, 15000)) return downloadId;
    chrome.downloads.erase({ id: downloadId }, () => {});
    return null;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function handleYouTubeDownload(request, sendResponse) {
  try {
    const { videoId, filename, tabId, watchUrl, isShorts } = request;
    if (!videoId) {
      sendResponse({ success: false, error: 'No video ID provided' });
      return;
    }
    const finalFilename = filename || `yt_${videoId}.mp4`;

    let streamUrl = tabId ? await extractStreamFromTab(tabId, 5000) : null;

    // Not the video currently open in that tab (e.g. a feed thumbnail) - resolve
    // it from its own watch page in the background instead.
    if (!streamUrl || !/googlevideo/i.test(streamUrl)) {
      const resolvedWatchUrl = watchUrl || (isShorts
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`);
      streamUrl = await resolveStreamViaHiddenTab(videoId, resolvedWatchUrl);
    }

    if (streamUrl && /googlevideo/i.test(streamUrl)) {
      const downloadId = await downloadStreamUrl(streamUrl, finalFilename);
      if (downloadId) {
        sendResponse({ success: true, downloadId });
        return;
      }
      // A stream URL was found but produced no usable file - this happens when
      // YouTube only offers its newer SABR/UMP delivery for this video, which needs
      // the player's own chunk-negotiation protocol rather than a single GET request.
      sendResponse({ success: false, error: 'Found a stream but could not download real video data from it (this video may only be available via YouTube\'s newer streaming protocol, which this extension can\'t decode).' });
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
      // Blob URLs are scoped to the tab's document - resolve them inside the tab first
      if (mediaUrl.startsWith('blob:') && tab && tab.id) {
        mediaUrl = await resolveBlobUrl(tab.id, mediaUrl);
      }

      // Convert to original high-resolution URL
      mediaUrl = getHighResUrl(mediaUrl);

      // Determine file extension
      let filename = mediaUrl.split('/').pop().split('?')[0] || `media-${Date.now()}`;
      if (!filename.includes('.')) {
        // Guess extension from mediaType context
        if (info.mediaType === 'image') filename += '.jpg';
        else if (info.mediaType === 'video') filename += '.mp4';
        else if (info.mediaType === 'audio') filename += '.mp3';
      }

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
        let filename = url.split('/').pop().split('?')[0] || `media-${Date.now()}`;
        if (!filename.includes('.')) {
          filename += (type === 'video' ? '.mp4' : '.jpg');
        }
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false,
          conflictAction: 'uniquify'
        });
      };

      if (postUrl && postUrl.startsWith('http')) {
        try {
          const response = await fetch(postUrl);
          const html = await response.text();
          // Unescape JSON Unicode escapes and backslashes in HTML payload
          const cleanHtml = html
            .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
            .replace(/\\\\/g, '');
          
          let extractedUrl = null;
          let type = 'image';
          
          // 1. Try OpenGraph video
          const ogVideoMatch = html.match(/<meta\s+(?:property|name)=["']og:video(?:[:w]*)?["']\s+content=["']([^"']+)["']/i) || 
                               html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:video(?:[:w]*)?["']/i);
          if (ogVideoMatch && ogVideoMatch[1]) {
            extractedUrl = ogVideoMatch[1];
            type = 'video';
          } 
          
          // 2. Try OpenGraph image (if not a generic profile pic)
          if (!extractedUrl) {
            const ogImageMatch = html.match(/<meta\s+(?:property|name)=["']og:image(?:[:w]*)?["']\s+content=["']([^"']+)["']/i) ||
                                 html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image(?:[:w]*)?["']/i);
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
            extractedUrl = extractedUrl.replace(/u0026/g, '&').replace(/x26/g, '&');
            downloadFallbackMedia(extractedUrl, type);
            return; // Success
          }
        } catch (e) {
          console.error("Background fetch for OpenGraph failed:", e);
        }
      }
      
      // 4. In-page script fallback if fetch fails or URL is unreachable
      if (tab && tab.id) {
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
              
              let bestUrl = largest.src;
              if (largest.srcset) {
                const parts = largest.srcset.split(',');
                const lastPart = parts[parts.length - 1].trim().split(/\s+/)[0];
                if (lastPart) bestUrl = lastPart;
              }
              return { url: bestUrl, type: 'image' };
            }
            return null;
          }
        }, (results) => {
          if (results && results[0] && results[0].result) {
            const media = results[0].result;
            if (media.url.startsWith('blob:')) {
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => alert('Blob video detected. Please open the Auto Downloader Popup to download this video properly.')
              });
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

// Resolve a blob: URL created inside a tab's document by fetching it there and
// converting it to a data URL, since blob URLs aren't reachable from the extension context.
async function resolveBlobUrl(tabId, blobUrl) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      },
      args: [blobUrl]
    });
    return (result && result[0] && result[0].result) || blobUrl;
  } catch (e) {
    console.error('Failed to resolve blob URL from context menu:', e);
    return blobUrl;
  }
}

// Get original/high-resolution URL by removing sizing parameters and CDN suffixes
function getHighResUrl(url) {
  if (!url || typeof url !== 'string') {
    return url;
  }
  
  // Helper to unescape JSON Unicode escapes and backslashes
  const unescapeUrl = (u) => {
    if (!u || typeof u !== 'string') return u;
    return u
      .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
      .replace(/\\\\/g, '')
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