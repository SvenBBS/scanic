use wasm_bindgen::prelude::*;

/// CLAHE (Contrast Limited Adaptive Histogram Equalization)
/// Based on Zuiderveld (1994)
#[wasm_bindgen]
pub fn clahe(
    input: &[u8],
    width: usize,
    height: usize,
    tile_grid_x: usize,
    tile_grid_y: usize,
    clip_limit: f32,
) -> Vec<u8> {
    let pixel_count = width * height;
    if input.len() != pixel_count {
        panic!("Input array size doesn't match width * height");
    }

    let tile_width = width / tile_grid_x;
    let tile_height = height / tile_grid_y;
    let tile_pixels = tile_width * tile_height;

    // Calculate the actual clip limit for histogram bins
    let actual_clip = if clip_limit > 0.0 {
        ((clip_limit * tile_pixels as f32) / 256.0).max(1.0) as u32
    } else {
        u32::MAX // No clipping
    };

    // Compute CDFs for each tile
    let num_tiles = tile_grid_x * tile_grid_y;
    // Each tile has a 256-element CDF (stored as u8 mapped values)
    let mut tile_cdfs = vec![0u8; num_tiles * 256];

    for ty in 0..tile_grid_y {
        for tx in 0..tile_grid_x {
            let tile_idx = ty * tile_grid_x + tx;

            // Compute histogram for this tile
            let mut hist = [0u32; 256];
            let y_start = ty * tile_height;
            let x_start = tx * tile_width;
            let y_end = if ty == tile_grid_y - 1 { height } else { y_start + tile_height };
            let x_end = if tx == tile_grid_x - 1 { width } else { x_start + tile_width };
            let actual_tile_pixels = (y_end - y_start) * (x_end - x_start);

            for y in y_start..y_end {
                for x in x_start..x_end {
                    hist[input[y * width + x] as usize] += 1;
                }
            }

            // Apply clip limit and redistribute excess
            if actual_clip < u32::MAX {
                let mut excess = 0u32;
                for bin in hist.iter_mut() {
                    if *bin > actual_clip {
                        excess += *bin - actual_clip;
                        *bin = actual_clip;
                    }
                }
                // Redistribute excess equally
                let per_bin = excess / 256;
                let remainder = (excess % 256) as usize;
                for (i, bin) in hist.iter_mut().enumerate() {
                    *bin += per_bin;
                    if i < remainder {
                        *bin += 1;
                    }
                }
            }

            // Compute CDF and map to [0, 255]
            let mut cdf = [0u32; 256];
            cdf[0] = hist[0];
            for i in 1..256 {
                cdf[i] = cdf[i - 1] + hist[i];
            }

            // Find min CDF value (first non-zero)
            let cdf_min = cdf.iter().copied().find(|&v| v > 0).unwrap_or(0);
            let denom = actual_tile_pixels as f32 - cdf_min as f32;

            let cdf_slice = &mut tile_cdfs[tile_idx * 256..(tile_idx + 1) * 256];
            if denom > 0.0 {
                for i in 0..256 {
                    let val = ((cdf[i] as f32 - cdf_min as f32) / denom * 255.0).round();
                    cdf_slice[i] = val.clamp(0.0, 255.0) as u8;
                }
            } else {
                for i in 0..256 {
                    cdf_slice[i] = i as u8;
                }
            }
        }
    }

    // Apply bilinear interpolation between tile CDFs for each pixel
    let mut output = vec![0u8; pixel_count];

    for y in 0..height {
        for x in 0..width {
            let pixel_val = input[y * width + x] as usize;

            // Find the tile coordinates (floating point)
            // Map pixel position to tile center coordinates
            let fy = (y as f32 / tile_height as f32) - 0.5;
            let fx = (x as f32 / tile_width as f32) - 0.5;

            // Clamp to valid tile range
            let fy_clamped = fy.clamp(0.0, (tile_grid_y - 1) as f32);
            let fx_clamped = fx.clamp(0.0, (tile_grid_x - 1) as f32);

            let ty0 = fy_clamped.floor() as usize;
            let tx0 = fx_clamped.floor() as usize;
            let ty1 = (ty0 + 1).min(tile_grid_y - 1);
            let tx1 = (tx0 + 1).min(tile_grid_x - 1);

            let wy = fy_clamped - ty0 as f32;
            let wx = fx_clamped - tx0 as f32;

            // Get CDF values from 4 neighboring tiles
            let v00 = tile_cdfs[(ty0 * tile_grid_x + tx0) * 256 + pixel_val] as f32;
            let v10 = tile_cdfs[(ty0 * tile_grid_x + tx1) * 256 + pixel_val] as f32;
            let v01 = tile_cdfs[(ty1 * tile_grid_x + tx0) * 256 + pixel_val] as f32;
            let v11 = tile_cdfs[(ty1 * tile_grid_x + tx1) * 256 + pixel_val] as f32;

            // Bilinear interpolation
            let top = v00 * (1.0 - wx) + v10 * wx;
            let bottom = v01 * (1.0 - wx) + v11 * wx;
            let result = top * (1.0 - wy) + bottom * wy;

            output[y * width + x] = result.round().clamp(0.0, 255.0) as u8;
        }
    }

    output
}

