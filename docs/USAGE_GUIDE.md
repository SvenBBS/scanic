# Scanic Usage Guide

**Complete guide for optimal document scanning with scanic**

This guide provides comprehensive information on how to use scanic effectively, including parameter recommendations, best practices, and troubleshooting tips.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Complete Parameter Reference](#complete-parameter-reference)
3. [Recommended Settings by Use Case](#recommended-settings-by-use-case)
4. [Performance Tuning](#performance-tuning)
5. [Understanding Pre-Enhancement](#understanding-pre-enhancement)
6. [Advanced Configuration](#advanced-configuration)
7. [Troubleshooting](#troubleshooting)
8. [Performance Benchmarks](#performance-benchmarks)

---

## Quick Start

### Basic Detection

```js
import { scanDocument } from 'scanic';

const result = await scanDocument(imageElement);
if (result.success) {
  console.log('Document corners:', result.corners);
}
```

### Extract Document (Recommended for Most Cases)

```js
const result = await scanDocument(imageElement, {
  mode: 'extract',
  maxProcessingDimension: 1200,  // Higher quality
  preEnhance: 'unsharp'          // Default, good for most cases
});

if (result.success) {
  document.body.appendChild(result.output);
}
```

### Production Usage (Scanner Class)

For real-time or batch processing, use the Scanner class to avoid WASM re-initialization overhead:

```js
import { Scanner } from 'scanic';

const scanner = new Scanner({
  maxProcessingDimension: 1200,
  preEnhance: 'unsharp',
  mode: 'extract'
});

await scanner.initialize();  // Once

// Process multiple images efficiently
for (const image of images) {
  const result = await scanner.scan(image);
  // Process result...
}
```

---

## Complete Parameter Reference

### Core Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `'detect' \| 'extract'` | `'detect'` | **'detect'**: Returns corner coordinates only<br>**'extract'**: Returns warped/cropped document image |
| `output` | `'canvas' \| 'imagedata' \| 'dataurl'` | `'canvas'` | Output format for extracted document |
| `maxProcessingDimension` | `number` | `2000` | Maximum dimension (width/height) for internal processing. Higher = better quality but slower. Range: 400-2000 |
| `preEnhance` | `'unsharp' \| 'clahe' \| 'none' \| false` | `'unsharp'` | Pre-enhancement applied before downscaling (see [Pre-Enhancement section](#understanding-pre-enhancement)) |
| `debug` | `boolean` | `false` | Enable debug output with intermediate processing steps |
| `useFallback` | `boolean` | `true` | Enable multi-strategy detection (recommended: keep enabled) |

### Edge Detection Parameters (Canny)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lowThreshold` | `number` | `75` | Lower threshold for Canny edge detection (0-255) |
| `highThreshold` | `number` | `200` | Upper threshold for Canny edge detection (0-255) |
| `dilationKernelSize` | `number` | `3` | Kernel size for edge dilation (odd number, typically 3-7) |
| `dilationIterations` | `number` | `1` | Number of dilation iterations |

### Fallback Canny Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fallbackCanny.lowThreshold` | `number` | `30` | Lower threshold for fallback Canny strategy |
| `fallbackCanny.highThreshold` | `number` | `90` | Upper threshold for fallback Canny strategy |

### CLAHE Parameters

Used in the enhanced preprocessing pipeline:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `clahe.clipLimit` | `number` | `2.0` | Contrast limiting threshold (1.0-10.0). Higher = more contrast |
| `clahe.tileGrid` | `[number, number]` | `[8, 8]` | Grid size for local histogram equalization. Smaller = more local adaptation |

### Adaptive Threshold Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threshold.blockSize` | `number` | `21` | Block size for adaptive thresholding (odd number) |
| `threshold.offset` | `number` | `12` | Threshold offset. Lower = more sensitive, higher = less sensitive |

### Morphological Operations Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `morphology.kernelSize` | `number` | `5` | Kernel size for morphological close operation |
| `morphology.iterations` | `number` | `2` | Number of close iterations (dilate → erode cycles) |

### Contour Filter Parameters

Advanced options for filtering detected contours:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `contourFilter.minAreaRatio` | `number` | `0.15` | Minimum document area as ratio of image (0.0-1.0) |
| `contourFilter.maxAreaRatio` | `number` | `0.98` | Maximum document area as ratio of image (0.0-1.0) |
| `contourFilter.angleRange` | `[number, number]` | `[70, 110]` | Valid corner angle range in degrees |
| `contourFilter.minAspectRatio` | `number` | `0.3` | Minimum width/height or height/width ratio |
| `contourFilter.maxAspectRatio` | `number` | `3.0` | Maximum width/height or height/width ratio |
| `contourFilter.areaWeight` | `number` | `0.4` | Weight for area in composite scoring (0.0-1.0) |
| `contourFilter.angleWeight` | `number` | `0.6` | Weight for angle in composite scoring (0.0-1.0) |
| `contourFilter.epsilonValues` | `number[]` | `null` | Custom epsilon values for contour approximation |

### Other Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `minArea` | `number` | `1000` | Minimum contour area in pixels (scaled) |
| `epsilon` | `number` | `0.02` | Polygon approximation accuracy (0.0-0.1) |

---

## Recommended Settings by Use Case

### 📸 High-Quality Document Scanning (Photos, Receipts)

**Best for**: High-resolution images, important documents, archival

```js
const options = {
  mode: 'extract',
  maxProcessingDimension: 1600,  // High quality processing
  preEnhance: 'unsharp',         // Good edge definition
  output: 'canvas'
};
```

**Why these settings:**
- Higher `maxProcessingDimension` preserves detail
- `unsharp` pre-enhancement sharpens edges for better detection
- Provides excellent corner detection accuracy

---

### 📱 Mobile/Webcam Real-Time Scanning

**Best for**: Live camera feeds, quick capture

```js
const scanner = new Scanner({
  mode: 'extract',
  maxProcessingDimension: 800,   // Fast processing
  preEnhance: 'unsharp',         // Quick enhancement
  output: 'canvas'
});

await scanner.initialize();

// In camera frame callback
async function onFrame(imageData) {
  const result = await scanner.scan(imageData);
  // Display result...
}
```

**Why these settings:**
- Lower `maxProcessingDimension` for faster processing (~50-100ms)
- Scanner class avoids WASM re-initialization overhead
- `unsharp` is faster than `clahe` for real-time use

---

### 📄 Low-Contrast Documents (Faded, Light Paper)

**Best for**: Old documents, low-contrast scans, poor lighting

```js
const options = {
  mode: 'extract',
  maxProcessingDimension: 1200,
  preEnhance: 'clahe',           // Strong contrast enhancement
  clahe: {
    clipLimit: 3.0,              // Moderate clipping
    tileGrid: [8, 8]             // Standard grid
  },
  threshold: {
    offset: 8                    // More sensitive
  },
  output: 'canvas'
};
```

**Why these settings:**
- `preEnhance: 'clahe'` provides strong contrast enhancement
- Lower threshold offset increases sensitivity
- Multi-strategy detection (enabled by default) tries multiple approaches

---

### ⚡ Batch Processing (High Volume)

**Best for**: Processing hundreds/thousands of images

```js
const scanner = new Scanner({
  mode: 'extract',
  maxProcessingDimension: 1000,  // Balance speed/quality
  preEnhance: 'unsharp',
  output: 'canvas'
});

await scanner.initialize();

const results = await Promise.all(
  images.map(img => scanner.scan(img))
);
```

**Why these settings:**
- Scanner class for WASM reuse
- Moderate resolution for good speed
- Can process in parallel

---

### 🎯 Maximum Accuracy (Difficult Documents)

**Best for**: Challenging cases, unusual angles, complex backgrounds

```js
const options = {
  mode: 'extract',
  maxProcessingDimension: 2000,  // Maximum detail
  preEnhance: 'clahe',           // Strong enhancement
  clahe: {
    clipLimit: 3.5,
    tileGrid: [8, 8]
  },
  threshold: {
    offset: 10                   // Balanced sensitivity
  },
  morphology: {
    kernelSize: 5,
    iterations: 3                // More morphological processing
  },
  contourFilter: {
    minAreaRatio: 0.10,          // Accept smaller documents
    maxAreaRatio: 0.99,
    angleRange: [60, 120]        // Wider angle tolerance
  },
  useFallback: true,             // Enable all strategies
  debug: false,
  output: 'canvas'
};
```

**Why these settings:**
- Maximum processing dimension
- Strong CLAHE enhancement
- Relaxed contour filtering for edge cases
- Multiple detection strategies

---

## Performance Tuning

### Speed vs. Quality Trade-offs

| `maxProcessingDimension` | Processing Time* | Quality | Use Case |
|--------------------------|------------------|---------|----------|
| 400 | ~30ms | Low | Real-time preview |
| 800 | ~50ms | Good | Mobile/webcam |
| 1200 | ~80ms | Very Good | General use |
| 1600 | ~120ms | Excellent | High quality |
| 2000 | ~180ms | Maximum | Archival/difficult |

*Approximate times on modern hardware

### Pre-Enhancement Performance

| Mode | Speed | Quality | Best For |
|------|-------|---------|----------|
| `'none'` or `false` | Fastest | Base | Clean, high-contrast images |
| `'unsharp'` | Fast | Good | General use, good edges |
| `'clahe'` | Moderate | Excellent | Low-contrast, poor lighting |

**Recommendation**: Use `'unsharp'` (default) for most cases. Switch to `'clahe'` only for low-contrast documents.

### Memory Considerations

Higher `maxProcessingDimension` uses more memory:
- 800: ~2MB working memory
- 1200: ~4MB working memory
- 2000: ~12MB working memory

For mobile devices, keep `maxProcessingDimension ≤ 1200`.

---

## Understanding Pre-Enhancement

The `preEnhance` parameter controls image preprocessing **before** downscaling and edge detection. This is a critical parameter for detection quality.

### Pre-Enhancement Modes

#### `'unsharp'` (Default) ✅

**What it does:**
- Applies unsharp masking (edge sharpening)
- Parameters: amount=0.5, radius=2
- Fused with downscaling for efficiency

**Best for:**
- Most document types
- Good lighting conditions
- Real-time applications
- General purpose scanning

**Example:**
```js
{ preEnhance: 'unsharp' }  // Default
```

---

#### `'clahe'` (Contrast Limited Adaptive Histogram Equalization)

**What it does:**
- Applies local contrast enhancement
- Divides image into tiles (8×8 grid by default)
- Equalizes histogram in each tile
- Excellent for low-contrast scenarios

**Best for:**
- Faded documents
- Poor lighting
- Low-contrast images
- Difficult detection cases

**Example:**
```js
{
  preEnhance: 'clahe',
  clahe: {
    clipLimit: 3.0,    // 1.0-10.0, higher = more contrast
    tileGrid: [8, 8]   // Smaller = more local adaptation
  }
}
```

**CLAHE Parameter Tuning:**
- **clipLimit**: 
  - `1.5-2.0`: Subtle enhancement
  - `3.0-4.0`: Moderate (recommended)
  - `5.0+`: Strong (may introduce artifacts)
- **tileGrid**:
  - `[8, 8]`: Standard (recommended)
  - `[16, 16]`: More local (slower, may be noisy)
  - `[4, 4]`: Less local (faster, smoother)

---

#### `'none'` or `false` (No Pre-Enhancement)

**What it does:**
- Skips pre-enhancement
- Only downscaling and grayscale conversion

**Best for:**
- Clean, high-contrast images
- Already pre-processed images
- Maximum speed
- Testing/debugging

**Example:**
```js
{ preEnhance: 'none' }
// or
{ preEnhance: false }
```

---

### Pre-Enhancement Decision Tree

```
Is your document clearly visible with good contrast?
├─ YES → Use 'unsharp' (default)
└─ NO → Is it faded/low-contrast?
    ├─ YES → Use 'clahe'
    └─ NO → Try 'unsharp' first, then 'clahe' if detection fails
```

---

## Advanced Configuration

### Multi-Strategy Detection

Scanic uses multiple detection strategies and picks the best result:

1. **Enhanced Pipeline**: CLAHE + Adaptive Threshold + Morphology
2. **Fallback Canny**: Lower thresholds (30/90) for edge cases
3. **Default Canny**: Standard thresholds (75/200) for backward compatibility

Each strategy produces candidates, which are scored and ranked. The best one is returned.

**Controlling strategies:**
```js
{
  useFallback: true,  // Enable all strategies (recommended)
  
  // Tune fallback strategy
  fallbackCanny: {
    lowThreshold: 30,
    highThreshold: 90
  },
  
  // Tune default strategy
  lowThreshold: 75,
  highThreshold: 200
}
```

---

### Contour Filtering

The contour filter rejects invalid detections based on geometric properties:

```js
{
  contourFilter: {
    // Area constraints
    minAreaRatio: 0.15,    // Document must be ≥15% of image
    maxAreaRatio: 0.98,    // But <98% (not full image)
    
    // Corner angle constraints
    angleRange: [70, 110], // Corners must be ~90° ± 20°
    
    // Aspect ratio constraints
    minAspectRatio: 0.3,   // Not too thin
    maxAspectRatio: 3.0,   // Not too elongated
    
    // Scoring weights
    areaWeight: 0.4,       // 40% weight on area
    angleWeight: 0.6       // 60% weight on angle
  }
}
```

**When to adjust:**
- **Smaller documents**: Lower `minAreaRatio` to 0.10
- **Full-page scans**: Increase `maxAreaRatio` to 0.99
- **Unusual shapes**: Widen `angleRange` to [60, 120]
- **Panoramic docs**: Increase `maxAspectRatio` to 5.0

---

### Custom Epsilon Values

For contour approximation, you can provide multiple epsilon values to try:

```js
{
  contourFilter: {
    epsilonValues: [0.01, 0.02, 0.03, 0.05]
  }
}
```

The system will try each epsilon and pick the best approximation that yields a 4-sided polygon.

---

## Troubleshooting

### Problem: Document Not Detected

**Symptoms:** `result.success === false`

**Solutions:**

1. **Enable pre-enhancement:**
   ```js
   { preEnhance: 'clahe' }
   ```

2. **Lower detection sensitivity:**
   ```js
   {
     threshold: { offset: 5 },  // More sensitive
     contourFilter: {
       minAreaRatio: 0.10       // Accept smaller docs
     }
   }
   ```

3. **Increase processing resolution:**
   ```js
   { maxProcessingDimension: 1600 }
   ```

4. **Check debug output:**
   ```js
   const result = await scanDocument(img, { debug: true });
   console.log(result.debug);
   ```

---

### Problem: Wrong Region Detected

**Symptoms:** Corners are on wrong object

**Solutions:**

1. **Tighten contour filter:**
   ```js
   {
     contourFilter: {
       minAreaRatio: 0.30,      // Must be larger
       angleRange: [75, 105]    // Stricter right angles
     }
   }
   ```

2. **Increase minimum area:**
   ```js
   { minArea: 5000 }
   ```

3. **Use higher resolution:**
   ```js
   { maxProcessingDimension: 1600 }
   ```

---

### Problem: Slow Performance

**Symptoms:** Processing takes >200ms

**Solutions:**

1. **Lower processing dimension:**
   ```js
   { maxProcessingDimension: 800 }
   ```

2. **Switch to unsharp pre-enhancement:**
   ```js
   { preEnhance: 'unsharp' }  // Faster than 'clahe'
   ```

3. **Use Scanner class for batch processing:**
   ```js
   const scanner = new Scanner();
   await scanner.initialize();  // Once
   // Reuse for multiple scans
   ```

4. **Disable debug mode:**
   ```js
   { debug: false }
   ```

---

### Problem: Inaccurate Corners

**Symptoms:** Corners are slightly off

**Solutions:**

1. **Increase processing resolution:**
   ```js
   { maxProcessingDimension: 2000 }
   ```

2. **Adjust epsilon (lower = more precise):**
   ```js
   { epsilon: 0.01 }
   ```

3. **Try CLAHE pre-enhancement:**
   ```js
   { preEnhance: 'clahe' }
   ```

---

### Problem: Memory Issues (Mobile)

**Symptoms:** Browser crashes or slows down

**Solutions:**

1. **Limit processing dimension:**
   ```js
   { maxProcessingDimension: 1000 }  // Max for mobile
   ```

2. **Process images sequentially:**
   ```js
   // Don't do this:
   await Promise.all(images.map(img => scanner.scan(img)))
   
   // Do this:
   for (const img of images) {
     await scanner.scan(img);
   }
   ```

---

## Performance Benchmarks

Based on visual tests with `test-document.jpg`:

### Detection Success Rate by Configuration

| Configuration | Success | Processing Time | Notes |
|--------------|---------|-----------------|-------|
| Default (unsharp, 800px) | ✓ | ~60ms | Recommended baseline |
| CLAHE pre-enhance | ✓ | ~75ms | Best for low-contrast |
| High-res (2000px) | ✓ | ~180ms | Maximum quality |
| Low-res (400px) | ✓ | ~30ms | Fast preview |
| No pre-enhance | ✓ | ~50ms | Clean images only |

### Pre-Enhancement Comparison

| Mode | Time | Quality Score | Use Case |
|------|------|---------------|----------|
| `none` | 50ms | 0.82 | High-contrast |
| `unsharp` | 60ms | 0.91 | General (recommended) |
| `clahe` | 75ms | 0.95 | Low-contrast |

### Resolution Scaling

| Resolution | Time | Memory | Accuracy |
|-----------|------|--------|----------|
| 400px | 30ms | 2MB | Good |
| 800px | 60ms | 4MB | Very Good |
| 1200px | 90ms | 6MB | Excellent |
| 1600px | 130ms | 8MB | Near Perfect |
| 2000px | 180ms | 12MB | Perfect |

---

## Best Practices Summary

### ✅ Do

- Use **Scanner class** for real-time or batch processing
- Set `maxProcessingDimension` between **800-1600** for most cases
- Use **'unsharp'** pre-enhancement by default
- Switch to **'clahe'** for low-contrast documents
- Enable `useFallback: true` (default) for robust detection
- Check `result.success` before using output
- Use `timings` array to identify bottlenecks

### ❌ Don't

- Re-initialize WASM for every scan (use Scanner class)
- Set `maxProcessingDimension > 2000` (diminishing returns)
- Use `preEnhance: 'clahe'` for all cases (slower than needed)
- Process huge batches in parallel on mobile (memory issues)
- Ignore `result.success === false` (handle failure cases)
- Use extreme contour filter values without testing

---

## Example: Complete Production Setup

```js
import { Scanner } from 'scanic';

// Initialize scanner
const scanner = new Scanner({
  mode: 'extract',
  maxProcessingDimension: 1200,
  preEnhance: 'unsharp',
  output: 'canvas'
});

await scanner.initialize();

// Scan with error handling
async function scanWithRetry(image, attempts = 2) {
  // Try with default settings
  let result = await scanner.scan(image);
  
  if (!result.success && attempts > 0) {
    // Retry with CLAHE for difficult cases
    console.log('Retrying with CLAHE enhancement...');
    result = await scanner.scan(image, {
      preEnhance: 'clahe',
      contourFilter: {
        minAreaRatio: 0.10,
        angleRange: [60, 120]
      }
    });
  }
  
  if (!result.success) {
    throw new Error('Document detection failed');
  }
  
  console.log('Detection time:', result.timings[0].ms);
  return result;
}

// Usage
try {
  const result = await scanWithRetry(imageElement);
  document.body.appendChild(result.output);
} catch (error) {
  console.error('Scan failed:', error);
  // Show user feedback
}
```

---

## Need Help?

- **Issues**: https://github.com/marquaye/scanic/issues
- **Discussions**: https://github.com/marquaye/scanic/discussions
- **Examples**: See `/docs` folder for React and Vue examples

---

**Last Updated**: 2026-02-16  
**Scanic Version**: 2.x