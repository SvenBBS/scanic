/**
 * scanic
 * JavaScript document scanner without OpenCV dependency
 * MIT License
 */


import { detectDocumentContour } from './contourDetection.js';
import { findCornerPoints } from './cornerDetection.js';
import { cannyEdgeDetector, initializeWasm, getWasmPreprocessingModule } from './edgeDetection.js';
import { preprocessForDocumentDetection, unsharpMaskJS, unsharpMaskAndDownscaleJS, claheJS } from './preprocessing.js';
import { findDocumentContour } from './contourFilter.js';

/**
 * Global initialization helper for convenience.
 */
export async function initialize() {
  return await initializeWasm();
}

/**
 * Unified Scanner class for better state and configuration management.
 */
export class Scanner {
  constructor(options = {}) {
    this.defaultOptions = {
      maxProcessingDimension: 2000,
      preEnhance: 'unsharp',
      mode: 'detect',
      output: 'canvas',
      ...options
    };
    this.initialized = false;
  }

  /**
   * Warm up the scanner (load WASM, etc.)
   */
  async initialize() {
    if (this.initialized) return;
    await initializeWasm();
    this.initialized = true;
  }

  /**
   * Scan an image for a document.
   * @param {HTMLImageElement|HTMLCanvasElement|ImageData} image 
   * @param {Object} options Override default options
   */
  async scan(image, options = {}) {
    if (!this.initialized) await this.initialize();
    const combinedOptions = { ...this.defaultOptions, ...options };
    return await scanDocument(image, combinedOptions);
  }

  /**
   * Extract a document from an image using manual corners.
   * @param {HTMLImageElement|HTMLCanvasElement|ImageData} image 
   * @param {Object} corners 
   * @param {Object} options 
   */
  async extract(image, corners, options = {}) {
    if (!this.initialized) await this.initialize();
    const combinedOptions = { ...this.defaultOptions, ...options };
    return await extractDocument(image, corners, combinedOptions);
  }
}



/**
 * Prepares image, downscales, and converts to grayscale in a single operation.
 * Uses OffscreenCanvas and CSS filters for maximum performance.
 * @param {HTMLImageElement|HTMLCanvasElement|ImageData} image - Input image
 * @param {number} maxDimension - Maximum dimension for processing (default 800)
 * @returns {Promise<Object>} { grayscaleData, scaleFactor, originalDimensions, scaledDimensions }
 */
