/**
 * Persistent dynamic media loader – injected into the active page.
 * Watches SPA / infinite-scroll feeds (YouTube, Shorts, Reels) and caches
 * discovered media so the popup scraper can pick them up on every scan.
 */
(function installAutoMediaDynamicLoader() {
  if (window.__AMD_DYNAMIC_LOADER__) return;
  window.__AMD_DYNAMIC_LOADER__ = true;

  const CACHE_KEY = '__AMD_MEDIA_CACHE__';
  const SEEN_KEY = '__AMD_SEEN_URLS__';

  if (!window[CACHE_KEY]) window[CACHE_KEY] = [];
  if (!window[SEEN_KEY]) window[SEEN_KEY] = new Set();

  function ytIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const patterns = [
      /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|live\/|shorts\/|reel\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function isMediaLikeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.startsWith('data:image') || url.startsWith('data:video') || url.startsWith('data:audio')) {
      return true;
    }
    if (/googlevideo\.com|ytimg\.com|ggpht\.com|googleusercontent\.com/i.test(url)) return true;
    if (/youtube\.com|youtu\.be/i.test(url) && ytIdFromUrl(url)) return true;
    if (/instagram\.com\/(?:reel|reels|p)\//i.test(url)) return true;
    if (/\.(mp4|webm|mov|m3u8|mpd|ts|m4v|jpe?g|png|gif|webp|mp3|wav|ogg)(?:[\?#]|$)/i.test(url)) return true;
    if (/videoplayback|mime=video|mime=audio/i.test(url)) return true;
    return false;
  }

  function getType(url) {
    if (!url) return 'other';
    if (url.startsWith('data:image/')) return 'image';
    if (url.startsWith('data:video/') || url.startsWith('blob:')) {
      // blob often video on social feeds
      if (/audio/i.test(url)) return 'audio';
      if (/image/i.test(url)) return 'image';
      return 'video';
    }
    if (/ytimg\.com|ggpht\.com/i.test(url) || /\.(jpe?g|png|gif|webp|svg|bmp|avif)(?:[\?#]|$)/i.test(url)) return 'image';
    if (/\.(mp3|wav|ogg|flac|m4a|aac)(?:[\?#]|$)/i.test(url)) return 'audio';
    if (
      /\.(mp4|webm|mov|m3u8|mpd|ts|m4v)(?:[\?#]|$)/i.test(url) ||
      /youtube\.com|youtu\.be|googlevideo\.com|videoplayback|instagram\.com\/(?:reel|reels)/i.test(url)
    ) {
      return 'video';
    }
    return 'other';
  }

  function pushMedia(entry) {
    if (!entry || !entry.url) return;
    let url = String(entry.url).trim();
    if (!url || window[SEEN_KEY].has(url)) return;
    if (!isMediaLikeUrl(url) && !entry.force) return;

    window[SEEN_KEY].add(url);

    const videoId = entry.videoId || ytIdFromUrl(url) || ytIdFromUrl(entry.watchUrl || '');
    const isShorts =
      entry.isShorts === true ||
      /\/shorts\//i.test(url) ||
      /\/shorts\//i.test(entry.watchUrl || '') ||
      entry.source === 'youtube-shorts';

    const item = {
      type: entry.type || getType(url),
      url,
      watchUrl: entry.watchUrl || (videoId ? (isShorts
        ? `https://www.youtube.com/shorts/${videoId}`
        : `https://www.youtube.com/watch?v=${videoId}`) : null),
      thumbnail: entry.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null),
      videoId: videoId || null,
      title: entry.title || null,
      source: entry.source || (videoId ? (isShorts ? 'youtube-shorts' : 'youtube') : 'dynamic'),
      isYouTube: !!videoId || /youtube\.com|youtu\.be|googlevideo\.com/i.test(url),
      isShorts: !!isShorts,
      streamUrl: entry.streamUrl || null,
      element: entry.element || 'Dynamic Loader',
      discoveredAt: Date.now()
    };

    // Prefer stream URL as primary downloadable url when present
    if (item.streamUrl && !item.url.includes('googlevideo.com') && !/\.mp4/i.test(item.url)) {
      // keep watch url as watchUrl, stream as url for download
      if (item.isYouTube && item.videoId) {
        item.watchUrl = item.watchUrl || item.url;
        item.url = item.streamUrl;
      }
    }

    window[CACHE_KEY].push(item);

    // Cap cache size
    if (window[CACHE_KEY].length > 5000) {
      window[CACHE_KEY] = window[CACHE_KEY].slice(-3000);
    }
  }

  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;

    try {
      const tag = (node.tagName || '').toUpperCase();

      if (tag === 'VIDEO') {
        const src = node.currentSrc || node.src || node.getAttribute('src');
        if (src) pushMedia({ url: src, type: 'video', source: 'dom-video' });
        node.querySelectorAll?.('source').forEach((s) => {
          const ssrc = s.src || s.getAttribute('src');
          if (ssrc) pushMedia({ url: ssrc, type: 'video', source: 'dom-video-source' });
        });
        if (node.poster) pushMedia({ url: node.poster, type: 'image', source: 'video-poster' });
      }

      if (tag === 'IMG') {
        const src = node.currentSrc || node.src || node.getAttribute('src');
        if (src && (src.includes('ytimg') || src.includes('ggpht') || /\.(jpe?g|png|webp)/i.test(src))) {
          pushMedia({ url: src, type: 'image', source: 'dom-img' });
        }
        // YouTube thumbnail often encodes video id
        const ytThumb = src && src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
        if (ytThumb) {
          const id = ytThumb[1];
          pushMedia({
            url: `https://www.youtube.com/watch?v=${id}`,
            type: 'video',
            videoId: id,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            source: 'youtube-thumb',
            force: true
          });
        }
      }

      if (tag === 'IFRAME') {
        const src = node.src || node.getAttribute('src') || '';
        const id = ytIdFromUrl(src);
        if (id) {
          pushMedia({
            url: src.includes('shorts') ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
            type: 'video',
            videoId: id,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            source: src.includes('shorts') ? 'youtube-shorts' : 'youtube-embed',
            isShorts: src.includes('shorts'),
            force: true
          });
        }
      }

      if (tag === 'A') {
        const href = node.href || node.getAttribute('href') || '';
        const id = ytIdFromUrl(href);
        if (id) {
          const isShorts = /\/shorts\//i.test(href);
          const title =
            node.getAttribute('title') ||
            node.getAttribute('aria-label') ||
            (node.textContent || '').trim().slice(0, 120) ||
            null;
          pushMedia({
            url: isShorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
            type: 'video',
            videoId: id,
            title,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            source: isShorts ? 'youtube-shorts' : 'youtube-link',
            isShorts,
            force: true
          });
        }
        // Instagram reels
        if (/instagram\.com\/(?:reel|reels|p)\//i.test(href)) {
          pushMedia({ url: href, type: 'video', source: 'instagram-reel', force: true });
        }
      }

      // YouTube custom elements often hold videoId
      const videoIdAttr =
        node.getAttribute?.('video-id') ||
        node.getAttribute?.('data-video-id') ||
        node.getAttribute?.('data-videoid');
      if (videoIdAttr && /^[a-zA-Z0-9_-]{11}$/.test(videoIdAttr)) {
        const isShorts =
          /shorts|reel/i.test(node.tagName || '') ||
          /shorts|reel/i.test(node.className || '') ||
          location.pathname.startsWith('/shorts');
        pushMedia({
          url: isShorts
            ? `https://www.youtube.com/shorts/${videoIdAttr}`
            : `https://www.youtube.com/watch?v=${videoIdAttr}`,
          type: 'video',
          videoId: videoIdAttr,
          thumbnail: `https://i.ytimg.com/vi/${videoIdAttr}/hqdefault.jpg`,
          source: isShorts ? 'youtube-shorts' : 'youtube-dom',
          isShorts,
          force: true
        });
      }
    } catch (_) {
      /* ignore node errors */
    }

    // Children (limited depth walk for performance on huge mutations)
    try {
      if (node.children && node.children.length && node.children.length < 200) {
        for (let i = 0; i < node.children.length; i++) {
          scanNode(node.children[i]);
        }
      }
    } catch (_) {}
  }

  // Performance resource polling – captures googlevideo streams as they load
  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (!name) continue;
        if (/googlevideo\.com\/videoplayback/i.test(name) || /mime=video/i.test(name)) {
          pushMedia({ url: name, type: 'video', source: 'network-stream', streamUrl: name, force: true });
        } else if (/ytimg\.com\/vi\//i.test(name)) {
          const m = name.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
          if (m) {
            pushMedia({
              url: `https://www.youtube.com/watch?v=${m[1]}`,
              type: 'video',
              videoId: m[1],
              thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
              source: 'network-thumb',
              force: true
            });
          }
        } else if (isMediaLikeUrl(name) && getType(name) !== 'other') {
          pushMedia({ url: name, type: getType(name), source: 'network-resource' });
        }
      }
    } catch (_) {}
  }

  // MutationObserver for dynamically injected feed items
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((n) => {
          if (n.nodeType === 1) scanNode(n);
        });
      } else if (mutation.type === 'attributes') {
        const name = mutation.attributeName;
        if (name === 'src' || name === 'href' || name === 'srcset' || name === 'video-id' || name === 'data-video-id') {
          scanNode(mutation.target);
        }
      }
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'srcset', 'poster', 'video-id', 'data-video-id', 'data-videoid']
  });

  // Listen for MAIN-world stream discoveries (CustomEvent bridges worlds)
  window.addEventListener('amd-media-found', (ev) => {
    try {
      const d = ev.detail || {};
      if (d.url) {
        pushMedia({
          url: d.url,
          streamUrl: d.streamUrl || d.url,
          type: d.type || 'video',
          videoId: d.videoId || null,
          title: d.title || null,
          source: d.source || 'main-world',
          force: true
        });
      }
    } catch (_) {}
  });

  // Poll data-amd-streams attribute written by MAIN world hooks
  function pollMainWorldStreams() {
    try {
      const raw = document.documentElement.getAttribute('data-amd-streams');
      if (!raw) return;
      const list = JSON.parse(raw);
      const vid = document.documentElement.getAttribute('data-amd-vid');
      if (Array.isArray(list)) {
        list.forEach((url) => {
          pushMedia({
            url,
            streamUrl: url,
            type: 'video',
            videoId: vid || ytIdFromUrl(location.href),
            source: 'main-world-attr',
            force: true
          });
        });
      }
    } catch (_) {}
  }

  // Initial full scan
  scanNode(document.body || document.documentElement);
  scanPerformance();
  pollMainWorldStreams();

  // Periodic performance + light DOM harvest (YouTube SPA)
  setInterval(() => {
    scanPerformance();
    pollMainWorldStreams();
    // Harvest visible YouTube anchors that may have been updated without full node replace
    try {
      document.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"], a[href*="youtu.be"], [video-id], [data-video-id]').forEach((el) => {
        scanNode(el);
      });
      document.querySelectorAll('video').forEach((v) => scanNode(v));
    } catch (_) {}
  }, 2000);

  // SPA navigation (YouTube client-side routing)
  const notifyNav = () => {
    setTimeout(() => {
      scanNode(document.body || document.documentElement);
      scanPerformance();
    }, 800);
  };

  const _pushState = history.pushState;
  const _replaceState = history.replaceState;
  history.pushState = function () {
    const r = _pushState.apply(this, arguments);
    notifyNav();
    return r;
  };
  history.replaceState = function () {
    const r = _replaceState.apply(this, arguments);
    notifyNav();
    return r;
  };
  window.addEventListener('popstate', notifyNav);
  window.addEventListener('yt-navigate-finish', notifyNav);
  window.addEventListener('yt-page-data-updated', notifyNav);

  // Expose helpers for popup-injected scroll loader
  window.__AMD_SCROLL_LOAD__ = async function scrollLoadMore(rounds = 6, pauseMs = 900) {
    const results = [];
    const heightBefore = () => Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    for (let i = 0; i < rounds; i++) {
      const before = heightBefore();
      // Prefer YouTube shorts / feed containers
      const scrollRoot =
        document.querySelector('#shorts-container') ||
        document.querySelector('ytd-shorts') ||
        document.querySelector('#contents') ||
        document.scrollingElement ||
        document.documentElement;

      if (scrollRoot === document.scrollingElement || scrollRoot === document.documentElement) {
        window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600));
      } else {
        scrollRoot.scrollTop = scrollRoot.scrollTop + Math.max(scrollRoot.clientHeight * 0.9, 600);
        // Also nudge window for hybrid layouts
        window.scrollBy(0, Math.max(window.innerHeight * 0.5, 400));
      }

      // Keyboard-like short navigation on Shorts
      if (location.pathname.startsWith('/shorts')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }

      await new Promise((r) => setTimeout(r, pauseMs));
      scanPerformance();
      results.push({ round: i + 1, height: heightBefore(), grew: heightBefore() > before });
    }

    return {
      rounds,
      cacheSize: window[CACHE_KEY].length,
      results
    };
  };

  window.__AMD_GET_CACHE__ = function () {
    return window[CACHE_KEY].slice();
  };
})();
