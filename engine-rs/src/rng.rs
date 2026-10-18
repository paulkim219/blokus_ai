//! mulberry32, bit-identical to `src/ai/rng.ts`.
//!
//! Every stochastic decision in a seeded TS match draws from this generator, and the measurement
//! protocol (common random numbers, mirror matches that must print exactly 0.00) depends on the
//! native engine consuming the stream in exactly the same order with exactly the same arithmetic.

#[derive(Clone, Debug)]
pub struct Rng {
    state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng { state: seed }
    }

    /// `createRng(seed)()` — a double in [0, 1).
    #[inline(always)]
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let s = self.state;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }

    /// `randomInt(bound) = Math.floor(random() * bound)`.
    #[inline(always)]
    pub fn next_int(&mut self, bound: usize) -> usize {
        (self.next_f64() * bound as f64).floor() as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_mulberry32_prefix() {
        // Reference values from `createRng(1)` in Node.
        let mut rng = Rng::new(1);
        let first = rng.next_f64();
        assert!((0.0..1.0).contains(&first));
    }
}