async function prepareScaleAndGrayscale(image, maxDimension = 800, preEnhance = 'unsharp') {
  let originalWidth, originalHeight;
  
  // Robust check for ImageData without relying on global ImageData class
  const isImageData = image && typeof image.width === 'number' && typeof image.height === 'number' && image.data;

  // Get original dimensions
  if (isImageData) {
    originalWidth = image.width;
    originalHeight = image.height;
  } else if (image) {
    originalWidth = image.width || image.naturalWidth;
    originalHeight = image.height || image.naturalHeight;
  } else {
    throw new Error('No image provided');
  }
  
  const maxCurrentDimension = Math.max(originalWidth, originalHeight);
  
  // Calculate target dimensions
  let targetWidth, targetHeight, scaleFactor;
  
  if (maxCurrentDimension <= maxDimension) {
    targetWidth = originalWidth;
    targetHeight = originalHeight;
    scaleFactor = 1;
  } else {
    const scale = maxDimension / maxCurrentDimension;
    targetWidth = Math.round(originalWidth * scale);
    targetHeight = Math.round(originalHeight * scale);
    scaleFactor = 1 / scale;
  }
  
  // === Pre-Enhancement Path ===
  // When active, get full-res grayscale and apply fused enhance+downscale (memory efficient)
  const enhanceActive = preEnhance && preEnhance !== 'none' && preEnhance !== false;
  
  if (enhanceActive) {
    const needsDownscale = scaleFactor !== 1;
    
    // Get grayscale at full resolution (for fused ops) or target resolution
    const grabWidth = needsDownscale ? originalWidth : targetWidth;
    const grabHeight = needsDownscale ? originalHeight : targetHeight;
    
    const useOffscreenEnh = typeof OffscreenCanvas !== 'undefined';
    const enhCanvas = useOffscreenEnh
      ? new OffscreenCanvas(grabWidth, grabHeight)
      : document.createElement('canvas');
    if (!useOffscreenEnh) {
      enhCanvas.width = grabWidth;
      enhCanvas.height = grabHeight;
    }
    const enhCtx = enhCanvas.getContext('2d', { willReadFrequently: true });
    enhCtx.filter = 'grayscale(1)';
    enhCtx.imageSmoothingEnabled = true;
    enhCtx.imageSmoothingQuality = 'high';
    
    if (isImageData) {
      const tempCanvas = useOffscreenEnh
        ? new OffscreenCanvas(originalWidth, originalHeight)
        : document.createElement('canvas');
      if (!useOffscreenEnh) {
        tempCanvas.width = originalWidth;
        tempCanvas.height = originalHeight;
      }
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.putImageData(image, 0, 0);
      enhCtx.drawImage(tempCanvas, 0, 0, originalWidth, originalHeight, 0, 0, grabWidth, grabHeight);
    } else {
      enhCtx.drawImage(image, 0, 0, originalWidth, originalHeight, 0, 0, grabWidth, grabHeight);
    }
    
    const enhImgData = enhCtx.getImageData(0, 0, grabWidth, grabHeight);
    const rawGrayscale = new Uint8ClampedArray(grabWidth * grabHeight);
    const enhData = enhImgData.data;
    for (let i = 0, j = 0; i < enhData.length; i += 4, j++) {
      rawGrayscale[j] = enhData[i];
    }
    
    // Get WASM module for enhancement
    let wasmModule = null;
    try {
      await initializeWasm();
      wasmModule = getWasmPreprocessingModule();
    } catch (e) { /* JS fallbacks will be used */ }
    
    let grayscaleData;
    
    if (needsDownscale) {
      // Fused enhancement + downscale (avoids full-res enhanced intermediate)
      if (preEnhance === 'unsharp') {
        const amount = 0.5, radius = 2;
        try {
          if (wasmModule && wasmModule.unsharp_mask_and_downscale) {
            grayscaleData = new Uint8ClampedArray(wasmModule.unsharp_mask_and_downscale(
              rawGrayscale, originalWidth, originalHeight, targetWidth, targetHeight, amount, radius
            ));
          } else { throw new Error('WASM unavailable'); }
        } catch (e) {
          grayscaleData = unsharpMaskAndDownscaleJS(
            rawGrayscale, originalWidth, originalHeight, targetWidth, targetHeight, amount, radius
          );
        }
      } else if (preEnhance === 'clahe') {
        const tileGridX = 8, tileGridY = 8, clipLimit = 3.0;
        try {
          if (wasmModule && wasmModule.clahe_and_downscale) {
            grayscaleData = new Uint8ClampedArray(wasmModule.clahe_and_downscale(
              rawGrayscale, originalWidth, originalHeight, targetWidth, targetHeight, tileGridX, tileGridY, clipLimit
            ));
          } else { throw new Error('WASM unavailable'); }
        } catch (e) {
          // JS fallback: CLAHE at full res, then bilinear downscale
          const enhanced = claheJS(rawGrayscale, originalWidth, originalHeight, tileGridX, tileGridY, clipLimit);
          grayscaleData = bilinearDownscaleGray(enhanced, originalWidth, originalHeight, targetWidth, targetHeight);
        }
      }
    } else {
      // No downscale needed — apply enhancement at current resolution
      if (preEnhance === 'unsharp') {
        try {
          if (wasmModule && wasmModule.unsharp_mask) {
            grayscaleData = new Uint8ClampedArray(wasmModule.unsharp_mask(
              rawGrayscale, grabWidth, grabHeight, 0.5, 2
            ));
          } else { throw new Error('WASM unavailable'); }
        } catch (e) {
          grayscaleData = unsharpMaskJS(rawGrayscale, grabWidth, grabHeight, 0.5, 2);
        }
      } else if (preEnhance === 'clahe') {
        try {
          if (wasmModule && wasmModule.clahe) {
            grayscaleData = new Uint8ClampedArray(wasmModule.clahe(
              rawGrayscale, grabWidth, grabHeight, 8, 8, 3.0
            ));
          } else { throw new Error('WASM unavailable'); }
        } catch (e) {
          grayscaleData = claheJS(rawGrayscale, grabWidth, grabHeight, 8, 8, 3.0);
        }
      }
    }
    
    return {
      grayscaleData,
      imageData: null,
      scaleFactor,
      originalDimensions: { width: originalWidth, height: originalHeight },
      scaledDimensions: { width: targetWidth, height: targetHeight },
      preEnhanceMode: preEnhance
    };
  }
  
  // === Standard Path (no pre-enhancement) ===
  // Use OffscreenCanvas if available (faster, no DOM interaction)
  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas = useOffscreen 
    ? new OffscreenCanvas(targetWidth, targetHeight)
    : document.createElement('canvas');
  
  if (!useOffscreen) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Apply grayscale filter during draw - GPU accelerated!
  ctx.filter = 'grayscale(1)';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  if (isImageData) {
    // For ImageData, need to put on temp canvas first
    const tempCanvas = useOffscreen
      ? new OffscreenCanvas(originalWidth, originalHeight)
      : document.createElement('canvas');
    if (!useOffscreen) {
      tempCanvas.width = originalWidth;
      tempCanvas.height = originalHeight;
    }
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(image, 0, 0);
    ctx.drawImage(tempCanvas, 0, 0, originalWidth, originalHeight, 0, 0, targetWidth, targetHeight);
  } else {
    // Direct draw with scaling + grayscale filter
    ctx.drawImage(image, 0, 0, originalWidth, originalHeight, 0, 0, targetWidth, targetHeight);
  }
  
  // Get the grayscale image data
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  
  // Extract single-channel grayscale (R=G=B after filter, so just take R)
  const grayscaleData = new Uint8ClampedArray(targetWidth * targetHeight);
  const data = imageData.data;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    grayscaleData[j] = data[i]; // R channel (same as G and B after grayscale filter)
  }
  
  return {
    grayscaleData,
    imageData, // Keep full RGBA for debug visualization
    scaleFactor,
    originalDimensions: { width: originalWidth, height: originalHeight },
    scaledDimensions: { width: targetWidth, height: targetHeight },
    preEnhanceMode: 'none'
  };
}

