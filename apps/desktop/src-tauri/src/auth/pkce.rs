//! PKCE (RFC 7636) helpers: code verifier and S256 challenge.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// A fresh code verifier: 64 random bytes, base64url without padding (86 characters, within the
/// 43–128 range of the RFC).
pub fn generate_verifier() -> String {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(verifier))` without padding (`code_challenge_method=s256`).
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifiers_are_valid_and_unique() {
        let a = generate_verifier();
        let b = generate_verifier();
        assert_ne!(a, b);
        assert!((43..=128).contains(&a.len()), "{}", a.len());
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let c = challenge(&a);
        assert_eq!(c.len(), 43);
        assert!(!c.contains('='));
    }
}
