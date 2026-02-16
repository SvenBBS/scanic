use wasm_bindgen::prelude::*;

/// Adaptive thresholding (Gaussian variant)
/// Compares each pixel against a locally blurred version with an offset.
/// The blurred image should be pre-computed using the existing blur() function.
#[wasm_bindgen]
pub fn adaptive_threshold(
    input: &[u8],
    blurred: &[u8],
    width: usize,
    height: usize,
    offset: i32,
    invert: bool,
) -> Vec<u8> {
    let pixel_count = width * height;
    if input.len() != pixel_count || blurred.len() != pixel_count {
        panic!("Input array sizes don't match width * height");
    }

    let mut output = vec![0u8; pixel_count];

    for i in 0..pixel_count {
        let threshold = blurred[i] as i32 - offset;
        let above = (input[i] as i32) > threshold;

        output[i] = if above != invert { 255 } else { 0 };
    }

    output
}