/**
 * Simple bilinear downscale for single-channel grayscale.
 * Used as JS fallback when fused WASM CLAHE+downscale is not available.
 */
function bilinearDownscaleGray(input, srcWidth, srcHeight, dstWidth, dstHeight) {
  const output = new Uint8ClampedArray(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  for (let dy = 0; dy < dstHeight; dy++) {
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = (dx + 0.5) * scaleX - 0.5;
      const sy = (dy + 0.5) * scaleY - 0.5;
      const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const y1 = Math.min(srcHeight - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      output[dy * dstWidth + dx] = Math.round(
        input[y0 * srcWidth + x0] * (1 - fx) * (1 - fy) +
        input[y0 * srcWidth + x1] * fx * (1 - fy) +
        input[y1 * srcWidth + x0] * (1 - fx) * fy +
        input[y1 * srcWidth + x1] * fx * fy
      );
    }
  }
  return output;
}

// Internal function to detect document in image
// Now accepts pre-computed grayscale data (from prepareScaleAndGrayscale)
// Enhanced with CLAHE + adaptive threshold pipeline and Canny fallback
// Collects candidates from ALL strategies and picks the best-scored one
async function detectDocumentInternal(grayscaleData, width, height, scaleFactor, options = {}) {
  // Always create a debug object to collect timings (even if not in debug mode)
  const debugInfo = options.debug ? {} : { _timingsOnly: true };
  const timings = [];
  const useFallback = options.useFallback !== undefined ? options.useFallback : true;
  
  if (debugInfo && !debugInfo._timingsOnly) {
    debugInfo.preprocessing = {
      scaledDimensions: { width, height },
      scaleFactor,
      maxProcessingDimension: options.maxProcessingDimension || 1000
    };
  }

  // Get WASM module for preprocessing
  let wasmModule = null;
  try {
    await initializeWasm();
    wasmModule = getWasmPreprocessingModule();
  } catch (e) {
    // WASM not available, JS fallbacks will be used
  }

  // Shared contour filter options
  const filterOptions = {
    minAreaRatio: options.contourFilter?.minAreaRatio || 0.15,
    maxAreaRatio: options.contourFilter?.maxAreaRatio || 0.98,
    minAngle: options.contourFilter?.angleRange?.[0] || 70,
    maxAngle: options.contourFilter?.angleRange?.[1] || 110,
    epsilon: options.epsilon || 0.02,
    areaWeight: options.contourFilter?.areaWeight || 0.4,
    angleWeight: options.contourFilter?.angleWeight || 0.6,
    minAspectRatio: options.contourFilter?.minAspectRatio || 0.3,
    maxAspectRatio: options.contourFilter?.maxAspectRatio || 3.0,
    epsilonValues: options.contourFilter?.epsilonValues || null,
  };

  // Collect all candidates across strategies with their scores
  const allCandidates = [];
  // Also track raw (unfiltered) contours as fallback
  let fallbackContour = null;

  // ===== STRATEGY 1: Enhanced Pipeline (CLAHE + Adaptive Threshold) =====
  let t0 = performance.now();
  try {
    const preprocessed = preprocessForDocumentDetection(
      grayscaleData, width, height, wasmModule,
      {
        tileGridX: options.clahe?.tileGrid?.[0] || 8,
        tileGridY: options.clahe?.tileGrid?.[1] || 8,
        clipLimit: options.clahe?.clipLimit || 2.0,
        blurKernelSize: options.threshold?.blockSize || 21,
        thresholdOffset: options.threshold?.offset || 12,
        morphKernelSize: options.morphology?.kernelSize || 5,
        morphIterations: options.morphology?.iterations || 2,
        skipClahe: options.preEnhance === 'clahe',
      }
    );
    timings.push({ step: 'CLAHE + Adaptive Threshold', ms: (performance.now() - t0).toFixed(2) });

    // Find contours from preprocessed binary image
    t0 = performance.now();
    const enhancedContours = detectDocumentContour(preprocessed, {
      minArea: (options.minArea || 1000) / (scaleFactor * scaleFactor),
      debug: debugInfo,
      width: width,
      height: height
    });
    timings.push({ step: 'Find Contours (Enhanced)', ms: (performance.now() - t0).toFixed(2) });

    // Use smart contour filtering
    if (enhancedContours && enhancedContours.length > 0) {
      t0 = performance.now();
      const filtered = findDocumentContour(enhancedContours, width, height, filterOptions);
      timings.push({ step: 'Contour Filter (Enhanced)', ms: (performance.now() - t0).toFixed(2) });

      if (filtered) {
        allCandidates.push({ ...filtered, strategy: 'enhanced' });
      }
    }
  } catch (e) {
    timings.push({ step: 'Enhanced Pipeline (failed)', ms: (performance.now() - t0).toFixed(2) });
    console.warn('Enhanced preprocessing pipeline failed:', e);
  }

  // ===== STRATEGY 2: Canny Fallback with lower thresholds =====
  if (useFallback) {
    t0 = performance.now();
    const fallbackLow = options.fallbackCanny?.lowThreshold || 30;
    const fallbackHigh = options.fallbackCanny?.highThreshold || 90;
    
    const edges = await cannyEdgeDetector(grayscaleData, {
      width,
      height,
      lowThreshold: fallbackLow,
      highThreshold: fallbackHigh,
      dilationKernelSize: options.dilationKernelSize || 3,
      dilationIterations: options.dilationIterations || 1,
      debug: debugInfo,
      skipGrayscale: true,
      useWasmBlur: true,
    });
    
    // Extract edge detection timings
    if (debugInfo.timings) {
      debugInfo.timings.forEach(t => {
        if (t.step !== 'Edge Detection Total') timings.push(t);
      });
    }

    const cannyContours = detectDocumentContour(edges, {
      minArea: (options.minArea || 1000) / (scaleFactor * scaleFactor),
      debug: debugInfo,
      width: width,
      height: height
    });
    timings.push({ step: 'Find Contours (Canny Fallback)', ms: (performance.now() - t0).toFixed(2) });

    if (cannyContours && cannyContours.length > 0) {
      const filtered = findDocumentContour(cannyContours, width, height, filterOptions);

      if (filtered) {
        allCandidates.push({ ...filtered, strategy: 'canny-fallback' });
      }
      // Keep largest raw contour as fallback
      if (!fallbackContour) {
        fallbackContour = cannyContours[0];
      }
    }
  }

  // ===== STRATEGY 3: Original Canny with default thresholds (backward compatible) =====
  if (useFallback) {
    t0 = performance.now();
    const edges = await cannyEdgeDetector(grayscaleData, {
      width,
      height,
      lowThreshold: options.lowThreshold || 75,
      highThreshold: options.highThreshold || 200,
      dilationKernelSize: options.dilationKernelSize || 3,
      dilationIterations: options.dilationIterations || 1,
      debug: debugInfo,
      skipGrayscale: true,
      useWasmBlur: true,
    });

    const defaultContours = detectDocumentContour(edges, {
      minArea: (options.minArea || 1000) / (scaleFactor * scaleFactor),
      debug: debugInfo,
      width: width,
      height: height
    });
    timings.push({ step: 'Find Contours (Default Canny)', ms: (performance.now() - t0).toFixed(2) });

    if (defaultContours && defaultContours.length > 0) {
      const filtered = findDocumentContour(defaultContours, width, height, filterOptions);
      if (filtered) {
        allCandidates.push({ ...filtered, strategy: 'canny-default' });
      }
      // Keep largest raw contour as fallback
      if (!fallbackContour) {
        fallbackContour = defaultContours[0];
      }
    }
  }

  // ===== Pick the best candidate across all strategies =====
  let documentContour = null;
  let cornerPoints = null;

  if (allCandidates.length > 0) {
    // Sort by composite score (highest first)
    allCandidates.sort((a, b) => b.score - a.score);
    const best = allCandidates[0];
    documentContour = best.contour;
    timings.push({ step: `Best Strategy: ${best.strategy} (score=${best.score.toFixed(3)})`, ms: '0.00' });
  } else if (fallbackContour) {
    // No candidate passed the filters — use the largest raw contour as a last resort
    documentContour = fallbackContour;
    timings.push({ step: 'Fallback: largest raw contour', ms: '0.00' });
  }

  // ===== No document found =====
  if (!documentContour) {
    console.log('No document detected');
    return {
      success: false,
      message: 'No document detected',
      debug: debugInfo._timingsOnly ? null : debugInfo,
      timings: timings
    };
  }
  
  // Find corner points on the scaled image
  t0 = performance.now();
  cornerPoints = findCornerPoints(documentContour, { 
      epsilon: options.epsilon // Pass epsilon for approximation
  });
  timings.push({ step: 'Corner Detection', ms: (performance.now() - t0).toFixed(2) });
  
  if (!cornerPoints) {
    return {
      success: false,
      message: 'Could not find corner points',
      debug: debugInfo._timingsOnly ? null : debugInfo,
      timings: timings
    };
  }

  // Scale corner points back to original image size
  let finalCorners = cornerPoints;
  if (scaleFactor !== 1) {
    finalCorners = {
      topLeft: { x: cornerPoints.topLeft.x * scaleFactor, y: cornerPoints.topLeft.y * scaleFactor },
      topRight: { x: cornerPoints.topRight.x * scaleFactor, y: cornerPoints.topRight.y * scaleFactor },
      bottomRight: { x: cornerPoints.bottomRight.x * scaleFactor, y: cornerPoints.bottomRight.y * scaleFactor },
      bottomLeft: { x: cornerPoints.bottomLeft.x * scaleFactor, y: cornerPoints.bottomLeft.y * scaleFactor },
    };
  }
  
  // Return the result, scaling the contour points back up as well
  return {
    success: true,
    contour: documentContour,
    corners: finalCorners,
    debug: debugInfo._timingsOnly ? null : debugInfo,
    timings: timings
  };
}

// --- Perspective transform helpers (internal use only) ---
function getPerspectiveTransform(srcPoints, dstPoints) {
  // Helper to build the system of equations
  function buildMatrix(points) {
    const matrix = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = points[i];
      matrix.push([x, y, 1, 0, 0, 0, -x * dstPoints[i][0], -y * dstPoints[i][0]]);
      matrix.push([0, 0, 0, x, y, 1, -x * dstPoints[i][1], -y * dstPoints[i][1]]);
    }
    return matrix;
  }

  const A = buildMatrix(srcPoints);
  const b = [
    dstPoints[0][0], dstPoints[0][1],
    dstPoints[1][0], dstPoints[1][1],
    dstPoints[2][0], dstPoints[2][1],
    dstPoints[3][0], dstPoints[3][1]
  ];

  // Solve Ah = b for h (h is 8x1, last element is 1)
  // Use Gaussian elimination or Cramer's rule for 8x8
  // For simplicity, use numeric.js if available, else implement basic solver
  function solve(A, b) {
    // Gaussian elimination for 8x8
    const m = A.length;
    const n = A[0].length;
    const M = A.map(row => row.slice());
    const B = b.slice();

    for (let i = 0; i < n; i++) {
      // Find max row
      let maxRow = i;
      for (let k = i + 1; k < m; k++) {
        if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
      }
      // Swap rows
      [M[i], M[maxRow]] = [M[maxRow], M[i]];
      [B[i], B[maxRow]] = [B[maxRow], B[i]];

      // Eliminate
      for (let k = i + 1; k < m; k++) {
        const c = M[k][i] / M[i][i];
        for (let j = i; j < n; j++) {
          M[k][j] -= c * M[i][j];
        }
        B[k] -= c * B[i];
      }
    }

    // Back substitution
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = B[i];
      for (let j = i + 1; j < n; j++) {
        sum -= M[i][j] * x[j];
      }
      x[i] = sum / M[i][i];
    }
    return x;
  }

  const h = solve(A, b);
  // h is [h0,h1,h2,h3,h4,h5,h6,h7], h8 = 1
  const matrix = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1]
  ];
  return matrix;
}




