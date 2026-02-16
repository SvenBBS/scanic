use wasm_bindgen::prelude::*;

/// Unsharp mask: sharpened = original + amount * (original - blurred)
/// Uses a box blur approximation for speed (separable, two-pass).
#[wasm_bindgen]
pub fn unsharp_mask(
    input: &[u8],
    width: usize,
    height: usize,
    amount: f32,   // sharpening strength, typically 1.0-2.0
    radius: usize, // blur radius (kernel size = 2*radius+1)
) -> Vec<u8> {
    let pixel_count = width * height;
    if input.len() != pixel_count {
        panic!("Input array size doesn't match width * height");
    }

    let kernel_size = 2 * radius + 1;
    let half_k = radius as isize;

    // Separable box blur: horizontal pass
    let mut temp = vec![0u16; pixel_count];
    for y in 0..height {
        let row_offset = y * width;
        for x in 0..width {
            let mut sum = 0u32;
            let mut count = 0u32;
            for k in -half_k..=half_k {
                let nx = (x as isize + k).clamp(0, (width - 1) as isize) as usize;
                sum += input[row_offset + nx] as u32;
                count += 1;
            }
            temp[row_offset + x] = (sum / count) as u16;
        }
    }

    // Vertical pass + unsharp mask combination
    let mut output = vec![0u8; pixel_count];
    for x in 0..width {
        for y in 0..height {
            let mut sum = 0u32;
            let mut count = 0u32;
            for k in -half_k..=half_k {
                let ny = (y as isize + k).clamp(0, (height - 1) as isize) as usize;
                sum += temp[ny * width + x] as u32;
                count += 1;
            }
            let blurred = (sum / count) as f32;
            let original = input[y * width + x] as f32;
            // Unsharp mask formula: sharpened = original + amount * (original - blurred)
            let sharpened = original + amount * (original - blurred);
            output[y * width + x] = sharpened.round().clamp(0.0, 255.0) as u8;
        }
    }

    output
}

/// Fused unsharp mask + bilinear downscale in a single pass.
/// For each output pixel, maps back to source coordinates, computes a local
/// box blur in the source neighborhood, applies unsharp mask, and writes
/// the result. This avoids allocating a full-resolution intermediate buffer.
///
/// Memory: only input (W*H) + output (tw*th) — no full-res intermediates.
#[wasm_bindgen]
pub fn unsharp_mask_and_downscale(
    input: &[u8],
    width: usize,
    height: usize,
    target_width: usize,
    target_height: usize,
    amount: f32,
    radius: usize,
) -> Vec<u8> {
    let pixel_count = width * height;
    if input.len() != pixel_count {
        panic!("Input array size doesn't match width * height");
    }

    // If no downscaling needed, just do regular unsharp mask
    if target_width >= width && target_height >= height {
        return unsharp_mask(input, width, height, amount, radius);
    }

    let half_k = radius as isize;
    let out_pixels = target_width * target_height;
    let mut output = vec![0u8; out_pixels];

    // Scale factors for mapping output coords to source coords
    let sx = width as f64 / target_width as f64;
    let sy = height as f64 / target_height as f64;

    for oy in 0..target_height {
        // Map output y to source y (center of the output pixel)
        let src_y = (oy as f64 + 0.5) * sy - 0.5;
        let src_y_floor = src_y.floor() as isize;
        let fy = (src_y - src_y_floor as f64) as f32;

        for ox in 0..target_width {
            // Map output x to source x
            let src_x = (ox as f64 + 0.5) * sx - 0.5;
            let src_x_floor = src_x.floor() as isize;
            let fx = (src_x - src_x_floor as f64) as f32;

            // Bilinear interpolation of the original pixel value
            let original = bilinear_sample(input, width, height, src_x_floor, src_y_floor, fx, fy);

            // Compute local blur at source position using box blur
            // Sample the blur kernel centered at the source pixel
            let iy = src_y.round() as isize;
            let ix = src_x.round() as isize;
            let mut blur_sum = 0u32;
            let mut blur_count = 0u32;
            for ky in -half_k..=half_k {
                let ny = (iy + ky).clamp(0, (height - 1) as isize) as usize;
                for kx in -half_k..=half_k {
                    let nx = (ix + kx).clamp(0, (width - 1) as isize) as usize;
                    blur_sum += input[ny * width + nx] as u32;
                    blur_count += 1;
                }
            }
            let blurred = blur_sum as f32 / blur_count as f32;

            // Apply unsharp mask
            let sharpened = original + amount * (original - blurred);
            output[oy * target_width + ox] = sharpened.round().clamp(0.0, 255.0) as u8;
        }
    }

    output
}

/// Bilinear interpolation helper for sampling a grayscale image.
#[inline]
fn bilinear_sample(
    data: &[u8],
    width: usize,
    height: usize,
    x_floor: isize,
    y_floor: isize,
    fx: f32,
    fy: f32,
) -> f32 {
    let x0 = x_floor.clamp(0, (width - 1) as isize) as usize;
    let y0 = y_floor.clamp(0, (height - 1) as isize) as usize;
    let x1 = (x_floor + 1).clamp(0, (width - 1) as isize) as usize;
    let y1 = (y_floor + 1).clamp(0, (height - 1) as isize) as usize;

    let p00 = data[y0 * width + x0] as f32;
    let p10 = data[y0 * width + x1] as f32;
    let p01 = data[y1 * width + x0] as f32;
    let p11 = data[y1 * width + x1] as f32;

    let top = p00 * (1.0 - fx) + p10 * fx;
    let bottom = p01 * (1.0 - fx) + p11 * fx;
    top * (1.0 - fy) + bottom * fy
}