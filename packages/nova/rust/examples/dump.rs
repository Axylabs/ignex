//! Debug helper: build a Quote, finish size-prefixed, dump hex, read back.
//! Run: cargo run --manifest-path rust/Cargo.toml --example dump --release
use flatbuffers::FlatBufferBuilder;

use ignex_ffi::generated::backend::{Quote, QuoteArgs};

fn main() {
    let mut fbb = FlatBufferBuilder::new();
    let symbol = fbb.create_string("AAPL");
    let quote = Quote::create(
        &mut fbb,
        &QuoteArgs {
            symbol: Some(symbol),
            bid: 180.25,
            ask: 180.3,
            bid_size: 100,
            ask_size: 200,
            ts: 1720000000000,
            ..Default::default()
        },
    );
    fbb.finish_size_prefixed(quote, Some("IGNX"));
    let data = fbb.finished_data();
    println!("len {}", data.len());
    let n = data.len().min(32);
    let hex: Vec<String> = data[..n].iter().map(|b| format!("{:02x}", b)).collect();
    println!("hex {}", hex.join(" "));

    let q = flatbuffers::size_prefixed_root::<Quote>(data).expect("read back");
    println!(
        "read symbol={:?} bid={} ask={} bid_size={} ask_size={} ts={}",
        q.symbol(),
        q.bid(),
        q.ask(),
        q.bid_size(),
        q.ask_size(),
        q.ts()
    );
}