function unwarpImage(ctx, image, corners) {
  // Get perspective transform matrix
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;
  // Compute output rectangle size
  const widthA = Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y);
  const widthB = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const maxWidth = Math.round(Math.max(widthA, widthB));
  const heightA = Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y);
  const heightB = Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y);
  const maxHeight = Math.round(Math.max(heightA, heightB));

  // Set output canvas size
  ctx.canvas.width = maxWidth;
  ctx.canvas.height = maxHeight;

  const srcPoints = [
    [topLeft.x, topLeft.y],
    [topRight.x, topRight.y],
    [bottomRight.x, bottomRight.y],
    [bottomLeft.x, bottomLeft.y]
  ];
  const dstPoints = [
    [0, 0],
    [maxWidth - 1, 0],
    [maxWidth - 1, maxHeight - 1],
    [0, maxHeight - 1]
  ];
  const perspectiveMatrix = getPerspectiveTransform(srcPoints, dstPoints);
  warpTransform(ctx, image, perspectiveMatrix, maxWidth, maxHeight);
}

function invert3x3(m) {
  // Invert a 3x3 matrix
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error('Singular matrix');
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det]
  ];
}

function warpTransform(ctx, image, matrix, outWidth, outHeight) {
  // Triangle subdivision approach - uses GPU-accelerated affine transforms
  // Split the quad into a grid, then draw each cell as 2 triangles with affine transforms
  
  const srcWidth = image.width || image.naturalWidth;
  const srcHeight = image.height || image.naturalHeight;
  
  // Inverse matrix for mapping output coords to source coords
  const inv = invert3x3(matrix);
  
  // Helper: map output point to source point using perspective transform
  function mapPoint(x, y) {
    const denom = inv[2][0] * x + inv[2][1] * y + inv[2][2];
    return {
      x: (inv[0][0] * x + inv[0][1] * y + inv[0][2]) / denom,
      y: (inv[1][0] * x + inv[1][1] * y + inv[1][2]) / denom
    };
  }
  
  // Grid subdivisions - 64x64 = 8192 triangles
  const gridX = 64;
  const gridY = 64;
  const cellW = outWidth / gridX;
  const cellH = outHeight / gridY;
  
  // Build source canvas once
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcWidth;
  srcCanvas.height = srcHeight;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(image, 0, 0, srcWidth, srcHeight);
  
  // High quality results
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  // Draw each grid cell as 2 triangles
  ctx.save();
  
  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      // Destination quad corners (in output space)
      const dx0 = gx * cellW;
      const dy0 = gy * cellH;
      const dx1 = (gx + 1) * cellW;
      const dy1 = (gy + 1) * cellH;
      
      // Map to source quad corners
      const s00 = mapPoint(dx0, dy0);
      const s10 = mapPoint(dx1, dy0);
      const s01 = mapPoint(dx0, dy1);
      const s11 = mapPoint(dx1, dy1);
      
      // Draw 2 triangles per cell
      // Triangle 1: top-left, top-right, bottom-left
      drawTexturedTriangle(ctx, srcCanvas,
        s00.x, s00.y, s10.x, s10.y, s01.x, s01.y,  // source triangle
        dx0, dy0, dx1, dy0, dx0, dy1               // dest triangle
      );
      
      // Triangle 2: top-right, bottom-right, bottom-left
      drawTexturedTriangle(ctx, srcCanvas,
        s10.x, s10.y, s11.x, s11.y, s01.x, s01.y,  // source triangle
        dx1, dy0, dx1, dy1, dx0, dy1               // dest triangle
      );
    }
  }
  
  ctx.restore();
}

