use near_sdk::env;

pub fn hx(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn nib(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    let mut o = Vec::with_capacity(b.len() / 2);
    for c in b.chunks(2) {
        o.push(nib(c[0])? << 4 | nib(c[1])?);
    }
    Some(o)
}

pub fn unhex32(s: &str) -> Option<[u8; 32]> {
    let v = unhex(s)?;
    v.try_into().ok()
}

pub fn must_unhex32(s: &str, what: &str) -> [u8; 32] {
    unhex32(s).unwrap_or_else(|| env::panic_str(&format!("{what}: expected 32-byte hex")))
}
