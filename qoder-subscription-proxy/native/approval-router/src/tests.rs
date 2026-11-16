use super::*;
use std::sync::Mutex;
static ABI_LOCK: Mutex<()> = Mutex::new(());

fn body(prefix: &str, effort: &str) -> Value {
    json!({"input": [
        {"role": "system", "content": [{"type": "input_text", "text": format!("{prefix} Return JSON.")}]},
        {"role": "user", "content": [{"type": "input_text", "text": "synthetic command"}]}
    ], "reasoning": {"effort": effort}})
}
fn request(provider: &str, model: &str, body: &Value) -> Value {
    json!({"AvailableProviders": [provider], "RequestedModel": model, "SourceFormat": "openai-response",
        "Body": STANDARD.encode(serde_json::to_vec(body).unwrap()), "host_callback_id": "test"})
}
fn catalog(provider: &str, model: &str) -> Value {
    json!({"credentials": [{"provider": provider, "models": [model]}]})
}

#[test]
fn codex_independent_approval_keeps_original_scope() {
    for prefix in CLASSIFIERS {
        for effort in ["none", "low"] {
            for role in ["system", "developer"] {
                let mut payload = body(prefix, effort);
                payload["input"][0]["role"] = json!(role);
                let req = request("codex", "gpt-test", &payload);
                assert!(approval_request(&req).is_some());
                let route =
                    approval_route(&req, &payload, "gpt-test", &catalog("codex", "gpt-test"));
                assert_eq!(route["Target"], "codex");
                assert_eq!(route["TargetModel"], "codex-auto-review(low)");
            }
        }
    }
}

#[test]
fn ordinary_or_modified_requests_are_not_redirected() {
    let initial = body(CLASSIFIERS[0], "low");
    for change in 0..10 {
        let mut payload = initial.clone();
        let mut req = request("codex", "gpt-test", &payload);
        match change {
            0 => payload["reasoning"]["effort"] = json!("high"),
            1 => payload["reasoning"] = Value::Null,
            2 => payload["tools"] = json!([{"name": "read_file"}]),
            3 => payload["tools"] = json!({"invalid": true}),
            4 => payload["input"][0]["role"] = json!("user"),
            5 => {
                payload["input"][0]["content"][0]["text"] = json!("Explain security classification")
            }
            6 => payload["input"]
                .as_array_mut()
                .unwrap()
                .push(json!({"role":"user","content":"extra"})),
            7 => payload["instructions"] = json!("unrelated instructions"),
            8 => req["SourceFormat"] = json!("openai"),
            _ => req["RequestedModel"] = json!("other-model"),
        }
        req["Body"] = json!(STANDARD.encode(serde_json::to_vec(&payload).unwrap()));
        assert!(approval_request(&req).is_none(), "case {change}");
    }
}

#[test]
fn google_approval_never_routes_to_gemini_reviewer() {
    for provider in [
        "antigravity",
        "gemini",
        "aistudio",
        "vertex",
        "antigravity-acp",
    ] {
        for model in ["gemini-test", "claude-test", "gpt-test"] {
            let payload = body(CLASSIFIERS[0], "low");
            let req = request(provider, model, &payload);
            assert!(approval_request(&req).is_none());
            assert_eq!(
                approval_route(&req, &payload, model, &catalog(provider, model))["Handled"],
                false
            );
        }
    }
}

#[test]
fn ambiguous_catalog_does_not_change_provider() {
    let mixed = json!({"credentials":[{"provider":"codex","models":["gpt-test"]}, {"provider":"antigravity","models":["gpt-test"]}]});
    assert_eq!(provider_for_catalog("gpt-test", &mixed), None);
    assert_eq!(
        provider_for_catalog("gpt-test(low)", &catalog("codex", "gpt-test")),
        Some("codex")
    );
    assert_eq!(provider_for_catalog("gpt-test", &json!({})), None);
}

#[test]
fn malformed_requests_do_not_route() {
    for req in [
        json!({}),
        json!({"AvailableProviders":["codex"],"Body":"!"}),
        json!({"AvailableProviders":null}),
    ] {
        assert!(approval_request(&req).is_none());
    }
}

#[test]
fn no_response_interceptors_or_continuation_capabilities_remain() {
    let registration = handle("plugin.register", b"{}").unwrap();
    assert_eq!(registration["capabilities"], json!({"model_router":true}));
    for method in [
        "response.intercept_stream_chunk",
        "response.intercept_after",
        "request.complete",
    ] {
        assert!(handle(method, b"{}").is_err());
    }
}

#[test]
fn routing_logs_never_include_prompts() {
    let payload = body(CLASSIFIERS[0], "low");
    let req = request("codex", "gpt-test", &payload);
    let route = approval_route(&req, &payload, "gpt-test", &catalog("codex", "gpt-test"));
    let log = route_log(&req, &route).to_string();
    assert!(!log.contains("synthetic command"));
    assert!(!log.contains("Body"));
}

unsafe extern "C" fn host_call(
    _: *mut c_void,
    _: *const c_char,
    _: *const u8,
    _: usize,
    _: *mut Buffer,
) -> i32 {
    1
}
unsafe extern "C" fn host_free(_: *mut c_void, _: usize) {}

#[test]
fn abi_initialization_buffer_ownership_and_reinitialization() {
    let _lock = ABI_LOCK.lock().unwrap();
    unsafe {
        plugin_shutdown();
        let host = HostApi {
            abi_version: ABI_VERSION,
            host_ctx: ptr::null_mut(),
            call: Some(host_call),
            free_buffer: Some(host_free),
        };
        let mut plugin = PluginApi {
            abi_version: 0,
            call: None,
            free_buffer: None,
            shutdown: None,
        };
        assert_eq!(cliproxy_plugin_init(ptr::null(), &mut plugin), 1);
        assert_eq!(cliproxy_plugin_init(&host, &mut plugin), 0);
        assert_eq!(cliproxy_plugin_init(&host, &mut plugin), 1);
        let mut response = Buffer {
            ptr: ptr::null_mut(),
            len: 0,
        };
        assert_eq!(
            plugin.call.unwrap()(
                c"plugin.register".as_ptr(),
                b"{}".as_ptr(),
                2,
                &mut response
            ),
            0
        );
        let decoded: Value =
            serde_json::from_slice(std::slice::from_raw_parts(response.ptr, response.len)).unwrap();
        assert_eq!(decoded["ok"], true);
        assert_eq!(decoded["result"]["capabilities"]["model_router"], true);
        plugin.free_buffer.unwrap()(response.ptr.cast(), response.len);
        plugin.shutdown.unwrap()();
        assert_eq!(cliproxy_plugin_init(&host, &mut plugin), 0);
        plugin.shutdown.unwrap()();
    }
}
