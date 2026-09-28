/*
 * Digit Scanner — recognition + UI logic.
 * Requires p5.min.js to be loaded first (see digit-scanner.html).
 * No network calls: camera frames are read, thresholded, segmented into
 * blobs, and matched against digit templates entirely in this script.
 */
(function () {
  'use strict';

  // ---------- DOM ----------
  var statusPill = document.getElementById('statusPill');
  var statusTextEl = document.getElementById('statusText');
  var startBtn = document.getElementById('startBtn');
  var pauseBtn = document.getElementById('pauseBtn');
  var resetBoxBtn = document.getElementById('resetBoxBtn');
  var rescanBtn = document.getElementById('rescanBtn');
  var readoutValue = document.getElementById('readoutValue');
  var confidenceFill = document.getElementById('confidenceFill');
  var confidenceLabel = document.getElementById('confidenceLabel');
  var liveStatus = document.getElementById('liveStatus');
  var historyList = document.getElementById('historyList');
  var historyEmpty = document.getElementById('historyEmpty');
  var clearHistoryBtn = document.getElementById('clearHistoryBtn');
  var stageEl = document.getElementById('videoStage');
  var debugCard = document.getElementById('debugCard');
  var debugCanvas = document.getElementById('debugCanvas');
  var debugCtx = debugCanvas.getContext('2d');
  var debugInfo = document.getElementById('debugInfo');

  // ---------- State ----------
  var videoEl = null;
  var cameraStarted = false;
  var scanning = false;
  var lastScanAt = 0;
  var forceScan = false;
  var SCAN_INTERVAL_MS = 120;

  var roi = { x: 0.22, y: 0.36, w: 0.56, h: 0.28 }; // fractions of canvas
  var DEFAULT_ROI = { x: 0.22, y: 0.36, w: 0.56, h: 0.28 };
  var dragMode = null;
  var dragStart = null;

  // Per-position rolling vote: each position keeps the last few classified
  // digits it has seen. A position "locks" once one digit has a clear
  // plurality, so one bad frame in a single digit doesn't throw away good
  // votes already collected for the other two — this converges faster AND
  // more reliably than requiring the whole 3-digit string to repeat.
  var VOTE_WINDOW = 6;
  var posHistory = [[], [], []];
  var currentReading = null; // { digits, score }
  var history = []; // { digits, score, time }
  var lastCommittedDigits = null;

  function resetVotes() { posHistory = [[], [], []]; }

  function voteLock(votes) {
    if (votes.length === 0) return null;
    var counts = {};
    for (var i = 0; i < votes.length; i++) counts[votes[i]] = (counts[votes[i]] || 0) + 1;
    var best = null, bestCount = 0, second = 0;
    for (var d in counts) {
      if (counts[d] > bestCount) { second = bestCount; best = d; bestCount = counts[d]; }
      else if (counts[d] > second) { second = counts[d]; }
    }
    if (bestCount >= 2 && bestCount > second) return best;
    return null;
  }

  var templates = null; // built once

  // Offscreen processing canvas
  var PROC_W = 170;
  var procCanvas = document.createElement('canvas');
  var procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

  // Canonical normalized glyph size used for both templates and live blobs
  var CANON_W = 26, CANON_H = 38;

  // ---------- UI helpers ----------
  function setStatus(state, text) {
    statusPill.setAttribute('data-state', state);
    statusTextEl.textContent = text;
  }

  function setLiveStatus(text) { liveStatus.textContent = text; if (debugInfo) debugInfo.textContent = text; }

  // iPadOS reports as "MacIntel" in navigator.platform, so touch points
  // disambiguate it from a real Mac.
  function isIOS() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // Draw what the recognizer actually sees: the binarized ROI, with every
  // detected shape outlined (green = kept as a digit, red = rejected).
  function renderDebugView(bin, w, h, allBlobs, candidates) {
    if (!debugCard) return;
    debugCard.hidden = false;
    debugCanvas.width = w;
    debugCanvas.height = h;
    var img = debugCtx.createImageData(w, h);
    for (var i = 0; i < w * h; i++) {
      var v = bin[i] ? 235 : 18;
      var p = i * 4;
      img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    debugCtx.putImageData(img, 0, 0);
    debugCtx.lineWidth = 1;
    for (var b = 0; b < allBlobs.length; b++) {
      if (candidates.indexOf(allBlobs[b]) !== -1) continue;
      debugCtx.strokeStyle = '#e2685a';
      debugCtx.strokeRect(allBlobs[b].x + 0.5, allBlobs[b].y + 0.5, Math.max(1, allBlobs[b].w - 1), Math.max(1, allBlobs[b].h - 1));
    }
    for (var c = 0; c < candidates.length; c++) {
      debugCtx.strokeStyle = '#4fe0a0';
      debugCtx.strokeRect(candidates[c].x + 0.5, candidates[c].y + 0.5, Math.max(1, candidates[c].w - 1), Math.max(1, candidates[c].h - 1));
    }
  }

  function setConfidence(score) {
    var pct = Math.max(0, Math.min(1, score || 0));
    confidenceFill.style.width = (pct * 100).toFixed(0) + '%';
    confidenceLabel.textContent = (pct * 100).toFixed(0) + '%';
    var color = pct >= 0.62 ? 'var(--accent)' : (pct >= 0.4 ? 'var(--warn)' : 'var(--bad)');
    confidenceFill.style.background = color;
  }

  function renderReadout() {
    if (currentReading) {
      readoutValue.textContent = currentReading.digits;
      readoutValue.classList.remove('placeholder');
      setConfidence(currentReading.score);
    } else {
      readoutValue.textContent = '— — —';
      readoutValue.classList.add('placeholder');
      setConfidence(0);
    }
  }

  function formatTime(d) {
    var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function pushHistory(digits, score) {
    history.unshift({ digits: digits, score: score, time: new Date() });
    if (history.length > 25) history.pop();
    renderHistory();
  }

  function renderHistory() {
    if (history.length === 0) {
      historyEmpty.hidden = false;
      historyList.hidden = true;
      historyList.innerHTML = '';
      return;
    }
    historyEmpty.hidden = true;
    historyList.hidden = false;
    historyList.innerHTML = history.map(function (h) {
      return '<li class="history-item"><span class="digits">' + h.digits + '</span>' +
        '<span class="meta"><span>' + Math.round(h.score * 100) + '%</span><span>' + formatTime(h.time) + '</span></span></li>';
    }).join('');
  }

  clearHistoryBtn.addEventListener('click', function () {
    history = [];
    lastCommittedDigits = null;
    renderHistory();
  });

  // ---------- Camera ----------
  function startCamera() {
    if (cameraStarted) return;
    startBtn.disabled = true;
    setStatus('idle', 'Requesting camera…');
    setLiveStatus('Waiting for camera permission…');

    if (!window.isSecureContext) {
      startBtn.disabled = false;
      setStatus('error', 'Camera error');
      setLiveStatus('This page is not loaded over HTTPS/localhost, so the browser blocks camera access.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      startBtn.disabled = false;
      setStatus('error', 'Camera error');
      setLiveStatus('This browser does not expose a camera API. Try Chrome, Edge, Firefox, or Safari.');
      return;
    }

    var constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

    navigator.mediaDevices.getUserMedia(constraints).catch(function (err) {
      console.warn('Preferred camera constraints failed, falling back:', err && err.name, err && err.message);
      // Fall back to any available camera
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }).then(function (stream) {
      videoEl = document.createElement('video');
      // iOS Safari needs these set both as attributes and as properties,
      // and is unreliable decoding frames from a <video> that was never
      // attached to the document — so it's appended here, just made
      // invisible rather than display:none (which some WebKit builds also
      // treat as "not really playing").
      videoEl.setAttribute('autoplay', '');
      videoEl.setAttribute('muted', '');
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = true;
      videoEl.srcObject = stream;
      videoEl.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(videoEl);
      return videoEl.play().then(function () { return stream; });
    }).then(function () {
      cameraStarted = true;
      scanning = true;
      resetVotes();
      pauseBtn.disabled = false;
      resetBoxBtn.disabled = false;
      rescanBtn.disabled = false;
      pauseBtn.textContent = 'Pause';
      setStatus('scanning', 'Scanning');
      setLiveStatus('Looking for a 3-digit number…');
    }).catch(function (err) {
      startBtn.disabled = false;
      setStatus('error', 'Camera error');
      console.error('Camera start failed:', err);
      var name = err && err.name;
      var msg = 'Could not start the camera' + (name ? ' (' + name + ')' : '') + '.';
      if (name === 'NotAllowedError') {
        if (isIOS()) {
          msg += ' iPhone/iPad blocked it before showing a prompt. Check, in this order: (1) Settings → Safari → Camera → set to "Ask" or "Allow". (2) Settings → Privacy & Security → Camera → make sure Safari is toggled on. (3) Tap the "aA" icon in Safari\'s address bar → Website Settings → set Camera to Allow for this page. (4) Fully close Safari (swipe it away in the app switcher) and reopen this link. If all of those are already allowed, try Settings → General → Software Update to confirm you\'re on a current iOS version — very old iOS builds can silently block getUserMedia.';
        } else {
          msg += ' Permission was denied or blocked for this page — check your browser\'s site settings and allow the camera.';
        }
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        msg += ' No camera could be matched on this device.';
      } else if (name === 'NotReadableError') {
        msg += ' The camera may already be in use by another app or tab.';
      } else if (err && err.message) {
        msg += ' ' + err.message;
      }
      setLiveStatus(msg);
    });
  }

  startBtn.addEventListener('click', startCamera);

  pauseBtn.addEventListener('click', function () {
    if (!cameraStarted) return;
    scanning = !scanning;
    pauseBtn.textContent = scanning ? 'Pause' : 'Resume';
    setStatus(scanning ? 'scanning' : 'paused', scanning ? 'Scanning' : 'Paused');
    setLiveStatus(scanning ? 'Looking for a 3-digit number…' : 'Scanning paused.');
  });

  resetBoxBtn.addEventListener('click', function () {
    roi.x = DEFAULT_ROI.x; roi.y = DEFAULT_ROI.y; roi.w = DEFAULT_ROI.w; roi.h = DEFAULT_ROI.h;
  });

  rescanBtn.addEventListener('click', function () {
    if (!cameraStarted) return;
    currentReading = null;
    resetVotes();
    lastCommittedDigits = null;
    renderReadout();
    setLiveStatus('Re-scanning…');
    forceScan = true;
  });

  // ---------- Image processing ----------

  // Build glyph templates once, from a couple of generic font families so
  // both plain printed digits and monospace/display digits have a chance.
  function buildTemplates() {
    var families = [
      'bold 64px Arial, Helvetica, sans-serif',
      'bold 64px "Courier New", monospace',
      '64px Arial, Helvetica, sans-serif'
    ];
    var tCanvas = document.createElement('canvas');
    tCanvas.width = 100; tCanvas.height = 100;
    var tCtx = tCanvas.getContext('2d', { willReadFrequently: true });
    var out = [];

    for (var f = 0; f < families.length; f++) {
      for (var d = 0; d <= 9; d++) {
        tCtx.fillStyle = '#fff';
        tCtx.fillRect(0, 0, tCanvas.width, tCanvas.height);
        tCtx.fillStyle = '#000';
        tCtx.font = families[f];
        tCtx.textBaseline = 'alphabetic';
        tCtx.textAlign = 'left';
        tCtx.fillText(String(d), 10, 78);
        var imgData = tCtx.getImageData(0, 0, tCanvas.width, tCanvas.height);
        var bin = binarizeFromLuma(imgData, 128, false);
        var bbox = boundingBoxOf(bin, tCanvas.width, tCanvas.height);
        if (!bbox) continue;
        var canon = normalizeToCanonical(bin, tCanvas.width, tCanvas.height, bbox);
        out.push({ digit: d, bitmap: canon });
      }
    }
    return out;
  }

  // Legacy helper kept for template rendering (clean synthetic glyphs need
  // no blur or shared-buffer plumbing).
  function binarizeFromLuma(imgData, threshold, invert) {
    var data = imgData.data;
    var n = imgData.width * imgData.height;
    var bin = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      var fg = luma < threshold;
      if (invert) fg = !fg;
      bin[i] = fg ? 1 : 0;
    }
    return bin;
  }

  function lumaOf(imgData) {
    var data = imgData.data;
    var n = imgData.width * imgData.height;
    var luma = new Uint8ClampedArray(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      luma[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    }
    return luma;
  }

  // A light 3x3 box blur on the live camera crop before thresholding.
  // Camera sensor/compression noise otherwise fragments digit strokes into
  // extra tiny blobs, which is the single biggest cause of bad segmentation.
  function boxBlur3(luma, w, h) {
    var out = new Uint8ClampedArray(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, count = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          var row = yy * w;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += luma[row + xx]; count++;
          }
        }
        out[y * w + x] = sum / count;
      }
    }
    return out;
  }

  function binarizeLuma(luma, threshold, invert) {
    var n = luma.length;
    var bin = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var fg = luma[i] < threshold;
      if (invert) fg = !fg;
      bin[i] = fg ? 1 : 0;
    }
    return bin;
  }

  function otsuThresholdLuma(luma) {
    var n = luma.length;
    var hist = new Array(256).fill(0);
    for (var i = 0; i < n; i++) hist[luma[i]]++;
    var total = n, sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
    for (var t2 = 0; t2 < 256; t2++) {
      wB += hist[t2];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      sumB += t2 * hist[t2];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) { maxVar = varBetween; threshold = t2; }
    }
    return threshold;
  }

  function boundingBoxOf(bin, w, h) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (bin[y * w + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // Scale a binary bbox region to CANON_W x CANON_H, preserving aspect ratio
  // (scale to fit height, center horizontally) so a thin "1" and a wide "8"
  // remain comparable in shape rather than being stretched to the same box.
  function normalizeToCanonical(bin, srcW, srcH, bbox) {
    var canon = new Uint8Array(CANON_W * CANON_H);
    var margin = 4;
    var targetH = CANON_H - margin * 2;
    var scale = targetH / bbox.h;
    var targetW = Math.min(CANON_W - margin * 2, bbox.w * scale);
    scale = Math.min(scale, targetW / bbox.w);
    var drawW = bbox.w * scale, drawH = bbox.h * scale;
    var offX = (CANON_W - drawW) / 2, offY = (CANON_H - drawH) / 2;

    for (var cy = 0; cy < CANON_H; cy++) {
      for (var cx = 0; cx < CANON_W; cx++) {
        var sx = Math.floor((cx - offX) / scale) + bbox.x;
        var sy = Math.floor((cy - offY) / scale) + bbox.y;
        if (sx >= bbox.x && sx < bbox.x + bbox.w && sy >= bbox.y && sy < bbox.y + bbox.h && sx >= 0 && sy >= 0 && sx < srcW && sy < srcH) {
          canon[cy * CANON_W + cx] = bin[sy * srcW + sx];
        }
      }
    }
    return canon;
  }

  function similarity(a, b) {
    var inter = 0, union = 0;
    for (var i = 0; i < a.length; i++) {
      var av = a[i], bv = b[i];
      if (av || bv) union++;
      if (av && bv) inter++;
    }
    if (union === 0) return 0;
    return inter / union;
  }

  function shiftBitmapX(bitmap, dx) {
    if (dx === 0) return bitmap;
    var out = new Uint8Array(CANON_W * CANON_H);
    for (var y = 0; y < CANON_H; y++) {
      for (var x = 0; x < CANON_W; x++) {
        var sx = x - dx;
        if (sx >= 0 && sx < CANON_W) out[y * CANON_W + x] = bitmap[y * CANON_W + sx];
      }
    }
    return out;
  }

  // Try the live glyph at a couple of horizontal offsets against every
  // template — segmentation crops are never pixel-perfect, so a little
  // alignment tolerance recovers matches that a rigid comparison would miss.
  function classifyGlyph(bitmap) {
    var variants = [bitmap, shiftBitmapX(bitmap, -1), shiftBitmapX(bitmap, 1)];
    var best = { digit: null, score: -1 };
    for (var i = 0; i < templates.length; i++) {
      for (var v = 0; v < variants.length; v++) {
        var s = similarity(variants[v], templates[i].bitmap);
        if (s > best.score) best = { digit: templates[i].digit, score: s };
      }
    }
    return best;
  }

  // Iterative flood fill (4-connectivity) connected component labeling.
  function findBlobs(bin, w, h) {
    var visited = new Uint8Array(w * h);
    var blobs = [];
    var stack = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = y * w + x;
        if (!bin[idx] || visited[idx]) continue;
        var minX = x, maxX = x, minY = y, maxY = y, count = 0;
        stack.length = 0;
        stack.push(idx);
        visited[idx] = 1;
        while (stack.length) {
          var cur = stack.pop();
          var cx = cur % w, cy = (cur / w) | 0;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          var neighbors = [
            cx > 0 ? cur - 1 : -1,
            cx < w - 1 ? cur + 1 : -1,
            cy > 0 ? cur - w : -1,
            cy < h - 1 ? cur + w : -1
          ];
          for (var n = 0; n < 4; n++) {
            var ni = neighbors[n];
            if (ni >= 0 && bin[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
          }
        }
        blobs.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count: count });
      }
    }
    return blobs;
  }

  // Run the full recognition pipeline on the current ROI of the video.
  function scanOnce(cw, ch, offsetX, offsetY, scale) {
    if (!videoEl || !videoEl.videoWidth) return;

    var roiScreen = { x: roi.x * cw, y: roi.y * ch, w: roi.w * cw, h: roi.h * ch };
    var srcX = (roiScreen.x - offsetX) / scale;
    var srcY = (roiScreen.y - offsetY) / scale;
    var srcW = roiScreen.w / scale;
    var srcH = roiScreen.h / scale;
    srcX = Math.max(0, srcX); srcY = Math.max(0, srcY);
    srcW = Math.min(srcW, videoEl.videoWidth - srcX);
    srcH = Math.min(srcH, videoEl.videoHeight - srcY);
    if (srcW < 10 || srcH < 10) return;

    var procH = Math.max(50, Math.round(PROC_W * (srcH / srcW)));
    procCanvas.width = PROC_W;
    procCanvas.height = procH;
    procCtx.drawImage(videoEl, srcX, srcY, srcW, srcH, 0, 0, PROC_W, procH);

    var imgData = procCtx.getImageData(0, 0, PROC_W, procH);
    var luma = boxBlur3(lumaOf(imgData), PROC_W, procH);
    var threshold = otsuThresholdLuma(luma);
    var binNormal = binarizeLuma(luma, threshold, false);

    // Decide polarity: digit strokes should be the minority of the area.
    var fgCount = 0;
    for (var i = 0; i < binNormal.length; i++) fgCount += binNormal[i];
    var fgFraction = fgCount / binNormal.length;
    var bin = fgFraction > 0.5 ? binarizeLuma(luma, threshold, true) : binNormal;

    var blobs = findBlobs(bin, PROC_W, procH);

    // Keep digit-shaped blobs: tall enough, not absurdly wide, not just noise.
    var candidates = blobs.filter(function (b) {
      return b.h >= procH * 0.28 && b.w <= PROC_W * 0.85 && b.count >= 8;
    });

    if (candidates.length > 3) {
      candidates.sort(function (a, b) { return b.h * b.w - a.h * a.w; });
      candidates = candidates.slice(0, 3);
    }
    candidates.sort(function (a, b) { return a.x - b.x; });

    renderDebugView(bin, PROC_W, procH, blobs, candidates);

    if (candidates.length !== 3) {
      setLiveStatus(candidates.length === 0 ? 'No shapes found in the frame (' + blobs.length + ' total blobs) — center the number and fill the box.' : 'Found ' + candidates.length + ' digit-shaped region(s) out of ' + blobs.length + ' total — needs exactly 3.');
      return;
    }

    var digits = '', scores = [];
    for (var c = 0; c < 3; c++) {
      var b = candidates[c];
      var canon = normalizeToCanonical(bin, PROC_W, procH, b);
      var result = classifyGlyph(canon);
      digits += (result.digit === null ? '?' : result.digit);
      scores.push(result.score);
      // Only cast a vote for this position when the match is decent —
      // garbage votes would just slow down (or corrupt) the majority.
      if (result.digit !== null && result.score >= 0.18) {
        var hist = posHistory[c];
        hist.push(String(result.digit));
        if (hist.length > VOTE_WINDOW) hist.shift();
      }
    }

    var avgScore = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    var scoreStr = scores.map(function (s) { return Math.round(s * 100) + '%'; }).join(', ');
    setLiveStatus('Live guess: ' + digits + ' (' + scoreStr + ')');

    var locked = [voteLock(posHistory[0]), voteLock(posHistory[1]), voteLock(posHistory[2])];
    if (locked[0] !== null && locked[1] !== null && locked[2] !== null) {
      var finalDigits = locked[0] + locked[1] + locked[2];
      currentReading = { digits: finalDigits, score: avgScore };
      renderReadout();
      if (finalDigits !== lastCommittedDigits) {
        lastCommittedDigits = finalDigits;
        pushHistory(finalDigits, avgScore);
      }
    }
  }

  // ---------- p5 sketch: canvas, video compositing, ROI interaction ----------
  var HANDLE_R = 16;

  new p5(function (p) {
    var cw = 0, ch = 0;

    function computeCoverFit() {
      if (!videoEl || !videoEl.videoWidth) return null;
      var vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      var scale = Math.max(cw / vw, ch / vh);
      var drawW = vw * scale, drawH = vh * scale;
      var offsetX = (cw - drawW) / 2, offsetY = (ch - drawH) / 2;
      return { scale: scale, offsetX: offsetX, offsetY: offsetY, drawW: drawW, drawH: drawH };
    }

    // Older WebKit (some iOS Safari versions) doesn't support the
    // `aspect-ratio` CSS property, which would otherwise leave this stage
    // at zero height and the whole canvas invisible/non-functional.
    function ensureStageSize() {
      if (stageEl.clientWidth > 0 && stageEl.clientHeight === 0) {
        stageEl.style.height = Math.round(stageEl.clientWidth * 0.75) + 'px';
      }
    }

    p.setup = function () {
      ensureStageSize();
      cw = stageEl.clientWidth; ch = stageEl.clientHeight;
      var c = p.createCanvas(cw, ch);
      c.parent(stageEl);
      templates = buildTemplates();

      function onStageResize() {
        ensureStageSize();
        cw = stageEl.clientWidth; ch = stageEl.clientHeight;
        if (cw > 0 && ch > 0) p.resizeCanvas(cw, ch);
      }
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(onStageResize).observe(stageEl);
      } else {
        window.addEventListener('resize', onStageResize);
      }
    };

    p.draw = function () {
      p.background(5, 8, 5);

      if (!cameraStarted) {
        p.noStroke();
        p.fill(142, 162, 151);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(14);
        p.textFont('IBM Plex Sans, sans-serif');
        p.text('Camera preview will appear here', cw / 2, ch / 2);
        return;
      }

      var fit = computeCoverFit();
      if (fit) {
        p.drawingContext.drawImage(videoEl, fit.offsetX, fit.offsetY, fit.drawW, fit.drawH);

        // Dim area outside the ROI
        var rx = roi.x * cw, ry = roi.y * ch, rw = roi.w * cw, rh = roi.h * ch;
        p.noStroke();
        p.fill(4, 8, 6, 165);
        p.rect(0, 0, cw, ry);
        p.rect(0, ry + rh, cw, ch - ry - rh);
        p.rect(0, ry, rx, rh);
        p.rect(rx + rw, ry, cw - rx - rw, rh);

        // Reticle box
        var accentActive = scanning;
        p.noFill();
        p.stroke(accentActive ? p.color(79, 224, 160) : p.color(142, 162, 151));
        p.strokeWeight(2);
        p.rect(rx, ry, rw, rh);

        // Corner brackets
        var bl = Math.min(22, rw * 0.25, rh * 0.25);
        p.stroke(accentActive ? p.color(79, 224, 160) : p.color(142, 162, 151));
        p.strokeWeight(3);
        drawCorner(p, rx, ry, bl, 1, 1);
        drawCorner(p, rx + rw, ry, bl, -1, 1);
        drawCorner(p, rx, ry + rh, bl, 1, -1);
        drawCorner(p, rx + rw, ry + rh, bl, -1, -1);

        // Handle dots
        p.noStroke();
        p.fill(accentActive ? p.color(79, 224, 160) : p.color(142, 162, 151));
        [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(function (pt) {
          p.circle(pt[0], pt[1], 8);
        });

        if (forceScan || (scanning && p.millis() - lastScanAt >= SCAN_INTERVAL_MS)) {
          lastScanAt = p.millis();
          forceScan = false;
          scanOnce(cw, ch, fit.offsetX, fit.offsetY, fit.scale);
        }
      }
    };

    function drawCorner(p, x, y, len, dx, dy) {
      p.line(x, y, x + len * dx, y);
      p.line(x, y, x, y + len * dy);
    }

    function hitTest(mx, my) {
      var rx = roi.x * cw, ry = roi.y * ch, rw = roi.w * cw, rh = roi.h * ch;
      var corners = { tl: [rx, ry], tr: [rx + rw, ry], bl: [rx, ry + rh], br: [rx + rw, ry + rh] };
      for (var key in corners) {
        var pt = corners[key];
        if (Math.hypot(mx - pt[0], my - pt[1]) <= HANDLE_R) return key;
      }
      if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) return 'move';
      return null;
    }

    function pressStart(mx, my) {
      if (!cameraStarted) return;
      var mode = hitTest(mx, my);
      if (!mode) { dragMode = null; return; }
      dragMode = mode;
      dragStart = { mx: mx, my: my, rect: { x: roi.x * cw, y: roi.y * ch, w: roi.w * cw, h: roi.h * ch } };
    }

    function dragMove(mx, my) {
      if (!dragMode || !dragStart) return;
      var dx = mx - dragStart.mx, dy = my - dragStart.my;
      var r = dragStart.rect;
      var nx = r.x, ny = r.y, nw = r.w, nh = r.h;
      var MIN = 40;

      if (dragMode === 'move') {
        nx = r.x + dx; ny = r.y + dy;
      } else if (dragMode === 'tl') {
        nx = r.x + dx; ny = r.y + dy; nw = r.w - dx; nh = r.h - dy;
      } else if (dragMode === 'tr') {
        ny = r.y + dy; nw = r.w + dx; nh = r.h - dy;
      } else if (dragMode === 'bl') {
        nx = r.x + dx; nw = r.w - dx; nh = r.h + dy;
      } else if (dragMode === 'br') {
        nw = r.w + dx; nh = r.h + dy;
      }

      if (nw < MIN) nw = MIN;
      if (nh < MIN) nh = MIN;
      nx = Math.max(0, Math.min(nx, cw - nw));
      ny = Math.max(0, Math.min(ny, ch - nh));
      if (nx + nw > cw) nw = cw - nx;
      if (ny + nh > ch) nh = ch - ny;

      roi.x = nx / cw; roi.y = ny / ch; roi.w = nw / cw; roi.h = nh / ch;
    }

    p.mousePressed = function () { pressStart(p.mouseX, p.mouseY); };
    p.mouseDragged = function () { dragMove(p.mouseX, p.mouseY); };
    p.mouseReleased = function () { dragMode = null; dragStart = null; };
    p.touchStarted = function () { pressStart(p.mouseX, p.mouseY); return false; };
    p.touchMoved = function () { dragMove(p.mouseX, p.mouseY); return false; };
    p.touchEnded = function () { dragMode = null; dragStart = null; return false; };
  }, stageEl);

  renderReadout();
  renderHistory();
})();
