use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock};

const ABI_VERSION: u32 = 1;
/// 宿主 RPC 最高契约版本；流式分片不再重复携带请求体，原始请求只在 header-init 缓存一次。
const SCHEMA_VERSION: u32 = 10;
const MAX_BUFFER: usize = 32 * 1024 * 1024;
const REVIEWER: &str = "gemini-3.8-flash-high(low)";
const CLASSIFIERS: [&str; 2] = [
    "You are a security classifier for auto permission mode.",
    "You are a security monitor for an autonomous AI coding agent.",
];
/// 上游 Antigravity 对“纯思考、零可见输出”的确定性空补全没有原生重试；续写时追加的
/// 用户提示对齐 Google 官方 agy 的 EmptyOutputContinuationCheckHook，用继续语义触发新输出。
/// CLIProxyAPI 原生产生同类自动续写后，应删除此插件兼容处理并直接使用上游行为。
const CONTINUATION_PROMPT: &str =
    "Continue and provide the complete final answer. Do not end the turn with an empty response.";
/// 同时跟踪的流式请求上限；异常客户端未发送 request.complete 时作为内存安全阀。
const MAX_STREAM_STATES: usize = 128;

#[repr(C)]
struct Buffer {
    ptr: *mut u8,
    len: usize,
}

type HostCall =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut Buffer) -> i32;
type FreeBuffer = unsafe extern "C" fn(*mut c_void, usize);
type PluginCall = unsafe extern "C" fn(*const c_char, *const u8, usize, *mut Buffer) -> i32;

#[repr(C)]
struct HostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<HostCall>,
    free_buffer: Option<FreeBuffer>,
}

#[repr(C)]
struct PluginApi {
    abi_version: u32,
    call: Option<PluginCall>,
    free_buffer: Option<FreeBuffer>,
    shutdown: Option<unsafe extern "C" fn()>,
}

struct HostBridge {
    context: usize,
    call: HostCall,
    free: FreeBuffer,
}

// 核心停用扩展后仍保留库映射；回调表必须可重置，并等待在途回调释放缓冲区。
static HOST: RwLock<Option<HostBridge>> = RwLock::new(None);

/// 单个流式请求的空补全检测状态；header-init 写入，request.complete 或进程结束移除。
struct StreamState {
    /// 客户端原始请求 JSON，仅 header-init 会提供；续写请求必须保留原始会话内容。
    original_request: Option<Value>,
    /// 客户端入口协议；目前只对 OpenAI Chat Completions 做自动续写。
    source_format: String,
    /// 客户端请求的模型名（路由前），续写时交由宿主重新选择同一模型。
    requested_model: String,
    /// 宿主回调 ID；调用 host.auth.models 与 host.model.execute 时必须原样回传。
    host_callback_id: String,
    /// 已观察到可见文本或工具调用；终止分片不再触发续写。
    has_visible: bool,
    /// 本请求已尝试过一次续写，避免同一失败重复计费。
    recovered: bool,
}

/// 流式请求状态表；插件回调可能并发，读写统一经过此互斥量。
static STREAMS: Mutex<Option<HashMap<String, StreamState>>> = Mutex::new(None);

/// 获取流式状态表；互斥量中毒时仍返回内部数据，避免单个 panic 永久禁用扩展。
fn streams() -> MutexGuard<'static, Option<HashMap<String, StreamState>>> {
    STREAMS.lock().unwrap_or_else(PoisonError::into_inner)
}

#[no_mangle]
unsafe extern "C" fn cliproxy_plugin_init(host: *const HostApi, plugin: *mut PluginApi) -> i32 {
    if host.is_null() || plugin.is_null() || (*host).abi_version != ABI_VERSION {
        return 1;
    }
    let (Some(call), Some(free)) = ((*host).call, (*host).free_buffer) else {
        return 1;
    };
    let Ok(mut current_host) = HOST.write() else {
        return 1;
    };
    if current_host.is_some() {
        return 1;
    }
    *current_host = Some(HostBridge {
        context: (*host).host_ctx as usize,
        call,
        free,
    });
    *plugin = PluginApi {
        abi_version: ABI_VERSION,
        call: Some(plugin_call),
        free_buffer: Some(plugin_free),
        shutdown: Some(plugin_shutdown),
    };
    0
}

