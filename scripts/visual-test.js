/**
 * Visual test script for document detection.
 * Runs test-document.jpg with various parameter combinations,
 * draws overlay polygons on the original image, and saves results.
 *
 * Usage: node --experimental-vm-modules scripts/visual-test.js
 *
 * @vitest-environment jsdom
 */
import { createCanvas, loadImage } from 'canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// We need jsdom for OffscreenCanvas / document.createElement shims
// Instead, we patch the globals that scanic expects
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.OffscreenCanvas = undefined; // Force fallback to document.createElement

// Shim ImageData
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// Patch document.createElement to return node-canvas instances
const origCreateElement = document.createElement.bind(document);
document.createElement = function (tag) {
  if (tag === 'canvas') {
    return createCanvas(1, 1); // will be resized later
  }
  return origCreateElement(tag);
};

// Now import scanic (after patching globals)
const { scanDocument } = await import('../src/index.js');

// ---------- Parameter sets to test ----------
const parameterSets = [
  {
    label: 'default',
    description: 'Default parameters (enhanced pipeline)',
    options: { maxProcessingDimension: 800 },
  },
  {
    label: 'clahe-high-clip',
    description: 'CLAHE clipLimit=6.0',
    options: {
      maxProcessingDimension: 800,
      clahe: { clipLimit: 6.0, tileGrid: [8, 8] },
    },
  },
  {
    label: 'clahe-low-clip',
    description: 'CLAHE clipLimit=1.5',
    options: {
      maxProcessingDimension: 800,
      clahe: { clipLimit: 1.5, tileGrid: [8, 8] },
    },
  },
  {
    label: 'clahe-16x16',
    description: 'CLAHE 16×16 tile grid',
    options: {
      maxProcessingDimension: 800,
      clahe: { clipLimit: 3.0, tileGrid: [16, 16] },
    },
  },
  {
    label: 'thresh-offset-5',
    description: 'Threshold offset=5 (more sensitive)',
    options: {
      maxProcessingDimension: 800,
      threshold: { offset: 5, blockSize: 21 },
    },
  },
  {
    label: 'thresh-offset-20',
    description: 'Threshold offset=20 (less sensitive)',
    options: {
      maxProcessingDimension: 800,
      threshold: { offset: 20, blockSize: 21 },
    },
  },
  {
    label: 'morph-iter-1',
    description: 'Morphology iterations=1',
    options: {
      maxProcessingDimension: 800,
      morphology: { kernelSize: 5, iterations: 1 },
    },
  },
  {
    label: 'morph-iter-4',
    description: 'Morphology iterations=4, kernel=7',
    options: {
      maxProcessingDimension: 800,
      morphology: { kernelSize: 7, iterations: 4 },
    },
  },
  {
    label: 'contour-strict',
    description: 'Strict contour filter: angle 75-105°, area 20-90%',
    options: {
      maxProcessingDimension: 800,
      contourFilter: { minAreaRatio: 0.20, maxAreaRatio: 0.90, angleRange: [75, 105] },
    },
  },
  {
    label: 'contour-relaxed',
    description: 'Relaxed contour filter: angle 45-135°, area 10-99%',
    options: {
      maxProcessingDimension: 800,
      contourFilter: { minAreaRatio: 0.10, maxAreaRatio: 0.99, angleRange: [45, 135] },
    },
  },
  {
    label: 'high-res',
    description: 'maxProcessingDimension=1200',
    options: { maxProcessingDimension: 1200 },
  },
  {
    label: 'low-res',
    description: 'maxProcessingDimension=400',
    options: { maxProcessingDimension: 400 },
  },
  {
    label: 'pre-unsharp',
    description: 'preEnhance=unsharp (default)',
    options: { maxProcessingDimension: 800, preEnhance: 'unsharp' },
  },
  {
    label: 'pre-clahe',
    description: 'preEnhance=clahe (full CLAHE pre-downscale)',
    options: { maxProcessingDimension: 800, preEnhance: 'clahe' },
  },
  {
    label: 'pre-none',
    description: 'preEnhance=none (no pre-enhancement)',
    options: { maxProcessingDimension: 800, preEnhance: 'none' },
  },
  {
    label: 'pre-unsharp-hires',
    description: 'preEnhance=unsharp + maxDim=2000',
    options: { maxProcessingDimension: 2000, preEnhance: 'unsharp' },
  },
  {
    label: 'pre-clahe-hires',
    description: 'preEnhance=clahe + maxDim=2000',
    options: { maxProcessingDimension: 2000, preEnhance: 'clahe' },
  },
];

// ---------- Drawing helpers ----------
function drawOverlay(canvas, ctx, corners, color, label) {
  const pts = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];

  // Draw filled polygon with transparency
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Draw polygon outline
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // Draw corner circles
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  const cornerLabels = ['TL', 'TR', 'BR', 'BL'];
  pts.forEach((pt, i) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cornerLabels[i], pt.x, pt.y);
    ctx.fillStyle = color;
  });
  ctx.restore();

  // Draw label text at top
  if (label) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, 36);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 10, 18);
    ctx.restore();
  }
}

