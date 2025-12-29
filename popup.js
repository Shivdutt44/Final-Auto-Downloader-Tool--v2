document.addEventListener('DOMContentLoaded', function() {
  const mediaContainer = document.getElementById('mediaContainer');
  const imageCountElement = document.getElementById('imageCount');
  const videoCountElement = document.getElementById('videoCount');
  const otherCountElement = document.getElementById('otherCount');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const previewModal = document.getElementById('previewModal');
  const previewContent = document.getElementById('previewContent');
  const closeBtn = document.querySelector('.close-btn');
  const typeFilter = document.getElementById('typeFilter');
  const extensionFilter = document.getElementById('extensionFilter');
  const stickyDownload = document.getElementById('stickyDownload');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const downloadZipBtn = document.getElementById('downloadZipBtn');
  const selectedCount = document.getElementById('selectedCount');
  
  let mediaData = [];
  let currentPreviewIndex = 0;
  let selectedItems = new Set();
  let fileExtensions = new Set();
  let filteredMediaData = [];
  
  // Auto-scrape when popup opens
  autoScrapeMedia();
  
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
    let other = 0;
    
    mediaItems.forEach(item => {
      if (item.type === 'image') images++;
      else if (item.type === 'video') videos++;
      else other++;
    });
    
    imageCountElement.textContent = images;
    videoCountElement.textContent = videos;
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
      
      return true;
    });
    
    updateMediaDisplay(filteredMediaData);
  }
  
  // Filter event listeners
  typeFilter.addEventListener('change', applyFilters);
  extensionFilter.addEventListener('change', applyFilters);
  
  function showEmptyState() {
    mediaContainer.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-circle"></i>
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
        img.onerror = () => updateProgress();
        card.appendChild(img);
      } else if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = item.url;
        video.muted = true;
        video.playsInline = true;
        video.onloadeddata = () => updateProgress();
        video.onerror = () => updateProgress();
        card.appendChild(video);
      } else {
        const icon = document.createElement('div');
        icon.className = 'file-icon';
        icon.innerHTML = `<i class="fas fa-file"></i>`;
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
    
    // Download each selected item
    selectedMedia.forEach((item, index) => {
      setTimeout(() => {
        downloadMedia(item);
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
  
  // Download selected items as ZIP
  downloadZipBtn.addEventListener('click', () => {
    if (selectedItems.size === 0) return;
    
    const selectedMedia = filteredMediaData.filter(item => selectedItems.has(item.url));
    const urls = selectedMedia.map(item => item.url);
    const zipName = `media_archive_${new Date().toISOString().slice(0, 10)}.zip`;
    
    chrome.runtime.sendMessage({
      action: 'downloadMultiple',
      urls: urls,
      zipName: zipName
    }, (response) => {
      if (response && response.progress) {
        progressBar.style.width = `${response.progress}%`;
        progressPercent.textContent = `${response.progress}%`;
      }
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
      previewItem.appendChild(img);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      previewItem.appendChild(video);
    } else {
      const icon = document.createElement('div');
      icon.className = 'file-icon-large';
      icon.innerHTML = `<i class="fas fa-file"></i>`;
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
  function downloadMedia(mediaItem) {
    chrome.runtime.sendMessage({
      action: 'download',
      url: mediaItem.url,
      filename: getFilename(mediaItem)
    }, (response) => {
      if (response && response.progress) {
        progressBar.style.width = `${response.progress}%`;
        progressPercent.textContent = `${response.progress}%`;
      }
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
        '.bin');
    
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
    const isVideo = /\.(mp4|webm|mov|youtube|vimeo)/i.test(url);
    const isImage = /\.(jpe?g|png|gif|webp|svg)/i.test(url);
    if (isVideo) return 'video';
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
  
  // Additional scraping for lazy-loaded and dynamically loaded media
  const potentialSources = [
    ...document.querySelectorAll('[data-src]'),
    ...document.querySelectorAll('[data-original]'),
    ...document.querySelectorAll('[data-srcset]'),
    ...document.querySelectorAll('[data-background]')
  ];

  potentialSources.forEach(element => {
    try {
      const src = element.getAttribute('data-src') ||
                  element.getAttribute('data-original') ||
                  element.getAttribute('data-background');

      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        const absoluteUrl = new URL(src, window.location.href).href;

        // Check if it's likely an image or video
        const isVideo = /\.(mp4|webm|mov|youtube|vimeo)/i.test(absoluteUrl);
        const isImage = /\.(jpe?g|png|gif|webp|svg)/i.test(absoluteUrl);

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
          const response = await fetch(cssUrl);
          if (response.ok) {
            const cssText = await response.text();
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