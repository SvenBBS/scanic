/**
 * Preprocessing pipeline for enhanced document detection.
 * Implements CLAHE + Adaptive Thresholding + Morphological Close
 * with JS fallbacks for when WASM is not available.
 */

/**
 * Run the enhanced preprocessing pipeline for document detection.
 * @param {Uint8ClampedArray} grayscale - Grayscale image (1 byte per pixel)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} wasmModule - WASM module with clahe, blur, adaptive_threshold, morphological_close
 * @param {Object} options - Configuration options
 * @returns {Uint8ClampedArray} Binary image (0 or 255)
 */
export function preprocessForDocumentDetection(grayscale, width, height, wasmModule, options = {}) {
  const {
    tileGridX = 8,
    tileGridY = 8,
    clipLimit = 3.0,
    blurKernelSize = 21,
    thresholdOffset = 12,
    morphKernelSize = 5,
    morphIterations = 2,
    skipClahe = false,
  } = options;

  let enhanced, blurred, binary, closed;

  try {
    // 1. CLAHE – contrast enhancement (skip if already applied as pre-enhancement)
    if (skipClahe) {
      enhanced = grayscale;
    } else if (wasmModule && wasmModule.clahe) {
      enhanced = wasmModule.clahe(grayscale, width, height, tileGridX, tileGridY, clipLimit);
    } else {
      enhanced = claheJS(grayscale, width, height, tileGridX, tileGridY, clipLimit);
    }

    // 2. Gaussian Blur (large kernel for adaptive thresholding)
    if (wasmModule && wasmModule.blur) {
      blurred = wasmModule.blur(enhanced, width, height, blurKernelSize, 0);
    } else {
      blurred = boxBlurJS(enhanced, width, height, blurKernelSize);
    }

    // 3. Adaptive Thresholding
    if (wasmModule && wasmModule.adaptive_threshold) {
      binary = wasmModule.adaptive_threshold(enhanced, blurred, width, height, thresholdOffset, true);
    } else {
      binary = adaptiveThresholdJS(enhanced, blurred, width, height, thresholdOffset, true);
    }

    // 4. Morphological Close (dilate → erode to close gaps)
    if (wasmModule && wasmModule.morphological_close) {
      closed = wasmModule.morphological_close(binary, width, height, morphKernelSize, morphIterations);
    } else {
      closed = morphologicalCloseJS(binary, width, height, morphKernelSize, morphIterations);
    }

    return new Uint8ClampedArray(closed);
  } catch (e) {
    console.warn('Enhanced preprocessing failed, using JS fallbacks:', e);
    // Full JS fallback path
    enhanced = claheJS(grayscale, width, height, tileGridX, tileGridY, clipLimit);
    blurred = boxBlurJS(enhanced, width, height, blurKernelSize);
    binary = adaptiveThresholdJS(enhanced, blurred, width, height, thresholdOffset, true);
    closed = morphologicalCloseJS(binary, width, height, morphKernelSize, morphIterations);
    return new Uint8ClampedArray(closed);
  }
}

// ============================================================
// Pure JavaScript fallback implementations
// ============================================================

/**
 * CLAHE in pure JavaScript (~200 lines, functional but slower than WASM)
 */
