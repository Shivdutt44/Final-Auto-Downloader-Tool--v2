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
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "download-media") {
    // Smart URL detection: check media source, hyperlink source, or tab URL (for direct media tabs)
    let mediaUrl = info.srcUrl || info.linkUrl;
    
    if (!mediaUrl && tab && tab.url && /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff|avif|heic|mp4|webm|mov|avi|mp3|wav|ogg|flac|m4a)(?:[\?#]|$)/i.test(tab.url)) {
      mediaUrl = tab.url;
    }

    if (mediaUrl) {
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
    }
  }
});

// Get original/high-resolution URL by removing sizing parameters and CDN suffixes
function getHighResUrl(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  try {
    let parsedUrl = new URL(url);
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