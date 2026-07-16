document.addEventListener('DOMContentLoaded', function() {
  const mediaContainer = document.getElementById('mediaContainer');
  const imageCountElement = document.getElementById('imageCount');
  const videoCountElement = document.getElementById('videoCount');
  const audioCountElement = document.getElementById('audioCount');
  const otherCountElement = document.getElementById('otherCount');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const previewModal = document.getElementById('previewModal');
  const previewContent = document.getElementById('previewContent');
  const closeBtn = document.querySelector('.close-btn');
  const typeFilter = document.getElementById('typeFilter');
  const extensionFilter = document.getElementById('extensionFilter');
  const searchFilter = document.getElementById('searchFilter');
  const stickyDownload = document.getElementById('stickyDownload');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const downloadZipBtn = document.getElementById('downloadZipBtn');
  const selectedCount = document.getElementById('selectedCount');
  const refreshBtn = document.getElementById('refreshBtn');
  
  let mediaData = [];
  let currentPreviewIndex = 0;
  let selectedItems = new Set();
  let fileExtensions = new Set();
  let filteredMediaData = [];
  
  // Auto-scrape when popup opens
  autoScrapeMedia();

  // Refresh button
  refreshBtn.addEventListener('click', () => {
    autoScrapeMedia();
  });
  
  async function autoScrapeMedia() {
    try {
      // Reset UI
      mediaContainer.innerHTML = `
        <div class="loading-spinner" id="loadingSpinner"></div>
      `;
      document.getElementById('loadingSpinner').style.display = 'block';
      
      imageCountElement.textContent = '0';
      videoCountElement.textContent = '0';
      otherCountElement.textContent = '0';
      progressBar.style.width = '0%';
      progressPercent.textContent = '0%';
      selectedItems.clear();
      updateSelectedCount();
      
      // Query the active tab and check context safety
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query && chrome.scripting) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        // Execute content script to scrape media
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeAllMediaFromPage
        });
        
        if (result && result[0] && result[0].result) {
          mediaData = result[0].result;
          
          // Categorize media and count
          categorizeMedia(mediaData);
          
          // Extract file extensions
          extractFileExtensions(mediaData);
          
          // Update filters
          updateExtensionFilter();
          
          // Apply initial filter
          applyFilters();
        } else {
          showEmptyState();
        }
      } else {
        console.warn('Not running in Chrome Extension context. Simulating empty state.');
        showEmptyState();
      }
    } catch (error) {
      console.error('Error scraping media:', error);
      showEmptyState();
    }
  }
  
  // Categorize media items and count them
  function categorizeMedia(mediaItems) {
    let images = 0;
    let videos = 0;
    let audio = 0;
    let other = 0;

    mediaItems.forEach(item => {
      if (item.type === 'image') images++;
      else if (item.type === 'video') videos++;
      else if (item.type === 'audio') audio++;
      else other++;
    });

    imageCountElement.textContent = images;
    videoCountElement.textContent = videos;
    audioCountElement.textContent = audio;
    otherCountElement.textContent = other;
  }
  
  // Extract unique file extensions from media data
  function extractFileExtensions(mediaItems) {
    fileExtensions.clear();
    fileExtensions.add('all');
    
    mediaItems.forEach(item => {
      try {
        const url = new URL(item.url);
        const pathname = url.pathname;
        const extensionMatch = pathname.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
        if (extensionMatch && extensionMatch[1]) {
          fileExtensions.add(extensionMatch[1].toLowerCase());
        }
      } catch (e) {
        console.log('Error parsing URL:', e);
      }
    });
  }
  
  // Update extension filter dropdown
  function updateExtensionFilter() {
    extensionFilter.innerHTML = '';
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = 'all';
    defaultOption.textContent = 'All';
    extensionFilter.appendChild(defaultOption);
    
    // Add sorted extensions
    const sortedExtensions = Array.from(fileExtensions).filter(ext => ext !== 'all').sort();
    sortedExtensions.forEach(ext => {
      const option = document.createElement('option');
      option.value = ext;
      option.textContent = `.${ext}`;
      extensionFilter.appendChild(option);
    });
  }
  
  // Apply filters based on selected options
  function applyFilters() {
    const typeValue = typeFilter.value;
    const extensionValue = extensionFilter.value;
    const searchValue = searchFilter.value.toLowerCase();

    filteredMediaData = mediaData.filter(item => {
      // Filter by type
      if (typeValue !== 'all') {
        if (typeValue === 'svg') {
          if (!(item.type === 'image' && (item.url.includes('.svg') || item.url.includes('svg+xml')))) {
            return false;
          }
        } else if (typeValue === 'data') {
          if (!item.url.startsWith('data:')) {
            return false;
          }
        } else if (item.type !== typeValue) {
          return false;
        }
      }

      // Filter by extension
      if (extensionValue !== 'all') {
        try {
          const url = new URL(item.url);
          const pathname = url.pathname;
          const extensionMatch = pathname.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
          if (!extensionMatch || extensionMatch[1].toLowerCase() !== extensionValue) {
            return false;
          }
        } catch (e) {
          return false;
        }
      }

      // Filter by search
      if (searchValue) {
        if (!item.url.toLowerCase().includes(searchValue)) {
          return false;
        }
      }

      return true;
    });

    updateMediaDisplay(filteredMediaData);
  }
  
  // Filter event listeners
  typeFilter.addEventListener('change', applyFilters);
  extensionFilter.addEventListener('change', applyFilters);
  searchFilter.addEventListener('input', applyFilters);
  
  function showEmptyState() {
    mediaContainer.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="var(--danger-color)" style="width: 40px; height: 40px; margin-bottom: 10px;"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24V264c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zm32 224a32 32 0 1 1-64 0 32 32 0 1 1 64 0z"/></svg>
        <p>No media found on this page</p>
        <p>Try a different website</p>
      </div>
    `;
  }
  
  // Function to update the media display
  function updateMediaDisplay(mediaItems) {
    mediaContainer.innerHTML = '';

    if (mediaItems.length === 0) {
      showEmptyState();
      return;
    }


    let processed = 0;
    const total = mediaItems.length;

    mediaItems.forEach((item, index) => {
      const card = document.createElement('media-card-element');
      card.setAttribute('url', item.url);
      card.setAttribute('type', item.type);
      if (selectedItems.has(item.url)) {
        card.setAttribute('selected', '');
      }

      card.addEventListener('toggle-select', (e) => {
        const checked = e.detail.checked;
        if (checked) {
          selectedItems.add(item.url);
          card.setAttribute('selected', '');
        } else {
          selectedItems.delete(item.url);
          card.removeAttribute('selected');
        }
        updateSelectedCount();
      });

      card.addEventListener('preview-media', () => {
        showPreview(index);
      });

      card.addEventListener('media-loaded', () => {
        updateProgress();
      });

      card.addEventListener('media-error', () => {
        updateProgress();
      });

      mediaContainer.appendChild(card);
      
      function updateProgress() {
        processed++;
        const percent = Math.round((processed / total) * 100);
        progressBar.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
      }
    });
  }
  
  // Toggle selection of media item
  function toggleSelection(url, checkbox, card) {
    if (checkbox.checked) {
      selectedItems.add(url);
      card.classList.add('selected');
    } else {
      selectedItems.delete(url);
      card.classList.remove('selected');
    }
    updateSelectedCount();
  }
  
  // Update selected count in sticky download button
  function updateSelectedCount() {
    const count = selectedItems.size;
    selectedCount.textContent = count;
    
    if (count > 0) {
      stickyDownload.classList.remove('hidden');
    } else {
      stickyDownload.classList.add('hidden');
    }
  }
  
  // Download selected items individually
  downloadSelectedBtn.addEventListener('click', () => {
    if (selectedItems.size === 0) return;
    
    const selectedMedia = filteredMediaData.filter(item => selectedItems.has(item.url));
    let completed = 0;
    const total = selectedMedia.length;
    
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    
    // Download each selected item
    selectedMedia.forEach((item, index) => {
      setTimeout(() => {
        downloadMedia(item, () => {
          completed++;
          const percent = Math.round((completed / total) * 100);
          progressBar.style.width = `${percent}%`;
          progressPercent.textContent = `${percent}%`;
          
          if (completed === total) {
            setTimeout(() => {
              progressBar.style.width = '0%';
              progressPercent.textContent = '0%';
            }, 3000);
          }
        });
      }, index * 300); // Stagger downloads to avoid issues
    });
    
    // Clear selection after download
    selectedItems.clear();
    updateSelectedCount();
    
    // Update UI to remove selection highlights
    document.querySelectorAll('.media-card').forEach(card => {
      card.classList.remove('selected');
    });
    document.querySelectorAll('.checkbox-select').forEach(checkbox => {
      checkbox.checked = false;
    });
  });
  
  // Helper to fetch media URL as blob with progress
  async function fetchMediaAsBlob(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
      return await response.blob();
    }
    
    const total = parseInt(contentLength, 10);
    let loaded = 0;
    const reader = response.body.getReader();
    const chunks = [];
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (onProgress) {
        onProgress(loaded / total);
      }
    }
    
    return new Blob(chunks);
  }

  // Download selected items as ZIP
  downloadZipBtn.addEventListener('click', async () => {
    if (selectedItems.size === 0) return;
    
    const selectedMedia = filteredMediaData.filter(item => selectedItems.has(item.url));
    const total = selectedMedia.length;
    
    progressBar.style.width = '0%';
    progressPercent.textContent = '0% (Fetching...)';
    
    const zip = new JSZip();
    let completed = 0;
    const nameCount = {};
    
    for (let i = 0; i < total; i++) {
      const item = selectedMedia[i];
      try {
        let filename = getFilename(item);
        // Ensure unique filenames inside the zip
        if (nameCount[filename]) {
          const extIndex = filename.lastIndexOf('.');
          if (extIndex !== -1) {
            const name = filename.slice(0, extIndex);
            const ext = filename.slice(extIndex);
            filename = `${name}_${nameCount[filename]}${ext}`;
          } else {
            filename = `${filename}_${nameCount[filename]}`;
          }
          nameCount[filename]++;
        } else {
          nameCount[filename] = 1;
        }

        if (item.url.startsWith('data:')) {
          const parts = item.url.split(',');
          const isBase64 = parts[0].includes('base64');
          const data = parts[1];
          const content = isBase64 ? data : decodeURIComponent(data);
          zip.file(filename, content, { base64: isBase64 });
        } else {
          const blob = await fetchMediaAsBlob(item.url, (percent) => {
            const overallPercent = Math.round(((completed + percent) / total) * 100);
            progressBar.style.width = `${overallPercent}%`;
            progressPercent.textContent = `${overallPercent}% (Fetching...)`;
          });
          zip.file(filename, blob);
        }
      } catch (e) {
        console.error('Failed to add file to ZIP:', item.url, e);
      }
      completed++;
      const overallPercent = Math.round((completed / total) * 100);
      progressBar.style.width = `${overallPercent}%`;
      progressPercent.textContent = `${overallPercent}% (Fetching...)`;
    }
    
    progressPercent.textContent = 'Zipping...';
    
    try {
      const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        const percent = Math.round(metadata.percent);
        progressBar.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}% (Zipping...)`;
      });
      
      const zipName = `media_archive_${new Date().toISOString().slice(0, 10)}.zip`;
      const blobUrl = URL.createObjectURL(zipBlob);
      
      chrome.downloads.download({
        url: blobUrl,
        filename: zipName,
        saveAs: true
      }, () => {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        progressBar.style.width = '100%';
        progressPercent.textContent = 'Completed!';
        
        // Clear selection
        selectedItems.clear();
        updateSelectedCount();
        document.querySelectorAll('.media-card').forEach(card => card.classList.remove('selected'));
        document.querySelectorAll('.checkbox-select').forEach(checkbox => checkbox.checked = false);
        
        setTimeout(() => {
          progressBar.style.width = '0%';
          progressPercent.textContent = '0%';
        }, 3000);
      });
    } catch (err) {
      console.error('ZIP generation failed:', err);
      progressPercent.textContent = 'Failed to generate ZIP';
    }
  });
  
  // Show preview modal
  function showPreview(index) {
    currentPreviewIndex = index;
    previewContent.innerHTML = '';
    
    const item = filteredMediaData[index];
    const previewItem = document.createElement('div');
    previewItem.className = 'preview-item';
    
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = 'Preview image';
      img.onerror = () => previewItem.remove();
      previewItem.appendChild(img);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      video.onerror = () => previewItem.remove();
      previewItem.appendChild(video);
    } else if (item.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = item.url;
      audio.controls = true;
      audio.autoplay = true;
      audio.onerror = () => previewItem.remove();
      previewItem.appendChild(audio);
    } else {
      const icon = document.createElement('div');
      icon.className = 'file-icon-large';
      icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="var(--primary-color)" style="width: 64px; height: 64px;"><path d="M0 64C0 28.7 28.7 0 64 0H224L384 160V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm224 0V160H352L224 64z"/></svg>`;
      previewItem.appendChild(icon);
    }
    
    // Add download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'download-btn';
    downloadBtn.innerHTML = `
      <img src="/icons/download.png" alt="Download">
      Download
    `;
    downloadBtn.addEventListener('click', () => downloadMedia(item));
    previewItem.appendChild(downloadBtn);
    
    previewContent.appendChild(previewItem);
    previewModal.classList.add('active');
  }
  
  // Close modal
  closeBtn.addEventListener('click', () => {
    previewModal.classList.remove('active');
  });
  
  // Close modal when clicking outside
  window.addEventListener('click', (e) => {
    if (e.target === previewModal) {
      previewModal.classList.remove('active');
    }
  });
  
  // Download media function
  function downloadMedia(mediaItem, callback) {
    chrome.downloads.download({
      url: mediaItem.url,
      filename: getFilename(mediaItem),
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
      }
      if (callback) callback();
    });
  }
  
  // Helper function to generate filename
  function getFilename(mediaItem) {
    const url = new URL(mediaItem.url);
    const pathParts = url.pathname.split('/');
    const lastPart = pathParts[pathParts.length - 1];

    if (lastPart && lastPart.includes('.')) {
      return lastPart;
    }

    const ext = mediaItem.type === 'image' ?
      (url.pathname.match(/\.(jpe?g|png|gif|webp)$/i) ? '' : '.jpg') :
      (mediaItem.type === 'video' ?
        (url.pathname.match(/\.(mp4|webm|mov)$/i) ? '' : '.mp4') :
        (mediaItem.type === 'audio' ?
          (url.pathname.match(/\.(mp3|wav|ogg|flac|m4a)$/i) ? '' : '.mp3') :
          '.bin'));

    return `media-${Date.now()}${ext}`;
  }
});

// Enhanced function to scrape ALL media from the page (deep & micro-level automation)
async function scrapeAllMediaFromPage() {
  const mediaItems = [];
  const fetchPromises = [];

  // Expanded media type checker
  function getMediaType(url) {
    if (url.startsWith('data:image/')) return 'image';
    if (url.startsWith('data:video/')) return 'video';
    if (url.startsWith('data:audio/')) return 'audio';
    
    // Expanded extensions list
    const isVideo = /\.(mp4|webm|mov|avi|mkv|flv|wmv|m3u8|ts|mpd|oggv|3gp|m4v)(?:[\?#]|$)/i.test(url) || /youtube\.com|youtu\.be|vimeo\.com/i.test(url);
    const isAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|mid|midi|amr)(?:[\?#]|$)/i.test(url);
    const isImage = /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff|avif|heic|jpeg|jpg)(?:[\?#]|$)/i.test(url);
    
    if (isVideo) return 'video';
    if (isAudio) return 'audio';
    if (isImage) return 'image';
    return 'other';
  }

  function extractYouTubeVideoId(url) {
    const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return match ? match[1] : null;
  }

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

  // 1. Recursive Shadow DOM element collector
  function getAllElements(root = document) {
    const elements = [];
    function traverse(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        elements.push(node);
        if (node.shadowRoot) {
          traverse(node.shadowRoot);
        }
      }
      let child = node.firstChild;
      while (child) {
        traverse(child);
        child = child.nextSibling;
      }
    }
    traverse(root);
    return elements;
  }

  const allElements = getAllElements();

  // Helper to add media items with safety checks
  function addMediaItem(url, sourceElement, typeOverride = null) {
    if (!url || typeof url !== 'string') return;
    
    // Clean and convert to original high resolution URL
    let cleanUrl = getHighResUrl(url.trim());
    if (!cleanUrl) return;
    
    // Skip tiny trackers / spacer GIFs / base64 of inline symbols (except valid SVGs)
    if (cleanUrl.startsWith('data:image/gif;base64,R0lGOD')) return; // common spacer
    
    try {
      // Resolve relative URLs
      const absoluteUrl = new URL(cleanUrl, window.location.href).href;
      const type = typeOverride || getMediaType(absoluteUrl);
      
      mediaItems.push({
        type: type,
        url: absoluteUrl,
        element: sourceElement ? (sourceElement.outerHTML ? sourceElement.outerHTML.slice(0, 150) + '...' : String(sourceElement)) : 'Dynamic / CSS Source'
      });
    } catch (e) {
      // If it's a valid custom format or data URL, keep it
      if (cleanUrl.startsWith('data:') || cleanUrl.startsWith('blob:')) {
        mediaItems.push({
          type: typeOverride || getMediaType(cleanUrl),
          url: cleanUrl,
          element: sourceElement ? (sourceElement.outerHTML ? sourceElement.outerHTML.slice(0, 150) + '...' : String(sourceElement)) : 'Data URI'
        });
      }
    }
  }

  // Helper to search text string for URLs
  function scanTextForUrls(text, sourceDesc) {
    if (!text || typeof text !== 'string') return;
    
    // Matches http/https URLs or relative paths starting with /
    const urlRegex = /(https?:\/\/[^\s"'()<>]+|href=["']?([^\s"'()<>]+)|src=["']?([^\s"'()<>]+)|url\(["']?([^\s"'()<>]+)["']?\))/gi;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      let foundUrl = match[1];
      if (foundUrl.startsWith('url(')) {
        foundUrl = foundUrl.substring(4, foundUrl.length - 1).replace(/["']/g, '');
      } else if (foundUrl.startsWith('href=') || foundUrl.startsWith('src=')) {
        foundUrl = foundUrl.substring(5).replace(/["']/g, '');
      }
      
      const type = getMediaType(foundUrl);
      if (type !== 'other') {
        addMediaItem(foundUrl, sourceDesc, type);
      }
    }
  }

  // 2. Process all elements (DOM + Shadow DOM)
  allElements.forEach(element => {
    try {
      const tagName = element.tagName.toUpperCase();

      // Check standard tags
      if (tagName === 'IMG') {
        addMediaItem(element.src || element.getAttribute('src'), element);
      } else if (tagName === 'VIDEO') {
        addMediaItem(element.src || element.getAttribute('src'), element);
        // Check video sources
        element.querySelectorAll('source').forEach(source => {
          addMediaItem(source.src || source.getAttribute('src'), element, 'video');
        });
        // Check poster image
        if (element.poster) {
          addMediaItem(element.poster, element, 'image');
        }
      } else if (tagName === 'AUDIO') {
        addMediaItem(element.src || element.getAttribute('src'), element);
        element.querySelectorAll('source').forEach(source => {
          addMediaItem(source.src || source.getAttribute('src'), element, 'audio');
        });
      } else if (tagName === 'IFRAME') {
        const src = element.src || element.getAttribute('src');
        if (src) {
          if (src.includes('youtube.com') || src.includes('youtu.be')) {
            const videoId = extractYouTubeVideoId(src);
            if (videoId) {
              const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
              addMediaItem(thumbnailUrl, element, 'image');
            }
          }
          addMediaItem(src, element, 'video');
        }
      } else if (tagName === 'SOURCE') {
        // Picture source or video source
        addMediaItem(element.src || element.getAttribute('src'), element);
        const srcset = element.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(item => {
            const parts = item.trim().split(/\s+/);
            if (parts[0]) addMediaItem(parts[0], element);
          });
        }
      } else if (tagName === 'SVG' || tagName === 'IMAGE') {
        if (tagName === 'SVG') {
          const svgData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(element.outerHTML);
          addMediaItem(svgData, element, 'image');
        }
        const href = element.getAttribute('href') || element.getAttribute('xlink:href');
        if (href) addMediaItem(href, element);
      } else if (tagName === 'EMBED' || tagName === 'OBJECT') {
        addMediaItem(element.src || element.getAttribute('src') || element.data || element.getAttribute('data'), element);
      }

      // 3. Computed CSS Background Images check
      const computed = window.getComputedStyle(element);
      if (computed) {
        const bgImg = computed.backgroundImage;
        if (bgImg && bgImg !== 'none') {
          const match = bgImg.match(/url\(["']?(.*?)["']?\)/);
          if (match && match[1]) {
            addMediaItem(match[1], element);
          }
        }
      }

      // 4. Universal Attribute Scanner (inspected for media extensions/URLs)
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const value = attr.value.trim();
        if (!value) continue;
        
        // Skip standard attributes that are already processed or are not URLs
        if (['class', 'id', 'style', 'alt', 'title', 'width', 'height', 'type'].includes(attr.name.toLowerCase())) {
          continue;
        }

        // If it looks like a media URL
        const type = getMediaType(value);
        if (type !== 'other') {
          addMediaItem(value, element, type);
        } else if (value.includes('http') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
          // Check if it's a list of srcsets
          if (value.includes(',') && (value.includes('.jpg') || value.includes('.png') || value.includes('.webp') || value.includes(' '))) {
            value.split(',').forEach(part => {
              const urlPart = part.trim().split(/\s+/)[0];
              if (getMediaType(urlPart) !== 'other') {
                addMediaItem(urlPart, element);
              }
            });
          }
        }
      }
    } catch (e) {
      console.log('Error processing element in deep scraper:', e);
    }
  });

  // 5. Parse inline <style> tags
  document.querySelectorAll('style').forEach(styleTag => {
    try {
      scanTextForUrls(styleTag.textContent, 'Inline <style> tag');
    } catch (e) {}
  });

  // 6. Parse JSON-LD metadata scripts
  document.querySelectorAll('script[type="application/ld+json"]').forEach(scriptTag => {
    try {
      const json = JSON.parse(scriptTag.textContent);
      const findUrlsRecursive = (obj) => {
        if (!obj) return;
        if (typeof obj === 'string') {
          const type = getMediaType(obj);
          if (type !== 'other') {
            addMediaItem(obj, 'JSON-LD Metadata', type);
          }
        } else if (Array.isArray(obj)) {
          obj.forEach(item => findUrlsRecursive(item));
        } else if (typeof obj === 'object') {
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              // Standard schema keys for media
              if (['image', 'logo', 'thumbnailUrl', 'contentUrl', 'embedUrl', 'url'].includes(key) || typeof obj[key] === 'string' || typeof obj[key] === 'object') {
                findUrlsRecursive(obj[key]);
              }
            }
          }
        }
      };
      findUrlsRecursive(json);
    } catch (e) {}
  });

  // 7. Parse external stylesheets via link tags
  const stylesheets = document.querySelectorAll('link[rel="stylesheet"]');
  stylesheets.forEach((link) => {
    fetchPromises.push((async () => {
      try {
        const cssUrl = link.href;
        if (cssUrl) {
          let cssText;
          try {
            cssText = await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', cssUrl);
              xhr.onload = () => {
                if (xhr.status === 200) {
                  resolve(xhr.responseText);
                } else {
                  reject(new Error('Failed to load'));
                }
              };
              xhr.onerror = () => reject(new Error('Network error'));
              xhr.send();
            });
          } catch (e) {
            return;
          }
          if (cssText) {
            scanTextForUrls(cssText, `External stylesheet: ${cssUrl}`);
          }
        }
      } catch (e) {}
    })());
  });

  // Wait for all CSS fetches to complete
  await Promise.all(fetchPromises);

  // 8. Scrape from Performance Resource API (captures AJAX fetches, video streams, dynamically loaded assets)
  try {
    const resources = performance.getEntriesByType('resource');
    resources.forEach(resource => {
      const url = resource.name;
      if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
        const type = getMediaType(url);
        if (type !== 'other') {
          addMediaItem(url, 'Performance API Resource', type);
        }
      }
    });
  } catch (e) {}

  // 9. Remove duplicates and clean list
  const uniqueMediaItems = [];
  const seenUrls = new Set();
  
  mediaItems.forEach(item => {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      uniqueMediaItems.push(item);
    }
  });
  
  return uniqueMediaItems;
}

// Custom Web Component for Media Cards using Shadow DOM
class MediaCardElement extends HTMLElement {
  static get observedAttributes() {
    return ['url', 'type', 'selected'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const url = this.getAttribute('url') || '';
    const type = this.getAttribute('type') || '';
    const selected = this.hasAttribute('selected');
    
    const style = `
      :host {
        display: block;
        border-radius: 10px;
        overflow: hidden;
        position: relative;
        cursor: pointer;
        box-shadow: 0 4px 10px rgba(0,0,0,0.03);
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        background-color: white;
        border: 2px solid transparent;
        height: 115px;
      }
      :host(:hover) {
        transform: translateY(-2px);
        box-shadow: 0 8px 16px rgba(108, 92, 231, 0.12);
        border-color: rgba(108, 92, 231, 0.2);
      }
      :host([selected]) {
        border-color: var(--accent-color, #fd79a8);
        box-shadow: 0 8px 20px rgba(253, 121, 168, 0.2);
      }
      img, video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .file-icon {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #f7fafc;
        color: var(--primary-color, #6c5ce7);
      }
      .eye-button {
        position: absolute;
        top: 6px;
        right: 6px;
        background-color: rgba(255,255,255,0.9);
        border: none;
        border-radius: 50%;
        width: 26px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        backdrop-filter: blur(5px);
        transition: all 0.2s ease;
        z-index: 2;
        opacity: 0;
        transform: scale(0.8);
      }
      :host(:hover) .eye-button {
        opacity: 1;
        transform: scale(1);
      }
      .eye-button:hover {
        transform: scale(1.1);
        background-color: white;
        box-shadow: 0 2px 8px rgba(108, 92, 231, 0.25);
      }
      .eye-button svg {
        width: 14px;
        height: 14px;
        fill: #2d3436;
      }
      .checkbox-select {
        position: absolute;
        top: 6px;
        left: 6px;
        width: 18px;
        height: 18px;
        z-index: 10;
        accent-color: var(--accent-color, #fd79a8);
        cursor: pointer;
        border-radius: 4px;
      }
      .checkbox-select:checked {
        box-shadow: 0 0 0 2px white;
      }
    `;

    let contentHtml = '';
    if (type === 'image') {
      contentHtml = `<img src="${url}" alt="Media Image" loading="lazy">`;
    } else if (type === 'video') {
      contentHtml = `<video src="${url}" preload="metadata" muted></video>`;
    } else {
      let iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="currentColor" style="width: 28px; height: 28px;"><path d="M0 64C0 28.7 28.7 0 64 0H224L384 160V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm224 0V160H352L224 64z"/></svg>`;
      if (type === 'audio') {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="currentColor" style="width: 28px; height: 28px;"><path d="M192 0C86 0 0 86 0 192c0 77.4 46.2 144 112 173v47c0 17.7 14.3 32 32 32h16c17.7 0 32-14.3 32-32v-16h32v16c0 17.7 14.3 32 32 32h16c17.7 0 32-14.3 32-32v-47c65.8-29 112-95.6 112-173C384 86 298 0 192 0z"/></svg>`;
      }
      contentHtml = `<div class="file-icon">${iconSvg}</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <input type="checkbox" class="checkbox-select" ${selected ? 'checked' : ''}>
      ${contentHtml}
      <button class="eye-button" title="Preview">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path d="M288 32c-144.8 0-271.8 82.8-328 201.7c-5.9 12.5-5.9 26.9 0 39.4C16.2 391.2 143.2 474 288 474s271.8-82.8 328-201.7c5.9-12.5 5.9-26.9 0-39.4C559.8 114.8 432.8 32 288 32zM288 400c-70.7 0-128-57.3-128-128s57.3-128 128-128s128 57.3 128 128s-57.3 128-128 128zm0-208c-44.2 0-80 35.8-80 80s35.8 80 80 80s80-35.8 80-80s-35.8-80-80-80z"/></svg>
      </button>
    `;

    const checkbox = this.shadowRoot.querySelector('.checkbox-select');
    const eyeBtn = this.shadowRoot.querySelector('.eye-button');
    const img = this.shadowRoot.querySelector('img');
    const video = this.shadowRoot.querySelector('video');

    const triggerLoad = () => {
      this.dispatchEvent(new CustomEvent('media-loaded'));
    };
    const triggerError = () => {
      this.style.display = 'none';
      this.dispatchEvent(new CustomEvent('media-error'));
    };

    if (img) {
      img.onload = triggerLoad;
      img.onerror = triggerError;
    } else if (video) {
      video.onloadeddata = triggerLoad;
      video.onerror = triggerError;
    } else {
      setTimeout(triggerLoad, 50);
    }

    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('toggle-select', { detail: { checked: checkbox.checked } }));
    });

    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('preview-media'));
    });

    this.addEventListener('click', (e) => {
      if (e.target !== this) return;
      checkbox.checked = !checkbox.checked;
      this.dispatchEvent(new CustomEvent('toggle-select', { detail: { checked: checkbox.checked } }));
    });
  }
}
customElements.define('media-card-element', MediaCardElement);