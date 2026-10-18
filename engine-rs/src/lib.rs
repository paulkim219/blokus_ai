//! Native port of the Blokee bitboard engine (`src/ai/bitboard/`).
//!
//! The port's first contract is exactness: for every config it accepts, a seeded game must replay
//! move-for-move what the TS engine plays, so that native workers can drop into the existing match
//! harness without changing any number it reports. `tests/parity.rs` holds it to that against
//! fixtures dumped from the TS engine by `scripts/dumpGoldens.ts`.

pub mod backup;
pub mod bitboard;
pub mod config;
pub mod engine;
pub mod features;
pub mod game;
pub mod jsmath;
pub mod ordering;
pub mod packer;
pub mod placements;
pub mod playout;
pub mod position;
pub mod prior;
pub mod regions;
pub mod rng;
pub mod rollout_policy;
pub mod search;
pub mod territory;