unsafe extern "C" fn plugin_call(
    method: *const c_char,
    request: *const u8,
    request_len: usize,
    response: *mut Buffer,
) -> i32 {
    if response.is_null() {
        return 1;
    }
    *response = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    if method.is_null() || request_len > MAX_BUFFER || (request.is_null() && request_len > 0) {
        return 1;
    }
    // 任何 Rust panic 都不得越过 C ABI 边界；错误不伪造成审批放行结果。
    let result = catch_unwind(AssertUnwindSafe(|| {
        let method = CStr::from_ptr(method)
            .to_str()
            .map_err(|_| "invalid method")?;
        let bytes = if request_len == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(request, request_len)
        };
        handle(method, bytes)
    }));
    let envelope = match result {
        Ok(Ok(value)) => json!({"ok": true, "result": value}),
        _ => {
            json!({"ok": false, "error": {"code": "approval_router_error", "message": "Approval router unavailable", "http_status": 503}})
        }
    };
    let Ok(bytes) = serde_json::to_vec(&envelope) else {
        return 1;
    };
    let bytes = bytes.into_boxed_slice();
    (*response).len = bytes.len();
    (*response).ptr = Box::into_raw(bytes) as *mut u8;
    0
}

unsafe extern "C" fn plugin_free(buffer: *mut c_void, len: usize) {
    if !buffer.is_null() {
        // 只释放本库通过 Box<[u8]> 交给宿主的缓冲区，不依赖 Vec 容量等于长度。
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            buffer as *mut u8,
            len,
        )));
    }
}

unsafe extern "C" fn plugin_shutdown() {
    if let Ok(mut host) = HOST.write() {
        *host = None;
    }
}

fn handle(method: &str, bytes: &[u8]) -> Result<Value, &'static str> {
    match method {
        "plugin.register" | "plugin.reconfigure" => Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "metadata": {"Name": "qoder-approval-router", "Version": env!("CARGO_PKG_VERSION"), "Author": "crx-96", "GitHubRepository": "https://github.com/crx-96/axing-qoder-plugin"},
            "capabilities": {
                "model_router": true,
                "response_interceptor": true,
                "response_stream_interceptor": true,
                "request_lifecycle_plugin": true
            }
        })),
        "response.intercept_stream_chunk" => intercept_stream_chunk(bytes),
        "response.intercept_after" => intercept_response(bytes),
        "request.complete" => complete_request(bytes),
        "model.route" => {
            let request: Value = serde_json::from_slice(bytes).map_err(|_| "invalid request")?;
            let Some((model, body)) = approval_request(&request) else {
                return Ok(json!({"Handled": false}));
            };
            let catalog = call_host(
                c"host.auth.models",
                &json!({"host_callback_id": request["host_callback_id"]}),
            )?;
            let route = approval_route(&request, &body, model, &catalog);
            if route["Handled"] == true {
                let _ = call_host(c"host.log", &route_log(&request, &route));
            }
            Ok(route)
        }
        _ => Err("unsupported method"),
    }
}

/// 解码宿主以 Go `[]byte` 传入的 Base64 字段；字段缺失或非法时跳过本次处理。
fn decode_bytes(value: &Value) -> Option<Vec<u8>> {
    STANDARD.decode(value.as_str()?).ok()
}

/// 解码 JSON 请求体；原始会话或响应不是对象时返回 None，不做猜测性修复。
fn decode_json(value: &Value) -> Option<Value> {
    serde_json::from_slice(&decode_bytes(value)?).ok()
}