export function claheJS(input, width, height, tileGridX = 8, tileGridY = 8, clipLimit = 3.0) {
  const pixelCount = width * height;
  const tileWidth = Math.floor(width / tileGridX);
  const tileHeight = Math.floor(height / tileGridY);
  const tilePixels = tileWidth * tileHeight;

  // Actual clip limit per histogram bin
  const actualClip = clipLimit > 0
    ? Math.max(1, Math.floor((clipLimit * tilePixels) / 256))
    : Infinity;

  const numTiles = tileGridX * tileGridY;
  // Store CDFs: each tile gets 256 mapped values
  const tileCDFs = new Uint8Array(numTiles * 256);

  for (let ty = 0; ty < tileGridY; ty++) {
    for (let tx = 0; tx < tileGridX; tx++) {
      const tileIdx = ty * tileGridX + tx;

      // Compute histogram
      const hist = new Uint32Array(256);
      const yStart = ty * tileHeight;
      const xStart = tx * tileWidth;
      const yEnd = ty === tileGridY - 1 ? height : yStart + tileHeight;
      const xEnd = tx === tileGridX - 1 ? width : xStart + tileWidth;
      const actualTilePixels = (yEnd - yStart) * (xEnd - xStart);

      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          hist[input[y * width + x]]++;
        }
      }

      // Clip and redistribute
      if (actualClip < Infinity) {
        let excess = 0;
        for (let i = 0; i < 256; i++) {
          if (hist[i] > actualClip) {
            excess += hist[i] - actualClip;
            hist[i] = actualClip;
          }
        }
        const perBin = Math.floor(excess / 256);
        const remainder = excess % 256;
        for (let i = 0; i < 256; i++) {
          hist[i] += perBin;
          if (i < remainder) hist[i]++;
        }
      }

      // Compute CDF
      const cdf = new Uint32Array(256);
      cdf[0] = hist[0];
      for (let i = 1; i < 256; i++) {
        cdf[i] = cdf[i - 1] + hist[i];
      }

      // Map CDF to [0, 255]
      let cdfMin = 0;
      for (let i = 0; i < 256; i++) {
        if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
      }
      const denom = actualTilePixels - cdfMin;

      const offset = tileIdx * 256;
      if (denom > 0) {
        for (let i = 0; i < 256; i++) {
          tileCDFs[offset + i] = Math.round(Math.max(0, Math.min(255,
            ((cdf[i] - cdfMin) / denom) * 255
          )));
        }
      } else {
        for (let i = 0; i < 256; i++) {
          tileCDFs[offset + i] = i;
        }
      }
    }
  }

  // Bilinear interpolation
  const output = new Uint8ClampedArray(pixelCount);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelVal = input[y * width + x];

      const fy = (y / tileHeight) - 0.5;
      const fx = (x / tileWidth) - 0.5;

      const fyClamped = Math.max(0, Math.min(tileGridY - 1, fy));
      const fxClamped = Math.max(0, Math.min(tileGridX - 1, fx));

      const ty0 = Math.floor(fyClamped);
      const tx0 = Math.floor(fxClamped);
      const ty1 = Math.min(ty0 + 1, tileGridY - 1);
      const tx1 = Math.min(tx0 + 1, tileGridX - 1);

      const wy = fyClamped - ty0;
      const wx = fxClamped - tx0;

      const v00 = tileCDFs[(ty0 * tileGridX + tx0) * 256 + pixelVal];
      const v10 = tileCDFs[(ty0 * tileGridX + tx1) * 256 + pixelVal];
      const v01 = tileCDFs[(ty1 * tileGridX + tx0) * 256 + pixelVal];
      const v11 = tileCDFs[(ty1 * tileGridX + tx1) * 256 + pixelVal];

      const top = v00 * (1 - wx) + v10 * wx;
      const bottom = v01 * (1 - wx) + v11 * wx;
      const result = top * (1 - wy) + bottom * wy;

      output[y * width + x] = Math.round(result);
    }
  }

  return output;
}

/**
 * Simple box blur as a fallback for Gaussian blur (for adaptive thresholding)
 */
export function boxBlurJS(input, width, height, kernelSize) {
  const halfK = Math.floor(kernelSize / 2);
  const pixelCount = width * height;
  const temp = new Uint8ClampedArray(pixelCount);
  const output = new Uint8ClampedArray(pixelCount);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let k = -halfK; k <= halfK; k++) {
        const nx = Math.max(0, Math.min(width - 1, x + k));
        sum += input[rowOffset + nx];
        count++;
      }
      temp[rowOffset + x] = Math.round(sum / count);
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      for (let k = -halfK; k <= halfK; k++) {
        const ny = Math.max(0, Math.min(height - 1, y + k));
        sum += temp[ny * width + x];
        count++;
      }
      output[y * width + x] = Math.round(sum / count);
    }
  }

  return output;
}

/**
 * Adaptive thresholding in pure JS
 */
export function adaptiveThresholdJS(input, blurred, width, height, offset = 12, invert = true) {
  const pixelCount = width * height;
  const output = new Uint8ClampedArray(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const threshold = blurred[i] - offset;
    const above = input[i] > threshold;
    output[i] = (above !== invert) ? 255 : 0;
  }

  return output;
}

/**
 * Morphological close in pure JS (dilate then erode)
 */
export function morphologicalCloseJS(input, width, height, kernelSize = 5, iterations = 2) {
  let current = input;

  for (let iter = 0; iter < iterations; iter++) {
    // Dilate (max filter)
    current = dilateJS(current, width, height, kernelSize);
    // Erode (min filter)
    current = erodeJS(current, width, height, kernelSize);
  }

  return current;
}

function dilateJS(input, width, height, kernelSize) {
  const halfK = Math.floor(kernelSize / 2);
  const pixelCount = width * height;
  const temp = new Uint8ClampedArray(pixelCount);
  const output = new Uint8ClampedArray(pixelCount);

  // Horizontal max
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let maxVal = 0;
      for (let k = -halfK; k <= halfK; k++) {
        const nx = Math.max(0, Math.min(width - 1, x + k));
        if (input[rowOffset + nx] > maxVal) maxVal = input[rowOffset + nx];
      }
      temp[rowOffset + x] = maxVal;
    }
  }

  // Vertical max
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let maxVal = 0;
      for (let k = -halfK; k <= halfK; k++) {
        const ny = Math.max(0, Math.min(height - 1, y + k));
        if (temp[ny * width + x] > maxVal) maxVal = temp[ny * width + x];
      }
      output[y * width + x] = maxVal;
    }
  }

  return output;
}

