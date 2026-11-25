document.addEventListener('DOMContentLoaded', function() {
  const mediaContainer = document.getElementById('mediaContainer');
  const imageCountElement = document.getElementById('imageCount');
  const videoCountElement = document.getElementById('videoCount');
  const audioCountElement = document.getElementById('audioCount');
  const otherCountElement = document.getElementById('otherCount');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  const progressContainer = document.getElementById('progressContainer');
  const progressLabel = document.getElementById('progressLabel');
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
  const statCards = document.querySelectorAll('.stat-card[data-type]');

  let mediaData = [];
  let currentPreviewIndex = 0;
  let selectedItems = new Set();
  let fileExtensions = new Set();
  let filteredMediaData = [];
  let autoScanInterval = null;
  let activeTabId = null;
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  
  // Auto-scrape when popup opens
  autoScrapeMedia().then(() => {
    startAutoScan();
  });

  // Refresh button
  refreshBtn.addEventListener('click', () => {
    autoScrapeMedia().then(() => {
      startAutoScan();
    });
  });

  // Dynamically scroll the page to force YouTube / Reels infinite-load
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) return;
      try {
        loadMoreBtn.disabled = true;
        loadMoreBtn.classList.add('loading');
        const originalText = loadMoreBtn.dataset.label || loadMoreBtn.textContent;
        loadMoreBtn.dataset.label = originalText;
        loadMoreBtn.textContent = 'Loading feed...';

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        activeTabId = tab.id;

        await ensureDynamicLoader(tab.id);

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            if (typeof window.__AMD_SCROLL_LOAD__ === 'function') {
              return await window.__AMD_SCROLL_LOAD__(8, 850);
            }
            // Fallback scroll if loader missing
            for (let i = 0; i < 6; i++) {
              window.scrollBy(0, window.innerHeight * 0.95);
              await new Promise(r => setTimeout(r, 700));
            }
            return { fallback: true };
          }
        });

        // Re-scrape after scroll loads new items
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeAllMediaFromPage
        });
        if (result?.[0]?.result) {
          integrateNewMedia(result[0].result);
          await mergeCacheStreamsIntoTab(tab.id);
        }

        loadMoreBtn.textContent = 'Loaded ✓';
        setTimeout(() => {
          loadMoreBtn.textContent = loadMoreBtn.dataset.label || 'Load More Videos';
          loadMoreBtn.disabled = false;
          loadMoreBtn.classList.remove('loading');
        }, 1200);
      } catch (e) {
        console.error('Load more failed:', e);
        loadMoreBtn.textContent = 'Retry Load More';
        loadMoreBtn.disabled = false;
        loadMoreBtn.classList.remove('loading');
      }
    });
  }

  async function ensureDynamicLoader(tabId) {
    try {
      // Isolated-world observer + cache (DOM / performance / scroll)
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dynamic-loader.js']
      });

      // MAIN-world: access YouTube player globals & capture progressive stream URLs
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          if (window.__AMD_MAIN_HOOKS__) return;
          window.__AMD_MAIN_HOOKS__ = true;

          const pushStream = (url, meta) => {
            if (!url) return;
            try {
              window.dispatchEvent(new CustomEvent('amd-media-found', {
                detail: { url, streamUrl: url, type: 'video', source: 'main-world', ...(meta || {}) }
              }));
            } catch (_) {}
            // Also stash on document for isolated world polling
            try {
              const node = document.documentElement;
              const prev = node.getAttribute('data-amd-streams') || '[]';
              let list = [];
              try { list = JSON.parse(prev); } catch (_) { list = []; }
              if (!list.includes(url)) {
                list.push(url);
                if (list.length > 40) list = list.slice(-40);
                node.setAttribute('data-amd-streams', JSON.stringify(list));
              }
              if (meta?.videoId) {
                node.setAttribute('data-amd-vid', meta.videoId);
              }
            } catch (_) {}
          };

          const harvestPlayer = () => {
            try {
              const pr = window.ytInitialPlayerResponse;
              if (!pr?.streamingData) return;
              const videoId = pr.videoDetails?.videoId;
              const title = pr.videoDetails?.title;
              const formats = [
                ...(pr.streamingData.formats || []),
                ...(pr.streamingData.adaptiveFormats || [])
              ];
              formats.forEach(f => {
                // Handle both direct url and signatureCipher/cipher
                let streamUrl = f.url;
                if (!streamUrl) {
                  const cipherStr = f.signatureCipher || f.cipher;
                  if (cipherStr) {
                    try {
                      const params = new URLSearchParams(cipherStr);
                      const url = params.get('url');
                      const sp = params.get('sp') || 'signature';
                      const sig = params.get('s');
                      if (url) {
                        const urlObj = new URL(decodeURIComponent(url));
                        if (sig) urlObj.searchParams.set(sp, sig);
                        streamUrl = urlObj.toString();
                      }
                    } catch (_) {}
                  }
                }
                if (streamUrl) pushStream(streamUrl, { videoId, title });
              });
            } catch (_) {}
          };

          harvestPlayer();
          setInterval(harvestPlayer, 3000);

          // Hook fetch for googlevideo
          const origFetch = window.fetch;
          if (origFetch) {
            window.fetch = function () {
              const p = origFetch.apply(this, arguments);
              try {
                const input = arguments[0];
                const u = typeof input === 'string' ? input : (input && input.url);
                if (u && /googlevideo\.com\/videoplayback/i.test(u)) {
                  pushStream(u, { source: 'fetch' });
                }
              } catch (_) {}
              return p;
            };
          }

          window.addEventListener('yt-navigate-finish', () => setTimeout(harvestPlayer, 500));
        }
      });
    } catch (e) {
      console.warn('Dynamic loader inject failed:', e);
    }
  }
  
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
        if (!tab?.id) {
          showEmptyState();
          return;
        }
        activeTabId = tab.id;

        // Install persistent dynamic loader (YouTube/Shorts/Reels infinite scroll)
        await ensureDynamicLoader(tab.id);
        
        // Execute content script to scrape media
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeAllMediaFromPage
        });
        
        if (result && result[0] && result[0].result) {
          mediaData = result[0].result;
          
          // Merge stream URLs from dynamic-loader cache
          await mergeCacheStreamsIntoTab(tab.id);
          
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

  // Start periodic live background scanning
  function startAutoScan() {
    if (autoScanInterval) clearInterval(autoScanInterval);
    
    autoScanInterval = setInterval(async () => {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query && chrome.scripting) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return;
          activeTabId = tab.id;

          // Keep dynamic loader alive across SPA navigations
          await ensureDynamicLoader(tab.id);
          
          // Silently execute scraper content script in the page
          const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrapeAllMediaFromPage
          });
          
          if (result && result[0] && result[0].result) {
            integrateNewMedia(result[0].result);
            // Also merge stream URLs from cache
            await mergeCacheStreamsIntoTab(tab.id);
          }
        } catch (e) {
          console.warn('Background dynamic scan skipped / context detached:', e);
        }
      }
    }, 1500);
  }

  // Read stream URLs from dynamic-loader cache and merge into mediaData
  async function mergeCacheStreamsIntoTab(tabId) {
    if (!tabId || typeof chrome === 'undefined' || !chrome.scripting) return;
    try {
      const cacheResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Prefer __AMD_GET_CACHE__ function for full item list, else fallback
          const cache = (typeof window.__AMD_GET_CACHE__ === 'function')
            ? window.__AMD_GET_CACHE__()
            : (window.__AMD_MEDIA_CACHE__ || []);
          // Return only items that have streamUrl (googlevideo) or videoId info
          return cache
            .filter(m => m.streamUrl || m.videoId)
            .map(m => ({
              type: m.type || 'video',
              url: m.streamUrl || m.url,
              watchUrl: m.watchUrl || null,
              streamUrl: m.streamUrl || null,
              thumbnail: m.thumbnail || null,
              videoId: m.videoId || null,
              title: m.title || null,
              source: m.source || 'cache',
              isYouTube: m.isYouTube === true || !!m.videoId,
              isShorts: m.isShorts === true,
              element: m.element || 'Cache'
            }));
        }
      });
      if (cacheResult?.[0]?.result && Array.isArray(cacheResult[0].result)) {
        const cachedItems = cacheResult[0].result;
        let merged = false;
        cachedItems.forEach(cacheItem => {
          if (!cacheItem.videoId && !cacheItem.streamUrl) return;
          // Try to find matching item in mediaData by videoId or streamUrl
          const match = mediaData.find(m => 
            (m.videoId && cacheItem.videoId && m.videoId === cacheItem.videoId) ||
            (cacheItem.streamUrl && m.url === cacheItem.streamUrl) ||
            (cacheItem.watchUrl && m.url === cacheItem.watchUrl)
          );
          if (match) {
            // Enrich existing item with stream URL if missing
            if (cacheItem.streamUrl && !match.streamUrl) {
              match.streamUrl = cacheItem.streamUrl;
              match.url = cacheItem.streamUrl; // Update primary URL to stream
              merged = true;
            }
            if (cacheItem.thumbnail && !match.thumbnail) {
              match.thumbnail = cacheItem.thumbnail;
            }
          } else if (cacheItem.streamUrl && /googlevideo\.com/i.test(cacheItem.streamUrl)) {
            // Add new entry for googlevideo streams not in current list
            mediaData.push(cacheItem);
            merged = true;
          }
        });
        if (merged) {
          categorizeMedia(mediaData);
          extractFileExtensions(mediaData);
          updateExtensionFilter();
          applyFilters();
        }
      }
    } catch (e) {
      console.warn('Cache stream merge failed:', e);
    }
  }

  // Safely integrate newly discovered media assets without breaking selection states
  function integrateNewMedia(newMediaItems) {
    let addedAny = false;
    
    newMediaItems.forEach(newItem => {
      // Deduplicate by url OR youtube videoId
      const exists = mediaData.some(item => {
        if (item.url === newItem.url) return true;
        if (newItem.videoId && item.videoId && item.videoId === newItem.videoId) {
          // Upgrade existing entry if new one has a real stream URL
          if (newItem.streamUrl && !item.streamUrl) {
            Object.assign(item, newItem);
            addedAny = true;
          } else if (newItem.thumbnail && !item.thumbnail) {
            item.thumbnail = newItem.thumbnail;
          }
          return true;
        }
        return false;
      });
      if (!exists) {
        mediaData.push(newItem);
        addedAny = true;
      }
    });
    
    if (addedAny) {
      // Recalculate statistics
      categorizeMedia(mediaData);
      
      // Update file filters
      extractFileExtensions(mediaData);
      updateExtensionFilter();
      
      // Re-apply filters to sync the display
      applyFilters();
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

      // Filter by search (URL, title, video id, source)
      if (searchValue) {
        const hay = [
          item.url,
          item.title,
          item.videoId,
          item.watchUrl,
          item.source,
          item.isShorts ? 'shorts reel' : ''
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(searchValue)) {
          return false;
        }
      }

      return true;
    });

    updateMediaDisplay(filteredMediaData);
  }
  
  // Filter event listeners
  typeFilter.addEventListener('change', () => {
    syncStatCardActiveState();
    applyFilters();
  });
  extensionFilter.addEventListener('change', applyFilters);
  searchFilter.addEventListener('input', applyFilters);

  // Stat cards act as quick filters (Images/Videos/Audio/Other).
  // Clicking the already-active card clears the filter back to "All".
  statCards.forEach(card => {
    const type = card.getAttribute('data-type');
    card.addEventListener('click', () => {
      typeFilter.value = (typeFilter.value === type) ? 'all' : type;
      syncStatCardActiveState();
      applyFilters();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
  });

  // Highlight whichever stat card matches the current type filter
  function syncStatCardActiveState() {
    const activeType = typeFilter.value;
    statCards.forEach(card => {
      card.classList.toggle('active', card.getAttribute('data-type') === activeType);
    });
  }
  
  function showEmptyState() {
    mediaContainer.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="var(--danger-color)" style="width: 40px; height: 40px; margin-bottom: 10px;"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24V264c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zm32 224a32 32 0 1 1-64 0 32 32 0 1 1 64 0z"/></svg>
        <p>No media found on this page</p>
        <p>Try a different website</p>
      </div>
    `;
  }
  
  // Function to update the media display dynamically (performs incremental DOM reconciliation)
  function updateMediaDisplay(mediaItems) {
    if (mediaItems.length === 0) {
      showEmptyState();
      return;
    }

    // Remove empty state / loading indicators if present
    const empty = mediaContainer.querySelector('.empty-state');
    if (empty) empty.remove();
    const spinner = mediaContainer.querySelector('.loading-spinner');
    if (spinner) spinner.remove();

    // Map existing cards by URL to reuse them
    const existingCards = new Map();
    Array.from(mediaContainer.children).forEach(child => {
      if (child.tagName === 'MEDIA-CARD-ELEMENT') {
        existingCards.set(child.getAttribute('url'), child);
      }
    });

    // Determine cards that should remain
    const keepUrls = new Set(mediaItems.map(item => item.url));

    // Remove cards for media that are no longer filtered/valid
    existingCards.forEach((card, url) => {
      if (!keepUrls.has(url)) {
        card.remove();
      }
    });

    mediaItems.forEach((item, index) => {
      const cardKey = item.url;
      let card = existingCards.get(cardKey);
      if (!card) {
        // Instantiate custom Web Component
        card = document.createElement('media-card-element');
        card.setAttribute('url', item.url);
        card.setAttribute('type', item.type);
        card.setAttribute('index', index);
        if (item.thumbnail) card.setAttribute('thumbnail', item.thumbnail);
        if (item.videoId) card.setAttribute('video-id', item.videoId);
        if (item.isYouTube) card.setAttribute('youtube', '');
        if (item.isShorts) card.setAttribute('shorts', '');
        if (item.title) card.setAttribute('title', item.title);
        if (item.streamUrl) card.setAttribute('stream-url', item.streamUrl);

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
          showPreview(parseInt(card.getAttribute('index')));
        });

        card.addEventListener('download-media', () => {
          const current = filteredMediaData[parseInt(card.getAttribute('index'))];
          if (current) downloadMedia(current);
        });

        mediaContainer.appendChild(card);
      } else {
        // Update index attribute directly
        card.setAttribute('index', index);
        if (item.thumbnail) card.setAttribute('thumbnail', item.thumbnail);
        if (item.streamUrl) card.setAttribute('stream-url', item.streamUrl);
      }

      // Synchronize selection state
      if (selectedItems.has(item.url)) {
        card.setAttribute('selected', '');
      } else {
        card.removeAttribute('selected');
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
    
    if (progressContainer) progressContainer.classList.remove('hidden');
    if (progressLabel) progressLabel.textContent = 'Download Progress';
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
              if (progressContainer) progressContainer.classList.add('hidden');
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
    
    if (progressContainer) progressContainer.classList.remove('hidden');
    if (progressLabel) progressLabel.textContent = 'ZIP Export Progress';
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

        const resolvedUrl = await resolveDownloadUrl(item);

        if (resolvedUrl.startsWith('data:')) {
          const parts = resolvedUrl.split(',');
          const isBase64 = parts[0].includes('base64');
          const data = parts[1];
          const content = isBase64 ? data : decodeURIComponent(data);
          zip.file(filename, content, { base64: isBase64 });
        } else {
          const blob = await fetchMediaAsBlob(resolvedUrl, (percent) => {
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
          if (progressContainer) progressContainer.classList.add('hidden');
        }, 3000);
      });
    } catch (err) {
      console.error('ZIP generation failed:', err);
      progressPercent.textContent = 'Failed to generate ZIP';
    }
  });
  
  // Show preview modal
  async function showPreview(index) {
    currentPreviewIndex = index;
    revokePreviewBlobUrls();
    previewContent.innerHTML = '';

    const item = filteredMediaData[index];
    const previewItem = document.createElement('div');
    previewItem.className = 'preview-item';

    // blob: URLs belong to the source tab's document and can't be loaded directly
    // inside the popup - resolve them to a data URL first.
    const isBlob = item.url && item.url.startsWith('blob:');
    const hasVideoId = item.videoId && /^[a-zA-Z0-9_-]{11}$/.test(item.videoId);

    let playableUrl = item.streamUrl || item.url;
    if (isBlob && (item.type === 'video' || item.type === 'image' || item.type === 'audio')) {
      const loading = document.createElement('div');
      loading.className = 'file-icon-large';
      loading.textContent = 'Loading preview...';
      previewItem.appendChild(loading);
      previewContent.appendChild(previewItem);
      previewModal.classList.add('active');
      playableUrl = await resolveDownloadUrl(item);
      loading.remove();
    }

    if (item.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'preview-title';
      titleEl.textContent = item.title;
      previewItem.appendChild(titleEl);
    }

    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = playableUrl;
      img.alt = 'Preview image';
      img.onerror = () => previewItem.remove();
      previewItem.appendChild(img);
    } else if (item.type === 'video' && hasVideoId) {
      // Iframe embeds reliably fail inside extension popups - YouTube rejects the
      // chrome-extension:// origin and shows "Error 153". Resolve a direct stream
      // (same pipeline used for downloads) and autoplay it in a native <video> instead.
      const loading = document.createElement('div');
      loading.className = 'file-icon-large';
      loading.textContent = 'Resolving stream...';
      previewItem.appendChild(loading);
      previewContent.appendChild(previewItem);
      previewModal.classList.add('active');

      let resolvedStream = /googlevideo\.com/i.test(playableUrl || '') ? playableUrl : null;
      if (!resolvedStream) {
        resolvedStream = await resolveDownloadUrl(item);
      }
      // Prefer a classic progressive format (has an explicit itag) - a plain
      // googlevideo hit without one is often YouTube's newer SABR/UMP negotiation
      // request, which returns a tiny protocol handshake rather than real media if
      // fetched as a file. If the active tab didn't have a good one, the hidden-tab
      // path (which specifically watches the network for an itag'd request) usually
      // finds one; only fall back to a non-itag hit if that also comes up empty.
      if (!resolvedStream || !/googlevideo\.com/i.test(resolvedStream) || !/itag=\d+/i.test(resolvedStream)) {
        loading.textContent = 'Fetching video source...';
        const hiddenTabStream = await resolveStreamViaHiddenTab(item);
        if (hiddenTabStream) resolvedStream = hiddenTabStream;
      }

      let playedInline = false;
      if (resolvedStream && /googlevideo\.com/i.test(resolvedStream)) {
        try {
          loading.textContent = 'Loading video...';
          const { base64, mimeType } = await fetchStreamBuffer(resolvedStream);
          const bytes = base64ToUint8Array(base64);
          // A "successfully fetched" response can still be worthless: some
          // googlevideo URLs (YouTube's newer SABR/UMP negotiation requests,
          // lacking an explicit itag) return a tiny protocol handshake instead of
          // real media - verified directly (a 31-byte application/vnd.yt-ump blob).
          if (bytes.length <= 20000) {
            throw new Error(`Resolved stream returned only ${bytes.length} bytes (likely a SABR handshake, not real video)`);
          }
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'video/mp4' }));
          const video = document.createElement('video');
          video.src = blobUrl;
          video.dataset.blobUrl = blobUrl;
          video.controls = true;
          video.autoplay = true;
          video.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            video.remove();
            showYouTubeFallback(previewItem, item);
          };
          previewItem.appendChild(video);
          playedInline = true;
        } catch (e) {
          console.warn('Inline YouTube stream playback failed:', e);
        }
      }
      loading.remove();

      if (!playedInline) {
        showYouTubeFallback(previewItem, item);
      }

      // Add "Open in YouTube" button for reliable playback
      const openBtn = document.createElement('button');
      openBtn.className = 'download-btn';
      openBtn.style.cssText = 'margin-top: 10px; background: #ff0000; background: linear-gradient(135deg, #ff0000, #cc0000);';
      openBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" fill="currentColor" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 6px;"><path d="M549.7 124.1c-6.3-23.7-24.8-42.3-48.3-48.6C458.8 64 288 64 288 64S117.2 64 74.6 75.5c-23.5 6.3-42 24.9-48.3 48.6C14.6 166.6 14.6 256 14.6 256s0 89.4 11.7 131.9c6.3 23.7 24.8 42.3 48.3 48.6C117.2 448 288 448 288 448s170.8 0 213.4-11.5c23.5-6.3 42-24.9 48.3-48.6C561.4 345.4 561.4 256 561.4 256s0-89.4-11.7-131.9zM232 327.1V184.9l142.7 71.1L232 327.1z"/></svg>
        ${item.isShorts ? 'Open in YouTube Shorts' : 'Open in YouTube'}
      `;
      openBtn.onclick = () => {
        const url = item.watchUrl || (item.isShorts 
          ? `https://www.youtube.com/shorts/${item.videoId}` 
          : `https://www.youtube.com/watch?v=${item.videoId}`);
        chrome.tabs.create({ url, active: true });
      };
      previewItem.appendChild(openBtn);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = playableUrl;
      video.controls = true;
      video.autoplay = true;
      video.onerror = () => {
        // Fallback to thumbnail if stream fails
        if (item.thumbnail) {
          video.remove();
          const fallbackImg = document.createElement('img');
          fallbackImg.src = item.thumbnail;
          fallbackImg.alt = 'Video thumbnail';
          fallbackImg.style.maxWidth = '100%';
          fallbackImg.style.borderRadius = '8px';
          previewItem.insertBefore(fallbackImg, previewItem.firstChild);
        } else {
          previewItem.remove();
        }
      };
      previewItem.appendChild(video);
    } else if (item.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = playableUrl;
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
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 6px;"><path d="M256 0a256 256 0 1 0 0 512A256 256 0 1 0 256 0zM127 297l-64-64 64-64 23 23L169 221 232 221 232 105c0-13.3 10.7-24 24-24s24 10.7 24 24l0 116 63 0 17-17 23-23 64 64-64 64-23-23-17-17-63 0 0 158c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-158-63 0-17 17-23 23z"/></svg>
      Download
    `;
    downloadBtn.addEventListener('click', () => downloadMedia(item));
    previewItem.appendChild(downloadBtn);

    // Show note for YouTube videos that stream URL may be needed
    if (hasVideoId && !item.streamUrl) {
      const noteEl = document.createElement('div');
      noteEl.className = 'preview-note';
      noteEl.textContent = 'YouTube video — download will try to capture the stream from the page.';
      noteEl.style.cssText = 'font-size: 11px; color: #999; margin-top: 8px; text-align: center;';
      previewItem.appendChild(noteEl);
    }

    // Thumbnail-only download for YouTube when no stream
    if (item.thumbnail && hasVideoId) {
      const thumbBtn = document.createElement('button');
      thumbBtn.className = 'download-btn secondary-dl';
      thumbBtn.textContent = 'Download Thumbnail';
      thumbBtn.addEventListener('click', () => {
        chrome.downloads.download({
          url: item.thumbnail,
          filename: `yt_${item.videoId || Date.now()}_thumb.jpg`,
          saveAs: false,
          conflictAction: 'uniquify'
        });
      });
      previewItem.appendChild(thumbBtn);
    }
    
    previewContent.appendChild(previewItem);
    previewModal.classList.add('active');
  }
  
  // Close modal and stop any playing media
  function closePreviewModal() {
    previewModal.classList.remove('active');
    revokePreviewBlobUrls();
  }

  // Pause playback and free blob: URLs created for inline stream playback
  function revokePreviewBlobUrls() {
    previewContent.querySelectorAll('video, audio').forEach(el => {
      el.pause();
      if (el.dataset.blobUrl) URL.revokeObjectURL(el.dataset.blobUrl);
    });
  }

  // chrome.runtime.sendMessage serializes payloads as if via JSON - an ArrayBuffer
  // arrives as an empty object (verified: all byte data silently lost), so binary
  // data crosses the message boundary as base64 and gets decoded back here instead.
  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Ask the background worker to fetch a stream URL with a spoofed YouTube
  // referrer and return the raw bytes, since googlevideo.com rejects requests
  // made directly from the popup's chrome-extension:// origin.
  function fetchStreamBuffer(url) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stream fetch timeout')), 30000);
      chrome.runtime.sendMessage({ action: 'fetch-stream-buffer', url }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) resolve(response);
        else reject(new Error(response?.error || 'Stream fetch failed'));
      });
    });
  }

  // Thumbnails scraped from a feed (home page, search results, etc.) only carry a
  // videoId - the real streaming formats only exist on that video's own watch page.
  // Delegates to the background worker's resolveStreamViaHiddenTab(), which loads it
  // in a background (non-active) tab so nothing visibly changes for the user, plays
  // it briefly to capture a real stream URL, then closes the tab. Kept as a single
  // implementation in background.js rather than duplicated here, since this logic is
  // delicate (YouTube's static player-response JSON no longer reliably carries a
  // usable stream URL) and background.js's downloadStreamUrl() needs the same fix.
  function resolveStreamViaHiddenTab(item) {
    if (!item.videoId) return Promise.resolve(null);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'resolve-youtube-stream',
        videoId: item.videoId,
        watchUrl: item.watchUrl,
        isShorts: item.isShorts
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Hidden-tab stream resolve failed:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.streamUrl || null);
      });
    });
  }

  closeBtn.addEventListener('click', closePreviewModal);
  
  // Close modal when clicking outside
  window.addEventListener('click', (e) => {
    if (e.target === previewModal) {
      closePreviewModal();
    }
  });
  
  // Blob URLs are scoped to the tab's document that created them - they can't be
  // resolved from the popup/background context, so fetch+convert them inside the tab.
  async function resolveDownloadUrl(mediaItem) {
    // Prefer direct stream when available (YouTube progressive / googlevideo)
    if (mediaItem.streamUrl && !mediaItem.streamUrl.startsWith('blob:')) {
      return mediaItem.streamUrl;
    }

    if (!mediaItem.url || !mediaItem.url.startsWith('blob:')) {
      // YouTube watch/shorts page URLs are not direct files – try live stream capture
      if (mediaItem.isYouTube && mediaItem.videoId &&
          /youtube\.com|youtu\.be/i.test(mediaItem.url) &&
          !/googlevideo\.com/i.test(mediaItem.url)) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            // MAIN world has access to ytInitialPlayerResponse / ytplayer
            const mainResult = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              func: (videoId) => {
                try {
                  let pr = window.ytInitialPlayerResponse;
                  if (!pr && window.ytplayer?.config?.args?.player_response) {
                    try {
                      pr = JSON.parse(window.ytplayer.config.args.player_response);
                    } catch (_) {}
                  }
                  // Match current player video when possible
                  if (pr?.videoDetails?.videoId && videoId &&
                      pr.videoDetails.videoId !== videoId) {
                    // still try formats – may be previous page
                  }
                  const formats = [
                    ...(pr?.streamingData?.formats || []),
                    ...(pr?.streamingData?.adaptiveFormats || [])
                  ];
                  // Helper to extract URL from format (handles signatureCipher/cipher)
                  function getUrl(f) {
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
                  const withUrl = formats.filter(f => getUrl(f) && /video|mp4|webm/i.test(f.mimeType || ''));
                  const progressive = withUrl
                    .filter(f => f.audioQuality)
                    .sort((a, b) => (b.width || 0) - (a.width || 0) || (b.bitrate || 0) - (a.bitrate || 0));
                  if (progressive[0]?.url) return progressive[0].url;
                  if (getUrl(progressive[0])) return getUrl(progressive[0]);
                  if (withUrl[0]?.url) return withUrl[0].url;
                  if (getUrl(withUrl[0])) return getUrl(withUrl[0]);
                } catch (_) {}
                try {
                  const resources = performance.getEntriesByType('resource');
                  for (let i = resources.length - 1; i >= 0; i--) {
                    const n = resources[i].name;
                    if (/googlevideo\.com\/videoplayback/i.test(n) && /mime=video/i.test(n)) return n;
                  }
                  for (let i = resources.length - 1; i >= 0; i--) {
                    const n = resources[i].name;
                    if (/googlevideo\.com\/videoplayback/i.test(n)) return n;
                  }
                } catch (_) {}
                return null;
              },
              args: [mediaItem.videoId]
            });
            if (mainResult?.[0]?.result) return mainResult[0].result;

            // Isolated world: dynamic loader cache + performance
            const result = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (videoId) => {
                try {
                  const cache = window.__AMD_MEDIA_CACHE__ || [];
                  const hit = cache.find(m => m.videoId === videoId && m.streamUrl) ||
                    cache.find(m => m.url && /googlevideo\.com\/videoplayback/i.test(m.url));
                  if (hit) return hit.streamUrl || hit.url;
                } catch (_) {}
                try {
                  const resources = performance.getEntriesByType('resource');
                  for (let i = resources.length - 1; i >= 0; i--) {
                    const n = resources[i].name;
                    if (/googlevideo\.com\/videoplayback/i.test(n)) return n;
                  }
                } catch (_) {}
                return null;
              },
              args: [mediaItem.videoId]
            });
            const stream = result?.[0]?.result;
            if (stream) return stream;
          }
        } catch (e) {
          console.warn('YouTube stream resolve failed:', e);
        }
        // Fallback: download best thumbnail rather than a dead page URL
        if (mediaItem.thumbnail) return mediaItem.thumbnail;
      }
      return mediaItem.url;
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (blobUrl) => {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        },
        args: [mediaItem.url]
      });
      return (result && result[0] && result[0].result) || mediaItem.url;
    } catch (e) {
      console.error('Failed to resolve blob URL:', e);
      return mediaItem.url;
    }
  }

  // Records the active tab's currently-playing YouTube video in real time via
  // HTMLMediaElement.captureStream() + MediaRecorder, then hands the result to
  // background.js to save. This sidesteps YouTube's stream-delivery format entirely
  // (works regardless of SABR/UMP) since it captures the already-decoded playback,
  // at the cost of taking real playback time and re-encoding to webm. Only usable
  // when the active tab already has this exact video loaded - it records whatever
  // is playing, so it must not be used against a mismatched video.
  async function recordActiveTabVideo(mediaItem, onProgress) {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) return false;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;

    // Isolated world (not MAIN) so recorder.onstop below can call chrome.runtime -
    // window.ytInitialPlayerResponse isn't reachable from here (that's a MAIN-world-
    // only page global), so match against the watch/shorts URL itself instead.
    const matchCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (videoId) => {
        try {
          const currentId = new URLSearchParams(location.search).get('v') ||
            (location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/) || [])[1];
          return currentId === videoId && !!document.querySelector('video');
        } catch (_) { return false; }
      },
      args: [mediaItem.videoId]
    }).catch(() => null);
    if (!matchCheck?.[0]?.result) return false;

    const filename = getFilename(mediaItem, '').replace(/\.(mp4|webm|jpg)$/i, '') + '.webm';

    const startResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (videoId, filename) => {
        try {
          const video = document.querySelector('video');
          if (!video) return { error: 'No video element found' };
          if (typeof video.captureStream !== 'function') return { error: 'captureStream unsupported' };

          const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
          if (!mimeType) return { error: 'MediaRecorder unsupported' };

          const wasMuted = video.muted;
          const wasPaused = video.paused;
          const originalTime = video.currentTime;

          const stream = video.captureStream();
          const recorder = new MediaRecorder(stream, { mimeType });
          const chunks = [];
          window.__AMD_RECORDING__ = { progress: 0, done: false, error: null };

          recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

          // Pushed straight from the tab (not polled by the popup) so the progress
          // notification keeps updating even after the popup/preview modal closes -
          // this keeps running independent of either of those.
          chrome.runtime.sendMessage({ action: 'recording-progress', progress: 0 });
          const progressInterval = setInterval(() => {
            if (video.duration) {
              const pct = video.currentTime / video.duration;
              window.__AMD_RECORDING__.progress = pct;
              chrome.runtime.sendMessage({ action: 'recording-progress', progress: Math.round(pct * 100) });
            }
          }, 1000);

          recorder.onstop = async () => {
            clearInterval(progressInterval);
            try {
              video.muted = wasMuted;
              if (wasPaused) video.pause();
              video.currentTime = originalTime;
              const blob = new Blob(chunks, { type: mimeType });
              // chrome.runtime.sendMessage serializes as if via JSON - a raw
              // ArrayBuffer arrives at the other end as an empty object (all byte
              // data silently lost), so send base64 instead.
              const bytes = new Uint8Array(await blob.arrayBuffer());
              let binary = '';
              const chunkSize = 0x8000;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
              }
              window.__AMD_RECORDING__.done = true;
              chrome.runtime.sendMessage({ action: 'recording-complete', base64: btoa(binary), mimeType, filename });
            } catch (e) {
              window.__AMD_RECORDING__.error = e.message;
            }
          };

          video.addEventListener('ended', () => {
            if (recorder.state === 'recording') recorder.stop();
          }, { once: true });

          // Safety net in case 'ended' never fires (live edge cases, seek issues)
          setTimeout(() => {
            if (recorder.state === 'recording') recorder.stop();
          }, (video.duration ? video.duration * 1000 + 15000 : 30 * 60 * 1000));

          video.currentTime = 0;
          video.muted = true;
          recorder.start(1000);
          video.play().catch(() => {});

          return { started: true, duration: video.duration };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [mediaItem.videoId, filename]
    }).catch((e) => [{ result: { error: e.message } }]);

    const outcome = startResult?.[0]?.result;
    if (!outcome?.started) {
      console.warn('Recording could not start:', outcome?.error);
      return false;
    }
    // The injected script itself just pushed the initial 'recording-progress'
    // message (progress: 0), which background.js turns into a live progress
    // notification - that keeps updating on its own even after this popup closes,
    // since the tab (not this popup) is what's sending the updates.

    // Poll progress purely for UI feedback - the actual save happens independently
    // via the 'recording-complete' message to background.js, so this loop ending
    // early (e.g. popup closes) doesn't affect whether the download completes.
    while (true) {
      await new Promise((r) => setTimeout(r, 800));
      const poll = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__AMD_RECORDING__ || null
      }).catch(() => null);
      const state = poll?.[0]?.result;
      if (!state) break;
      if (onProgress) onProgress(state.progress || 0);
      if (state.done || state.error) break;
    }
    return true;
  }

  // Download media function
  async function downloadMedia(mediaItem, callback) {
    if (mediaItem.isYouTube && mediaItem.videoId) {
      try {
        if (progressContainer) progressContainer.classList.remove('hidden');
        if (progressLabel) progressLabel.textContent = 'Recording video (plays in the tab)...';
        const recorded = await recordActiveTabVideo(mediaItem, (progress) => {
          const percent = Math.round(progress * 100);
          progressBar.style.width = `${percent}%`;
          progressPercent.textContent = `${percent}%`;
        });
        if (recorded) {
          progressBar.style.width = '100%';
          progressPercent.textContent = 'Saved!';
          setTimeout(() => {
            progressBar.style.width = '0%';
            progressPercent.textContent = '0%';
            if (progressContainer) progressContainer.classList.add('hidden');
          }, 3000);
          if (callback) callback();
          return;
        }
      } catch (e) {
        console.warn('Recording-based download failed, falling back:', e);
      } finally {
        if (progressContainer && progressLabel?.textContent === 'Recording video (plays in the tab)...') {
          progressContainer.classList.add('hidden');
        }
      }
    }

    const downloadUrl = await resolveDownloadUrl(mediaItem);

    // For YouTube videos without a valid stream URL (resolveDownloadUrl falls back to
    // the thumbnail image when it can't find one, which isn't a video), use the
    // background approach that can also resolve the stream via a hidden tab.
    if (mediaItem.isYouTube && mediaItem.videoId && !/googlevideo\.com/i.test(downloadUrl || '')) {
      // Try to download via background fetch with proper referrer
      try {
        await downloadYouTubeViaBackground(mediaItem);
        if (callback) callback();
        return;
      } catch (e) {
        console.warn('Background YouTube download failed, trying direct:', e);
      }
    }
    
    chrome.downloads.download({
      url: downloadUrl,
      filename: getFilename(mediaItem, downloadUrl),
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
      }
      if (callback) callback();
    });
  }

  // Download YouTube video via background fetch with proper headers
  async function downloadYouTubeViaBackground(mediaItem) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Background download timeout')), 30000);
      
      chrome.runtime.sendMessage({
        action: 'download-youtube-video',
        videoId: mediaItem.videoId,
        filename: getFilename(mediaItem, ''),
        tabId: activeTabId,
        watchUrl: mediaItem.watchUrl,
        isShorts: mediaItem.isShorts
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) {
          resolve();
        } else {
          reject(new Error(response?.error || 'Background download failed'));
        }
      });
    });
  }
  
  // Show fallback when YouTube embed fails to load
  function showYouTubeFallback(container, item) {
    // Remove existing embed wrap if present
    const existingWrap = container.querySelector('.yt-embed-wrap');
    if (existingWrap) existingWrap.remove();
    
    // Show thumbnail with play button
    if (item.thumbnail) {
      const fallbackDiv = document.createElement('div');
      fallbackDiv.style.cssText = 'position: relative; width: 100%; min-height: 200px; background: #000; border-radius: 10px; overflow: hidden; margin-bottom: 10px;';
      
      const img = document.createElement('img');
      img.src = item.thumbnail;
      img.alt = item.title || 'YouTube video';
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
      fallbackDiv.appendChild(img);
      
      // Play overlay
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3);';
      overlay.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="white" style="width: 60px; height: 60px; opacity: 0.9;"><path d="M504 256C504 119 393 8 256 8S8 119 8 256s111 248 248 248 248-111 248-248zM192 144c0-13.3 14.3-22.3 25.4-15l176 112c9.7 6.2 9.7 20.8 0 27l-176 112c-11.1 7.3-25.4-1.7-25.4-15V144z"/></svg>`;
      fallbackDiv.appendChild(overlay);
      
      // Click to open in YouTube
      fallbackDiv.style.cursor = 'pointer';
      fallbackDiv.onclick = () => {
        const url = item.watchUrl || (item.isShorts 
          ? `https://www.youtube.com/shorts/${item.videoId}` 
          : `https://www.youtube.com/watch?v=${item.videoId}`);
        chrome.tabs.create({ url, active: true });
      };
      
      container.appendChild(fallbackDiv);
    }
  }

  // Helper function to generate filename
  function getFilename(mediaItem, resolvedUrl) {
    if (mediaItem.videoId) {
      const tag = mediaItem.isShorts ? 'shorts' : 'yt';
      const titleSafe = (mediaItem.title || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim()
        .slice(0, 60);
      const base = titleSafe || mediaItem.videoId;
      const urlForExt = resolvedUrl || mediaItem.streamUrl || mediaItem.url || '';
      let ext = '.mp4';
      if (/\.webm/i.test(urlForExt) || /mime=video%2Fwebm|mime=video\/webm/i.test(urlForExt)) ext = '.webm';
      if (/ytimg|thumb|\.jpe?g/i.test(urlForExt) && !/googlevideo|videoplayback/i.test(urlForExt)) ext = '.jpg';
      return `${tag}_${base}${ext}`;
    }

    try {
      const url = new URL(resolvedUrl || mediaItem.url);
      const pathParts = url.pathname.split('/');
      const lastPart = pathParts[pathParts.length - 1];

      if (lastPart && lastPart.includes('.')) {
        return lastPart.split('?')[0];
      }

      const ext = mediaItem.type === 'image' ?
        (url.pathname.match(/\.(jpe?g|png|gif|webp)$/i) ? '' : '.jpg') :
        (mediaItem.type === 'video' ?
          (url.pathname.match(/\.(mp4|webm|mov)$/i) ? '' : '.mp4') :
          (mediaItem.type === 'audio' ?
            (url.pathname.match(/\.(mp3|wav|ogg|flac|m4a)$/i) ? '' : '.mp3') :
            '.bin'));

      return `media-${Date.now()}${ext}`;
    } catch (_) {
      return `media-${Date.now()}.bin`;
    }
  }
});

