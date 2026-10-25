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
    use std::sync::Mutex;

    /// 生命周期用例会改 `OTOOLS_TOONFLOW_ROOT` / `HOME`，与端口探测用例互斥。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

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
        let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let response =
            invoke_impl(br#"{"method":"plugin_http_port","payload":null}"#).expect("port");
        assert_eq!(response["port"], 0);
    }

    /// 端到端：用桩服务替掉 Toonflow，验证「起进程 → 分配端口 → 健康检查 → 停止」。
    ///
    /// 需要本机有 bun；没有就跳过（CI 若不带 bun 不该因此变红）。
    #[test]
    fn sidecar_lifecycle_with_stub_server() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());

        let Some(bun) = find_bun() else {
            eprintln!("[skip] 本机没有 bun，跳过边车生命周期用例");
            return;
        };

        let root =
            std::env::temp_dir().join(format!("otools-toonflow-stub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("runtime")).expect("runtime dir");
        std::fs::create_dir_all(root.join("build/server")).expect("build dir");
        std::fs::write(
            root.join("runtime/launch.mjs"),
            include_str!("../../runtime/launch.mjs"),
        )
        .expect("launch.mjs");
        std::fs::write(
            root.join("build/server/index.js"),
            concat!(
                "const port = Number(process.env.TOONFLOW_SERVER_PORT);\n",
                "Bun.serve({ hostname: \"127.0.0.1\", port, fetch: () => new Response(\"toonflow-stub-ok\") });\n",
                "console.log(`stub listening on ${port}`);\n",
            ),
        )
        .expect("stub server");

        // 故意做成**不可执行**的副本：复现真实 bug——.oplg 解包后 bun 只剩 644，
        // spawn 前必须 chmod 兜底。Windows 没有 +x 概念，直接复制即可。
        let target = if cfg!(unix) {
            root.join("runtime/bun")
        } else {
            root.join("runtime/bun.exe")
        };
        std::fs::copy(&bun, &target).expect("copy bun");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))
                .expect("chmod 644");
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o111,
                0,
                "测试前置：副本不应可执行"
            );
        }

        std::env::set_var("OTOOLS_TOONFLOW_ROOT", &root);
        std::env::set_var("HOME", root.join("home"));

        sidecar::start().expect("start");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut port = 0;
        while std::time::Instant::now() < deadline {
            port = sidecar::current_port();
            if port > 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        let status = sidecar::status_json();
        assert!(port > 0, "边车未就绪: {status}");
        assert_eq!(status["state"], "running");

        // 真发一次 HTTP：不只是健康检查通过，边车得真的把响应体吐出来。
        let body = http_get(port).expect("边车 HTTP GET");
        assert!(body.contains("toonflow-stub-ok"), "边车响应异常: {body}");

        sidecar::stop().expect("stop");
        assert_eq!(sidecar::current_port(), 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 阻塞式 HTTP GET，取回响应体（只用于测试里的边车冒烟）。
    fn http_get(port: u16) -> Option<String> {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok()?;
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .ok()?;
        let mut buffer = String::new();
        stream.read_to_string(&mut buffer).ok()?;
        Some(buffer)
    }

    fn find_bun() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Some(bin) = std::env::var_os("BUN_BIN") {
            candidates.push(std::path::PathBuf::from(bin));
        }
        if let Some(home) = home {
            candidates.push(home.join(".bun/bin/bun"));
        }
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/bun"));
        candidates.push(std::path::PathBuf::from("/usr/local/bin/bun"));
        candidates.into_iter().find(|path| path.is_file())
    }
}
