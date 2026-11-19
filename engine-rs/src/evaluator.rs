//! Network evaluators (hybrid H0; `research_paper/v5_hybrid_cpu_gpu_plan.md`).
//!
//! An [`Evaluator`] turns request records (`prior::encode_request`) into protocol-2 outputs
//! ([`NetOutput`]: 64 logits by candidate slot and 12 utilities). Implementations:
//!
//! - **none**: no `native.net` block. Nothing here is constructed and the engine is today's engine.
//! - **socket**: `native.net` without an `evaluator` key: [`NetClient`] talking to
//!   `ml/torch/serve.py --protocol 2`, exactly as before H0.
//! - **ort**: `native.net.evaluator` with `backend` "ort": the network exported by
//!   `ml/torch/onnx_export.py`, run in-process by ONNX Runtime through the `ort` crate, with the
//!   inputs encoded in Rust (`net_features`). `device` "cuda" (CUDA provider), "cpu" (CPU
//!   provider) or "coreml" (CoreML provider; feature `ort-coreml`, written for the Mac, not
//!   measured in H0). Needs the cargo feature `ort`; ONNX Runtime itself is loaded at run time
//!   from `library` or `ORT_DYLIB_PATH` (feature `load-dynamic`).
//!
//! Calls are synchronous: `evaluate` returns when the batch is done. Engines in one process that
//! name the same model and device share one ONNX Runtime session (behind a mutex).

use crate::net::{NetClient, NetOptions, NetOutput, UTILITIES};
use crate::prior::{MAX_CANDIDATES, REQUEST_BYTES};
use serde::{Deserialize, Serialize};

pub trait Evaluator: Send {
    /// Protocol-2 outputs for `records`, one per record, logits truncated to `candidates[i]`.
    fn evaluate(&mut self, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]) -> Result<Vec<NetOutput>, String>;

    /// Short description for logs ("socket /tmp/x.sock", "ort cuda:0 model.onnx").
    fn describe(&self) -> String;
}

/// `native.net.evaluator`. Absent: the socket (`native.net.socket`), as before H0.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorOptions {
    /// "ort" (the only in-process backend so far).
    pub backend: String,
    /// The ONNX file (`ml/torch/onnx_export.py`), relative to the working directory.
    pub model: String,
    /// "cuda", "cpu" or "coreml".
    #[serde(default = "cpu_device")]
    pub device: String,
    #[serde(default)]
    pub device_id: i32,
    /// Intra-op threads of the session; 0 leaves ONNX Runtime's default (one per physical core).
    #[serde(default)]
    pub threads: usize,
    /// CUDA provider TF32 (off by default: an fp32 model then runs in fp32).
    #[serde(default)]
    pub tf32: bool,
    /// ONNX Runtime shared library; None reads `ORT_DYLIB_PATH`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
}

fn cpu_device() -> String {
    "cpu".into()
}

impl EvaluatorOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.backend != "ort" {
            return Err(format!("native.net.evaluator.backend {:?} (only \"ort\")", self.backend));
        }
        if !matches!(self.device.as_str(), "cuda" | "cpu" | "coreml") {
            return Err(format!("native.net.evaluator.device {:?} (\"cuda\", \"cpu\" or \"coreml\")", self.device));
        }
        if self.model.is_empty() {
            return Err("native.net.evaluator.model is empty".into());
        }
        Ok(())
    }
}

impl Evaluator for NetClient {
    fn evaluate(&mut self, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]) -> Result<Vec<NetOutput>, String> {
        NetClient::evaluate(self, records, candidates)
    }

    fn describe(&self) -> String {
        "socket".into()
    }
}

/// The evaluator a `native.net` block asks for: in-process when it has an `evaluator`, else its socket.
pub fn connect(options: &NetOptions) -> Result<Box<dyn Evaluator>, String> {
    match &options.evaluator {
        None => Ok(Box::new(NetClient::connect(&options.socket)?)),
        Some(e) => open(e),
    }
}

/// An in-process evaluator.
pub fn open(options: &EvaluatorOptions) -> Result<Box<dyn Evaluator>, String> {
    options.validate()?;
    #[cfg(all(feature = "ort", not(target_arch = "wasm32")))]
    {
        Ok(Box::new(ort_backend::OrtEvaluator::open(options)?))
    }
    #[cfg(not(all(feature = "ort", not(target_arch = "wasm32"))))]
    {
        Err("native.net.evaluator needs a build with the cargo feature \"ort\"".into())
    }
}

/// Splits a flat (B × 76) protocol-2 output into [`NetOutput`]s, logits truncated per record.
pub fn split_outputs(logits: &[f32], utilities: &[f32], candidates: &[usize]) -> Vec<NetOutput> {
    candidates
        .iter()
        .enumerate()
        .map(|(i, &n)| NetOutput {
            logits: logits[i * MAX_CANDIDATES..i * MAX_CANDIDATES + n.min(MAX_CANDIDATES)].to_vec(),
            utility: std::array::from_fn(|u| utilities[i * UTILITIES + u]),
        })
        .collect()
}

#[cfg(all(feature = "ort", not(target_arch = "wasm32")))]
pub mod ort_backend {
    use super::{EvaluatorOptions, Evaluator, split_outputs};
    use crate::net::{NetOutput, UTILITIES};
    use crate::net_features::{FOOTPRINT, HAND_BITS, Inputs, PLANES};
    use crate::position::SEAT_COUNT;
    use crate::prior::{MAX_CANDIDATES, REQUEST_BYTES};
    use ort::environment::Environment;
    use ort::session::Session;
    use ort::value::TensorRef;
    use std::sync::{Arc, Mutex, OnceLock};

