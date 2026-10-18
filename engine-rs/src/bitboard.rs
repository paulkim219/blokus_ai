//! Layer 0: the 20×20 board as a 400-bit mask, word-for-word the layout of `bitboard.ts`.
//!
//! The words stay 32 bits wide on purpose. The placement table's `mask_lo..mask_hi` word ranges,
//! the cell → word mapping and every iteration order are defined in those units on the TS side,
//! and the first job of this crate is to reproduce that engine exactly. Widening to u64 is a later
//! speed change that the parity suite can then check.

pub const BOARD_SIZE: usize = 20;
pub const CELL_COUNT: usize = BOARD_SIZE * BOARD_SIZE;
pub const WORDS: usize = 13;
const TAIL_WORD: usize = WORDS - 1;
const TAIL_MASK: u32 = 0x0000_ffff;

pub type Mask = [u32; WORDS];

pub const EMPTY: Mask = [0; WORDS];

#[inline(always)]
pub fn cell_index(x: usize, y: usize) -> usize {
    y * BOARD_SIZE + x
}

#[inline(always)]
pub fn set_bit(mask: &mut Mask, index: usize) {
    mask[index >> 5] |= 1 << (index & 31);
}

#[inline(always)]
pub fn clear_bit(mask: &mut Mask, index: usize) {
    mask[index >> 5] &= !(1 << (index & 31));
}

#[inline(always)]
pub fn test_bit(mask: &Mask, index: usize) -> bool {
    mask[index >> 5] & (1 << (index & 31)) != 0
}

#[inline(always)]
pub fn popcount(mask: &Mask) -> u32 {
    mask.iter().map(|w| w.count_ones()).sum()
}

#[inline(always)]
pub fn or_into(dst: &mut Mask, src: &Mask) {
    for w in 0..WORDS {
        dst[w] |= src[w];
    }
}

#[inline(always)]
pub fn and_into(dst: &mut Mask, src: &Mask) {
    for w in 0..WORDS {
        dst[w] &= src[w];
    }
}

#[inline(always)]
pub fn and_not_into(dst: &mut Mask, src: &Mask) {
    for w in 0..WORDS {
        dst[w] &= !src[w];
    }
}

#[inline(always)]
pub fn intersects(a: &Mask, b: &Mask) -> bool {
    (0..WORDS).any(|w| a[w] & b[w] != 0)
}

#[inline(always)]
pub fn is_empty(mask: &Mask) -> bool {
    mask.iter().all(|&w| w == 0)
}

/// Writes the set cell indices into `out` in ascending order and returns how many.
#[inline]
pub fn to_indices(mask: &Mask, out: &mut [i32]) -> usize {
    let mut count = 0;
    for w in 0..WORDS {
        let mut word = mask[w];
        let base = (w << 5) as i32;
        while word != 0 {
            out[count] = base + word.trailing_zeros() as i32;
            count += 1;
            word &= word - 1;
        }
    }
    count
}

pub fn mask_from_indices(indices: &[usize]) -> Mask {
    let mut mask = EMPTY;
    for &index in indices {
        set_bit(&mut mask, index);
    }
    mask
}

pub fn full_board() -> Mask {
    let mut mask = EMPTY;
    for i in 0..CELL_COUNT {
        set_bit(&mut mask, i);
    }
    mask
}

fn column_mask(predicate: impl Fn(usize) -> bool) -> Mask {
    let mut mask = EMPTY;
    for i in 0..CELL_COUNT {
        if predicate(i % BOARD_SIZE) {
            set_bit(&mut mask, i);
        }
    }
    mask
}

fn shl_into(dst: &mut Mask, src: &Mask, bits: usize) {
    let word_shift = bits >> 5;
    let bit_shift = bits & 31;
    for w in (0..WORDS).rev() {
        let lo = w as isize - word_shift as isize;
        let mut value = if lo >= 0 { src[lo as usize] << bit_shift } else { 0 };
        if bit_shift != 0 && lo - 1 >= 0 {
            value |= src[(lo - 1) as usize] >> (32 - bit_shift);
        }
        dst[w] = value;
    }
    dst[TAIL_WORD] &= TAIL_MASK;
}

fn shr_into(dst: &mut Mask, src: &Mask, bits: usize) {
    let word_shift = bits >> 5;
    let bit_shift = bits & 31;
    for w in 0..WORDS {
        let hi = w + word_shift;
        let mut value = if hi < WORDS { src[hi] >> bit_shift } else { 0 };
        if bit_shift != 0 && hi + 1 < WORDS {
            value |= src[hi + 1] << (32 - bit_shift);
        }
        dst[w] = value;
    }
    dst[TAIL_WORD] &= TAIL_MASK;
}

/// `dst = src` translated by (dx, dy), dropping anything that would leave the board.
pub fn shift_into(dst: &mut Mask, src: &Mask, dx: isize, dy: isize) {
    let mut scratch = *src;
    if dx > 0 {
        and_into(&mut scratch, &column_mask(|x| x < BOARD_SIZE - 1));
    } else if dx < 0 {
        and_into(&mut scratch, &column_mask(|x| x > 0));
    }
    let delta = dy * BOARD_SIZE as isize + dx;
    if delta >= 0 {
        shl_into(dst, &scratch, delta as usize);
    } else {
        shr_into(dst, &scratch, (-delta) as usize);
    }
}

pub fn dilate_orthogonal(src: &Mask) -> Mask {
    let mut dst = EMPTY;
    let mut scratch = EMPTY;
    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        shift_into(&mut scratch, src, dx, dy);
        or_into(&mut dst, &scratch);
    }
    dst
}

pub fn dilate_diagonal(src: &Mask) -> Mask {
    let mut dst = EMPTY;
    let mut scratch = EMPTY;
    for (dx, dy) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
        shift_into(&mut scratch, src, dx, dy);
        or_into(&mut dst, &scratch);
    }
    dst
}
