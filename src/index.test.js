/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { scanDocument, Scanner } from './index.js';
import { loadImage } from 'canvas';
import path from 'path';

// Shim ImageData if it's not defined (JSDOM doesn't have it by default)
if (typeof ImageData === 'undefined') {
  global.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

describe('Scanner API', () => {
  it('should expose scanDocument function', () => {
    expect(scanDocument).toBeDefined();
  });

  it('should expose Scanner class', () => {
    const scanner = new Scanner();
    expect(scanner.scan).toBeDefined();
    expect(scanner.initialize).toBeDefined();
  });

  it('should handle missing image gracefully', async () => {
    try {
      await scanDocument(null);
    } catch (e) {
      expect(e.message).toBe('No image provided');
    }
  });
});

describe('Regression Tests', () => {
  const imagesDir = path.join(__dirname, '..', 'testImages');

  const testCases = [
    { 
      name: 'test.png', 
      expected: {
        topLeft: { x: 306.9, y: 75.9 },
        topRight: { x: 650.1, y: 91.3 },
        bottomRight: { x: 661.1, y: 467.5 },
        bottomLeft: { x: 165.0, y: 467.5 }
      }
    },
    { 
      name: 'test2.png', 
      expected: {
        topLeft: { x: 200, y: 180 },
        topRight: { x: 966, y: 188 },
        bottomRight: { x: 1148, y: 1360 },
        bottomLeft: { x: 54, y: 1378 }
      }
    }
  ];

  testCases.forEach(({ name, expected }) => {
    it(`should match baseline for ${name}`, async () => {
      const imgPath = path.join(imagesDir, name);
      const img = await loadImage(imgPath);
      const result = await scanDocument(img, { maxProcessingDimension: 800 });
      
      expect(result.success).toBe(true);
      
      // We check if coordinates are close enough (within 2 pixels) to account for small math variations
      const precision = 2;
      
      Object.keys(expected).forEach(corner => {
        expect(result.corners[corner].x).toBeCloseTo(expected[corner].x, -Math.log10(precision));
        expect(result.corners[corner].y).toBeCloseTo(expected[corner].y, -Math.log10(precision));
      });
    });
  });
});

describe('Low-Contrast Document Detection (test-document.jpg)', () => {
  const imagesDir = path.join(__dirname, '..', 'testImages');

  it('should detect document in test-document.jpg', async () => {
    const imgPath = path.join(imagesDir, 'test-document.jpg');
    const img = await loadImage(imgPath);
    const result = await scanDocument(img, { maxProcessingDimension: 800 });
    
    // The enhanced pipeline (CLAHE + adaptive threshold) should detect the document
    expect(result.success).toBe(true);
    expect(result.corners).not.toBeNull();
    
    // Verify all 4 corner points exist
    expect(result.corners.topLeft).toBeDefined();
    expect(result.corners.topRight).toBeDefined();
    expect(result.corners.bottomRight).toBeDefined();
    expect(result.corners.bottomLeft).toBeDefined();
    
    // Verify corner points have valid coordinates
    expect(result.corners.topLeft.x).toBeGreaterThanOrEqual(0);
    expect(result.corners.topLeft.y).toBeGreaterThanOrEqual(0);
    expect(result.corners.topRight.x).toBeGreaterThan(result.corners.topLeft.x);
    expect(result.corners.bottomRight.y).toBeGreaterThan(result.corners.topRight.y);
    expect(result.corners.bottomLeft.y).toBeGreaterThan(result.corners.topLeft.y);
  });

  it('should return corners within image bounds for test-document.jpg', async () => {
    const imgPath = path.join(imagesDir, 'test-document.jpg');
    const img = await loadImage(imgPath);
    const result = await scanDocument(img, { maxProcessingDimension: 800 });
    
    if (result.success) {
      const imgWidth = img.width;
      const imgHeight = img.height;
      
      Object.keys(result.corners).forEach(corner => {
        expect(result.corners[corner].x).toBeGreaterThanOrEqual(0);
        expect(result.corners[corner].x).toBeLessThanOrEqual(imgWidth);
        expect(result.corners[corner].y).toBeGreaterThanOrEqual(0);
        expect(result.corners[corner].y).toBeLessThanOrEqual(imgHeight);
      });
    }
  });

  it('should detect a document covering a reasonable area of test-document.jpg', async () => {
    const imgPath = path.join(imagesDir, 'test-document.jpg');
    const img = await loadImage(imgPath);
    const result = await scanDocument(img, { maxProcessingDimension: 800 });
    
    if (result.success) {
      // Calculate the approximate area of the detected document
      const corners = result.corners;
      const area = Math.abs(
        (corners.topRight.x - corners.topLeft.x) * (corners.bottomLeft.y - corners.topLeft.y) -
        (corners.bottomLeft.x - corners.topLeft.x) * (corners.topRight.y - corners.topLeft.y)
      ) / 2 +
      Math.abs(
        (corners.bottomRight.x - corners.topRight.x) * (corners.bottomLeft.y - corners.topRight.y) -
        (corners.bottomLeft.x - corners.topRight.x) * (corners.bottomRight.y - corners.topRight.y)
      ) / 2;
      
      const imageArea = img.width * img.height;
      const areaRatio = area / imageArea;
      
      // Document should cover at least 15% of the image
      expect(areaRatio).toBeGreaterThan(0.15);
      // But not the entire image
      expect(areaRatio).toBeLessThan(0.98);
    }
  });
});


