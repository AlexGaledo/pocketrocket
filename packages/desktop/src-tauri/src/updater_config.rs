//! Checks on `tauri.conf.json > plugins.updater`. `pubkey_is_set` is also used at runtime by update.rs.
//!
//! The committed config carries the placeholder pubkey `OWNER_STEP_PASTE_UPDATER_PUBKEY` until the owner pastes
//! the real minisign public key (`cargo tauri signer generate`; the private key never enters the repo). Local and
//! CI builds work with the placeholder because nothing checks for updates yet and `createUpdaterArtifacts` is not
//! set in the committed config.
//!
//! Tag-build gate: with `POCKETROCKET_RELEASE_TAG` set (the release workflow passes the tag name), the test
//! `release_tag_build_has_a_real_pubkey` fails while the placeholder is still there, so a release can never ship
//! an updater that trusts no key. Run it with:
//!   POCKETROCKET_RELEASE_TAG=vX.Y.Z cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml updater_config
//! (The call site in release.yml is added with the draft/finalize pipeline, task A2.)

use serde_json::Value;

pub const PUBKEY_PLACEHOLDER: &str = "OWNER_STEP_PASTE_UPDATER_PUBKEY";
pub const RELEASE_TAG_ENV: &str = "POCKETROCKET_RELEASE_TAG";
const ENDPOINT_PREFIX: &str = "https://github.com/AlexGaledo/Toki/releases/";

#[cfg(test)]
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

fn updater(conf: &Value) -> Result<&Value, String> {
    conf.pointer("/plugins/updater").ok_or_else(|| "tauri.conf.json has no plugins.updater".to_string())
}

/// Endpoints must be https on this repo's GitHub release path, so a config edit cannot point updates elsewhere.
pub fn check_endpoints(conf: &Value) -> Result<(), String> {
    let eps = updater(conf)?
        .get("endpoints")
        .and_then(Value::as_array)
        .ok_or("plugins.updater.endpoints is missing or not a list")?;
    if eps.is_empty() {
        return Err("plugins.updater.endpoints is empty".into());
    }
    for ep in eps {
        let s = ep.as_str().ok_or("an updater endpoint is not a string")?;
        if !s.starts_with(ENDPOINT_PREFIX) || !s.ends_with("/latest.json") || s.contains("..") || s.contains(char::is_whitespace) {
            return Err(format!("updater endpoint {s:?} is not https on {ENDPOINT_PREFIX}…/latest.json"));
        }
    }
    Ok(())
}

/// `Ok(true)` when a real-looking key is set, `Ok(false)` for the placeholder, `Err` when malformed.
/// A Tauri updater pubkey is the base64 of the minisign `.pub` file, so it is plain base64 and well over 40 chars.
pub fn pubkey_is_set(conf: &Value) -> Result<bool, String> {
    let key = updater(conf)?
        .get("pubkey")
        .and_then(Value::as_str)
        .ok_or("plugins.updater.pubkey is missing or not a string")?
        .trim();
    if key == PUBKEY_PLACEHOLDER {
        return Ok(false);
    }
    let base64 = key.len() >= 40 && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    if base64 { Ok(true) } else { Err("plugins.updater.pubkey is neither the placeholder nor a base64 minisign key".into()) }
}

/// The gate a tag build runs: fails while the placeholder (or a malformed key) is in the config.
pub fn check_for_release(conf: &Value) -> Result<(), String> {
    check_endpoints(conf)?;
    match pubkey_is_set(conf)? {
        true => Ok(()),
        false => Err(format!(
            "plugins.updater.pubkey is still {PUBKEY_PLACEHOLDER}: paste the public key from `cargo tauri signer generate` before tagging"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conf(pubkey: &str, endpoints: Value) -> Value {
        json!({ "plugins": { "updater": { "pubkey": pubkey, "endpoints": endpoints } } })
    }
    const EP: &str = "https://github.com/AlexGaledo/Toki/releases/latest/download/latest.json";
    // shape of a real key (base64 of a minisign .pub file); not a key anyone holds
    const FAKE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0RFRgpSV1RFU1RURVNUVEVTVA==";

    fn committed() -> Value {
        serde_json::from_str(TAURI_CONF).expect("tauri.conf.json parses")
    }

    #[test]
    fn committed_endpoint_is_https_on_the_github_release_path() {
        check_endpoints(&committed()).unwrap();
        assert_eq!(committed().pointer("/plugins/updater/endpoints/0").and_then(Value::as_str), Some(EP));
    }

    #[test]
    fn committed_pubkey_is_the_placeholder_or_a_real_key() {
        // never malformed; the placeholder is fine for local and CI builds
        pubkey_is_set(&committed()).unwrap();
    }

    #[test]
    fn committed_config_does_not_force_updater_artifacts() {
        // A2 turns this on with --config in tag builds only, so local builds need no signing key.
        assert!(committed().pointer("/bundle/createUpdaterArtifacts").is_none());
    }

    #[test]
    fn release_tag_build_has_a_real_pubkey() {
        match std::env::var(RELEASE_TAG_ENV) {
            Ok(tag) if !tag.trim().is_empty() => {
                if let Err(e) = check_for_release(&committed()) {
                    panic!("release {tag}: {e}");
                }
            }
            _ => {} // not a tag build
        }
    }

    #[test]
    fn placeholder_fails_the_release_gate() {
        let c = conf(PUBKEY_PLACEHOLDER, json!([EP]));
        assert_eq!(pubkey_is_set(&c), Ok(false));
        assert!(check_for_release(&c).unwrap_err().contains(PUBKEY_PLACEHOLDER));
    }

    #[test]
    fn real_looking_key_passes_the_release_gate() {
        check_for_release(&conf(FAKE_KEY, json!([EP]))).unwrap();
    }

    #[test]
    fn malformed_or_missing_keys_are_rejected() {
        assert!(pubkey_is_set(&conf("", json!([EP]))).is_err());
        assert!(pubkey_is_set(&conf("short", json!([EP]))).is_err());
        assert!(pubkey_is_set(&conf(&format!("{FAKE_KEY} x"), json!([EP]))).is_err());
        assert!(pubkey_is_set(&json!({ "plugins": { "updater": {} } })).is_err());
        assert!(pubkey_is_set(&json!({})).is_err());
    }

    #[test]
    fn endpoints_off_the_release_path_are_rejected() {
        for bad in [
            json!([]),
            json!(["http://github.com/AlexGaledo/Toki/releases/latest/download/latest.json"]),
            json!(["https://github.com/someone/else/releases/latest/download/latest.json"]),
            json!(["https://example.com/latest.json"]),
            json!(["https://github.com/AlexGaledo/Toki/releases/../../x/latest.json"]),
            json!([EP, "https://evil.example/latest.json"]),
            json!("not a list"),
        ] {
            assert!(check_endpoints(&conf(FAKE_KEY, bad.clone())).is_err(), "{bad}");
        }
    }
}
