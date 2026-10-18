//! Writes the placement table as JSON for the Python trainers, so placement ids in self-play
//! records are decoded by the engine's own geometry rather than a re-derivation.
//!
//!   blokee-tables > ../ml/data/placements.json
use blokee::placements::{RAW_PIECES, placements};
use serde_json::json;

fn main() {
    let t = placements();
    let cells: Vec<Vec<i32>> = (0..t.count)
        .map(|p| t.cell_list[t.cell_start[p] as usize..t.cell_start[p + 1] as usize].to_vec())
        .collect();
    let out = json!({
        "count": t.count,
        "pieceNames": RAW_PIECES.iter().map(|p| p.0).collect::<Vec<_>>(),
        "piece": t.piece_id,
        "orientation": t.orientation,
        "size": t.size,
        "cells": cells,
    });
    println!("{out}");
}
