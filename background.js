// Background service worker for Auto Media Downloader

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
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
            .replace(/\\/g, '');
          
          let extractedUrl = null;
          let type = 'image';
          
          // 1. Try OpenGraph video
          const ogVideoMatch = html.match(/<meta\s+(?:property|name)=["']og:video(?:[:\w]*)["']\s+content=["']([^"']+)["']/i) || 
                               html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:video(?:[:\w]*)["']/i);
          if (ogVideoMatch && ogVideoMatch[1]) {
            extractedUrl = ogVideoMatch[1];
            type = 'video';
          } 
          
          // 2. Try OpenGraph image (if not a generic profile pic)
          if (!extractedUrl) {
            const ogImageMatch = html.match(/<meta\s+(?:property|name)=["']og:image(?:[:\w]*)["']\s+content=["']([^"']+)["']/i) ||
                                 html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image(?:[:\w]*)["']/i);
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
              const jpgMatch = cleanHtml.match(/(https?:\/\/[^\s"'<>]+?\/[^\s"'<>]+?\.jpg[^\s"'<>]*)/ig);
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