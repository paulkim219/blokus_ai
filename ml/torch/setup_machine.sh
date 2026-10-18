#!/bin/zsh
# One-time setup for running the v6 pipeline (self-play, training, E4) on a fresh clone.
# Linux, WSL2 or macOS. Native Windows is not supported: the prior server and the engine talk
# over a Unix socket. Steps are idempotent; re-run after pulling.
#
#   zsh ml/torch/setup_machine.sh
set -eu
cd "$(dirname "$0")/../.."
need() { command -v $1 >/dev/null || { echo "missing: $1 — $2"; exit 1; }; }
need cargo "install Rust from https://rustup.rs"
need node "install Node 22+ (https://nodejs.org or nvm)"
need python3.12 "install Python 3.12 (apt install python3.12 python3.12-venv, or pyenv)"
need bc "apt install bc"

echo "== npm dependencies"; npm ci --silent
echo "== native engine"; cargo build --release --manifest-path engine-rs/Cargo.toml
echo "== parity fixtures (recorded on macOS arm64; see the runbook if a float comparison fails here)"
cargo test --release --manifest-path engine-rs/Cargo.toml || echo "!! parity tests failed — read docs/E4_RUNBOOK.md, 'Parity on another platform'"

echo "== python venv"
[ -x ml/.venv-torch/bin/python ] || python3.12 -m venv ml/.venv-torch
ml/.venv-torch/bin/pip install -q --upgrade pip
ml/.venv-torch/bin/python -c "import torch" 2>/dev/null || ml/.venv-torch/bin/pip install -q -r ml/torch/requirements.txt
ml/.venv-torch/bin/pip install -q numpy==2.5.4

mkdir -p ml/data
engine-rs/target/release/blokee-tables > ml/data/placements.json
ml/.venv-torch/bin/python - <<'PY'
import sys; sys.path.insert(0, "ml/torch")
from train import device
import torch
d = device(); x = torch.randn(1024, 1024, device=d); (x @ x).sum().item()
print(f"== torch {torch.__version__} on {d}" + (f" ({torch.cuda.get_device_name()})" if d.type == "cuda" else ""))
if d.type == "cpu": print("!! no GPU found: training will be very slow. Install the CUDA build of torch.")
PY
[ -d ml/data/selfplay-v41u-300 ] && echo "== base corpus present" || echo "!! ml/data/selfplay-v41u-300 missing — copy it (runbook step 3) or run E4 with BASE_RUN="
echo "setup complete"
