# Hybrid H0: environment for the in-process `ort` evaluator on Linux (source it from the repo root).
#   source engine-rs/scripts/h0-env.sh [venv]        (default ml/.venv-hybrid)
# ONNX Runtime and the CUDA 13 / cuDNN 9 libraries come from the venv's pip wheels
# (onnxruntime-gpu==1.31.1, torch==2.14.1+cu130), so Rust and Python run the same ONNX Runtime build.
H0_VENV=${1:-ml/.venv-hybrid}
H0_SITE=$(cd "$H0_VENV/lib/python3.12/site-packages" && pwd)
export ORT_DYLIB_PATH=$H0_SITE/onnxruntime/capi/libonnxruntime.so.1.31.1
export LD_LIBRARY_PATH=$H0_SITE/onnxruntime/capi:$H0_SITE/nvidia/cu13/lib:$H0_SITE/nvidia/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
