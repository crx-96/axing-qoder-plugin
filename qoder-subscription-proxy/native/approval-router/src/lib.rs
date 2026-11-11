use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::RwLock;

const ABI_VERSION: u32 = 1;
const MAX_BUFFER: usize = 32 * 1024 * 1024;
const REVIEWER: &str = "gemini-3.8-flash-high(low)";
const CLASSIFIERS: [&str; 2] = [
    "You are a security classifier for auto permission mode.",
    "You are a security monitor for an autonomous AI coding agent.",
];

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
            "schema_version": 1,
            "metadata": {"Name": "qoder-approval-router", "Version": env!("CARGO_PKG_VERSION"), "Author": "crx-96", "GitHubRepository": "https://github.com/crx-96/axing-qoder-plugin"},
            "capabilities": {"model_router": true}
        })),
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
        .map_err(|_| "invalid catalog")
    } else {
        Err("catalog unavailable")
    };
    if !buffer.ptr.is_null() {
        unsafe { (host.free)(buffer.ptr as *mut c_void, buffer.len) };
    }
    let envelope = result?;
    if envelope["ok"] != true {
        return Err("catalog unavailable");
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
