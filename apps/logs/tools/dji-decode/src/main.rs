//! Local test tool for Ledge Top Logs: decodes raw DJI flight logs with the MIT-licensed
//! `dji-log-parser` crate and prints one JSON summary per file. It never prints the API key,
//! keychains or full serial numbers.
//!
//! Usage: ltds-dji-decode <log.txt>...   (set LTDS_DJI_API_KEY in the environment for v13+ logs)
use dji_log_parser::DJILog;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::panic;

fn mask(serial: &str) -> String {
    let s = serial.trim();
    if s.is_empty() { String::new() } else { format!("…{}", &s[s.len().saturating_sub(4)..]) }
}

/// Counts the starts of each true run, e.g. how many photos were taken.
fn rising_edges(values: impl Iterator<Item = bool>) -> usize {
    let mut last = false;
    let mut count = 0;
    for v in values { if v && !last { count += 1; } last = v; }
    count
}

fn summarize(path: &str, api_key: Option<&str>) -> Value {
    let bytes = match std::fs::read(path) { Ok(b) => b, Err(e) => return json!({ "file": path, "ok": false, "error": format!("read: {e}") }) };
    let sha = hex::encode(Sha256::digest(&bytes));
    let parser = match DJILog::from_bytes(bytes) { Ok(p) => p, Err(e) => return json!({ "file": path, "sha256": sha, "ok": false, "error": format!("parse: {e}") }) };
    let d = &parser.details;
    let mut out = json!({
        "file": std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()),
        "sha256": sha, "version": parser.version,
        "aircraft": { "name": d.aircraft_name, "productType": format!("{:?}", d.product_type), "serial": mask(&d.aircraft_sn) },
        "battery": { "serial": mask(&d.battery_sn) }, "controller": { "serial": mask(&d.rc_sn) }, "camera": { "serial": mask(&d.camera_sn) },
        "app": { "platform": format!("{:?}", d.app_platform), "version": d.app_version },
        "startTime": d.start_time.to_rfc3339(),
        "header": { "totalTimeSeconds": d.total_time, "totalDistanceMeters": d.total_distance, "maxHeightMeters": d.max_height,
                    "maxHorizontalSpeed": d.max_horizontal_speed, "captureNum": d.capture_num, "videoTimeSeconds": d.video_time },
    });
    // Logs from version 13 on are encrypted; their keychains come from DJI's API with an Open API key.
    let keychains = if parser.version >= 13 {
        match api_key {
            None => { out["ok"] = json!(false); out["error"] = json!("needs a DJI Open API key (v13+ log)"); return out; }
            Some(key) => match parser.fetch_keychains(key) {
                Ok(k) => { out["keychainsFetched"] = json!(k.len()); Some(k) }
                Err(e) => { out["ok"] = json!(false); out["error"] = json!(format!("keychains: {e}")); return out; }
            },
        }
    } else { None };
    let frames = match parser.frames(keychains) { Ok(f) => f, Err(e) => { out["ok"] = json!(false); out["error"] = json!(format!("frames: {e}")); return out; } };
    let max_height = frames.iter().map(|f| f.osd.height).fold(f32::MIN, f32::max);
    let gps = frames.iter().filter(|f| f.osd.latitude != 0.0 && f.osd.longitude != 0.0).count();
    out["frames"] = json!({
        "count": frames.len(), "withGps": gps,
        "flyTimeSeconds": frames.last().map(|f| f.osd.fly_time),
        "maxHeightMeters": if frames.is_empty() { Value::Null } else { json!(max_height) },
        "photosFromFrames": rising_edges(frames.iter().map(|f| f.camera.is_photo)),
        "videoClipsFromFrames": rising_edges(frames.iter().map(|f| f.camera.is_video)),
        "minBatteryPercent": frames.iter().map(|f| f.battery.charge_level).filter(|v| *v > 0).min(),
    });
    out["ok"] = json!(true);
    out
}

fn main() {
    let api_key = std::env::var("LTDS_DJI_API_KEY").ok().filter(|k| !k.trim().is_empty());
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() { eprintln!("usage: ltds-dji-decode <log.txt>..."); std::process::exit(2); }
    // The parser can panic on damaged logs; report that file and carry on.
    panic::set_hook(Box::new(|_| {}));
    for file in files {
        let key = api_key.clone();
        let line = panic::catch_unwind(|| summarize(&file, key.as_deref()))
            .unwrap_or_else(|_| json!({ "file": file, "ok": false, "error": "parser panicked (damaged or unsupported log)" }));
        println!("{line}");
    }
}
