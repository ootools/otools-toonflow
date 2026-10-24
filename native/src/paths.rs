//! 插件自身目录与数据目录的解析。
//!
//! 宿主加载 cdylib 时会先把它复制到缓存目录（见主仓
//! `platform/native_plugins/core.rs::copy_native_lib_to_cache`），所以**不能**
//! 用 `current_exe` / `dladdr` 反推插件根，只能按安装约定定位。

use std::env;
use std::path::PathBuf;

pub const PACKID: &str = "otools-toonflow";

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 插件根目录。
///
/// 顺序：显式环境变量（测试/调试用）→ 安装态 `~/.otools/plugins/<packid>`
/// → 开发态 `<cwd>/plugins/<packid>`。
pub fn plugin_root() -> PathBuf {
    if let Some(raw) = env::var_os("OTOOLS_TOONFLOW_ROOT") {
        let candidate = PathBuf::from(raw);
        if candidate.is_dir() {
            return candidate;
        }
    }

    let installed = home_dir().join(".otools").join("plugins").join(PACKID);
    if installed.is_dir() {
        return installed;
    }

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let dev = cwd.join("plugins").join(PACKID);
    if dev.is_dir() {
        return dev;
    }

    installed
}

pub fn runtime_dir() -> PathBuf {
    plugin_root().join("runtime")
}

/// 上游 `build:server` 的产物入口。
pub fn server_entry() -> PathBuf {
    plugin_root().join("build").join("server").join("index.js")
}

/// 边车启动器（见 `runtime/launch.mjs`）。
pub fn launcher_entry() -> PathBuf {
    runtime_dir().join("launch.mjs")
}

pub fn bun_path() -> PathBuf {
    runtime_dir().join(if cfg!(windows) { "bun.exe" } else { "bun" })
}

/// 数据目录：插件目录会随升级被替换，工作区不能放那儿。
pub fn data_dir() -> PathBuf {
    home_dir().join(".otools").join("local").join("toonflow")
}

pub fn log_path() -> PathBuf {
    data_dir().join("logs").join("sidecar.log")
}

pub fn pid_path() -> PathBuf {
    data_dir().join("sidecar.json")
}
