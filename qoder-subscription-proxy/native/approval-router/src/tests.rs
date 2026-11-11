use super::*;

fn responses(prefix: &str) -> Value {
    json!({"input": [
        {"role": "system", "content": [{"type": "input_text", "text": format!("{prefix}\nKeep the host policy unchanged.")}]},
        {"role": "user", "content": [{"type": "input_text", "text": "Synthetic action."}]}
    ]})
}

fn catalog(provider: &str, models: &[&str]) -> Value {
    json!({"credentials": [{"id": "synthetic", "auth_index": "synthetic", "provider": provider, "models": models}]})
}

#[test]
fn recognizes_independent_approval_in_supported_protocols() {
    for prefix in CLASSIFIERS {
        let mut body = responses(prefix);
        for role in ["system", "developer"] {
            body["input"][0]["role"] = json!(role);
            for effort in ["none", "minimal", "low", "high", "auto"] {
                body["reasoning"] = json!({"effort": effort});
                assert!(is_approval("openai-response", &body));
            }
        }
        assert!(is_approval(
            "openai-response",
            &json!({"instructions": prefix, "input": "Synthetic action."})
        ));
        assert!(is_approval(
            "openai-response",
            &json!({"instructions": prefix, "input": [{"role": "user", "content": "Synthetic action."}]})
        ));
        assert!(is_approval(
            "openai",
            &json!({"messages": [
                {"role": "system", "content": prefix}, {"role": "user", "content": "Synthetic action."}
            ]})
        ));
        assert!(is_approval(
            "claude",
            &json!({"system": [{"type": "text", "text": prefix}], "messages": [
                {"role": "user", "content": "Synthetic action."}
            ]})
        ));
        assert!(is_approval(
            "gemini",
            &json!({"systemInstruction": {"parts": [{"text": prefix}]}, "contents": [
                {"role": "user", "parts": [{"text": "Synthetic action."}]}
            ]})
        ));
    }
}

