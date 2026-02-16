use wasm_bindgen::prelude::*;
use crate::dilation::dilate;

/// Erode operation - inverse of dilate (uses min instead of max)
/// Uses separable (two-pass) approach for square structuring elements.
#[wasm_bindgen]
pub fn erode(
    input: &[u8],
    width: usize,
    height: usize,
    kernel_size: usize,
) -> Vec<u8> {
    let half_kernel = kernel_size / 2;
    let mut temp = vec![255u8; width * height];
    let mut eroded = vec![255u8; width * height];

    // Horizontal pass (min filter)
    for y in 0..height {
        let row_offset = y * width;
        for x in 0..width {
            let mut min_val = 255u8;
            for k in 0..kernel_size {
                let dx = k as isize - half_kernel as isize;
                let nx = (x as isize + dx).clamp(0, (width - 1) as isize) as usize;
                let val = input[row_offset + nx];
                if val < min_val {
                    min_val = val;
                }
            }
            temp[row_offset + x] = min_val;
        }
    }

    // Vertical pass (min filter)
    for y in 0..height {
        for x in 0..width {
            let mut min_val = 255u8;
            for k in 0..kernel_size {
                let dy = k as isize - half_kernel as isize;
                let ny = (y as isize + dy).clamp(0, (height - 1) as isize) as usize;
                let val = temp[ny * width + x];
                if val < min_val {
                    min_val = val;
                }
            }
            eroded[y * width + x] = min_val;
        }
    }

    eroded
}

/// Morphological close operation: dilate then erode.
/// Closes small gaps in binary edges.
#[wasm_bindgen]
pub fn morphological_close(
    input: &[u8],
    width: usize,
    height: usize,
    kernel_size: usize,
    iterations: usize,
) -> Vec<u8> {
    let mut current = input.to_vec();

    for _ in 0..iterations {
        // Dilate first (close gaps)
        current = dilate(&current, width, height, kernel_size);
        // Then erode (restore size)
        current = erode(&current, width, height, kernel_size);
    }

    current
}