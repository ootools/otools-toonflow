//! Toonflow 的 OTools 插件 native 适配层。
//!
//! 职责只有三件：
//! 1. 拉起打包在插件里的 Bun 边车（`runtime/bun` + `runtime/launch.mjs`）；
//! 2. 管住它的生命周期（健康检查、接管、停止、日志）；
//! 3. 把端口报给宿主，让 `/api/otools/http` 整站反向代理能接上。
//!
//! 业务代码一律在上游 Toonflow，这里不重写任何业务逻辑。
//!
//! **为什么内联 FFI 守卫、不依赖主仓的 `ot-plugin-ffi`**：本仓是公开仓，
//! `ootools/OTools` 主仓拉不到；仓内既有先例（`otools-designcraft`、`otools-vm`）
//! 同样内联自己的守卫，两者逻辑一致。
//!
//! 为什么必须有守卫：`otools_plugin_invoke` 是 `extern "C"` 边界，Rust panic
//! 不能跨 DLL unwind，逃出去会 `abort()` 掉整个宿主进程。

mod paths;
mod sidecar;

use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn dispatch(method: &str, _payload: &Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "message": "pong" })),
        "toonflow_status" | "status" => Ok(sidecar::status_json()),
        "toonflow_start" | "start" => {
            sidecar::start()?;
            Ok(sidecar::status_json())
        }
        "toonflow_stop" | "stop" => {
            sidecar::stop()?;
            Ok(sidecar::status_json())
        }
        // 宿主整站代理（`/api/otools/http`）约定的端口探测方法。
        "plugin_http_port" => Ok(json!({ "port": sidecar::current_port() })),
        "toonflow_log" | "log" => Ok(json!({ "lines": sidecar::log_tail(120) })),
        // 宿主在热更新 / 卸载前会先走一次停机协商。
        "__otools_shutdown__" => {
            sidecar::stop()?;
            Ok(json!("toonflow 边车已停止"))
        }
        other => Err(format!("未知方法: {other}")),
    }
}

fn invoke_impl(input: &[u8]) -> Result<Value, String> {
    let parsed: Value =
        serde_json::from_slice(input).map_err(|error| format!("请求解析失败: {error}"))?;
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method.trim().is_empty() {
        return Err("缺少 method".to_string());
    }
    let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
    dispatch(method, &payload)
}

/// FFI 边界：任何 panic 都转成普通的 `{ ok: false }` 响应，绝不跨边界。
fn guard_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
    handler: fn(&[u8]) -> Result<Value, String>,
) -> *mut u8 {
    let response = match catch_unwind(AssertUnwindSafe(|| {
        if input_ptr.is_null() || input_len == 0 {
            return Err("请求为空".to_string());
        }
        let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
        handler(input)
    })) {
        Ok(Ok(data)) => json!({ "ok": true, "data": data }),
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            eprintln!("[toonflow-native] 插件内部 panic: {message}");
            json!({ "ok": false, "error": format!("插件内部错误: {message}"), "panic": true })
        }
    };

    let mut bytes = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    if bytes.is_empty() {
        bytes.extend_from_slice(b"{}");
    }
    let len = bytes.len();
    unsafe {
        *output_len = len;
    }
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    guard_invoke(input_ptr, input_len, output_len, invoke_impl)
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        let response = invoke_impl(br#"{"method":"ping","payload":null}"#).expect("ping");
        assert_eq!(response["message"], "pong");
    }

    #[test]
    fn unknown_method_is_an_error() {
        assert!(invoke_impl(br#"{"method":"nope"}"#).is_err());
    }

    #[test]
    fn empty_request_is_rejected() {
        assert!(invoke_impl(b"").is_err());
    }

    #[test]
    fn port_probe_reports_zero_when_stopped() {
        let response =
            invoke_impl(br#"{"method":"plugin_http_port","payload":null}"#).expect("port");
        assert_eq!(response["port"], 0);
    }
}