    static ENVIRONMENT: OnceLock<Result<Environment, String>> = OnceLock::new();
    #[allow(clippy::type_complexity)]
    static SESSIONS: Mutex<Vec<(EvaluatorOptions, Arc<Mutex<Session>>)>> = Mutex::new(Vec::new());

    /// The process's ONNX Runtime environment, loading the library on first use.
    pub fn environment(library: Option<&str>) -> Result<&'static Environment, String> {
        ENVIRONMENT
            .get_or_init(|| {
                let path = match library {
                    Some(p) => p.to_string(),
                    None => std::env::var("ORT_DYLIB_PATH").map_err(|_| {
                        "ONNX Runtime library: set native.net.evaluator.library or ORT_DYLIB_PATH".to_string()
                    })?,
                };
                ort::init_from(&path)
                    .map_err(|e| format!("loading ONNX Runtime from {path}: {e}"))?
                    .with_name("blokee")
                    .build()
                    .map_err(|e| format!("ONNX Runtime environment: {e}"))
            })
            .as_ref()
            .map_err(|e| e.clone())
    }

    /// A new session (not shared). Benches use this to time one configuration at a time.
    pub fn new_session(options: &EvaluatorOptions) -> Result<Session, String> {
        let env = environment(options.library.as_deref())?;
        let err = |what: &str, e: &dyn std::fmt::Display| format!("ort {what} ({} {}): {e}", options.device, options.model);
        let mut builder = Session::builder(env).map_err(|e| err("session builder", &e))?;
        if options.threads > 0 {
            builder = builder.with_intra_threads(options.threads).map_err(|e| err("threads", &e))?;
        }
        let provider = match options.device.as_str() {
            "cuda" => ort::ep::CUDA::default()
                .with_device_id(options.device_id)
                .with_tf32(options.tf32)
                .build()
                .error_on_failure(),
            #[cfg(feature = "ort-coreml")]
            "coreml" => ort::ep::CoreML::default().build().error_on_failure(),
            #[cfg(not(feature = "ort-coreml"))]
            "coreml" => return Err("device \"coreml\" needs the cargo feature \"ort-coreml\"".into()),
            _ => ort::ep::CPU::default().build().error_on_failure(),
        };
        builder = builder.with_execution_providers([provider]).map_err(|e| err("execution provider", &e))?;
        builder.commit_from_file(&options.model).map_err(|e| err("loading model", &e))
    }

    /// The session shared by every engine in this process with the same options.
    fn shared_session(options: &EvaluatorOptions) -> Result<Arc<Mutex<Session>>, String> {
        let mut sessions = SESSIONS.lock().unwrap();
        if let Some((_, s)) = sessions.iter().find(|(o, _)| o == options) {
            return Ok(Arc::clone(s));
        }
        let session = Arc::new(Mutex::new(new_session(options)?));
        sessions.push((options.clone(), Arc::clone(&session)));
        Ok(session)
    }

    /// Runs `inputs` through `session`: (B × 64 logits, B × 12 utilities).
    pub fn run(session: &mut Session, inputs: &Inputs) -> Result<(Vec<f32>, Vec<f32>), String> {
        let b = inputs.batch;
        let e = |e: ort::Error| format!("ort run: {e}");
        let outputs = session
            .run(ort::inputs![
                "planes" => TensorRef::from_array_view(([b, PLANES, 20, 20], &inputs.planes[..])).map_err(e)?,
                "hands" => TensorRef::from_array_view(([b, SEAT_COUNT, HAND_BITS], &inputs.hands[..])).map_err(e)?,
                "footprint" => TensorRef::from_array_view(([b, MAX_CANDIDATES, FOOTPRINT], &inputs.footprint[..])).map_err(e)?,
                "pieces" => TensorRef::from_array_view(([b, MAX_CANDIDATES], &inputs.pieces[..])).map_err(e)?,
                "mask" => TensorRef::from_array_view(([b, MAX_CANDIDATES], &inputs.mask[..])).map_err(e)?,
                "seat" => TensorRef::from_array_view(([b], &inputs.seat[..])).map_err(e)?,
            ])
            .map_err(e)?;
        let (_, logits) = outputs["logits"].try_extract_tensor::<f32>().map_err(e)?;
        let (_, utilities) = outputs["utilities"].try_extract_tensor::<f32>().map_err(e)?;
        if logits.len() != b * MAX_CANDIDATES || utilities.len() != b * UTILITIES {
            return Err(format!("ort run: output sizes {} and {} for batch {b}", logits.len(), utilities.len()));
        }
        Ok((logits.to_vec(), utilities.to_vec()))
    }

    pub struct OrtEvaluator {
        options: EvaluatorOptions,
        session: Arc<Mutex<Session>>,
        inputs: Inputs,
    }

    impl OrtEvaluator {
        pub fn open(options: &EvaluatorOptions) -> Result<OrtEvaluator, String> {
            Ok(OrtEvaluator { options: options.clone(), session: shared_session(options)?, inputs: Inputs::with_capacity(64) })
        }
    }

    impl Evaluator for OrtEvaluator {
        fn evaluate(&mut self, records: &[[u8; REQUEST_BYTES]], candidates: &[usize]) -> Result<Vec<NetOutput>, String> {
            if records.is_empty() {
                return Ok(Vec::new());
            }
            self.inputs.clear();
            for record in records {
                self.inputs.push_record(record);
            }
            let (logits, utilities) = run(&mut self.session.lock().unwrap(), &self.inputs)?;
            Ok(split_outputs(&logits, &utilities, candidates))
        }

        fn describe(&self) -> String {
            format!("ort {}:{} {}", self.options.device, self.options.device_id, self.options.model)
        }
    }
}
