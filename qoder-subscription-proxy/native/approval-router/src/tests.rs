use super::*;

/// HOST 是进程级静态；涉及宿主回调替身的测试必须串行，避免并行测试互相覆盖。
static HOST_TEST_LOCK: Mutex<()> = Mutex::new(());

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
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
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
        assert_eq!(value["result"]["schema_version"], 10);
        assert_eq!(value["result"]["capabilities"]["model_router"], true);
        assert_eq!(
            value["result"]["capabilities"]["response_interceptor"],
            true
        );
        assert_eq!(
            value["result"]["capabilities"]["response_stream_interceptor"],
            true
        );
        assert_eq!(
            value["result"]["capabilities"]["request_lifecycle_plugin"],
            true
        );
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

/// 测试宿主替身：记录每次回调，并按方法返回模型目录或续写完成体。
struct TestHost {
    catalog: Value,
    completion: Value,
    calls: Mutex<Vec<(String, Value)>>,
}

unsafe extern "C" fn test_host_callback(
    context: *mut c_void,
    method: *const c_char,
    request: *const u8,
    request_len: usize,
    response: *mut Buffer,
) -> i32 {
    let host = &*(context as *const TestHost);
    let method = CStr::from_ptr(method).to_str().unwrap_or("").to_string();
    let payload: Value = if request_len == 0 {
        json!({})
    } else {
        serde_json::from_slice(std::slice::from_raw_parts(request, request_len))
            .unwrap_or(Value::Null)
    };
    host.calls.lock().unwrap().push((method.clone(), payload));
    let result = match method.as_str() {
        "host.auth.models" => host.catalog.clone(),
        "host.model.execute" => json!({
            "status_code": 200,
            "headers": {},
            "body": STANDARD.encode(serde_json::to_vec(&host.completion).unwrap())
        }),
        _ => json!({}),
    };
    let bytes = serde_json::to_vec(&json!({"ok": true, "result": result}))
        .unwrap()
        .into_boxed_slice();
    (*response).len = bytes.len();
    (*response).ptr = Box::into_raw(bytes) as *mut u8;
    0
}

/// 安装测试宿主并返回带自动清理的插件句柄，失败断言时也不会污染后续测试。
struct HostGuard(PluginApi);

impl Drop for HostGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(shutdown) = self.0.shutdown {
                shutdown();
            }
        }
    }
}

fn install_host(host: &mut TestHost) -> HostGuard {
    let api = HostApi {
        abi_version: ABI_VERSION,
        host_ctx: ptr::from_mut(host).cast(),
        call: Some(test_host_callback),
        free_buffer: Some(plugin_free),
    };
    let mut plugin = PluginApi {
        abi_version: 0,
        call: None,
        free_buffer: None,
        shutdown: None,
    };
    unsafe { assert_eq!(cliproxy_plugin_init(&api, &mut plugin), 0) };
    HostGuard(plugin)
}

fn call_method(method: &str, request: &Value) -> Value {
    handle(method, serde_json::to_vec(request).unwrap().as_slice())
        .unwrap_or_else(|error| panic!("{method} failed: {error}"))
}

fn continuation_completion(content: &str) -> Value {
    json!({
        "id": "chatcmpl-continuation",
        "object": "chat.completion",
        "model": "gemini-4-hydrogen-xhigh",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}
    })
}