/**
 * Unsharp mask in pure JavaScript (fallback for WASM).
 * Uses separable box blur as approximation for Gaussian blur.
 * Formula: output = clamp(original + amount * (original - blurred))
 * @param {Uint8ClampedArray} input - Grayscale image (1 byte per pixel)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} amount - Sharpening strength (e.g. 0.5 = moderate, 1.0 = strong)
 * @param {number} radius - Blur radius (kernel size = 2*radius+1)
 * @returns {Uint8ClampedArray} Sharpened grayscale image
 */
export function unsharpMaskJS(input, width, height, amount = 0.5, radius = 2) {
  const kernelSize = 2 * radius + 1;
  const blurred = boxBlurJS(input, width, height, kernelSize);
  const pixelCount = width * height;
  const output = new Uint8ClampedArray(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const val = input[i] + amount * (input[i] - blurred[i]);
    output[i] = val < 0 ? 0 : val > 255 ? 255 : Math.round(val);
  }

  return output;
}

/**
 * Unsharp mask + downscale in pure JavaScript (fallback for fused WASM op).
 * For each output pixel, maps back to source, computes local blur, applies unsharp.
 * @param {Uint8ClampedArray} input - Full-resolution grayscale image
 * @param {number} srcWidth - Source width
 * @param {number} srcHeight - Source height
 * @param {number} targetWidth - Target (downscaled) width
 * @param {number} targetHeight - Target (downscaled) height
 * @param {number} amount - Sharpening strength
 * @param {number} radius - Blur radius
 * @returns {Uint8ClampedArray} Sharpened + downscaled grayscale image
 */
export function unsharpMaskAndDownscaleJS(input, srcWidth, srcHeight, targetWidth, targetHeight, amount = 0.5, radius = 2) {
  const output = new Uint8ClampedArray(targetWidth * targetHeight);
  const scaleX = srcWidth / targetWidth;
  const scaleY = srcHeight / targetHeight;

  for (let oy = 0; oy < targetHeight; oy++) {
    for (let ox = 0; ox < targetWidth; ox++) {
      // Map output pixel to source coordinates
      const sx = (ox + 0.5) * scaleX - 0.5;
      const sy = (oy + 0.5) * scaleY - 0.5;

      // Bilinear sample from source for the "original" value
      const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const y1 = Math.min(srcHeight - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const original =
        input[y0 * srcWidth + x0] * (1 - fx) * (1 - fy) +
        input[y0 * srcWidth + x1] * fx * (1 - fy) +
        input[y1 * srcWidth + x0] * (1 - fx) * fy +
        input[y1 * srcWidth + x1] * fx * fy;

      // Compute local box blur around source location
      const bx = Math.round(sx);
      const by = Math.round(sy);
      let sum = 0;
      let count = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        const cy = Math.max(0, Math.min(srcHeight - 1, by + ky));
        for (let kx = -radius; kx <= radius; kx++) {
          const cx = Math.max(0, Math.min(srcWidth - 1, bx + kx));
          sum += input[cy * srcWidth + cx];
          count++;
        }
      }
      const blurred = sum / count;

      // Apply unsharp mask
      const val = original + amount * (original - blurred);
      output[oy * targetWidth + ox] = val < 0 ? 0 : val > 255 ? 255 : Math.round(val);
    }
  }

  return output;
}

function erodeJS(input, width, height, kernelSize) {
  const halfK = Math.floor(kernelSize / 2);
  const pixelCount = width * height;
  const temp = new Uint8ClampedArray(pixelCount);
  const output = new Uint8ClampedArray(pixelCount);
  temp.fill(255);
  output.fill(255);

  // Horizontal min
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let minVal = 255;
      for (let k = -halfK; k <= halfK; k++) {
        const nx = Math.max(0, Math.min(width - 1, x + k));
        if (input[rowOffset + nx] < minVal) minVal = input[rowOffset + nx];
      }
      temp[rowOffset + x] = minVal;
    }
  }

  // Vertical min
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let minVal = 255;
      for (let k = -halfK; k <= halfK; k++) {
        const ny = Math.max(0, Math.min(height - 1, y + k));
        if (temp[ny * width + x] < minVal) minVal = temp[ny * width + x];
      }
      output[y * width + x] = minVal;
    }
  }

  return output;
}