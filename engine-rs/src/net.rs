//! The network as a second evaluator inside the rollout search (experiment E6), wire protocol 2.
//!
//! `native.net` replaces `native.prior` when a config wants more than the root prior. Per searched
//! move the search makes one batched call: record 0 is the root (exactly the record the prior client
//! sends), then, when a depth-1 or value channel is on, one record per non-terminal root child.
//!
//! Protocol 2 (`ml/torch/serve.py --protocol 2`): requests are the same 512-byte records as
//! protocol 1 and may be pipelined; responses come back in request order, each 76 little-endian
//! f32 — 64 policy logits by candidate slot, then 12 utilities laid out as relative seat
//! r = 0..3 × [margin, rank, first], each a probability. Relative seat r is absolute seat
//! (mover + r) % 4.

use crate::prior::{MAX_CANDIDATES, REQUEST_BYTES};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

pub const UTILITIES: usize = 12;
pub const RESPONSE_FLOATS: usize = MAX_CANDIDATES + UTILITIES;
pub const RESPONSE_BYTES: usize = 4 * RESPONSE_FLOATS;

/// `native.net`. With `depth1Blend` 0 and `valueVisits` 0 it is the `native.prior` root prior
/// (phase "all", no pseudo-visits) and sends one record per searched move.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetOptions {
    /// Unix socket of a running `ml/torch/serve.py --protocol 2`.
    pub socket: String,
    /// Root prior: probability-space blend, 0 the hand prior, 1 the network's.
    #[serde(default = "half")]
    pub root_blend: f64,
    /// Root prior: softmax temperature over the network's logits.
    #[serde(default = "one")]
    pub temperature: f64,
    /// Depth-1 policy: blend into each root child's own prior, after which its moves are re-sorted.
    #[serde(default)]
    pub depth1_blend: f64,
    #[serde(default = "one")]
    pub depth1_temperature: f64,
    /// Root-child value: virtual visits `n_v` of the re-centred network utility in root selection.
    #[serde(default)]
    pub value_visits: f64,
}

fn half() -> f64 {
    0.5
}

fn one() -> f64 {
    1.0
}

impl NetOptions {
    /// Whether the call needs a record per root child (any channel beyond the root prior).
    pub fn wants_children(&self) -> bool {
        self.depth1_blend > 0.0 || self.value_visits > 0.0
    }
}

/// One position's network output.
#[derive(Clone, Debug)]
pub struct NetOutput {
    /// Logits by candidate slot, truncated to the candidates sent.
    pub logits: Vec<f32>,
    /// Relative seat r × [margin, rank, first].
    pub utility: [f32; UTILITIES],
}

impl NetOutput {
    /// `[margin, rank]` for absolute `seat` when `mover` is to move in the evaluated position.
    pub fn margin_rank(&self, mover: usize, seat: usize) -> (f64, f64) {
        let r = (seat + 4 - mover) % 4;
        (self.utility[3 * r] as f64, self.utility[3 * r + 1] as f64)
    }
}

pub struct NetClient {
    stream: UnixStream,
    writer: UnixStream,
}

impl NetClient {
    pub fn connect(path: &str) -> Result<NetClient, String> {
        let stream = UnixStream::connect(path).map_err(|e| format!("net server at {path}: {e}"))?;
        let writer = stream.try_clone().map_err(|e| format!("net server at {path}: {e}"))?;
        Ok(NetClient { stream, writer })
    }

    /// Evaluates `records` (each with `candidates[i]` moves sent) in one pipelined exchange.
    ///
    /// More than one record is written from a scoped thread while this one reads, so neither side
    /// can stall on a full socket buffer whatever the server's read/write interleaving is.
    pub fn evaluate(&mut self, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]) -> Result<Vec<NetOutput>, String> {
        let k = records.len();
        let mut response = vec![0u8; k * RESPONSE_BYTES];
        if k == 1 {
            self.writer.write_all(&records[0]).map_err(|e| format!("net request: {e}"))?;
            self.stream.read_exact(&mut response).map_err(|e| format!("net response: {e}"))?;
        } else if k > 1 {
            let payload: Vec<u8> = records.iter().flat_map(|r| r.iter().copied()).collect();
            let writer = &mut self.writer;
            let stream = &mut self.stream;
            std::thread::scope(|scope| -> Result<(), String> {
                let sent = scope.spawn(move || writer.write_all(&payload).map_err(|e| format!("net request: {e}")));
                let read = stream.read_exact(&mut response).map_err(|e| format!("net response: {e}"));
                sent.join().map_err(|_| "net writer panicked".to_string())??;
                read
            })?;
        }
        Ok((0..k)
            .map(|i| {
                let at = i * RESPONSE_BYTES;
                let f = |j: usize| f32::from_le_bytes(response[at + 4 * j..at + 4 * j + 4].try_into().unwrap());
                let n = candidates[i].min(MAX_CANDIDATES);
                NetOutput { logits: (0..n).map(f).collect(), utility: std::array::from_fn(|u| f(MAX_CANDIDATES + u)) }
            })
            .collect())
    }
}