// ---------- Main ----------
async function main() {
  const imgPath = path.join(rootDir, 'testImages', 'test-document.jpg');
  const img = await loadImage(imgPath);
  const imgWidth = img.width;
  const imgHeight = img.height;

  console.log(`\nImage: test-document.jpg (${imgWidth}×${imgHeight})\n`);

  const results = [];

  for (const paramSet of parameterSets) {
    const t0 = performance.now();
    const result = await scanDocument(img, paramSet.options);
    const elapsed = (performance.now() - t0).toFixed(1);

    const entry = {
      label: paramSet.label,
      description: paramSet.description,
      success: result.success,
      elapsed: `${elapsed}ms`,
      corners: result.corners,
      options: paramSet.options,
    };

    if (result.success && result.corners) {
      // Create overlay image
      const canvas = createCanvas(imgWidth, imgHeight);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      drawOverlay(canvas, ctx, result.corners, '#00FF00', `${paramSet.label}: ${paramSet.description}`);

      const outPath = path.join(rootDir, 'testImages', `test-document-overlay-${paramSet.label}.png`);
      const buffer = canvas.toBuffer('image/png');
      fs.writeFileSync(outPath, buffer);
      entry.outputFile = `test-document-overlay-${paramSet.label}.png`;

      // Compute area ratio
      const c = result.corners;
      const area =
        Math.abs(
          (c.topRight.x - c.topLeft.x) * (c.bottomLeft.y - c.topLeft.y) -
            (c.bottomLeft.x - c.topLeft.x) * (c.topRight.y - c.topLeft.y)
        ) /
          2 +
        Math.abs(
          (c.bottomRight.x - c.topRight.x) * (c.bottomLeft.y - c.topRight.y) -
            (c.bottomLeft.x - c.topRight.x) * (c.bottomRight.y - c.topRight.y)
        ) /
          2;
      entry.areaRatio = ((area / (imgWidth * imgHeight)) * 100).toFixed(1) + '%';
    } else {
      entry.outputFile = '—';
      entry.areaRatio = '—';
    }

    results.push(entry);
  }

  // Print parameter table
  console.log('┌──────────────────────┬───────────────────────────────────────────────────┬─────────┬────────┬──────────────────────────────────────────────┐');
  console.log('│ Label                │ Description                                       │ Success │ Time   │ Area%  │ Output File                                  │');
  console.log('├──────────────────────┼───────────────────────────────────────────────────┼─────────┼────────┼──────────────────────────────────────────────┤');

  for (const r of results) {
    const label = r.label.padEnd(20);
    const desc = r.description.padEnd(49);
    const success = (r.success ? '✓' : '✗').padEnd(7);
    const time = r.elapsed.padEnd(6);
    const area = (r.areaRatio || '—').padEnd(6);
    const file = (r.outputFile || '—').padEnd(44);
    console.log(`│ ${label} │ ${desc} │ ${success} │ ${time} │ ${area} │ ${file} │`);
  }

  console.log('└──────────────────────┴───────────────────────────────────────────────────┴─────────┴────────┴────────┴──────────────────────────────────────────────┘');

  // Also print detailed corner coordinates
  console.log('\n=== Detailed Corner Coordinates ===\n');
  console.log('Label'.padEnd(22) + 'TopLeft'.padEnd(18) + 'TopRight'.padEnd(18) + 'BottomRight'.padEnd(18) + 'BottomLeft');
  console.log('─'.repeat(94));
  for (const r of results) {
    if (r.success && r.corners) {
      const fmt = (pt) => `(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`;
      console.log(
        r.label.padEnd(22) +
          fmt(r.corners.topLeft).padEnd(18) +
          fmt(r.corners.topRight).padEnd(18) +
          fmt(r.corners.bottomRight).padEnd(18) +
          fmt(r.corners.bottomLeft)
      );
    } else {
      console.log(r.label.padEnd(22) + '(detection failed)');
    }
  }

  // Print parameter details
  console.log('\n=== Parameter Details ===\n');
  for (const r of results) {
    console.log(`[${r.label}]`);
    const opts = { ...r.options };
    delete opts.maxProcessingDimension;
    console.log(`  maxProcessingDimension: ${r.options.maxProcessingDimension}`);
    if (r.options.clahe) console.log(`  clahe: clipLimit=${r.options.clahe.clipLimit}, tileGrid=${JSON.stringify(r.options.clahe.tileGrid)}`);
    if (r.options.threshold) console.log(`  threshold: offset=${r.options.threshold.offset}, blockSize=${r.options.threshold.blockSize}`);
    if (r.options.morphology) console.log(`  morphology: kernelSize=${r.options.morphology.kernelSize}, iterations=${r.options.morphology.iterations}`);
    if (r.options.contourFilter) console.log(`  contourFilter: minArea=${r.options.contourFilter.minAreaRatio}, maxArea=${r.options.contourFilter.maxAreaRatio}, angle=${JSON.stringify(r.options.contourFilter.angleRange)}`);
    console.log('');
  }

  console.log(`\n✓ Generated ${results.filter((r) => r.success).length} overlay images in testImages/`);
}

main().catch(console.error);