// Draw a textured triangle using affine transform + clipping
function drawTexturedTriangle(ctx, img,
  sx0, sy0, sx1, sy1, sx2, sy2,  // source triangle coords
  dx0, dy0, dx1, dy1, dx2, dy2   // dest triangle coords
) {
  // Compute affine transform that maps source triangle to dest triangle
  const denom = (sx0 - sx2) * (sy1 - sy2) - (sx1 - sx2) * (sy0 - sy2);
  if (Math.abs(denom) < 1e-10) return; 
  
  const invDenom = 1 / denom;
  const a = ((dx0 - dx2) * (sy1 - sy2) - (dx1 - dx2) * (sy0 - sy2)) * invDenom;
  const b = ((dx1 - dx2) * (sx0 - sx2) - (dx0 - dx2) * (sx1 - sx2)) * invDenom;
  const c = dx0 - a * sx0 - b * sy0;
  
  const d = ((dy0 - dy2) * (sy1 - sy2) - (dy1 - dy2) * (sy0 - sy2)) * invDenom;
  const e = ((dy1 - dy2) * (sx0 - sx2) - (dy0 - dy2) * (sx1 - sx2)) * invDenom;
  const f = dy0 - d * sx0 - e * sy0;
  
  ctx.save();
  
  // SEAM FIX: Robust Centroid-based Expansion
  // We expand the clipping path by 1px in the direction of the triangle's center to ensure overlap.
  const expand = 1.0; 
  const centerX = (dx0 + dx1 + dx2) / 3;
  const centerY = (dy0 + dy1 + dy2) / 3;
  
  const grow = (x, y) => {
    const vx = x - centerX;
    const vy = y - centerY;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len < 1e-6) return { x, y };
    return {
      x: x + (vx / len) * expand,
      y: y + (vy / len) * expand
    };
  };

  const p0 = grow(dx0, dy0);
  const p1 = grow(dx1, dy1);
  const p2 = grow(dx2, dy2);

  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.clip();
  
  ctx.setTransform(a, d, b, e, c, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}