// Enhanced function to scrape ALL media from the page (deep & micro-level automation)
async function scrapeAllMediaFromPage() {
  const mediaItems = [];
  const fetchPromises = [];
  const seenVideoIds = new Set();

  // Expanded media type checker
  function getMediaType(url) {
    if (!url || typeof url !== 'string') return 'other';
    if (url.startsWith('data:image/')) return 'image';
    if (url.startsWith('data:video/')) return 'video';
    if (url.startsWith('data:audio/')) return 'audio';
    if (url.startsWith('blob:')) return 'video';
    
    // Expanded extensions list
    const isVideo = /\.(mp4|webm|mov|avi|mkv|flv|wmv|m3u8|ts|mpd|oggv|3gp|m4v)(?:[\?#]|$)/i.test(url) ||
      /youtube\.com|youtu\.be|vimeo\.com|googlevideo\.com|instagram\.com\/(?:reel|reels|p)\//i.test(url) ||
      /videoplayback|mime=video/i.test(url);
    const isAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|mid|midi|amr)(?:[\?#]|$)/i.test(url) || /mime=audio/i.test(url);
    const isImage = /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff|avif|heic|jpeg|jpg)(?:[\?#]|$)/i.test(url) ||
      /ytimg\.com|ggpht\.com/i.test(url);
    
    if (isVideo) return 'video';
    if (isAudio) return 'audio';
    if (isImage) return 'image';
    return 'other';
  }

  function extractYouTubeVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const patterns = [
      /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|live\/|shorts\/|reel\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//
    ];
    for (const re of patterns) {
      const match = url.match(re);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  function isShortsUrl(url) {
    return /\/shorts\//i.test(url || '') || /youtube\.com\/reel\//i.test(url || '');
  }

  function ytThumb(id, quality) {
    return `https://i.ytimg.com/vi/${id}/${quality || 'hqdefault'}.jpg`;
  }

  function ytWatchUrl(id, shorts) {
    return shorts
      ? `https://www.youtube.com/shorts/${id}`
      : `https://www.youtube.com/watch?v=${id}`;
  }

  // Extract stream URL from a YouTube format object, handling signatureCipher/cipher
  function getStreamUrlFromFormat(f) {
    // Direct URL
    if (f.url) return f.url;
    
    // Parse signatureCipher or cipher: "s=xxx&sp=xxx&url=https://..."
    const cipherStr = f.signatureCipher || f.cipher;
    if (cipherStr) {
      try {
        const params = new URLSearchParams(cipherStr);
        const url = params.get('url');
        const sp = params.get('sp') || 'signature';
        const sig = params.get('s');
        if (url) {
          const urlObj = new URL(decodeURIComponent(url));
          if (sig) {
            urlObj.searchParams.set(sp, sig);
          }
          return urlObj.toString();
        }
      } catch (_) {}
    }
    
    return null;
  }

  // Extract balanced JSON object starting at index of '{'
  function extractJsonObject(text, startIdx) {
    if (startIdx < 0 || text[startIdx] !== '{') return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(startIdx, i + 1));
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function findAssignedJson(scriptText, varName) {
    const markers = [
      `var ${varName} = `,
      `window["${varName}"] = `,
      `window.${varName} = `,
      `${varName} = `
    ];
    for (const marker of markers) {
      const idx = scriptText.indexOf(marker);
      if (idx === -1) continue;
      const brace = scriptText.indexOf('{', idx + marker.length);
      if (brace === -1) continue;
      const obj = extractJsonObject(scriptText, brace);
      if (obj) return obj;
    }
    return null;
  }

  function addYouTubeVideo(videoId, meta = {}) {
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;
    if (seenVideoIds.has(videoId) && !meta.streamUrl) return;
    seenVideoIds.add(videoId);

    const shorts = meta.isShorts === true || isShortsUrl(meta.watchUrl || '');
    const watchUrl = meta.watchUrl || ytWatchUrl(videoId, shorts);
    const streamUrl = meta.streamUrl || null;
    const thumbnail = meta.thumbnail || ytThumb(videoId, 'hqdefault');

    mediaItems.push({
      type: 'video',
      url: streamUrl || watchUrl,
      watchUrl,
      streamUrl,
      thumbnail,
      videoId,
      title: meta.title || null,
      source: shorts ? 'youtube-shorts' : (meta.source || 'youtube'),
      isYouTube: true,
      isShorts: shorts,
      element: meta.element || 'YouTube'
    });

    // Also keep high-res thumbnail as separate image asset
    if (meta.includeThumb !== false) {
      addMediaItem(ytThumb(videoId, 'maxresdefault'), meta.element || 'YouTube thumb', 'image');
    }
  }

  function harvestYouTubeFromPlayerResponse(pr, sourceLabel) {
    if (!pr || typeof pr !== 'object') return;
    try {
      const details = pr.videoDetails || {};
      const videoId = details.videoId;
      const title = details.title || null;
      const isLive = details.isLiveContent;
      const micro = pr.microformat?.playerMicroformatRenderer || {};
      const isShorts = /shorts/i.test(micro.ownerProfileUrl || '') ||
        /shorts/i.test(location.pathname) ||
        (details.lengthSeconds && parseInt(details.lengthSeconds, 10) <= 60 && /shorts/i.test(location.href));

      let streamUrl = null;
      const formats = [
        ...(pr.streamingData?.formats || []),
        ...(pr.streamingData?.adaptiveFormats || [])
      ];
      // Prefer progressive mp4 with both audio+video (has audioQuality + url)
      const progressive = formats
        .filter(f => getStreamUrlFromFormat(f) && f.mimeType && /video\/mp4/i.test(f.mimeType) && f.audioQuality)
        .sort((a, b) => (b.width || 0) - (a.width || 0) || (b.bitrate || 0) - (a.bitrate || 0));
      if (progressive[0]) streamUrl = getStreamUrlFromFormat(progressive[0]);
      if (!streamUrl) {
        const anyUrl = formats.find(f => getStreamUrlFromFormat(f) && /video/i.test(f.mimeType || ''));
        if (anyUrl) streamUrl = getStreamUrlFromFormat(anyUrl);
      }

      if (videoId) {
        addYouTubeVideo(videoId, {
          title,
          streamUrl,
          isShorts: isShorts || location.pathname.startsWith('/shorts'),
          source: sourceLabel || 'ytInitialPlayerResponse',
          element: sourceLabel || 'Player Response',
          includeThumb: true
        });
      }

      // thumbnails array
      const thumbs = details.thumbnail?.thumbnails || [];
      thumbs.forEach(t => {
        if (t.url) addMediaItem(t.url, 'YouTube player thumb', 'image');
      });
    } catch (e) {
      console.log('player response harvest error', e);
    }
  }

  function walkYtDataForVideos(obj, depth = 0) {
    if (!obj || depth > 12) return;
    if (typeof obj === 'string') {
      const id = extractYouTubeVideoId(obj);
      if (id) addYouTubeVideo(id, { watchUrl: obj, source: 'ytInitialData-url', includeThumb: false });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => walkYtDataForVideos(item, depth + 1));
      return;
    }
    if (typeof obj !== 'object') return;

    // Common YouTube renderer videoId fields
    if (typeof obj.videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(obj.videoId)) {
      const title =
        obj.title?.simpleText ||
        obj.title?.runs?.map(r => r.text).join('') ||
        obj.headline?.simpleText ||
        obj.headline?.runs?.map(r => r.text).join('') ||
        obj.overlayMetadata?.primaryText?.content ||
        null;
      const nav = obj.navigationEndpoint?.watchEndpoint ||
        obj.navigationEndpoint?.reelWatchEndpoint ||
        obj.watchEndpoint ||
        obj.reelWatchEndpoint;
      const isShorts = !!(obj.reelWatchEndpoint || obj.navigationEndpoint?.reelWatchEndpoint ||
        (nav && nav.params) || location.pathname.startsWith('/shorts'));
      addYouTubeVideo(obj.videoId, {
        title,
        isShorts,
        source: 'ytInitialData',
        includeThumb: false
      });
    }

    for (const key of Object.keys(obj)) {
      // Skip huge non-media blobs for performance
      if (['responseContext', 'trackingParams', 'loggingContext', 'frameworkUpdates'].includes(key)) continue;
      walkYtDataForVideos(obj[key], depth + 1);
    }
  }

  function scrapeYouTubeDeep() {
    const host = location.hostname || '';
    const isYt = /youtube\.com$|youtu\.be$/i.test(host) || host.endsWith('youtube.com');
    if (!isYt && !document.querySelector('ytd-app, ytd-shorts, #movie_player')) {
      // Still try generic youtube links on any site
    }

    // Current page URL
    const pageId = extractYouTubeVideoId(location.href);
    if (pageId) {
      addYouTubeVideo(pageId, {
        isShorts: location.pathname.startsWith('/shorts'),
        source: 'page-url',
        title: document.title?.replace(/ - YouTube$/, '') || null
      });
    }

    // Live player globals (isolated world may not see them – also parse scripts)
    try {
      if (window.ytInitialPlayerResponse) {
        harvestYouTubeFromPlayerResponse(window.ytInitialPlayerResponse, 'window.ytInitialPlayerResponse');
      }
    } catch (_) {}
    try {
      if (window.ytInitialData) {
        walkYtDataForVideos(window.ytInitialData);
      }
    } catch (_) {}

    // Parse inline scripts for ytInitial* payloads (works in isolated world)
    document.querySelectorAll('script').forEach(script => {
      const text = script.textContent || '';
      if (!text || text.length < 50) return;
      if (text.includes('ytInitialPlayerResponse')) {
        const pr = findAssignedJson(text, 'ytInitialPlayerResponse');
        if (pr) harvestYouTubeFromPlayerResponse(pr, 'script-ytInitialPlayerResponse');
      }
      if (text.includes('ytInitialData')) {
        const data = findAssignedJson(text, 'ytInitialData');
        if (data) walkYtDataForVideos(data);
      }
      // Lightweight videoId harvest from script text
      if (text.includes('videoId')) {
        const re = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
        let m;
        let count = 0;
        while ((m = re.exec(text)) !== null && count < 200) {
          addYouTubeVideo(m[1], { source: 'script-videoId', includeThumb: false });
          count++;
        }
      }
    });

    // DOM: all youtube anchors + custom elements
    document.querySelectorAll('a[href*="watch"], a[href*="/shorts/"], a[href*="youtu.be"], a[href*="youtube.com"]').forEach(a => {
      const href = a.href || a.getAttribute('href') || '';
      const id = extractYouTubeVideoId(href);
      if (!id) return;
      const title = a.getAttribute('title') || a.getAttribute('aria-label') ||
        (a.textContent || '').trim().slice(0, 120) || null;
      addYouTubeVideo(id, {
        watchUrl: href.startsWith('http') ? href : ytWatchUrl(id, isShortsUrl(href)),
        title,
        isShorts: isShortsUrl(href),
        source: 'dom-anchor',
        includeThumb: false
      });
    });

    document.querySelectorAll('[video-id], [data-video-id], [data-videoid]').forEach(el => {
      const id = el.getAttribute('video-id') || el.getAttribute('data-video-id') || el.getAttribute('data-videoid');
      if (id) {
        addYouTubeVideo(id, {
          isShorts: location.pathname.startsWith('/shorts') || /short|reel/i.test(el.tagName + el.className),
          source: 'dom-video-id',
          includeThumb: false
        });
      }
    });

    // ytimg thumbnails encode video ids
    document.querySelectorAll('img[src*="ytimg.com/vi"], img[src*="ytimg.com/vi_webp"]').forEach(img => {
      const id = extractYouTubeVideoId(img.src || '');
      if (id) addYouTubeVideo(id, { source: 'dom-ytimg', includeThumb: false });
    });
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

  // Helper to unescape JSON Unicode escapes and backslashes
  function unescapeUrl(url) {
    if (!url || typeof url !== 'string') return url;
    return url
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
      .replace(/\\/g, '')
      .trim();
  }

  // Helper to add media items with safety checks
  function addMediaItem(url, sourceElement, typeOverride = null, extra = null) {
    if (!url || typeof url !== 'string') return;
    
    // Clean, unescape backslashes, and convert to original high resolution URL
    let cleanUrl = unescapeUrl(url);
    cleanUrl = getHighResUrl(cleanUrl);
    if (!cleanUrl) return;
    
    // Skip tiny trackers / spacer GIFs / base64 of inline symbols (except valid SVGs)
    if (cleanUrl.startsWith('data:image/gif;base64,R0lGOD')) return; // common spacer

    // Route YouTube page / shorts URLs through specialized handler
    const ytId = extractYouTubeVideoId(cleanUrl);
    if (ytId && /youtube\.com|youtu\.be/i.test(cleanUrl) && !/googlevideo\.com|ytimg\.com/i.test(cleanUrl)) {
      addYouTubeVideo(ytId, {
        watchUrl: cleanUrl.startsWith('http') ? cleanUrl : undefined,
        isShorts: isShortsUrl(cleanUrl),
        source: 'addMediaItem',
        streamUrl: extra?.streamUrl || null,
        title: extra?.title || null,
        includeThumb: false,
        element: sourceElement
      });
      return;
    }
    
    try {
      // Resolve relative URLs
      const absoluteUrl = new URL(cleanUrl, window.location.href).href;
      const type = typeOverride || getMediaType(absoluteUrl);

      // googlevideo streams
      if (/googlevideo\.com\/videoplayback/i.test(absoluteUrl)) {
        mediaItems.push({
          type: 'video',
          url: absoluteUrl,
          streamUrl: absoluteUrl,
          isYouTube: true,
          source: 'googlevideo-stream',
          element: sourceElement ? String(sourceElement).slice(0, 120) : 'YouTube stream',
          ...(extra || {})
        });
        return;
      }
      
      mediaItems.push({
        type: type,
        url: absoluteUrl,
        element: sourceElement ? (sourceElement.outerHTML ? sourceElement.outerHTML.slice(0, 150) + '...' : String(sourceElement)) : 'Dynamic / CSS Source',
        ...(extra || {})
      });
    } catch (e) {
      // If it's a valid custom format or data URL, keep it
      if (cleanUrl.startsWith('data:') || cleanUrl.startsWith('blob:')) {
        mediaItems.push({
          type: typeOverride || getMediaType(cleanUrl),
          url: cleanUrl,
          element: sourceElement ? (sourceElement.outerHTML ? sourceElement.outerHTML.slice(0, 150) + '...' : String(sourceElement)) : 'Data URI',
          ...(extra || {})
        });
      }
    }
  }

  // Helper to search text string for URLs
  function scanTextForUrls(text, sourceDesc) {
    if (!text || typeof text !== 'string') return;
    
    // Unescape backslashes first so we can parse standard URL strings cleanly
    const cleanText = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
      .replace(/\\/g, '');
    
    // Matches http/https URLs or relative paths starting with /
    const urlRegex = /(https?:\/\/[^\s"'()<>]+|href=["']?([^\s"'()<>]+)|src=["']?([^\s"'()<>]+)|url\(["']?([^\s"'()<>]+)["']?\))/gi;
    let match;
    while ((match = urlRegex.exec(cleanText)) !== null) {
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
        const srcset = element.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(item => {
            const parts = item.trim().split(/\s+/);
            if (parts[0]) addMediaItem(parts[0], element);
          });
        }
      } else if (tagName === 'VIDEO') {
        // Force 'video' type override since blob: src URLs (common on Instagram/Facebook
        // players) have no file extension for getMediaType() to infer from.
        addMediaItem(element.src || element.getAttribute('src'), element, 'video');
        // Check video sources
        element.querySelectorAll('source').forEach(source => {
          addMediaItem(source.src || source.getAttribute('src'), element, 'video');
        });
        // Check poster image
        if (element.poster) {
          addMediaItem(element.poster, element, 'image');
        }
      } else if (tagName === 'AUDIO') {
        addMediaItem(element.src || element.getAttribute('src'), element, 'audio');
        element.querySelectorAll('source').forEach(source => {
          addMediaItem(source.src || source.getAttribute('src'), element, 'audio');
        });
      } else if (tagName === 'IFRAME') {
        const src = element.src || element.getAttribute('src');
        if (src) {
          if (src.includes('youtube.com') || src.includes('youtu.be')) {
            const videoId = extractYouTubeVideoId(src);
            if (videoId) {
              addYouTubeVideo(videoId, {
                isShorts: isShortsUrl(src),
                source: 'iframe-embed',
                element
              });
            }
          } else {
            addMediaItem(src, element, 'video');
          }
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
      } else if (tagName === 'IMAGE') {
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
        if (!attr.value || typeof attr.value !== 'string') continue;
        const value = unescapeUrl(attr.value);
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

  // 5. Parse inline <style> tags for background images
  document.querySelectorAll('style').forEach(styleTag => {
    try {
      if (styleTag.textContent) {
        scanTextForUrls(styleTag.textContent, 'Inline <style> tag');
      }
    } catch (e) {}
  });

  // 5.5. Parse inline <script> tags for raw JSON data/URLs (crucial for React/Relay state on Instagram/Facebook)
  document.querySelectorAll('script').forEach(scriptTag => {
    try {
      if (scriptTag.textContent) {
        scanTextForUrls(scriptTag.textContent, 'Inline <script> tag');
      }
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

  // 6.5. Scrape OpenGraph and Twitter Card meta headers (stores high-res original posts media)
  try {
    document.querySelectorAll('meta').forEach(meta => {
      let content = meta.getAttribute('content');
      const property = meta.getAttribute('property') || meta.getAttribute('name') || '';
      if (content && typeof content === 'string') {
        content = unescapeUrl(content);
        if (content.startsWith('http') || content.startsWith('//')) {
          if (property.includes('image') || property.includes('video') || property.includes('media')) {
            const type = property.includes('video') ? 'video' : 'image';
            addMediaItem(content, `Meta Header (${property})`, type);
          }
        }
      }
    });
  } catch (e) {}

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

  // 8.5 Deep YouTube / Shorts / Reels harvest (SPA feeds + player JSON)
  try {
    scrapeYouTubeDeep();
  } catch (e) {
    console.log('YouTube deep scrape error:', e);
  }

  // Instagram Reels / posts links on page
  try {
    document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]').forEach(a => {
      const href = a.href || a.getAttribute('href');
      if (href) addMediaItem(href, a, 'video', { source: 'instagram-reel' });
    });
  } catch (e) {}

  // 8.6 Merge dynamic loader cache (MutationObserver / network / scroll discoveries)
  try {
    const cache = window.__AMD_MEDIA_CACHE__;
    if (Array.isArray(cache)) {
      cache.forEach(item => {
        if (!item || !item.url) return;
        if (item.videoId) {
          addYouTubeVideo(item.videoId, {
            title: item.title,
            streamUrl: item.streamUrl || (/googlevideo\.com/i.test(item.url) ? item.url : null),
            watchUrl: item.watchUrl,
            thumbnail: item.thumbnail,
            isShorts: item.isShorts,
            source: item.source || 'dynamic-cache',
            includeThumb: false
          });
        } else {
          addMediaItem(item.url, item.element || 'dynamic-cache', item.type || null, {
            streamUrl: item.streamUrl,
            thumbnail: item.thumbnail,
            title: item.title,
            source: item.source,
            isYouTube: item.isYouTube,
            isShorts: item.isShorts
          });
        }
      });
    }
  } catch (e) {}

  // 8.7 MAIN-world progressive streams stored on <html data-amd-streams>
  try {
    const raw = document.documentElement.getAttribute('data-amd-streams');
    const vid = document.documentElement.getAttribute('data-amd-vid') || extractYouTubeVideoId(location.href);
    if (raw) {
      const streams = JSON.parse(raw);
      if (Array.isArray(streams)) {
        streams.forEach(url => {
          if (vid) {
            addYouTubeVideo(vid, {
              streamUrl: url,
              source: 'data-amd-streams',
              isShorts: location.pathname.startsWith('/shorts'),
              includeThumb: false
            });
          } else {
            addMediaItem(url, 'MAIN world stream', 'video', { streamUrl: url, isYouTube: true });
          }
        });
      }
    }
  } catch (e) {}

  // 9. Remove duplicates and clean list
  const uniqueMediaItems = [];
  const seenUrls = new Set();
  const seenIds = new Set();
  
  mediaItems.forEach(item => {
    // Prefer entries that have stream URLs for the same YouTube id
    if (item.videoId) {
      if (seenIds.has(item.videoId)) {
        const existing = uniqueMediaItems.find(x => x.videoId === item.videoId);
        if (existing && item.streamUrl && !existing.streamUrl) {
          Object.assign(existing, item);
          if (item.streamUrl) {
            existing.url = item.streamUrl;
            existing.streamUrl = item.streamUrl;
          }
        } else if (existing && item.title && !existing.title) {
          existing.title = item.title;
        } else if (existing && item.thumbnail && !existing.thumbnail) {
          existing.thumbnail = item.thumbnail;
        }
        return;
      }
      seenIds.add(item.videoId);
    }
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
    return ['url', 'type', 'selected', 'thumbnail', 'youtube', 'shorts', 'title', 'video-id'];
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
    const thumbnail = this.getAttribute('thumbnail') || '';
    const isYouTube = this.hasAttribute('youtube');
    const isShorts = this.hasAttribute('shorts');
    const title = this.getAttribute('title') || '';
    
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
      .video-wrapper {
        position: relative;
        width: 100%;
        height: 100%;
        background-color: #000;
      }
      .video-overlay {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.25);
        transition: background 0.2s ease;
      }
      :host(:hover) .video-overlay {
        background: rgba(0, 0, 0, 0.45);
      }
      .video-overlay svg {
        width: 32px;
        height: 32px;
        fill: white;
        opacity: 0.85;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
        transition: transform 0.2s ease, opacity 0.2s ease;
      }
      :host(:hover) .video-overlay svg {
        transform: scale(1.15);
        opacity: 1;
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
      .download-button {
        position: absolute;
        bottom: 6px;
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
      :host(:hover) .download-button {
        opacity: 1;
        transform: scale(1);
      }
      .download-button:hover {
        transform: scale(1.1);
        background-color: var(--primary-color, #6c5ce7);
        box-shadow: 0 2px 8px rgba(108, 92, 231, 0.35);
      }
      .download-button:hover svg {
        fill: white;
      }
      .download-button svg {
        width: 15px;
        height: 15px;
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
      .yt-badge {
        position: absolute;
        bottom: 6px;
        left: 6px;
        background: rgba(255,0,0,0.9);
        color: #fff;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.3px;
        padding: 2px 6px;
        border-radius: 4px;
        z-index: 3;
        font-family: system-ui, sans-serif;
        pointer-events: none;
      }
      .yt-badge.shorts {
        background: linear-gradient(135deg, #ff0050, #ff4081);
      }
    `;

    // blob: URLs belong to the source tab's document - they can never load inside
    // the popup's own document, so show a placeholder icon instead of a dead <img>/<video>.
    const isBlob = url.startsWith('blob:');
    const isYtPage = isYouTube && /youtube\.com|youtu\.be/i.test(url) && !/googlevideo\.com/i.test(url);
    const displayImage = thumbnail || (isYtPage ? '' : '');
    const canUseVideoTag = type === 'video' && !isBlob && !isYtPage &&
      (/\.(mp4|webm|mov|m4v)(?:[\?#]|$)/i.test(url) || /googlevideo\.com|blob:/i.test(url) || url.startsWith('data:video'));

    let contentHtml = '';
    if (type === 'image' && !isBlob) {
      contentHtml = `<img src="${url}" alt="Media Image">`;
    } else if (type === 'video' && (thumbnail || isYtPage)) {
      const thumbSrc = thumbnail || (this.getAttribute('video-id')
        ? `https://i.ytimg.com/vi/${this.getAttribute('video-id')}/hqdefault.jpg`
        : '');
      contentHtml = `
        <div class="video-wrapper">
          ${thumbSrc ? `<img src="${thumbSrc}" alt="${title || 'YouTube'}">` : ''}
          <div class="video-overlay">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M504 256C504 119 393 8 256 8S8 119 8 256s111 248 248 248 248-111 248-248zM192 144c0-13.3 14.3-22.3 25.4-15l176 112c9.7 6.2 9.7 20.8 0 27l-176 112c-11.1 7.3-25.4-1.7-25.4-15V144z"/>
            </svg>
          </div>
          <span class="yt-badge ${isShorts ? 'shorts' : ''}">${isShorts ? 'SHORTS' : (isYouTube ? 'YT' : 'VIDEO')}</span>
        </div>
      `;
    } else if (type === 'video' && canUseVideoTag) {
      contentHtml = `
        <div class="video-wrapper">
          <video src="${url}" preload="metadata" muted></video>
          <div class="video-overlay">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M504 256C504 119 393 8 256 8S8 119 8 256s111 248 248 248 248-111 248-248zM192 144c0-13.3 14.3-22.3 25.4-15l176 112c9.7 6.2 9.7 20.8 0 27l-176 112c-11.1 7.3-25.4-1.7-25.4-15V144z"/>
            </svg>
          </div>
        </div>
      `;
    } else if (type === 'video' && !isBlob) {
      // Generic video URL – try video tag, hide on error via handler below
      contentHtml = `
        <div class="video-wrapper">
          <video src="${url}" preload="metadata" muted></video>
          <div class="video-overlay">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M504 256C504 119 393 8 256 8S8 119 8 256s111 248 248 248 248-111 248-248zM192 144c0-13.3 14.3-22.3 25.4-15l176 112c9.7 6.2 9.7 20.8 0 27l-176 112c-11.1 7.3-25.4-1.7-25.4-15V144z"/>
            </svg>
          </div>
        </div>
      `;
    } else {
      let iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="currentColor" style="width: 28px; height: 28px;"><path d="M0 64C0 28.7 28.7 0 64 0H224L384 160V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm224 0V160H352L224 64z"/></svg>`;
      if (type === 'audio') {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" fill="currentColor" style="width: 28px; height: 28px;"><path d="M192 0C86 0 0 86 0 192c0 77.4 46.2 144 112 173v47c0 17.7 14.3 32 32 32h16c17.7 0 32-14.3 32-32v-16h32v16c0 17.7 14.3 32 32 32h16c17.7 0 32-14.3 32-32v-47c65.8-29 112-95.6 112-173C384 86 298 0 192 0z"/></svg>`;
      } else if (type === 'video') {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" style="width: 28px; height: 28px;"><path d="M0 96C0 60.7 28.7 32 64 32H320c35.3 0 64 28.7 64 64V416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96zM559.1 99.8c10.4 5.6 16.9 16.4 16.9 28.2V384c0 11.8-6.5 22.6-16.9 28.2s-23 5-32.9-1.6l-96-64L416 337.1V320 192 174.9l14.2-9.5 96-64c9.8-6.6 22.4-7.2 32.9-1.6z"/></svg>`;
      }
      contentHtml = `<div class="file-icon">${iconSvg}</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <input type="checkbox" class="checkbox-select" ${selected ? 'checked' : ''}>
      ${contentHtml}
      <button class="download-button" title="Download">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 0a256 256 0 1 0 0 512A256 256 0 1 0 256 0zM127 281c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l71 71L232 136c0-13.3 10.7-24 24-24s24 10.7 24 24l0 182.1 71-71c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9L273 393c-9.4 9.4-24.6 9.4-33.9 0L127 281z"/></svg>
      </button>
    `;

    const checkbox = this.shadowRoot.querySelector('.checkbox-select');
    const downloadBtn = this.shadowRoot.querySelector('.download-button');
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
      img.onerror = () => {
        // YouTube maxresdefault often 404 – fall back to hqdefault
        const vid = this.getAttribute('video-id');
        if (vid && img.src.includes('maxresdefault')) {
          img.src = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          return;
        }
        if (vid && img.src.includes('hqdefault')) {
          img.src = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
          return;
        }
        triggerError();
      };
    } else if (video) {
      video.onloadeddata = triggerLoad;
      video.onerror = () => {
        // Don't hide YouTube cards when direct stream fails – show thumb instead
        const vid = this.getAttribute('video-id');
        const thumb = this.getAttribute('thumbnail');
        if (vid || thumb) {
          const wrap = video.parentElement;
          if (wrap) {
            video.remove();
            const fallback = document.createElement('img');
            fallback.src = thumb || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
            fallback.alt = 'video';
            wrap.insertBefore(fallback, wrap.firstChild);
            triggerLoad();
            return;
          }
        }
        triggerError();
      };
    } else {
      setTimeout(triggerLoad, 50);
    }

    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('toggle-select', { detail: { checked: checkbox.checked } }));
    });

    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('download-media'));
    });

    // Clicking the thumbnail/card opens the preview and auto-plays video/audio.
    // Selection stays on the checkbox so it doesn't conflict with playback.
    this.addEventListener('click', (e) => {
      if (e.target !== this) return;
      this.dispatchEvent(new CustomEvent('preview-media'));
    });
  }
}
customElements.define('media-card-element', MediaCardElement);