#[test]
fn continuation_body_appends_prompt_and_forces_non_stream() {
    let original = json!({
        "model": "gemini-4-hydrogen-xhigh",
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": [{"role": "user", "content": "private prompt"}]
    });
    let body = continuation_body(&original, "gemini-4-hydrogen-xhigh").unwrap();
    assert_eq!(body["stream"], false);
    assert!(body.get("stream_options").is_none());
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["content"], CONTINUATION_PROMPT);
    // 原始请求保持不变，避免续写构造污染已缓存的会话。
    assert_eq!(original["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn reasoning_only_and_tool_call_outputs_are_classified_correctly() {
    let reasoning =
        json!({"choices": [{"delta": {"reasoning_content": "thinking"}, "finish_reason": "stop"}]});
    assert!(!has_visible_delta(&reasoning));
    let text = json!({"choices": [{"delta": {"content": "answer"}, "finish_reason": null}]});
    assert!(has_visible_delta(&text));
    let tools = json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1"}]}, "finish_reason": "tool_calls"}]});
    assert!(has_visible_delta(&tools));
    assert_eq!(terminal_finish_reason(&reasoning), Some("stop".to_string()));
    assert_eq!(terminal_finish_reason(&text), None);

    let empty = json!({"choices": [{"message": {"role": "assistant", "content": null}, "finish_reason": "stop"}]});
    assert!(!completion_has_visible(&empty));
    let answered = json!({"choices": [{"message": {"role": "assistant", "content": "answer"}, "finish_reason": "stop"}]});
    assert!(completion_has_visible(&answered));
    let tool_answer = json!({"choices": [{"message": {"role": "assistant", "content": null, "tool_calls": [{"id": "call-1"}]}, "finish_reason": "tool_calls"}]});
    assert!(completion_has_visible(&tool_answer));
    assert!(recoverable_finish(Some("stop")));
    assert!(!recoverable_finish(Some("length")));
    assert!(!recoverable_finish(Some("content_filter")));
}

#[test]
fn stream_empty_completion_continues_once_and_merges_usage() {
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut host = TestHost {
        catalog: catalog("antigravity", &["gemini-4-hydrogen-xhigh"]),
        completion: continuation_completion("final answer"),
        calls: Mutex::new(Vec::new()),
    };
    let _guard = install_host(&mut host);
    let original = json!({
        "model": "gemini-4-hydrogen-xhigh",
        "stream": true,
        "messages": [{"role": "user", "content": "private prompt"}]
    });
    let header = json!({
        "RequestID": "req-stream",
        "SourceFormat": "openai",
        "RequestedModel": "gemini-4-hydrogen-xhigh",
        "OriginalRequest": STANDARD.encode(serde_json::to_vec(&original).unwrap()),
        "ChunkIndex": -1,
        "host_callback_id": "callback-1"
    });
    assert_eq!(
        call_method("response.intercept_stream_chunk", &header),
        json!({})
    );
    let terminal = json!({
        "id": "chatcmpl-empty",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gemini-4-hydrogen-xhigh",
        "choices": [{
            "index": 0,
            "delta": {"reasoning_content": "thinking"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
    });
    let chunk = json!({
        "RequestID": "req-stream",
        "SourceFormat": "openai",
        "RequestedModel": "gemini-4-hydrogen-xhigh",
        "ChunkIndex": 0,
        "Body": STANDARD.encode(serde_json::to_vec(&terminal).unwrap()),
        "host_callback_id": "callback-1"
    });
    let output = call_method("response.intercept_stream_chunk", &chunk);
    let merged: Value = serde_json::from_slice(&decode_bytes(&output["Body"]).unwrap()).unwrap();
    assert_eq!(merged["choices"][0]["delta"]["content"], "final answer");
    assert_eq!(merged["choices"][0]["finish_reason"], "stop");
    assert_eq!(merged["usage"]["prompt_tokens"], 30);
    assert_eq!(merged["usage"]["completion_tokens"], 5);
    assert_eq!(merged["usage"]["total_tokens"], 35);

    // 同一请求的后续终止分片不再续写，也不重复计费。
    let again = call_method("response.intercept_stream_chunk", &chunk);
    assert!(again.get("Body").is_none());
    let calls = host.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(method, _)| method == "host.model.execute")
            .count(),
        1
    );
    let execution = calls
        .iter()
        .find(|(method, _)| method == "host.model.execute")
        .map(|(_, payload)| payload)
        .unwrap();
    let request_body: Value = serde_json::from_slice(
        &STANDARD
            .decode(execution["body"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request_body["stream"], false);
    assert_eq!(request_body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(execution["host_callback_id"], "callback-1");
}

#[test]
fn non_stream_empty_completion_replaces_body_and_sums_usage() {
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut host = TestHost {
        catalog: catalog("antigravity", &["gemini-4-hydrogen-xhigh"]),
        completion: continuation_completion("final answer"),
        calls: Mutex::new(Vec::new()),
    };
    let _guard = install_host(&mut host);
    let original = json!({
        "model": "gemini-4-hydrogen-xhigh",
        "stream": false,
        "messages": [{"role": "user", "content": "private prompt"}]
    });
    let empty = json!({
        "id": "chatcmpl-empty",
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": null, "reasoning_content": "thinking"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
    });
    let request = json!({
        "RequestID": "req-nonstream",
        "SourceFormat": "openai",
        "Model": "gemini-4-hydrogen-xhigh",
        "RequestedModel": "gemini-4-hydrogen-xhigh",
        "OriginalRequest": STANDARD.encode(serde_json::to_vec(&original).unwrap()),
        "Body": STANDARD.encode(serde_json::to_vec(&empty).unwrap()),
        "host_callback_id": "callback-2"
    });
    let output = call_method("response.intercept_after", &request);
    let replaced: Value = serde_json::from_slice(&decode_bytes(&output["Body"]).unwrap()).unwrap();
    assert_eq!(replaced["choices"][0]["message"]["content"], "final answer");
    assert_eq!(replaced["model"], "gemini-4-hydrogen-xhigh");
    assert_eq!(replaced["usage"]["prompt_tokens"], 30);
    assert_eq!(replaced["usage"]["completion_tokens"], 5);
    assert_eq!(replaced["usage"]["total_tokens"], 35);
}

#[test]
fn non_stream_empty_completion_for_other_provider_is_unchanged() {
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut host = TestHost {
        catalog: catalog("gemini", &["gemini-4-hydrogen-xhigh"]),
        completion: continuation_completion("final answer"),
        calls: Mutex::new(Vec::new()),
    };
    let _guard = install_host(&mut host);
    let request = json!({
        "RequestID": "req-other",
        "SourceFormat": "openai",
        "RequestedModel": "gemini-4-hydrogen-xhigh",
        "OriginalRequest": STANDARD.encode(b"{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"),
        "Body": STANDARD.encode(b"{\"choices\":[{\"message\":{\"content\":null},\"finish_reason\":\"stop\"}]}"),
        "host_callback_id": "callback-3"
    });
    assert_eq!(call_method("response.intercept_after", &request), json!({}));
    assert!(host
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|(method, _)| method != "host.model.execute"));
}

#[test]
fn request_completion_drops_stream_recovery_state() {
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    {
        let mut guard = streams();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            "req-cleanup".to_string(),
            StreamState {
                original_request: None,
                source_format: "openai".to_string(),
                requested_model: "gemini-4-hydrogen-xhigh".to_string(),
                host_callback_id: "callback-4".to_string(),
                has_visible: false,
                recovered: false,
            },
        );
    }
    assert_eq!(
        call_method("request.complete", &json!({"RequestID": "req-cleanup"})),
        json!({})
    );
    assert!(!streams()
        .as_ref()
        .is_some_and(|map| map.contains_key("req-cleanup")));
}

#[test]
fn stream_merge_normalizes_tool_call_index_and_finish_reason() {
    let terminal = json!({
        "choices": [{"index": 0, "delta": {"reasoning_content": "thinking"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1}
    });
    let completion = json!({
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "run", "arguments": "{}"}}]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
    });
    let merged = merge_stream_completion(&terminal, &completion);
    assert_eq!(merged["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(merged["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
    assert_eq!(
        merged["choices"][0]["delta"]["tool_calls"][0]["id"],
        "call-1"
    );
    assert_eq!(merged["usage"]["prompt_tokens"], 3);
    assert_eq!(merged["usage"]["completion_tokens"], 3);
    assert_eq!(merged["usage"]["total_tokens"], 6);
}

#[test]
fn empty_approval_completion_is_not_continued() {
    let _serial = HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut host = TestHost {
        catalog: catalog("antigravity", &["gpt-6-astra"]),
        completion: continuation_completion("shouldBlock:false"),
        calls: Mutex::new(Vec::new()),
    };
    let _guard = install_host(&mut host);
    let original = json!({
        "model": "gpt-6-astra",
        "stream": false,
        "messages": [
            {"role": "system", "content": CLASSIFIERS[0]},
            {"role": "user", "content": "Synthetic action."}
        ]
    });
    let empty = json!({
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": null},
            "finish_reason": "stop"
        }]
    });
    let request = json!({
        "RequestID": "req-approval",
        "SourceFormat": "openai",
        "Model": "gemini-3.8-flash-high(low)",
        "RequestedModel": "gpt-6-astra",
        "OriginalRequest": STANDARD.encode(serde_json::to_vec(&original).unwrap()),
        "Body": STANDARD.encode(serde_json::to_vec(&empty).unwrap()),
        "host_callback_id": "callback-approval"
    });
    assert_eq!(call_method("response.intercept_after", &request), json!({}));
    assert!(host
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|(method, _)| method != "host.model.execute"));
}
