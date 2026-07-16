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
      
      // Query the active tab
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
      const card = document.createElement('div');
      card.className = 'media-card';
      if (selectedItems.has(item.url)) {
        card.classList.add('selected');
      }


      // Add checkbox for selection
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'checkbox-select';
      checkbox.checked = selectedItems.has(item.url);
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSelection(item.url, checkbox, card);
      });
      card.appendChild(checkbox);
      
      if (item.type === 'image') {
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = 'Scraped image';
        img.loading = 'lazy';
        img.onload = () => updateProgress();
        img.onerror = () => { updateProgress(); card.style.display = 'none'; }
        card.appendChild(img);
      } else if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = item.url;
        video.muted = true;
        video.playsInline = true;
        video.onloadeddata = () => updateProgress();
        video.onerror = () => { updateProgress(); card.style.display = 'none'; }
        card.appendChild(video);
      } else if (item.type === 'audio') {
        const audio = document.createElement('audio');
        audio.src = item.url;
        audio.controls = true;
        audio.onloadeddata = () => updateProgress();
        audio.onerror = () => { updateProgress(); card.style.display = 'none'; }
        card.appendChild(audio);
      } else {
        const icon = document.createElement('div');
        icon.className = 'file-icon';
        icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="var(--primary-color)" style="width: 32px; height: 32px;"><path d="M0 64C0 28.7 28.7 0 64 0H224L384 160V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm224 0V160H352L224 64z"/></svg>`;
        card.appendChild(icon);
      }
      
      // Add eye button for preview
      const eyeButton = document.createElement('button');
      eyeButton.className = 'eye-button';
      eyeButton.innerHTML = `<img src="/icons/pre1.png" alt="Preview">`;
      eyeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        showPreview(index);
      });
      card.appendChild(eyeButton);
      
      // Click on card to show preview
      card.addEventListener('click', () => {
        showPreview(index);
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
    previewModal.style.display = 'block';
  }
  
  // Close modal
  closeBtn.addEventListener('click', () => {
    previewModal.style.display = 'none';
  });
  
  // Close modal when clicking outside
  window.addEventListener('click', (e) => {
    if (e.target === previewModal) {
      previewModal.style.display = 'none';
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

// Enhanced function to scrape ALL media from the page
async function scrapeAllMediaFromPage() {
  const mediaItems = [];
  const fetchPromises = [];

  function getMediaType(url) {
    if (url.startsWith('data:image/')) return 'image';
    if (url.startsWith('data:video/')) return 'video';
    if (url.startsWith('data:audio/')) return 'audio';
    const isVideo = /\.(mp4|webm|mov|youtube|vimeo)/i.test(url);
    const isAudio = /\.(mp3|wav|ogg|flac|m4a)/i.test(url);
    const isImage = /\.(jpe?g|png|gif|webp|svg)/i.test(url);
    if (isVideo) return 'video';
    if (isAudio) return 'audio';
    if (isImage) return 'image';
    return 'other';
  }

  function extractYouTubeVideoId(url) {
    const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return match ? match[1] : null;
  }
  
  // Scrape all possible image elements
  const imageElements = [
    ...document.querySelectorAll('img'),
    ...document.querySelectorAll('input[type="image"]'),
    ...document.querySelectorAll('[style*="background-image"]'),
    ...document.querySelectorAll('svg image')
  ];
  
  // Process image elements
  imageElements.forEach(element => {
    try {
      let src = '';
      
      if (element.tagName === 'IMG' || element.tagName === 'IMAGE') {
        src = element.src || element.getAttribute('data-src') || element.getAttribute('data-original');
      } else if (element.tagName === 'INPUT' && element.type === 'image') {
        src = element.src;
      } else if (element.style.backgroundImage) {
        const match = element.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1]) src = match[1];
      }
      
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        // Resolve relative URLs
        const absoluteUrl = new URL(src, window.location.href).href;
        
        mediaItems.push({
          type: getMediaType(absoluteUrl),
          url: absoluteUrl,
          element: element.outerHTML.slice(0, 100) + '...'
        });
      }
    } catch (e) {
      console.log('Error processing image element:', e);
    }
  });
  
  // Scrape all possible video elements
  const videoElements = [
    ...document.querySelectorAll('video'),
    ...document.querySelectorAll('iframe[src*="youtube.com"], iframe[src*="youtu.be"], iframe[src*="vimeo.com"]'),
    ...document.querySelectorAll('embed'),
    ...document.querySelectorAll('object'),
    ...document.querySelectorAll('[data-video-src]')
  ];

  // Scrape all possible audio elements
  const audioElements = [
    ...document.querySelectorAll('audio'),
    ...document.querySelectorAll('[data-audio-src]')
  ];
  
  // Process video elements
  videoElements.forEach(element => {
    try {
      let src = '';

      if (element.tagName === 'VIDEO') {
        src = element.src ||
              (element.querySelector('source') && element.querySelector('source').src);
      } else if (element.tagName === 'IFRAME') {
        src = element.src;
        if (src && (src.includes('youtube.com') || src.includes('youtu.be'))) {
          const videoId = extractYouTubeVideoId(src);
          if (videoId) {
            const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
            mediaItems.push({
              type: 'image',
              url: thumbnailUrl,
              element: `YouTube Thumbnail for ${src}`
            });
          }
        }
      } else if (element.tagName === 'EMBED') {
        src = element.src;
      } else if (element.tagName === 'OBJECT') {
        src = element.data;
      } else if (element.hasAttribute('data-video-src')) {
        src = element.getAttribute('data-video-src');
      }

      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        // Resolve relative URLs
        const absoluteUrl = new URL(src, window.location.href).href;

        mediaItems.push({
          type: getMediaType(absoluteUrl),
          url: absoluteUrl,
          element: element.outerHTML.slice(0, 100) + '...'
        });
      }
    } catch (e) {
      console.log('Error processing video element:', e);
    }
  });

  // Process audio elements
  audioElements.forEach(element => {
    try {
      let src = '';

      if (element.tagName === 'AUDIO') {
        src = element.src ||
              (element.querySelector('source') && element.querySelector('source').src);
      } else if (element.hasAttribute('data-audio-src')) {
        src = element.getAttribute('data-audio-src');
      }

      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        // Resolve relative URLs
        const absoluteUrl = new URL(src, window.location.href).href;

        mediaItems.push({
          type: getMediaType(absoluteUrl),
          url: absoluteUrl,
          element: element.outerHTML.slice(0, 100) + '...'
        });
      }
    } catch (e) {
      console.log('Error processing audio element:', e);
    }
  });
  
  // Additional scraping for lazy-loaded and dynamically loaded media
  const potentialSources = [
    ...document.querySelectorAll('[data-src]'),
    ...document.querySelectorAll('[data-original]'),
    ...document.querySelectorAll('[data-srcset]'),
    ...document.querySelectorAll('[data-background]'),
    ...document.querySelectorAll('[data-audio-src]')
  ];

  potentialSources.forEach(element => {
    try {
      const src = element.getAttribute('data-src') ||
                  element.getAttribute('data-original') ||
                  element.getAttribute('data-background') ||
                  element.getAttribute('data-audio-src');

      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        const absoluteUrl = new URL(src, window.location.href).href;

        mediaItems.push({
          type: getMediaType(absoluteUrl),
          url: absoluteUrl,
          element: element.outerHTML.slice(0, 100) + '...'
        });
      }
    } catch (e) {
      console.log('Error processing potential source:', e);
    }
  });

  // Process inline SVG elements
  const svgElements = document.querySelectorAll('svg');
  svgElements.forEach(element => {
    try {
      const svgData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(element.outerHTML);
      mediaItems.push({
        type: 'image',
        url: svgData,
        element: element.outerHTML.slice(0, 100) + '...'
      });
    } catch (e) {
      console.log('Error processing SVG element:', e);
    }
  });

  // Scrape media from external CSS files
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
            console.log('Error fetching CSS with XHR:', e);
            return;
          }
          if (cssText) {
            const urlRegex = /url\(["']?([^"']+)["']?\)/gi;
            let match;
            while ((match = urlRegex.exec(cssText)) !== null) {
              const url = match[1];
              if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
                try {
                  const absoluteUrl = new URL(url, cssUrl).href;
                  const type = getMediaType(absoluteUrl);
                  if (type !== 'other') {
                    mediaItems.push({
                      type: type,
                      url: absoluteUrl,
                      element: `CSS url() from ${cssUrl}`
                    });
                  }
                } catch (e) {
                  console.log('Error resolving CSS URL:', e);
                }
              }
            }
          }
        }
      } catch (e) {
        console.log('Error fetching CSS:', e);
      }
    })());
  });

  // Wait for all CSS fetches to complete
  await Promise.all(fetchPromises);
  // Scrape from performance resources
  const resources = performance.getEntriesByType('resource');
  resources.forEach(resource => {
    const url = resource.name;
    if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
      const type = getMediaType(url);
      if (type !== 'other') {
        mediaItems.push({
          type: type,
          url: url,
          element: `Performance resource`
        });
      }
    }
  });
  // Remove duplicates
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