/// 将修改后的对象编码为宿主期望的 Base64 `[]byte` 字段。
fn encode_json(value: &Value) -> Option<String> {
    serde_json::to_vec(value)
        .ok()
        .map(|bytes| STANDARD.encode(bytes))
}

/// 兼容不同 RPC 请求来源的回调 ID；缺失时无法安全调用宿主模型接口。
fn host_callback_id(request: &Value) -> String {
    request["host_callback_id"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// 流式分片是否已经携带可见内容；纯 reasoning_content 不算可见输出，正是空补全特征。
fn has_visible_delta(chunk: &Value) -> bool {
    // 逐 choice 检查 delta；只要任一 choice 出现文本、工具调用或函数调用，就不再视为空补全。
    chunk["choices"].as_array().is_some_and(|choices| {
        choices.iter().any(|choice| {
            let delta = &choice["delta"];
            let content = delta["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty());
            let tools = delta["tool_calls"]
                .as_array()
                .is_some_and(|items| !items.is_empty());
            let call = delta["function_call"]
                .as_object()
                .is_some_and(|call| !call.is_empty());
            content || tools || call
        })
    })
}

/// 返回终止分片的 finish_reason；没有终止标记表示上游流已结束但客户端仍会继续等待。
fn terminal_finish_reason(chunk: &Value) -> Option<String> {
    // 任一 choice 带 finish_reason 即说明本分片是下游终止分片。
    chunk["choices"]
        .as_array()?
        .iter()
        .find_map(|choice| choice["finish_reason"].as_str().map(ToOwned::to_owned))
}

/// 只有 stop/end_turn 等正常结束且零可见输出才视为空补全；长度截断和内容过滤保留原行为。
fn recoverable_finish(reason: Option<&str>) -> bool {
    !matches!(reason, Some("length" | "content_filter"))
}

/// 判断非流式完成是否为空补全：无文本、无工具调用、无函数调用。
fn completion_has_visible(completion: &Value) -> bool {
    // 非流式按 message 判定；content 数组只有包含非空 text 才算可见输出。
    completion["choices"].as_array().is_some_and(|choices| {
        choices.iter().any(|choice| {
            let message = &choice["message"];
            let content = match &message["content"] {
                Value::String(text) => !text.trim().is_empty(),
                Value::Array(parts) => parts.iter().any(|part| {
                    part["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                }),
                _ => false,
            };
            let tools = message["tool_calls"]
                .as_array()
                .is_some_and(|items| !items.is_empty());
            let call = message["function_call"]
                .as_object()
                .is_some_and(|call| !call.is_empty());
            content || tools || call
        })
    })
}

/// 通过宿主模型目录确认模型属于 Antigravity；不读取凭据，也不猜测同名多渠道归属。
fn model_provider(callback: &str, model: &str) -> Option<String> {
    if callback.is_empty() || model.is_empty() {
        return None;
    }
    let catalog = call_host(c"host.auth.models", &json!({"host_callback_id": callback})).ok()?;
    provider_for_catalog(model, &catalog).map(str::to_string)
}

/// 递归累加 usage 中的数值字段；用于把空补全尝试与续写调用的计费合并给客户端。
fn sum_usage(target: &mut Value, source: &Value) {
    let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) else {
        return;
    };
    for (key, value) in source {
        if let Some(number) = value.as_i64() {
            let current = target.get(key).and_then(Value::as_i64).unwrap_or(0);
            target.insert(key.clone(), json!(current + number));
        } else if value.is_object() {
            if let Some(entry) = target.get_mut(key) {
                sum_usage(entry, value);
            }
        }
    }
}

/// 将额外调用的 usage 合并进目标对象；目标没有 usage 时直接采用额外调用结果。
fn add_usage(target: &mut Value, extra: Option<&Value>) {
    let Some(extra) = extra.filter(|usage| usage.is_object()) else {
        return;
    };
    match target.get_mut("usage") {
        Some(usage) if usage.is_object() => sum_usage(usage, extra),
        _ => target["usage"] = extra.clone(),
    }
}

/// 构造续写请求：保留原始会话与工具定义，追加继续指令并改为同步调用。
fn continuation_body(original: &Value, model: &str) -> Result<Value, &'static str> {
    let mut body = original.clone();
    let Some(object) = body.as_object_mut() else {
        return Err("invalid original request");
    };
    let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) else {
        return Err("original request has no messages");
    };
    // 追加继续指令改变 payload，打破原空补全的确定性触发条件。
    messages.push(json!({"role": "user", "content": CONTINUATION_PROMPT}));
    // 宿主模型执行接口只支持非流式；同步去掉仅对下游流式有效的选项。
    object.insert("model".to_string(), json!(model));
    object.insert("stream".to_string(), Value::Bool(false));
    object.remove("stream_options");
    Ok(body)
}

/// 通过宿主执行一次非流式续写；宿主会跳过本插件的拦截器与路由，避免递归。
fn continuation(callback: &str, model: &str, original: &Value) -> Result<Value, &'static str> {
    if callback.is_empty() || model.is_empty() {
        return Err("missing host callback");
    }
    let body = continuation_body(original, model)?;
    let payload = serde_json::to_vec(&body).map_err(|_| "invalid continuation request")?;
    let response = call_host(
        c"host.model.execute",
        &json!({
            "entry_protocol": "openai",
            "exit_protocol": "openai",
            "model": model,
            "stream": false,
            "body": STANDARD.encode(payload),
            "headers": {},
            "query": {},
            "host_callback_id": callback
        }),
    )?;
    if response["status_code"].as_i64() != Some(200) {
        return Err("continuation status");
    }
    let bytes = decode_bytes(&response["body"]).ok_or("invalid continuation body")?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid continuation body")
}

/// 把非流式续写结果合并为下游终止分片；一次分片携带完整内容与工具调用。
fn merge_stream_completion(chunk: &Value, completion: &Value) -> Value {
    let mut merged = chunk.clone();
    let Some(message) = completion["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .map(|choice| &choice["message"])
    else {
        return merged;
    };
    // 续写可能返回文本、工具调用或仅反思；只搬运客户端可消费的字段。
    let content = message
        .get("content")
        .filter(|value| !value.is_null() && value.as_str() != Some(""))
        .cloned();
    let reasoning = message
        .get("reasoning_content")
        .filter(|value| !value.is_null())
        .cloned();
    let tool_calls = message
        .get("tool_calls")
        .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
        .cloned()
        .map(|mut calls| {
            // 非流式 tool_calls 不带 index；补上序号，兼容按流式增量累积的客户端。
            if let Some(items) = calls.as_array_mut() {
                for (index, call) in items.iter_mut().enumerate() {
                    if call.get("index").is_none() {
                        call["index"] = json!(index);
                    }
                }
            }
            calls
        });
    if let Some(choice) = merged["choices"]
        .as_array_mut()
        .and_then(|choices| choices.first_mut())
    {
        // ABI 一次只能替换当前分片，因此把完整续写内容、工具调用与结束标记放进终止分片。
        let mut delta = Map::new();
        if let Some(content) = content {
            delta.insert("content".to_string(), content);
        }
        if let Some(reasoning) = reasoning {
            delta.insert("reasoning_content".to_string(), reasoning);
        }
        if let Some(tool_calls) = tool_calls {
            delta.insert("tool_calls".to_string(), tool_calls);
            choice["finish_reason"] = json!("tool_calls");
            choice["native_finish_reason"] = json!("tool_calls");
        }
        choice["delta"] = Value::Object(delta);
    }
    add_usage(&mut merged, completion.get("usage"));
    merged
}

/// 写入续写诊断日志；只记录模型、渠道与计费，不记录提示正文、凭据或工具参数。
fn log_continuation(callback: &str, level: &str, message: &str, model: &str, extra: Value) {
    let mut fields = json!({"model": model});
    if let (Some(target), Some(extra)) = (fields.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    let _ = call_host(
        c"host.log",
        &json!({
            "level": level,
            "message": message,
            "host_callback_id": callback,
            "fields": fields
        }),
    );
}

/// header-init 只出现一次；缓存客户端原始会话，后续分片按 schema 10 不再重复携带。
fn observe_stream_header(request: &Value, request_id: &str) {
    let state = StreamState {
        original_request: decode_json(&request["OriginalRequest"]),
        source_format: request["SourceFormat"].as_str().unwrap_or("").to_string(),
        requested_model: request["RequestedModel"].as_str().unwrap_or("").to_string(),
        host_callback_id: host_callback_id(request),
        has_visible: false,
        recovered: false,
    };
    let mut guard = streams();
    let map = guard.get_or_insert_with(HashMap::new);
    // 正常请求应显式完成并移除；超限时淘汰任意旧项，避免异常客户端导致内存增长。
    if map.len() >= MAX_STREAM_STATES {
        if let Some(key) = map.keys().next().cloned() {
            map.remove(&key);
        }
    }
    map.insert(request_id.to_string(), state);
}

/// 流式空补全处理：终止分片零可见输出且来自 Antigravity 时同步续写一次。
fn intercept_stream_chunk(bytes: &[u8]) -> Result<Value, &'static str> {
    let request: Value = serde_json::from_slice(bytes).map_err(|_| "invalid request")?;
    // 只跟踪 OpenAI 聊天补全，避免为其他协议缓存状态或解析每个分片。
    if request["SourceFormat"].as_str() != Some("openai") {
        return Ok(json!({}));
    }
    let Some(request_id) = request["RequestID"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(json!({}));
    };
    // header-init 只建立检测状态，不修改响应；分片序号缺失时无法确认阶段，直接跳过。
    let chunk_index = request["ChunkIndex"].as_i64().unwrap_or(-2);
    if chunk_index == -1 {
        observe_stream_header(&request, request_id);
        return Ok(json!({}));
    }
    if chunk_index < 0 {
        return Ok(json!({}));
    }
    let Some(body) = decode_bytes(&request["Body"]) else {
        return Ok(json!({}));
    };
    let Ok(chunk) = serde_json::from_slice::<Value>(&body) else {
        return Ok(json!({}));
    };
    let visible = has_visible_delta(&chunk);
    let terminal = terminal_finish_reason(&chunk);
    let mut recovery = None;
    {
        let mut guard = streams();
        let map = guard.get_or_insert_with(HashMap::new);
        // 插件可能在流中途加载；缺失状态时按当前分片重建，至少保留诊断能力。
        let state = map
            .entry(request_id.to_string())
            .or_insert_with(|| StreamState {
                original_request: None,
                source_format: request["SourceFormat"].as_str().unwrap_or("").to_string(),
                requested_model: request["RequestedModel"].as_str().unwrap_or("").to_string(),
                host_callback_id: host_callback_id(&request),
                has_visible: false,
                recovered: false,
            });
        if visible {
            state.has_visible = true;
        }
        // 仅对 OpenAI 聊天补全的普通结束做一次续写；重建状态没有原始请求时无法安全继续。
        if terminal.is_some()
            && !state.has_visible
            && !state.recovered
            && state.source_format == "openai"
            && recoverable_finish(terminal.as_deref())
        {
            state.recovered = true;
            if let Some(original) = state.original_request.clone() {
                recovery = Some((
                    state.requested_model.clone(),
                    state.host_callback_id.clone(),
                    original,
                    chunk.clone(),
                ));
            }
        }
    }
    let Some((model, callback, original, terminal_chunk)) = recovery else {
        return Ok(json!({}));
    };
    // 审批请求已由 ModelRouter 改投审核模型；追加继续指令会破坏分类器签名并可能回到昂贵模型。
    if is_approval("openai", &original) {
        log_continuation(
            &callback,
            "info",
            "空补全未续写：审批请求",
            &model,
            json!({}),
        );
        return Ok(json!({}));
    }
    let provider = model_provider(&callback, &model);
    if provider.as_deref() != Some("antigravity") {
        log_continuation(
            &callback,
            "info",
            "空补全未续写：模型未确认属于 Antigravity",
            &model,
            json!({"provider": provider}),
        );
        return Ok(json!({}));
    }
    match continuation(&callback, &model, &original) {
        Ok(completion) => {
            let merged = merge_stream_completion(&terminal_chunk, &completion);
            if !has_visible_delta(&merged) {
                log_continuation(
                    &callback,
                    "warn",
                    "空补全续写后仍无可见输出",
                    &model,
                    json!({"finish_reason": terminal}),
                );
                return Ok(json!({}));
            }
            log_continuation(
                &callback,
                "info",
                "空补全已自动续写",
                &model,
                json!({"usage": merged.get("usage").cloned().unwrap_or(Value::Null)}),
            );
            Ok(match encode_json(&merged) {
                Some(body) => json!({"Body": body}),
                None => json!({}),
            })
        }
        Err(reason) => {
            log_continuation(
                &callback,
                "warn",
                "空补全续写失败",
                &model,
                json!({"reason": reason, "finish_reason": terminal}),
            );
            Ok(json!({}))
        }
    }
}

/// 非流式空补全处理：替换为续写完成体，并把两次调用的 usage 合并给客户端。
fn intercept_response(bytes: &[u8]) -> Result<Value, &'static str> {
    let request: Value = serde_json::from_slice(bytes).map_err(|_| "invalid request")?;
    if request["SourceFormat"].as_str() != Some("openai") {
        return Ok(json!({}));
    }
    let Some(body) = decode_bytes(&request["Body"]) else {
        return Ok(json!({}));
    };
    let Ok(completion) = serde_json::from_slice::<Value>(&body) else {
        return Ok(json!({}));
    };
    let finish = completion["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice["finish_reason"].as_str());
    // 有可见输出、截断或内容过滤时不由插件介入。
    if completion_has_visible(&completion) || !recoverable_finish(finish) {
        return Ok(json!({}));
    }
    let Some(original) = decode_json(&request["OriginalRequest"]) else {
        return Ok(json!({}));
    };
    let model = request["RequestedModel"].as_str().unwrap_or("");
    let callback = host_callback_id(&request);
    // 审批分类请求保持原样：续写会破坏分类器签名，并可能绕过审批模型的路由。
    if is_approval("openai", &original) {
        log_continuation(
            &callback,
            "info",
            "空补全未续写：审批请求",
            model,
            json!({}),
        );
        return Ok(json!({}));
    }
    let provider = model_provider(&callback, model);
    if provider.as_deref() != Some("antigravity") {
        log_continuation(
            &callback,
            "info",
            "空补全未续写：模型未确认属于 Antigravity",
            model,
            json!({"provider": provider}),
        );
        return Ok(json!({}));
    }
    match continuation(&callback, model, &original) {
        Ok(mut next) => {
            if !completion_has_visible(&next) {
                log_continuation(
                    &callback,
                    "warn",
                    "空补全续写后仍无可见输出",
                    model,
                    json!({"finish_reason": finish}),
                );
                return Ok(json!({}));
            }
            add_usage(&mut next, completion.get("usage"));
            // 客户端只认识自己请求的模型名；续写内部路由不改变响应中的模型标识。
            if let Some(requested) = request["RequestedModel"].as_str() {
                next["model"] = json!(requested);
            }
            log_continuation(
                &callback,
                "info",
                "空补全已自动续写",
                model,
                json!({"usage": next.get("usage").cloned().unwrap_or(Value::Null)}),
            );
            Ok(match encode_json(&next) {
                Some(body) => json!({"Body": body}),
                None => json!({}),
            })
        }
        Err(reason) => {
            log_continuation(
                &callback,
                "warn",
                "空补全续写失败",
                model,
                json!({"reason": reason, "finish_reason": finish}),
            );
            Ok(json!({}))
        }
    }
}

/// 请求终态回调：移除流式状态，正常与失败路径都释放，避免长期存活请求泄漏。
fn complete_request(bytes: &[u8]) -> Result<Value, &'static str> {
    let request: Value = serde_json::from_slice(bytes).map_err(|_| "invalid request")?;
    if let Some(request_id) = request["RequestID"].as_str() {
        let mut guard = streams();
        if let Some(map) = guard.as_mut() {
            map.remove(request_id);
        }
    }
    Ok(json!({}))
}

fn call_host(method: &CStr, request: &Value) -> Result<Value, &'static str> {
    let host = HOST.read().map_err(|_| "host unavailable")?;
    let host = host.as_ref().ok_or("host unavailable")?;
    let payload = serde_json::to_vec(request).map_err(|_| "invalid callback")?;
    let mut buffer = Buffer {
        ptr: ptr::null_mut(),
        len: 0,
    };
    let status = unsafe {
        (host.call)(
            host.context as *mut c_void,
            method.as_ptr(),
            payload.as_ptr(),
            payload.len(),
            &mut buffer,
        )
    };
    let result = if status == 0 && !buffer.ptr.is_null() && buffer.len <= MAX_BUFFER {
        unsafe {
            serde_json::from_slice::<Value>(std::slice::from_raw_parts(buffer.ptr, buffer.len))
        }
        .map_err(|_| "invalid callback result")
    } else {
        Err("callback failed")
    };
    if !buffer.ptr.is_null() {
        unsafe { (host.free)(buffer.ptr as *mut c_void, buffer.len) };
    }
    let envelope = result?;
    if envelope["ok"] != true {
        return Err("callback failed");
    }
    Ok(envelope["result"].clone())
}

fn approval_request(request: &Value) -> Option<(&str, Value)> {
    if !request["AvailableProviders"]
        .as_array()?
        .iter()
        .any(|provider| provider == "antigravity" || provider == "codex")
    {
        return None;
    }
    let bytes = STANDARD.decode(request["Body"].as_str()?).ok()?;
    let body: Value = serde_json::from_slice(&bytes).ok()?;
    let format = request["SourceFormat"].as_str()?;
    if !is_approval(format, &body) {
        return None;
    }
    let model = request["RequestedModel"]
        .as_str()
        .filter(|model| !model.is_empty())?;
    Some((model, body))
}

fn is_codex_review(request: &Value, body: &Value) -> bool {
    let content = &body["input"][0]["content"];
    request["SourceFormat"] == "openai-response"
        && request["RequestedModel"]
            .as_str()
            .is_some_and(|model| model.starts_with("gpt-"))
        && matches!(body["reasoning"]["effort"].as_str(), Some("none" | "low"))
        && matches!(
            body["input"][0]["role"].as_str(),
            Some("system" | "developer")
        )
        && content.as_array().is_some_and(|parts| parts.len() == 1)
        && content[0]["type"] == "input_text"
        && is_approval("openai-response", body)
}

fn approval_route(request: &Value, body: &Value, model: &str, catalog: &Value) -> Value {
    let provider = provider_for_catalog(model, catalog);
    let target = match provider {
        Some("antigravity")
            if is_approval(request["SourceFormat"].as_str().unwrap_or(""), body) =>
        {
            REVIEWER
        }
        Some("codex") if is_codex_review(request, body) => "codex-auto-review(low)",
        _ => return json!({"Handled": false}),
    };
    json!({"Handled": true, "TargetKind": "provider", "Target": provider, "TargetModel": target})
}

fn route_log(request: &Value, route: &Value) -> Value {
    json!({"level": "info", "message": format!("审批模型切换: {} -> {}; thinking=low", request["RequestedModel"], route["TargetModel"]), "host_callback_id": request["host_callback_id"],
        "fields": {"provider": route["Target"], "source_model": request["RequestedModel"],
            "target_model": route["TargetModel"], "thinking": "low"}})
}

fn classifier_text(content: &Value, part_type: &str) -> bool {
    let text = if let Some(text) = content.as_str() {
        Some(text)
    } else {
        content
            .as_array()
            .filter(|parts| parts.len() == 1)
            .and_then(|parts| {
                let part = &parts[0];
                if part["type"] == part_type {
                    part["text"].as_str()
                } else {
                    None
                }
            })
    };
    text.is_some_and(|text| CLASSIFIERS.iter().any(|prefix| text.starts_with(prefix)))
}

fn single_user(messages: &Value) -> bool {
    messages
        .as_array()
        .is_some_and(|messages| messages.len() == 1 && messages[0]["role"] == "user")
}

fn is_approval(format: &str, body: &Value) -> bool {
    if body.get("tools").is_some_and(|tools| {
        !tools.is_null() && tools.as_array().is_none_or(|items| !items.is_empty())
    }) {
        return false;
    }
    match format {
        "openai-response" => {
            if body
                .get("instructions")
                .is_some_and(|value| classifier_text(value, "input_text"))
            {
                return body["input"].is_string() || single_user(&body["input"]);
            }
            if body
                .get("instructions")
                .is_some_and(|value| !value.is_null() && value != "")
            {
                return false;
            }
            system_user_pair(&body["input"], "input_text")
        }
        "openai" => system_user_pair(&body["messages"], "text"),
        "claude" => classifier_text(&body["system"], "text") && single_user(&body["messages"]),
        "gemini" => {
            let system = body
                .get("systemInstruction")
                .or_else(|| body.get("system_instruction"));
            let text = system
                .and_then(|system| system["parts"].as_array())
                .filter(|parts| parts.len() == 1)
                .and_then(|parts| parts[0]["text"].as_str());
            text.is_some_and(|text| CLASSIFIERS.iter().any(|prefix| text.starts_with(prefix)))
                && single_user(&body["contents"])
        }
        _ => false,
    }
}

fn system_user_pair(messages: &Value, part_type: &str) -> bool {
    let Some(messages) = messages.as_array().filter(|items| items.len() == 2) else {
        return false;
    };
    matches!(messages[0]["role"].as_str(), Some("system" | "developer"))
        && classifier_text(&messages[0]["content"], part_type)
        && messages[1]["role"] == "user"
}

fn provider_for_catalog<'a>(requested: &str, catalog: &'a Value) -> Option<&'a str> {
    let credentials = catalog["credentials"].as_array()?;
    let stripped = requested
        .strip_suffix(')')
        .and_then(|value| value.rsplit_once('('))
        .map(|(model, _)| model);
    let has_model = |credential: &Value, model: &str| {
        credential["models"]
            .as_array()
            .is_some_and(|models| models.iter().any(|item| item == model))
    };
    let model = if credentials
        .iter()
        .any(|credential| has_model(credential, requested))
    {
        requested
    } else {
        stripped.unwrap_or(requested)
    };
    let mut provider = None;
    for credential in credentials
        .iter()
        .filter(|credential| has_model(credential, model))
    {
        let current = credential["provider"].as_str()?;
        if provider.is_some_and(|provider| provider != current) {
            // 同名多渠道不能推断客户端原本会选谁，保留核心原路由。
            return None;
        }
        provider = Some(current);
    }
    provider
}

#[cfg(test)]
mod tests;
