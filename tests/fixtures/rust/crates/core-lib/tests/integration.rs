use core_engine::service;
use std::path::PathBuf;

#[test]
fn reads_a_record() {
    let _ = service::read();
    let _ = PathBuf::new();
}