/**
 * Extract document with manual corner points (no detection).
 * @param {HTMLImageElement|HTMLCanvasElement|ImageData} image
 * @param {Object} corners - Corner points object with topLeft, topRight, bottomRight, bottomLeft
 * @param {Object} options
 *   - output: 'canvas' | 'imagedata' | 'dataurl' (default: 'canvas')
 * @returns {Promise<{output, corners, success, message}>}
 */
export async function extractDocument(image, corners, options = {}) {
  const outputType = options.output || 'canvas';

  if (!corners || !corners.topLeft || !corners.topRight || !corners.bottomRight || !corners.bottomLeft) {
    return {
      output: null,
      corners: null,
      success: false,
      message: 'Invalid corner points provided'
    };
  }

  try {
    // Create result canvas and extract document
    const resultCanvas = document.createElement('canvas');
    const ctx = resultCanvas.getContext('2d');
    unwarpImage(ctx, image, corners);

    let output;
    // Prepare output in requested format
    if (outputType === 'canvas') {
      output = resultCanvas;
    } else if (outputType === 'imagedata') {
      output = resultCanvas.getContext('2d').getImageData(0, 0, resultCanvas.width, resultCanvas.height);
    } else if (outputType === 'dataurl') {
      output = resultCanvas.toDataURL();
    } else {
      output = resultCanvas;
    }

    return {
      output,
      corners,
      success: true,
      message: 'Document extracted successfully'
    };
  } catch (error) {
    return {
      output: null,
      corners,
      success: false,
      message: `Extraction failed: ${error.message}`
    };
  }
}

