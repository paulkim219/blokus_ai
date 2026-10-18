//! `Math.*` with V8's exact results.
//!
//! A one-ulp difference is enough to flip a softmax or PUCT tie and fork a seeded game, so each
//! function here was checked against V8 output rather than assumed:
//!
//! - `Math.exp` is V8's own port of fdlibm (`src/base/ieee754.cc`), reproduced below *as clang
//!   compiles it for arm64*: the default `-ffp-contract=on` fuses each `a + b*c` within an
//!   expression into an FMA, and the polynomial's rounding depends on it. Unfused, this function
//!   disagreed with Node 25 on 140 of 200,000 probes; fused, on none. The `libm` crate's exp
//!   (musl lineage) rounds its reconstruction differently again, and the platform exp disagreed
//!   on 361 of 4,000.
//! - `Math.pow` calls the C library's `pow` in current V8, so `f64::powf` (which lowers to the same
//!   libSystem call on macOS) matches it exactly — 0 of 480 probes differ — while the fdlibm port
//!   in `libm` differs on 36. This makes pow results platform-dependent, exactly as they already
//!   are for the TS engine: parity holds between the two engines *on the same machine*.
//! - Square root, floor and the basic operators are correctly rounded everywhere.

/// V8 `base::ieee754::exp` (fdlibm e_exp.c as modified in FreeBSD and V8), FMA-contracted.
pub fn exp(x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2_HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2_LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = 2.718281828459045;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;

    let bits = x.to_bits();
    let mut hx = (bits >> 32) as u32;
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fff_ffff;

    if hx >= 0x4086_2e42 {
        if hx >= 0x7ff0_0000 {
            let lx = bits as u32;
            if ((hx & 0xfffff) | lx) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }

    let mut x = x;
    let (mut hi, mut lo, mut k) = (0.0f64, 0.0f64, 0i32);
    if hx > 0x3fd6_2e42 {
        if hx < 0x3ff0_a2b2 {
            if x == 1.0 {
                return E;
            }
            hi = x - LN2_HI[xsb];
            lo = LN2_LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = INVLN2.mul_add(x, HALF[xsb]) as i32;
            let t = k as f64;
            hi = (-t).mul_add(LN2_HI[0], x);
            lo = t * LN2_LO[0];
        }
        x = hi - lo;
    } else if hx < 0x3e30_0000 {
        if HUGE + x > ONE {
            return ONE + x;
        }
    } else {
        k = 0;
    }

    let t = x * x;
    let twopk = if k >= -1021 {
        f64::from_bits(((0x3ff0_0000i64 + ((k as i64) << 20)) as u64) << 32)
    } else {
        f64::from_bits(((0x3ff0_0000i64 + (((k + 1000) as i64) << 20)) as u64) << 32)
    };
    // x - t*(P1 + t*(P2 + t*(P3 + t*(P4 + t*P5)))), contracted the way clang contracts it.
    let c = (-t).mul_add(t.mul_add(t.mul_add(t.mul_add(t.mul_add(P5, P4), P3), P2), P1), x);
    if k == 0 {
        return ONE - ((x * c) / (c - 2.0) - x);
    }
    let y = ONE - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

/// `Math.pow`: the C library's pow, as V8 calls it.
#[inline(always)]
pub fn pow(x: f64, y: f64) -> f64 {
    x.powf(y)
}

/// `Math.log` — only reaches reported values (logit), never a decision.
#[inline(always)]
pub fn log(x: f64) -> f64 {
    x.ln()
}

/// `Math.round`: ties toward +∞, which differs from `f64::round` on negative halves.
#[inline]
pub fn round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}