#[test]
fn leaves_ordinary_and_ambiguous_conversations_untouched() {
    let prefix = CLASSIFIERS[0];
    for text in [
        "Ordinary coding task",
        "You are a security expert.",
        &format!("Quoted: {prefix}"),
    ] {
        assert!(!is_approval("openai-response", &responses(text)));
    }
    let mut body = responses(prefix);
    body["input"][0]["role"] = json!("user");
    assert!(!is_approval("openai-response", &body));
    let mut body = responses(prefix);
    body["input"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type": "input_text", "text": "Additional instructions."}));
    assert!(!is_approval("openai-response", &body));
    let mut body = responses(prefix);
    body["input"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role": "assistant", "content": "History"}));
    assert!(!is_approval("openai-response", &body));
    let mut body = responses(prefix);
    body["tools"] = json!([{"type": "function", "name": "execute"}]);
    assert!(!is_approval("openai-response", &body));
    let mut body = responses(prefix);
    body["instructions"] = json!("Other instructions");
    assert!(!is_approval("openai-response", &body));
    assert!(!is_approval(
        "claude",
        &json!({"system": prefix, "messages": [{"role": "assistant", "content": "History"}]})
    ));
    assert!(!is_approval("unknown", &responses(prefix)));
    assert!(!is_approval("openai-response", &json!({})));
}

#[test]
fn routing_uses_registered_provider_not_model_name() {
    for model in [
        "claude-opus-5-5-high",
        "claude-sonnet-5-5-high",
        "gemini-4-argon-high",
        "gpt-oss-120b-medium",
        "private-alias",
    ] {
        let result = route_for_catalog(model, &catalog("antigravity", &[model]));
        assert_eq!(result["Target"], "antigravity");
        assert_eq!(result["TargetModel"], REVIEWER);
        assert_eq!(result["TargetKind"], "provider");
        assert_eq!(result["Handled"], true);
        assert_eq!(
            route_for_catalog(model, &catalog("gemini", &[model]))["Handled"],
            false
        );
    }
    assert_eq!(
        route_for_catalog("gpt-6-astra", &catalog("codex", &["gpt-6-astra"]))["Handled"],
        false
    );
    assert_eq!(
        route_for_catalog("unknown", &catalog("antigravity", &["gemini-4-argon-high"]))["Handled"],
        false
    );
    assert_eq!(
        route_for_catalog(
            "gemini-4-argon-high(high)",
            &catalog("antigravity", &["gemini-4-argon-high"])
        )["TargetModel"],
        REVIEWER
    );
    assert_eq!(
        route_for_catalog("named(alias)", &catalog("antigravity", &["named(alias)"]))
            ["TargetModel"],
        REVIEWER
    );
    let mixed = json!({"credentials": [
        {"provider": "antigravity", "models": ["shared"]}, {"provider": "gemini", "models": ["shared"]}
    ]});
    assert_eq!(route_for_catalog("shared", &mixed)["Handled"], false);
    assert_eq!(route_for_catalog("any", &json!({}))["Handled"], false);
}

#[test]
fn request_requires_valid_body_and_available_provider() {
    let body = responses(CLASSIFIERS[0]);
    let mut request = json!({"SourceFormat": "openai-response", "RequestedModel": "private-alias", "Body": STANDARD.encode(serde_json::to_vec(&body).unwrap()), "AvailableProviders": ["antigravity"]});
    let unchanged = request.clone();
    assert_eq!(
        approval_request(&request).map(|(model, _)| model),
        Some("private-alias")
    );
    assert_eq!(request, unchanged);
    request["AvailableProviders"] = json!(["gemini"]);
    assert_eq!(approval_request(&request).map(|(model, _)| model), None);
    request["AvailableProviders"] = json!(["antigravity"]);
    request["Body"] = json!("not base64!");
    assert_eq!(approval_request(&request).map(|(model, _)| model), None);
    request["Body"] = json!(STANDARD.encode(b"not json"));
    assert_eq!(approval_request(&request).map(|(model, _)| model), None);
}

fn route_for_catalog(model: &str, catalog: &Value) -> Value {
    let request = json!({"SourceFormat": "openai-response", "RequestedModel": model});
    approval_route(&request, &responses(CLASSIFIERS[0]), model, catalog)
}

fn route_request(format: &str, model: &str, provider: &str, body: &Value) -> Value {
    let request = json!({
        "SourceFormat": format, "RequestedModel": model,
        "Body": STANDARD.encode(serde_json::to_vec(body).unwrap()),
        "AvailableProviders": [provider]
    });
    let Some((model, decoded)) = approval_request(&request) else {
        return json!({"Handled": false});
    };
    approval_route(&request, &decoded, model, &catalog(provider, &[model]))
}

#[test]
fn codex_routes_only_known_independent_approval_requests() {
    for prefix in CLASSIFIERS {
        for role in ["system", "developer"] {
            for effort in ["none", "low"] {
                for tools in [Value::Null, json!([])] {
                    let mut body = responses(prefix);
                    body["input"][0]["role"] = json!(role);
                    body["reasoning"] = json!({"effort": effort});
                    body["tools"] = tools;
                    let original = body.clone();
                    assert_eq!(
                        route_request("openai-response", "gpt-6-astra", "codex", &body),
                        json!({"Handled": true, "TargetKind": "provider", "Target": "codex",
                            "TargetModel": "codex-auto-review(low)"})
                    );
                    assert_eq!(body, original);
                }
            }
        }
    }
}

#[test]
fn codex_retains_original_protocol_effort_and_classifier_scope() {
    let mut body = responses(CLASSIFIERS[0]);
    for effort in [
        json!("high"),
        json!("xhigh"),
        json!("auto"),
        json!("minimal"),
        json!(""),
        Value::Null,
    ] {
        body["reasoning"] = json!({"effort": effort});
        assert_eq!(
            route_request("openai-response", "gpt-6-astra", "codex", &body)["Handled"],
            false
        );
    }
    body.as_object_mut().unwrap().remove("reasoning");
    assert_eq!(
        route_request("openai-response", "gpt-6-astra", "codex", &body)["Handled"],
        false
    );
    body["reasoning"] = json!({"effort": "none"});
    assert_eq!(
        route_request("openai-response", "not-gpt-model", "codex", &body)["Handled"],
        false
    );
    body["input"][0]["content"] = json!(CLASSIFIERS[0]);
    assert_eq!(
        route_request("openai-response", "gpt-6-astra", "codex", &body)["Handled"],
        false
    );

    for (format, mut body) in [
        (
            "openai",
            json!({"messages": [{"role": "system", "content": CLASSIFIERS[0]}, {"role": "user", "content": "Action"}]}),
        ),
        (
            "claude",
            json!({"system": CLASSIFIERS[0], "messages": [{"role": "user", "content": "Action"}]}),
        ),
        (
            "gemini",
            json!({"systemInstruction": {"parts": [{"text": CLASSIFIERS[0]}]}, "contents": [{"role": "user", "parts": [{"text": "Action"}]}]}),
        ),
        (
            "openai-response",
            json!({"instructions": CLASSIFIERS[0], "input": "Action"}),
        ),
        (
            "openai-response",
            json!({"instructions": CLASSIFIERS[0], "input": [{"role": "user", "content": "Action"}]}),
        ),
    ] {
        body["reasoning"] = json!({"effort": "low"});
        assert_eq!(
            route_request(format, "gpt-6-astra", "codex", &body)["Handled"],
            false,
            "{format}: {body}"
        );
        assert_eq!(
            route_request(format, "private-alias", "antigravity", &body)["TargetModel"],
            REVIEWER
        );
    }
}

#[test]
fn codex_rejects_ordinary_security_prompts_and_mixed_requests_through_full_route() {
    for role in ["system", "developer"] {
        for effort in ["none", "low"] {
            for prefix in [
                CLASSIFIERS[0],
                CLASSIFIERS[1],
                "You are a security expert. Help me review this application.",
                "You are a security custom classifier.",
                "Quoted: You are a security classifier for auto permission mode.",
                "Quoted: You are a security monitor for an autonomous AI coding agent.",
            ] {
                let mut base = responses(prefix);
                base["input"][0]["role"] = json!(role);
                base["reasoning"] = json!({"effort": effort});
                let mut cases = Vec::new();
                if !CLASSIFIERS.contains(&prefix) {
                    cases.push(base.clone());
                }
                let mut body = base.clone();
                body["tools"] = json!([{"type": "function", "name": "execute"}]);
                cases.push(body);
                let mut body = base.clone();
                body["tools"] = json!({"invalid": "tools"});
                cases.push(body);
                let mut body = base.clone();
                body["input"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role": "assistant", "content": "History"}));
                cases.push(body);
                let mut body = base.clone();
                body["input"].as_array_mut().unwrap().truncate(1);
                cases.push(body);
                let mut body = base.clone();
                body["input"][1]["role"] = json!("assistant");
                cases.push(body);
                let mut body = base.clone();
                body["input"][0]["role"] = json!("user");
                cases.push(body);
                for instructions in ["Other instructions", CLASSIFIERS[0]] {
                    let mut body = base.clone();
                    body["instructions"] = json!(instructions);
                    cases.push(body);
                }
                let mut body = base.clone();
                body["input"][0]["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type": "input_text", "text": "Additional instructions"}));
                cases.push(body);
                let mut body = base.clone();
                body["input"][0]["content"][0]["type"] = json!("text");
                cases.push(body);
                for body in cases {
                    assert_eq!(
                        route_request("openai-response", "gpt-6-astra", "codex", &body)["Handled"],
                        false,
                        "{body}"
                    );
                }
            }
        }
    }
}

#[test]
fn normal_route_logs_are_info_and_never_include_prompt_or_credentials() {
    for provider in ["codex", "antigravity"] {
        let request = json!({"RequestedModel": "source-model", "Body": "private-prompt", "Headers": {"Authorization": "private-token"}});
        let route = json!({"Target": provider, "TargetModel": "reviewer(low)"});
        let log = route_log(&request, &route);
        assert_eq!(log["level"], "info");
        assert_eq!(log["fields"]["provider"], provider);
        assert_eq!(log["fields"]["thinking"], "low");
        assert!(!log.to_string().contains("private-"));
    }
}

#[test]
fn abi_reinitialization_replaces_host_callbacks_after_shutdown() {
    unsafe extern "C" fn callback(
        context: *mut c_void,
        _method: *const c_char,
        _request: *const u8,
        _request_len: usize,
        response: *mut Buffer,
    ) -> i32 {
        let bytes = serde_json::to_vec(&json!({"ok": true, "result": *(context as *const usize)}))
            .unwrap()
            .into_boxed_slice();
        (*response).len = bytes.len();
        (*response).ptr = Box::into_raw(bytes) as *mut u8;
        0
    }

    let mut plugin = PluginApi {
        abi_version: 0,
        call: None,
        free_buffer: None,
        shutdown: None,
    };
    let mut contexts = [11usize, 22usize];
    for context in &mut contexts {
        let host = HostApi {
            abi_version: ABI_VERSION,
            host_ctx: ptr::from_mut(context).cast(),
            call: Some(callback),
            free_buffer: Some(plugin_free),
        };
        unsafe {
            assert_eq!(cliproxy_plugin_init(&host, &mut plugin), 0);
            assert_eq!(
                call_host(c"host.auth.models", &json!({})),
                Ok(json!(*context))
            );
            plugin.shutdown.unwrap()();
        }
        assert!(call_host(c"host.auth.models", &json!({})).is_err());
    }
}

#[test]
fn abi_registration_owns_and_releases_exact_response_buffer() {
    let mut response = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    unsafe {
        assert_eq!(
            plugin_call(
                c"plugin.register".as_ptr(),
                b"{}".as_ptr(),
                2,
                &mut response
            ),
            0
        );
        let value: Value =
            serde_json::from_slice(std::slice::from_raw_parts(response.ptr, response.len)).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["capabilities"]["model_router"], true);
        assert_eq!(value["result"]["metadata"]["Name"], "qoder-approval-router");
        plugin_free(response.ptr as *mut c_void, response.len);
        assert_eq!(
            plugin_call(c"model.route".as_ptr(), ptr::null(), 10, &mut response),
            1
        );
        assert!(response.ptr.is_null());
        assert_eq!(cliproxy_plugin_init(ptr::null(), ptr::null_mut()), 1);
    }
}
