/**
 * Contour filtering for document detection.
 * Validates contours based on shape (4 corners), area, convexity, angles,
 * and composite scoring (angle proximity to 90° + area preference).
 */

import { approximatePolygon } from './contourDetection.js';

/**
 * Find the best document contour from a list of contour candidates.
 * Filters by: 4 corners, area ratio, convexity, angle constraints, and aspect ratio.
 * Scores candidates by composite metric: angle proximity to 90° + normalized area.
 * @param {Array} contours - Array of contour objects with .points and .area
 * @param {number} imageWidth - Image width
 * @param {number} imageHeight - Image height
 * @param {Object} options - Configuration options
 * @returns {Object|null} Best contour candidate or null
 */
export function findDocumentContour(contours, imageWidth, imageHeight, options = {}) {
  const {
    minAreaRatio = 0.15,
    maxAreaRatio = 0.98,
    minAngle = 60,
    maxAngle = 120,
    epsilon = 0.02,
    // Scoring weights
    areaWeight = 0.4,
    angleWeight = 0.6,
    // Aspect ratio bounds (width/height of the detected quad)
    minAspectRatio = 0.3,
    maxAspectRatio = 3.0,
    // Multiple epsilon values to try for better polygon approximation
    epsilonValues = null,
  } = options;

  const imageArea = imageWidth * imageHeight;
  const minArea = imageArea * minAreaRatio;
  const maxArea = imageArea * maxAreaRatio;

  // Epsilon values to try: user-provided or derive from the base epsilon
  const epsilons = epsilonValues || [epsilon * 0.5, epsilon * 0.75, epsilon, epsilon * 1.5, epsilon * 2.0];

  const candidates = [];

  for (const contour of contours) {
    // Get contour points
    const points = contour.points || contour;
    if (!points || points.length < 4) continue;

    // Try multiple epsilon values for polygon approximation
    for (const eps of epsilons) {
      const approx = approximatePolygon(points, eps);

      // Must have exactly 4 corners
      if (!approx || approx.length !== 4) continue;

      // Calculate area using shoelace formula
      const area = contourArea(approx);

      // Area must be within bounds
      if (area < minArea || area > maxArea) continue;

      // Must be convex
      if (!isConvex(approx)) continue;

      // Angles must be reasonable (close to 90°, allowing perspective distortion)
      if (!hasReasonableAngles(approx, minAngle, maxAngle)) continue;

      // Aspect ratio sanity check
      const aspect = quadAspectRatio(approx);
      if (aspect < minAspectRatio || aspect > maxAspectRatio) continue;

      // Compute composite score
      const angleScore = computeAngleScore(approx);
      const normalizedArea = area / imageArea;
      const score = areaWeight * normalizedArea + angleWeight * angleScore;

      candidates.push({
        contour: contour,
        approx: approx,
        area: area,
        points: points,
        epsilon: eps,
        angleScore: angleScore,
        score: score,
      });

      // Don't add duplicate candidates from different epsilons for the same contour
      // if this one is already a good fit (score > 0.5)
      if (score > 0.5) break;
    }
  }

  // Sort by composite score (highest first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Calculate area of a polygon using the shoelace formula
 * @param {Array} points - Array of {x, y} points
 * @returns {number} Absolute area
 */
export function contourArea(points) {
  const n = points.length;
  if (n < 3) return 0;

  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }

  return Math.abs(area) / 2;
}

/**
 * Check if a polygon is convex by verifying all cross products have the same sign
 * @param {Array} points - Array of {x, y} points (at least 3)
 * @returns {boolean} True if the polygon is convex
 */
export function isConvex(points) {
  const n = points.length;
  if (n < 3) return false;

  let sign = 0;

  for (let i = 0; i < n; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const p2 = points[(i + 2) % n];

    const dx1 = p1.x - p0.x;
    const dy1 = p1.y - p0.y;
    const dx2 = p2.x - p1.x;
    const dy2 = p2.y - p1.y;

    const cross = dx1 * dy2 - dy1 * dx2;

    if (cross !== 0) {
      if (sign === 0) {
        sign = cross > 0 ? 1 : -1;
      } else if ((cross > 0 ? 1 : -1) !== sign) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Check if all interior angles of a polygon are within a reasonable range.
 * For a document, angles should be roughly 60°-120° to account for perspective.
 * @param {Array} points - Array of {x, y} points
 * @param {number} minAngle - Minimum angle in degrees
 * @param {number} maxAngle - Maximum angle in degrees
 * @returns {boolean} True if all angles are within range
 */
export function hasReasonableAngles(points, minAngle = 60, maxAngle = 120) {
  const n = points.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];

    const angle = angleBetween(p0, p1, p2);

    if (angle < minAngle || angle > maxAngle) {
      return false;
    }
  }

  return true;
}

/**
 * Compute a score [0, 1] indicating how close all angles are to 90°.
 * 1.0 = perfect rectangle, 0.0 = all angles at ±30° from 90°.
 * @param {Array} points - Array of 4 {x, y} points
 * @returns {number} Score between 0 and 1
 */
export function computeAngleScore(points) {
  const n = points.length;
  if (n < 3) return 0;

  let totalDeviation = 0;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const angle = angleBetween(p0, p1, p2);
    totalDeviation += Math.abs(angle - 90);
  }

  // Average deviation from 90° per corner
  const avgDeviation = totalDeviation / n;

  // Normalize: 0° deviation → score 1.0, 30° deviation → score 0.0
  return Math.max(0, Math.min(1, 1 - avgDeviation / 30));
}

/**
 * Compute the aspect ratio of a quadrilateral (avg width / avg height).
 * @param {Array} points - Array of 4 {x, y} points (ordered: TL, TR, BR, BL or any consistent winding)
 * @returns {number} Aspect ratio (width / height)
 */
export function quadAspectRatio(points) {
  if (points.length !== 4) return 1;

  // Compute edge lengths
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const dx = points[j].x - points[i].x;
    const dy = points[j].y - points[i].y;
    edges.push(Math.sqrt(dx * dx + dy * dy));
  }

  // For a quadrilateral, opposite edges correspond to width/height pairs
  const width = (edges[0] + edges[2]) / 2;
  const height = (edges[1] + edges[3]) / 2;

  if (height === 0) return Infinity;
  return width / height;
}

/**
 * Calculate angle at vertex p1, formed by edges p0→p1 and p1→p2
 * @param {Object} p0 - Previous point
 * @param {Object} p1 - Vertex point
 * @param {Object} p2 - Next point
 * @returns {number} Angle in degrees
 */
export function angleBetween(p0, p1, p2) {
  const v1x = p0.x - p1.x;
  const v1y = p0.y - p1.y;
  const v2x = p2.x - p1.x;
  const v2y = p2.y - p1.y;

  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);

  if (mag1 === 0 || mag2 === 0) return 0;

  const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cosAngle) * (180 / Math.PI);
}