/// Fused CLAHE + bilinear downscale in a single pass.
/// Computes tile CDFs at full resolution, then for each output pixel
/// maps back to source coordinates and applies CLAHE interpolation.
/// Memory: input (W*H) + tile_cdfs (num_tiles*256) + output (tw*th) — no full-res intermediate.
#[wasm_bindgen]
pub fn clahe_and_downscale(
    input: &[u8],
    width: usize,
    height: usize,
    target_width: usize,
    target_height: usize,
    tile_grid_x: usize,
    tile_grid_y: usize,
    clip_limit: f32,
) -> Vec<u8> {
    let pixel_count = width * height;
    if input.len() != pixel_count {
        panic!("Input array size doesn't match width * height");
    }

    // If no downscaling needed, use regular CLAHE
    if target_width >= width && target_height >= height {
        return clahe(input, width, height, tile_grid_x, tile_grid_y, clip_limit);
    }

    let tile_width = width / tile_grid_x;
    let tile_height = height / tile_grid_y;
    let tile_pixels = tile_width * tile_height;

    let actual_clip = if clip_limit > 0.0 {
        ((clip_limit * tile_pixels as f32) / 256.0).max(1.0) as u32
    } else {
        u32::MAX
    };

    // Compute CDFs for each tile (same as regular CLAHE)
    let num_tiles = tile_grid_x * tile_grid_y;
    let mut tile_cdfs = vec![0u8; num_tiles * 256];

    for ty in 0..tile_grid_y {
        for tx in 0..tile_grid_x {
            let tile_idx = ty * tile_grid_x + tx;

            let mut hist = [0u32; 256];
            let y_start = ty * tile_height;
            let x_start = tx * tile_width;
            let y_end = if ty == tile_grid_y - 1 { height } else { y_start + tile_height };
            let x_end = if tx == tile_grid_x - 1 { width } else { x_start + tile_width };
            let actual_tile_pixels = (y_end - y_start) * (x_end - x_start);

            for y in y_start..y_end {
                for x in x_start..x_end {
                    hist[input[y * width + x] as usize] += 1;
                }
            }

            if actual_clip < u32::MAX {
                let mut excess = 0u32;
                for bin in hist.iter_mut() {
                    if *bin > actual_clip {
                        excess += *bin - actual_clip;
                        *bin = actual_clip;
                    }
                }
                let per_bin = excess / 256;
                let remainder = (excess % 256) as usize;
                for (i, bin) in hist.iter_mut().enumerate() {
                    *bin += per_bin;
                    if i < remainder {
                        *bin += 1;
                    }
                }
            }

            let mut cdf = [0u32; 256];
            cdf[0] = hist[0];
            for i in 1..256 {
                cdf[i] = cdf[i - 1] + hist[i];
            }

            let cdf_min = cdf.iter().copied().find(|&v| v > 0).unwrap_or(0);
            let denom = actual_tile_pixels as f32 - cdf_min as f32;

            let cdf_slice = &mut tile_cdfs[tile_idx * 256..(tile_idx + 1) * 256];
            if denom > 0.0 {
                for i in 0..256 {
                    let val = ((cdf[i] as f32 - cdf_min as f32) / denom * 255.0).round();
                    cdf_slice[i] = val.clamp(0.0, 255.0) as u8;
                }
            } else {
                for i in 0..256 {
                    cdf_slice[i] = i as u8;
                }
            }
        }
    }

    // Now produce downscaled output using bilinear mapping + CLAHE interpolation
    let out_pixels = target_width * target_height;
    let mut output = vec![0u8; out_pixels];

    let sx = width as f64 / target_width as f64;
    let sy = height as f64 / target_height as f64;

    for oy in 0..target_height {
        let src_y = (oy as f64 + 0.5) * sy - 0.5;
        let src_y_round = src_y.round().clamp(0.0, (height - 1) as f64) as usize;

        for ox in 0..target_width {
            let src_x = (ox as f64 + 0.5) * sx - 0.5;
            let src_x_round = src_x.round().clamp(0.0, (width - 1) as f64) as usize;

            let pixel_val = input[src_y_round * width + src_x_round] as usize;

            // Apply CLAHE bilinear interpolation using tile CDFs
            let fy = (src_y_round as f32 / tile_height as f32) - 0.5;
            let fx = (src_x_round as f32 / tile_width as f32) - 0.5;

            let fy_clamped = fy.clamp(0.0, (tile_grid_y - 1) as f32);
            let fx_clamped = fx.clamp(0.0, (tile_grid_x - 1) as f32);

            let ty0 = fy_clamped.floor() as usize;
            let tx0 = fx_clamped.floor() as usize;
            let ty1 = (ty0 + 1).min(tile_grid_y - 1);
            let tx1 = (tx0 + 1).min(tile_grid_x - 1);

            let wy = fy_clamped - ty0 as f32;
            let wx = fx_clamped - tx0 as f32;

            let v00 = tile_cdfs[(ty0 * tile_grid_x + tx0) * 256 + pixel_val] as f32;
            let v10 = tile_cdfs[(ty0 * tile_grid_x + tx1) * 256 + pixel_val] as f32;
            let v01 = tile_cdfs[(ty1 * tile_grid_x + tx0) * 256 + pixel_val] as f32;
            let v11 = tile_cdfs[(ty1 * tile_grid_x + tx1) * 256 + pixel_val] as f32;

            let top = v00 * (1.0 - wx) + v10 * wx;
            let bottom = v01 * (1.0 - wx) + v11 * wx;
            let result = top * (1.0 - wy) + bottom * wy;

            output[oy * target_width + ox] = result.round().clamp(0.0, 255.0) as u8;
        }
    }

    output
}
