//! Self-play record format v3 (hybrid H1, `research_paper/v5_hybrid_cpu_gpu_plan.md`).
//!
//! The 512-byte v2 record (`blokee-selfplay` without `--format v3`) keeps at most 64 root moves,
//! but a v5 root holds every legal move (port P4). A v3 record keeps, for one decision:
//!
//! - the full position (four bitboards, hands, last pieces) and the mover;
//! - **every legal move** with its **real** search visits and its root prior;
//! - the root's mean backed-up value for all four seats and its real visit count;
//! - the game's final scores (filled in when the game ends).
//!
//! **Visits are real.** `native.candidates.initVisits` (root) and `interiorInitVisits` (interior)
//! are *virtual* visits: `V12Search::select` mixes `n0` visits at the prior-derived initial value
//! into an edge's Q, but they are never added to `child_visits` or to a node's `visits`. Only
//! `V12Search::backup` adds to those, once per simulation through the edge. So the visits stored
//! here are exactly the simulations that went through each root edge, and they sum to the root's
//! visit count (one per iteration). Nothing has to be subtracted.
//!
//! Records are variable-length; each starts with a magic and its own length, so a shard is read by
//! walking it. Layout, little-endian, offsets in bytes:
//!
//! | offset | type | field |
//! |---:|---|---|
//! | 0 | u32 | magic `MAGIC` ("BKR3") |
//! | 4 | u32 | record length in bytes (header + arrays + padding to a multiple of 4) |
//! | 8 | u32 | game index within the run |
//! | 12 | u16 | ply (passes count as plies) |
//! | 14 | u8 | mover's seat (0 blue, 1 green, 2 purple, 3 yellow: turn order) |
//! | 15 | u8 | source: 0 search, 1 opening heuristic, 2 packer, 3 greedy, 4 teacher move (Pentobi) |
//! | 16 | 4 × 13 u32 | bitboards per seat (turn order), as in v2 |
//! | 224 | 4 × u32 | piece masks in hand per seat |
//! | 240 | 4 × i8 | last piece placed per seat (−1 none) |
//! | 244 | u16 | chosen placement id (the move played) |
//! | 246 | u16 | n, the number of moves listed (every legal move of the mover) |
//! | 248 | u32 | search iterations (0 unless source 0) |
//! | 252 | u32 | root visits (real; 0 unless source 0) |
//! | 256 | 4 × f32 | root mean value per seat (`values[s] / visits` at the root, in the search's reward units; NaN unless source 0) |
//! | 272 | 4 × f32 | final scores per seat (turn order) |
//! | 288 | u8 | teacher: 0 Blokee self-play, k Pentobi level k |
//! | 289 | u8 | pieces the mover has placed before this move |
//! | 290 | u16 | reserved (0) |
//! | 292 | u32 | game seed |
//! | 296 | n × u32 | visits per move (source 0: real root visits; source 4: 1 for the move played, else 0; else 0) |
//! | 296 + 4n | n × f32 | root prior per move (source 0; else 0) |
//! | 296 + 8n | n × u16 | placement ids (source 0: root tree order, i.e. the root's prior order; else generation order) |
//!
//! The record ends with zero padding to a multiple of 4 bytes.

use crate::bitboard::WORDS;
use crate::position::SEAT_COUNT;

pub const MAGIC: u32 = u32::from_le_bytes(*b"BKR3");
pub const HEADER_BYTES: usize = 296;

pub const SOURCE_SEARCH: u8 = 0;
pub const SOURCE_HEURISTIC: u8 = 1;
pub const SOURCE_PACKER: u8 = 2;
pub const SOURCE_GREEDY: u8 = 3;
pub const SOURCE_TEACHER: u8 = 4;

