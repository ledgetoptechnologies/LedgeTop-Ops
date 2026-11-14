//! ltds-dji-decode <input-log> <output-json>
//!
//! Decodes one DJI flight log with dji-log-parser and writes `{ version, details, frames }` (the same shape as the
//! upstream `dji-log` CLI's JSON). Logs v13+ need keychains from the DJI Open API: the key is read from the file named
//! by DJI_API_KEY_FILE, never from argv, and is never printed. Nothing is written to stdout or stderr; the outcome is
//! the exit code, so no parser message can carry a key or log content anywhere.

use dji_log_parser::frame::{Frame, FrameDetails};
use dji_log_parser::{DJILog, Error};
use serde::Serialize;
use std::env;
use std::fs;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

/// Exit codes, mapped by the runner (src/parser.mjs) to the decode contract's closed vocabulary.
mod code {
    pub const OK: u8 = 0;
    pub const USAGE: u8 = 2;
    pub const INPUT_UNREADABLE: u8 = 3;
    pub const KEY_MISSING: u8 = 10;
    pub const KEY_REJECTED: u8 = 11;
    pub const DJI_UNAVAILABLE: u8 = 12;
    pub const NETWORK_UNAVAILABLE: u8 = 13;
    pub const CORRUPT_LOG: u8 = 20;
    pub const OUTPUT_UNWRITABLE: u8 = 30;
    pub const OTHER: u8 = 40;
}

#[derive(Serialize)]
struct Output<'a> {
    version: u8,
    details: FrameDetails,
    frames: &'a Vec<Frame>,
}

fn classify(error: &Error) -> u8 {
    match error {
        Error::ApiKeyError => code::KEY_REJECTED,
        Error::KeychainRequired => code::KEY_MISSING,
        Error::ApiError(_) => code::DJI_UNAVAILABLE,
        Error::NetworkRequestStatus(status) if *status == 429 || *status >= 500 => code::DJI_UNAVAILABLE,
        Error::NetworkRequestStatus(_) => code::KEY_REJECTED,
        Error::NetworkConnection => code::NETWORK_UNAVAILABLE,
        Error::Parse(_) | Error::Base64Decode(_) | Error::MissingAuxilliaryData(_) => code::CORRUPT_LOG,
        Error::Io(_) => code::INPUT_UNREADABLE,
        _ => code::OTHER,
    }
}

fn read_key() -> Result<String, u8> {
    let path = env::var("DJI_API_KEY_FILE").map_err(|_| code::KEY_MISSING)?;
    let key = fs::read_to_string(path).map_err(|_| code::KEY_MISSING)?;
    let key = key.trim().to_string();
    if key.is_empty() { Err(code::KEY_MISSING) } else { Ok(key) }
}

fn run(input: &str, output: &str) -> Result<(), u8> {
    let bytes = fs::read(input).map_err(|_| code::INPUT_UNREADABLE)?;
    let parser = DJILog::from_bytes(bytes).map_err(|e| classify(&e))?;
    let keychains = if parser.version >= 13 {
        let key = read_key()?;
        Some(parser.fetch_keychains(&key).map_err(|e| classify(&e))?)
    } else {
        None
    };
    let frames = parser.frames(keychains).map_err(|e| classify(&e))?;
    let out = Output { version: parser.version, details: parser.details.clone().into(), frames: &frames };
    let file = fs::File::create(output).map_err(|_| code::OUTPUT_UNWRITABLE)?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, &out).map_err(|_| code::OUTPUT_UNWRITABLE)?;
    writer.flush().map_err(|_| code::OUTPUT_UNWRITABLE)?;
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        return ExitCode::from(code::USAGE);
    }
    match run(&args[1], &args[2]) {
        Ok(()) => ExitCode::from(code::OK),
        Err(exit) => ExitCode::from(exit),
    }
}