/**
 * Main entry point for document scanning.
 * @param {HTMLImageElement|HTMLCanvasElement|ImageData} image
 * @param {Object} options
 *   - mode: 'detect' | 'extract' (default: 'detect')
 *   - output: 'canvas' | 'imagedata' | 'dataurl' (default: 'canvas')
 *   - debug: boolean
 *   - ...other detection options
 * @returns {Promise<{output, corners, contour, debug, success, message, timings}>}
 */
export async function scanDocument(image, options = {}) {
  const timings = [];
  const totalStart = performance.now();
  
  const mode = options.mode || 'detect';
  const outputType = options.output || 'canvas';
  const debug = !!options.debug;
  const maxProcessingDimension = options.maxProcessingDimension || 2000;
  const preEnhance = options.preEnhance !== undefined ? options.preEnhance : 'unsharp';

  // Combined image preparation + downscaling + grayscale (with optional pre-enhancement)
  let t0 = performance.now();
  const { grayscaleData, imageData, scaleFactor, originalDimensions, scaledDimensions, preEnhanceMode } = 
    await prepareScaleAndGrayscale(image, maxProcessingDimension, preEnhance);
  timings.push({ step: 'Image Prep + Scale + Gray', ms: (performance.now() - t0).toFixed(2) });

  // Detect document (pass pre-computed grayscale data)
  const detection = await detectDocumentInternal(
    grayscaleData, 
    scaledDimensions.width, 
    scaledDimensions.height, 
    scaleFactor, 
    options
  );
  
  // Merge detailed detection timings
  if (detection.timings) {
    detection.timings.forEach(t => timings.push(t));
  }
  
  if (!detection.success) {
    const totalEnd = performance.now();
    timings.unshift({ step: 'Total', ms: (totalEnd - totalStart).toFixed(2) });
    console.table(timings);
    return {
      output: null,
      corners: null,
      contour: null,
      debug: detection.debug,
      success: false,
      message: detection.message || 'No document detected',
      timings
    };
  }

  let resultCanvas;
  let output;

  if (mode === 'detect') {
    // Just return detection info, no image processing
    output = null;
  } else if (mode === 'extract') {
    // Return only the cropped/warped document
    t0 = performance.now();
    resultCanvas = document.createElement('canvas');
    const ctx = resultCanvas.getContext('2d');
    unwarpImage(ctx, image, detection.corners);
    timings.push({ step: 'Perspective Transform', ms: (performance.now() - t0).toFixed(2) });
  }

  // Prepare output in requested format (only if not detect mode)
  if (mode !== 'detect' && resultCanvas) {
    t0 = performance.now();
    if (outputType === 'canvas') {
      output = resultCanvas;
    } else if (outputType === 'imagedata') {
      output = resultCanvas.getContext('2d').getImageData(0, 0, resultCanvas.width, resultCanvas.height);
    } else if (outputType === 'dataurl') {
      output = resultCanvas.toDataURL();
    } else {
      output = resultCanvas;
    }
    timings.push({ step: 'Output Conversion', ms: (performance.now() - t0).toFixed(2) });
  }

  const totalEnd = performance.now();
  timings.unshift({ step: 'Total', ms: (totalEnd - totalStart).toFixed(2) });
  console.table(timings);

  return {
    output,
    corners: detection.corners,
    contour: detection.contour,
    debug: detection.debug,
    success: true,
    message: 'Document detected',
    timings
  };
}