/// One decision, before it is written.
#[derive(Clone, Debug)]
pub struct RecordV3 {
    pub game: u32,
    pub ply: u16,
    pub seat: u8,
    pub source: u8,
    pub own: [[u32; WORDS]; SEAT_COUNT],
    pub hand: [u32; SEAT_COUNT],
    pub last_piece: [i8; SEAT_COUNT],
    pub chosen: u16,
    pub iterations: u32,
    pub root_visits: u32,
    pub root_values: [f32; SEAT_COUNT],
    pub final_scores: [f32; SEAT_COUNT],
    pub teacher: u8,
    pub own_moves: u8,
    pub seed: u32,
    pub moves: Vec<u16>,
    pub visits: Vec<u32>,
    pub priors: Vec<f32>,
}

impl RecordV3 {
    /// Bytes `encode` writes.
    pub fn len(&self) -> usize {
        let n = self.moves.len();
        (HEADER_BYTES + 10 * n).div_ceil(4) * 4
    }

    pub fn is_empty(&self) -> bool {
        self.moves.is_empty()
    }

    /// Appends the record to `out`.
    pub fn encode(&self, out: &mut Vec<u8>) {
        let n = self.moves.len();
        assert!(n <= u16::MAX as usize && self.visits.len() == n && self.priors.len() == n, "record v3: inconsistent move arrays");
        let start = out.len();
        let len = self.len();
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&(len as u32).to_le_bytes());
        out.extend_from_slice(&self.game.to_le_bytes());
        out.extend_from_slice(&self.ply.to_le_bytes());
        out.push(self.seat);
        out.push(self.source);
        for seat in 0..SEAT_COUNT {
            for w in 0..WORDS {
                out.extend_from_slice(&self.own[seat][w].to_le_bytes());
            }
        }
        for seat in 0..SEAT_COUNT {
            out.extend_from_slice(&self.hand[seat].to_le_bytes());
        }
        for seat in 0..SEAT_COUNT {
            out.push(self.last_piece[seat] as u8);
        }
        out.extend_from_slice(&self.chosen.to_le_bytes());
        out.extend_from_slice(&(n as u16).to_le_bytes());
        out.extend_from_slice(&self.iterations.to_le_bytes());
        out.extend_from_slice(&self.root_visits.to_le_bytes());
        for v in self.root_values {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in self.final_scores {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.push(self.teacher);
        out.push(self.own_moves);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.seed.to_le_bytes());
        debug_assert_eq!(out.len() - start, HEADER_BYTES);
        for &v in &self.visits {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for &p in &self.priors {
            out.extend_from_slice(&p.to_le_bytes());
        }
        for &m in &self.moves {
            out.extend_from_slice(&m.to_le_bytes());
        }
        out.resize(start + len, 0);
    }

    /// Fills in the final scores of a record already encoded at `out[at..]`.
    pub fn patch_scores(out: &mut [u8], at: usize, scores: &[f64; SEAT_COUNT]) {
        for (s, &v) in scores.iter().enumerate() {
            out[at + 272 + 4 * s..at + 276 + 4 * s].copy_from_slice(&(v as f32).to_le_bytes());
        }
    }

    /// Reads one record from the front of `bytes`; returns it and its length.
    pub fn decode(bytes: &[u8]) -> Result<(RecordV3, usize), String> {
        if bytes.len() < HEADER_BYTES {
            return Err("record v3: truncated header".into());
        }
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u16_at = |at: usize| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
        let f32_at = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        if u32_at(0) != MAGIC {
            return Err("record v3: bad magic".into());
        }
        let len = u32_at(4) as usize;
        let n = u16_at(246) as usize;
        if len < HEADER_BYTES + 10 * n || bytes.len() < len {
            return Err("record v3: bad length".into());
        }
        let own = std::array::from_fn(|s| std::array::from_fn(|w| u32_at(16 + 52 * s + 4 * w)));
        let record = RecordV3 {
            game: u32_at(8),
            ply: u16_at(12),
            seat: bytes[14],
            source: bytes[15],
            own,
            hand: std::array::from_fn(|s| u32_at(224 + 4 * s)),
            last_piece: std::array::from_fn(|s| bytes[240 + s] as i8),
            chosen: u16_at(244),
            iterations: u32_at(248),
            root_visits: u32_at(252),
            root_values: std::array::from_fn(|s| f32_at(256 + 4 * s)),
            final_scores: std::array::from_fn(|s| f32_at(272 + 4 * s)),
            teacher: bytes[288],
            own_moves: bytes[289],
            seed: u32_at(292),
            visits: (0..n).map(|i| u32_at(HEADER_BYTES + 4 * i)).collect(),
            priors: (0..n).map(|i| f32_at(HEADER_BYTES + 4 * n + 4 * i)).collect(),
            moves: (0..n).map(|i| u16_at(HEADER_BYTES + 8 * n + 2 * i)).collect(),
        };
        Ok((record, len))
    }

    /// The layout as JSON, for `meta.json`.
    pub fn layout_json() -> serde_json::Value {
        serde_json::json!({
            "format": "v3",
            "magic": "BKR3",
            "headerBytes": HEADER_BYTES,
            "header": {
                "magic": [0, "u32"], "length": [4, "u32, whole record incl. padding to 4"],
                "game": [8, "u32"], "ply": [12, "u16"], "seat": [14, "u8"],
                "source": [15, "u8 (0 search, 1 opening heuristic, 2 packer, 3 greedy, 4 teacher move)"],
                "own": [16, "4 x 13 u32 bitboards, seats in turn order (blue, green, purple, yellow)"],
                "hand": [224, "4 x u32 piece masks"], "lastPiece": [240, "4 x i8"],
                "chosen": [244, "u16 placement id"], "n": [246, "u16 moves listed (every legal move)"],
                "iterations": [248, "u32"], "rootVisits": [252, "u32 real visits"],
                "rootValues": [256, "4 x f32 root mean value per seat (reward units), NaN if not a search"],
                "finalScores": [272, "4 x f32 per seat"], "teacher": [288, "u8: 0 self-play, k Pentobi level k"],
                "ownMoves": [289, "u8 pieces the mover has placed"], "reserved": [290, "u16"], "seed": [292, "u32"],
            },
            "arrays": "after the header: n x u32 visits (real), n x f32 root prior, n x u16 placement ids; zero padding to a multiple of 4",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let r = RecordV3 {
            game: 7,
            ply: 13,
            seat: 2,
            source: SOURCE_SEARCH,
            own: std::array::from_fn(|s| std::array::from_fn(|w| (s * 100 + w) as u32)),
            hand: [1, 2, 3, 4],
            last_piece: [-1, 3, 20, 0],
            chosen: 512,
            iterations: 7000,
            root_visits: 7000,
            root_values: [0.1, 0.2, f32::NAN, 0.4],
            final_scores: [0.0; 4],
            teacher: 0,
            own_moves: 3,
            seed: 105_000_007,
            moves: vec![512, 3, 9000],
            visits: vec![6000, 999, 1],
            priors: vec![0.5, 0.25, 0.25],
        };
        let mut out = Vec::new();
        r.encode(&mut out);
        assert_eq!(out.len(), r.len());
        assert_eq!(out.len() % 4, 0);
        RecordV3::patch_scores(&mut out, 0, &[10.0, -3.0, 5.0, 20.0]);
        let (back, len) = RecordV3::decode(&out).unwrap();
        assert_eq!(len, out.len());
        assert_eq!(back.moves, r.moves);
        assert_eq!(back.visits, r.visits);
        assert_eq!(back.priors, r.priors);
        assert_eq!(back.own, r.own);
        assert_eq!(back.final_scores, [10.0, -3.0, 5.0, 20.0]);
        assert!(back.root_values[2].is_nan());
        assert_eq!((back.game, back.ply, back.seat, back.chosen, back.seed, back.own_moves), (7, 13, 2, 512, 105_000_007, 3));
    }
}
