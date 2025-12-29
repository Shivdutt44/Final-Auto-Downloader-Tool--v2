// Track ongoing downloads
const ongoingDownloads = new Map();

// Listen for messages from the popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    // Handle download requests
    const { url, filename } = request;
    downloadFile(url, filename, (progress) => {
      // Send progress updates back to the sender
      sendResponse({ progress });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === 'downloadMultiple') {
    // Handle multiple file downloads as ZIP
    const { urls, zipName } = request;
    downloadMultipleFilesAsZip(urls, zipName, (progress) => {
      sendResponse({ progress });
    });
    return true;
  }
});

/**
 * Initiates a file download and tracks its progress
 * @param {string} url - The URL of the file to download
 * @param {string} filename - The suggested filename for the download
 * @param {function} progressCallback - Callback to receive progress updates
 */
function downloadFile(url, filename, progressCallback) {
  if (!isValidDownloadUrl(url)) {
    console.error('Invalid download URL:', url);
    progressCallback(0);
    return;
  }

  // Create a unique ID for this download
  const downloadId = `dl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  // Start with 0% progress
  progressCallback(0);

  // Initiate the download
  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false,
    conflictAction: 'uniquify'
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error('Download failed:', chrome.runtime.lastError);
      progressCallback(0);
      return;
    }

    // Store the download info
    ongoingDownloads.set(downloadId, {
      progress: 0,
      lastUpdated: Date.now(),
      progressCallback
    });
  });
}

/**
 * Downloads multiple files as a ZIP archive
 * @param {Array} urls - Array of file URLs to download
 * @param {string} zipName - Name for the ZIP file
 * @param {function} progressCallback - Callback for progress updates
 */
async function downloadMultipleFilesAsZip(urls, zipName, progressCallback) {
  progressCallback(0);
  
  try {
    // Create a new ZIP file
    const zipWriter = new window.ZipWriter(new window.BlobWriter('application/zip'));
    let completed = 0;
    
    for (const url of urls) {
      if (!isValidDownloadUrl(url)) continue;
      
      try {
        // Fetch each file
        const response = await fetch(url);
        const blob = await response.blob();
        const filename = url.split('/').pop() || `file_${Date.now()}`;
        
        // Add to ZIP
        await zipWriter.add(filename, new window.BlobReader(blob));
        
        // Update progress
        completed++;
        progressCallback(Math.round((completed / urls.length) * 100));
      } catch (error) {
        console.error(`Failed to download ${url}:`, error);
      }
    }
    
    // Finalize ZIP and download
    const zipBlob = await zipWriter.close();
    const zipUrl = URL.createObjectURL(zipBlob);
    
    chrome.downloads.download({
      url: zipUrl,
      filename: zipName,
      saveAs: true,
      conflictAction: 'uniquify'
    }, () => {
      progressCallback(100);
      URL.revokeObjectURL(zipUrl);
    });
  } catch (error) {
    console.error('ZIP creation failed:', error);
    progressCallback(0);
  }
}

// Listen for download progress updates
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.id || !ongoingDownloads.has(delta.id)) {
    return;
  }

  const downloadInfo = ongoingDownloads.get(delta.id);

  if (delta.state) {
    // Handle state changes
    if (delta.state.current === 'complete') {
      // Download completed successfully
      downloadInfo.progressCallback(100);
      ongoingDownloads.delete(delta.id);
      return;
    } else if (delta.state.current === 'interrupted') {
      // Download failed or was canceled
      downloadInfo.progressCallback(0);
      ongoingDownloads.delete(delta.id);
      return;
    }
  }

  // Calculate progress percentage if we have total bytes
  if (delta.bytesReceived && delta.totalBytes) {
    const progress = Math.round((delta.bytesReceived / delta.totalBytes) * 100);
    
    // Only update if progress has changed significantly or every 2 seconds
    const now = Date.now();
    if (progress !== downloadInfo.progress || now - downloadInfo.lastUpdated > 2000) {
      downloadInfo.progress = progress;
      downloadInfo.lastUpdated = now;
      downloadInfo.progressCallback(progress);
    }
  }
});

// Clean up any remaining downloads when extension is reloaded
chrome.runtime.onSuspend.addListener(() => {
  ongoingDownloads.clear();
});

// Optional: Add error handling for downloads
chrome.downloads.onErased.addListener((downloadId) => {
  if (ongoingDownloads.has(downloadId)) {
    const downloadInfo = ongoingDownloads.get(downloadId);
    downloadInfo.progressCallback(0);
    ongoingDownloads.delete(downloadId);
  }
});

/**
 * Helper function to validate URLs before downloading
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if URL is valid for download
 */
function isValidDownloadUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (e) {
    return false;
  }
}