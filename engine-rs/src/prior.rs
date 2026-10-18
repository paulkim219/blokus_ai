//! Learned root prior served over a Unix socket (experiment E3a).
//!
//! The search sends one 512-byte request per root — the same record layout `blokee-selfplay`
//! writes, so the server decodes it with the exact encoder the network was trained through — and
//! reads back 64 little-endian f32 logits, one per candidate slot. `ml/torch/serve.py` batches
//! requests across every connected worker before running the network.

use crate::bitboard::WORDS;
use crate::position::{Position, SEAT_COUNT};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

pub const REQUEST_BYTES: usize = 512;
pub const MAX_CANDIDATES: usize = 64;

/// Native-only extension of a config. TS never sees it: a config carrying it can only be played by
/// the native engine, which is the point — the TS engine has no way to honour it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorOptions {
    /// Unix socket of a running `ml/torch/serve.py`.
    pub socket: String,
    /// Probability-space blend: 0 is the hand prior, 1 the network's.
    pub blend: f64,
    /// Softmax temperature over the network's logits.
    pub temperature: f64,
    /// "all", "openingMidgame" or "endgame".
    #[serde(default = "all_phases")]
    pub phase: String,
    /// Pseudo-visits added to the root ranking in proportion to the (blended) prior.
    #[serde(default)]
    pub pseudo_visits: f64,
}

fn all_phases() -> String {
    "all".into()
}

pub struct PriorClient {
    stream: UnixStream,
}

impl PriorClient {
    pub fn connect(path: &str) -> Result<PriorClient, String> {
        let stream = UnixStream::connect(path).map_err(|e| format!("prior server at {path}: {e}"))?;
        Ok(PriorClient { stream })
    }

    /// Logits for `moves` at `position` with `seat` to move.
    pub fn logits(&mut self, position: &Position, seat: usize, moves: &[i32]) -> Result<Vec<f32>, String> {
        let mut request = [0u8; REQUEST_BYTES];
        request[6] = seat as u8;
        let mut at = 8;
        for s in 0..SEAT_COUNT {
            for w in 0..WORDS {
                request[at..at + 4].copy_from_slice(&position.own[s][w].to_le_bytes());
                at += 4;
            }
        }
        for s in 0..SEAT_COUNT {
            request[at..at + 4].copy_from_slice(&position.hand[s].to_le_bytes());
            at += 4;
        }
        for s in 0..SEAT_COUNT {
            request[at] = position.last_piece[s] as i8 as u8;
            at += 1;
        }
        let n = moves.len().min(MAX_CANDIDATES);
        request[236] = n as u8;
        for (i, &mv) in moves.iter().take(n).enumerate() {
            request[240 + 2 * i..242 + 2 * i].copy_from_slice(&(mv as u16).to_le_bytes());
            request[368 + 2 * i..370 + 2 * i].copy_from_slice(&1u16.to_le_bytes());
        }
        self.stream.write_all(&request).map_err(|e| format!("prior request: {e}"))?;
        let mut response = [0u8; 4 * MAX_CANDIDATES];
        self.stream.read_exact(&mut response).map_err(|e| format!("prior response: {e}"))?;
        Ok((0..n).map(|i| f32::from_le_bytes(response[4 * i..4 * i + 4].try_into().unwrap())).collect())
    }
}
