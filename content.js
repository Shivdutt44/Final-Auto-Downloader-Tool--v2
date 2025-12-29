document.addEventListener('DOMContentLoaded', function() {
  // Recommended character lengths
  const RECOMMENDED_TITLE_LENGTH = 60;
  const RECOMMENDED_DESCRIPTION_LENGTH = 160;
  
  // Tab switching functionality
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      
      button.classList.add('active');
      const tabId = button.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
    });
  });
  
  // Refresh button functionality
  document.getElementById('refresh-btn').addEventListener('click', refreshData);
  
  // Initialize data when popup opens
  refreshData();
  
  // Add toggle functionality for headers
  document.querySelectorAll('.header-toggle').forEach(toggle => {
    toggle.addEventListener('click', function() {
      this.classList.toggle('active');
      const list = this.nextElementSibling;
      if (list.style.display === 'none') {
        list.style.display = 'block';
      } else {
        list.style.display = 'none';
      }
    });
  });

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'SEO_DATA') {
      updateUI(request.data);
    }
    if (request.type === 'SEO_DATA_UPDATE') {
      updateSpecificData(request.key, request.value);
    }
  });

  function updateCharacterCount(element, currentLength, recommendedLength, type) {
    const countElement = document.createElement('span');
    countElement.className = 'character-count';
    
    const difference = currentLength - recommendedLength;
    const absDifference = Math.abs(difference);
    
    if (currentLength > recommendedLength) {
      element.classList.add('error');
      element.classList.remove('success');
      countElement.textContent = `(${absDifference} over)`;
      countElement.classList.add('error-text');
      countElement.title = `${type} should be ${recommendedLength} characters or less`;
    } else if (currentLength === 0) {
      element.classList.add('error');
      element.classList.remove('success');
      countElement.textContent = '(missing)';
      countElement.classList.add('error-text');
      countElement.title = `${type} is missing`;
    } else {
      element.classList.add('success');
      element.classList.remove('error');
      countElement.textContent = `(${absDifference} under)`;
      countElement.classList.add('success-text');
      countElement.title = `${type} length is good`;
    }
    
    // Remove existing count if present
    const existingCount = element.parentElement.querySelector('.character-count');
    if (existingCount) {
      existingCount.remove();
    }
    
    element.parentElement.appendChild(countElement);
  }

  function refreshData() {
    // Show loading state
    document.querySelectorAll('.value').forEach(el => {
      el.textContent = 'Loading...';
      el.classList.remove('error', 'success');
    });
    
    // Clear existing character counts
    document.querySelectorAll('.character-count').forEach(el => el.remove());
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.scripting.executeScript({
          target: {tabId: tabs[0].id},
          files: ['content.js']
        }).catch(err => {
          console.error('Failed to execute script:', err);
          showErrorState();
        });
      } else {
        showErrorState();
      }
    });
  }

  function showErrorState() {
    document.querySelectorAll('.value').forEach(el => {
      el.textContent = 'Failed to load data';
      el.classList.add('error');
    });
  }

  function updateUI(data) {
    if (!data) {
      showErrorState();
      return;
    }

    // Basic Info Tab
    const titleElement = document.getElementById('page-title');
    titleElement.textContent = data.title || 'Not found';
    const titleLength = data.title ? data.title.length : 0;
    document.getElementById('title-length').textContent = `${titleLength} chars`;
    updateCharacterCount(titleElement, titleLength, RECOMMENDED_TITLE_LENGTH, 'Title');
    
    const descElement = document.getElementById('meta-description');
    descElement.textContent = data.description || 'Not found';
    const descLength = data.description ? data.description.length : 0;
    document.getElementById('description-length').textContent = `${descLength} chars`;
    updateCharacterCount(descElement, descLength, RECOMMENDED_DESCRIPTION_LENGTH, 'Description');
    
    document.getElementById('current-url').textContent = data.url || 'Not available';
    document.getElementById('canonical-url').textContent = data.canonical || data.url || 'Not available';
    
    const robotsElement = document.getElementById('meta-robots');
    robotsElement.textContent = data.robots || 'Not specified';
    if (!data.robots) {
      robotsElement.classList.add('error');
    } else {
      robotsElement.classList.remove('error');
    }
    
    // Headers Tab
    updateHeaders(data.headers);
    
    // Media Tab
    document.getElementById('total-images').textContent = data.images?.total || 0;
    document.getElementById('images-with-alt').textContent = data.images?.withAlt || 0;
    document.getElementById('images-no-alt').textContent = data.images?.withoutAlt || 0;
    
    const missingAltList = document.getElementById('missing-alt-list');
    missingAltList.innerHTML = '';
    if (data.images?.missingAltUrls) {
      data.images.missingAltUrls.forEach(url => {
        const li = document.createElement('li');
        li.textContent = url;
        li.classList.add('error-text');
        missingAltList.appendChild(li);
      });
    }
    
    // Links Tab
    document.getElementById('total-links').textContent = data.links?.total || 0;
    document.getElementById('internal-links').textContent = data.links?.internal || 0;
    document.getElementById('external-links').textContent = data.links?.external || 0;
    document.getElementById('unique-internal').textContent = data.links?.uniqueInternal || 0;
    document.getElementById('unique-external').textContent = data.links?.uniqueExternal || 0;
    
    // Social Tab
    updateSocialData('og-data', data.openGraph);
    updateSocialData('twitter-data', data.twitterCards);
    
    // Technical Tab
    updateTechnicalData(data);
  }

  function updateSpecificData(key, value) {
    switch(key) {
      case 'robotsTxt':
        const robotsStatus = document.getElementById('robots-txt-status');
        robotsStatus.textContent = value ? 'Found' : 'Not found';
        if (!value) {
          robotsStatus.classList.add('error-text');
        } else {
          robotsStatus.classList.remove('error-text');
        }
        document.getElementById('robots-txt-content').textContent = value || '';
        break;
      case 'sitemap':
        const sitemapStatus = document.getElementById('sitemap-status');
        sitemapStatus.textContent = value ? 'Found' : 'Not found';
        if (!value) {
          sitemapStatus.classList.add('error-text');
        } else {
          sitemapStatus.classList.remove('error-text');
        }
        document.getElementById('sitemap-content').textContent = value || '';
        break;
    }
  }

  function updateHeaders(headers) {
    for (let i = 1; i <= 6; i++) {
      const level = `h${i}`;
      const container = document.getElementById(`${level}-container`);
      const countElement = document.getElementById(`${level}-count`);
      const listElement = document.getElementById(`${level}-list`);
      const toggleElement = container.querySelector('.header-toggle');
      
      if (headers[level] && headers[level].length > 0) {
        countElement.textContent = headers[level].length;
        listElement.innerHTML = '';
        
        headers[level].forEach(header => {
          const li = document.createElement('li');
          li.textContent = header;
          listElement.appendChild(li);
        });
        
        container.style.display = 'block';
        
        // Only show H1 by default
        if (i === 1) {
          listElement.style.display = 'block';
          toggleElement.classList.add('active');
        } else {
          listElement.style.display = 'none';
          toggleElement.classList.remove('active');
        }
      } else {
        container.style.display = 'none';
      }
    }
    
    // Highlight H1 count issues
    const h1Count = headers.h1 ? headers.h1.length : 0;
    const h1CountElement = document.getElementById('h1-count');
    if (h1Count === 0) {
      h1CountElement.classList.add('error-text');
      h1CountElement.title = 'Page should have exactly one H1 tag';
    } else if (h1Count > 1) {
      h1CountElement.classList.add('error-text');
      h1CountElement.title = 'Page should have only one H1 tag';
    } else {
      h1CountElement.classList.remove('error-text');
      h1CountElement.title = '';
    }
  }

  function updateSocialData(containerId, data) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    
    if (!data || Object.keys(data).length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No data found';
      p.classList.add('error-text');
      container.appendChild(p);
      return;
    }
    
    for (const [key, value] of Object.entries(data)) {
      const div = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${key}:`;
      
      const span = document.createElement('span');
      span.textContent = value || 'Not specified';
      if (!value) {
        span.classList.add('error-text');
      }
      
      div.appendChild(strong);
      div.appendChild(span);
      container.appendChild(div);
    }
  }

  function updateTechnicalData(data) {
    // Viewport
    const viewportElement = document.getElementById('viewport-meta');
    viewportElement.textContent = data.viewport || 'Not found';
    if (!data.viewport) {
      viewportElement.classList.add('error-text');
    } else {
      viewportElement.classList.remove('error-text');
    }
    
    // Charset
    const charsetElement = document.getElementById('charset-meta');
    charsetElement.textContent = data.charset || 'Not found';
    if (!data.charset) {
      charsetElement.classList.add('error-text');
    } else {
      charsetElement.classList.remove('error-text');
    }
    
    // Protocol
    const protocolElement = document.getElementById('protocol');
    protocolElement.textContent = data.protocol || 'Not available';
    
    // Language
    const langElement = document.getElementById('html-lang');
    langElement.textContent = data.lang || 'Not specified';
    if (!data.lang) {
      langElement.classList.add('error-text');
    } else {
      langElement.classList.remove('error-text');
    }
  }
});