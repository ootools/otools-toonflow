//! Bun 边车的生命周期：启动、健康检查、接管、停止。
//!
//! 设计约束（来自宿主）：
//! - `native_plugin_invoke` 在阻塞线程池里跑，但 UI 会同步等结果，所以
//!   **启动不能阻塞**：`start()` 只负责拉起进程就返回，就绪状态由看门狗线程更新，
//!   前端轮询 `toonflow_status`。
//! - 宿主被强杀时插件拿不到任何回调，边车会残留；因此把 pid/port 落盘，
//!   下次启动先尝试接管，避免两份服务抢同一个数据目录。

use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::paths;

/// 首次启动要初始化内置节点/工具/技能，慢机器上见过 40s+，给足余量。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_INTERVAL: Duration = Duration::from_millis(400);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const LOG_TAIL_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Stopped,
    Starting,
    Running,
    Failed,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Stopped => "stopped",
            State::Starting => "starting",
            State::Running => "running",
            State::Failed => "failed",
        }
    }
}

struct Inner {
    child: Option<Child>,
    /// 接管来的旧进程：只有 pid，没有 Child 句柄。
    adopted_pid: Option<u32>,
    port: u16,
    state: State,
    message: String,
}

fn inner() -> &'static Mutex<Inner> {
    static INNER: OnceLock<Mutex<Inner>> = OnceLock::new();
    INNER.get_or_init(|| {
        Mutex::new(Inner {
            child: None,
            adopted_pid: None,
            port: 0,
            state: State::Stopped,
            message: String::new(),
        })
    })
}

/// 锁中毒时直接取回内部值：边车状态不值得因为一次 panic 就永久不可用。
fn lock() -> MutexGuard<'static, Inner> {
    inner().lock().unwrap_or_else(|error| error.into_inner())
}

pub fn status_json() -> Value {
    let mut guard = lock();
    // 子进程已退出但看门狗还没轮到：这里顺手收敛状态。
    let exited = match guard.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => false,
    };
    if exited {
        guard.child = None;
        guard.port = 0;
        guard.state = State::Failed;
        guard.message = "边车已退出，日志见 sidecar.log".to_string();
    }
    let state = guard.state;
    let port = guard.port;
    let message = guard.message.clone();
    let pid = guard
        .child
        .as_ref()
        .map(|child| child.id())
        .or(guard.adopted_pid);
    drop(guard);

    json!({
        "state": state.as_str(),
        "port": port,
        "pid": pid,
        "message": message,
        "root": paths::plugin_root().to_string_lossy(),
        "dataDir": paths::data_dir().to_string_lossy(),
        "logPath": paths::log_path().to_string_lossy(),
        "log": log_tail(40),
    })
}

pub fn start() -> Result<(), String> {
    let bun = paths::bun_path();
    let entry = paths::launcher_entry();
    if !bun.is_file() {
        return Err(format!(
            "缺少 Bun 运行时：{}。先执行 `node scripts/prepare-runtime.mjs`。",
            bun.display()
        ));
    }
    if !entry.is_file() {
        return Err(format!("缺少启动器：{}", entry.display()));
    }
    if !paths::server_entry().is_file() {
        return Err(format!(
            "缺少 Toonflow 服务端产物：{}。先执行 `node scripts/prepare-runtime.mjs --from <Toonflow>/build`。",
            paths::server_entry().display()
        ));
    }

    {
        let mut guard = lock();
        if guard.state == State::Running && guard.port > 0 && is_healthy(guard.port) {
            return Ok(());
        }
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.adopted_pid = None;
        guard.port = 0;
        guard.state = State::Starting;
        guard.message.clear();
    }

    // 上一次宿主被强杀留下的实例：能接管就接管，不重复起第二份。
    if let Some((pid, port)) = read_pid_file() {
        if is_healthy(port) {
            let mut guard = lock();
            guard.adopted_pid = Some(pid);
            guard.port = port;
            guard.state = State::Running;
            guard.message = "已接管上次运行的实例".to_string();
            return Ok(());
        }
        let _ = fs::remove_file(paths::pid_path());
    }

    let port = free_port()?;
    let data = paths::data_dir();
    fs::create_dir_all(data.join("logs")).map_err(|error| format!("创建数据目录失败: {error}"))?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_path())
        .map_err(|error| format!("打开日志失败: {error}"))?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("复制日志句柄失败: {error}"))?;

    let mut command = Command::new(&bun);
    command
        .arg(&entry)
        .current_dir(paths::plugin_root())
        .env("TOONFLOW_DATA_DIR", &data)
        .env("TOONFLOW_SERVER_PORT", port.to_string())
        // stdin 必须保持 piped：宿主进程消失时管道关闭，launch.mjs 会据此自杀，
        // 这是没有关机钩子可用时唯一可靠的孤儿回收手段。
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "启动边车失败({}): {error}；日志见 {}",
            bun.display(),
            paths::log_path().display()
        )
    })?;
    let pid = child.id();

    {
        let mut guard = lock();
        guard.child = Some(child);
        guard.port = port;
        guard.state = State::Starting;
        guard.message.clear();
    }
    let _ = write_pid_file(pid, port);
    spawn_watchdog(pid, port);
    Ok(())
}

pub fn stop() -> Result<(), String> {
    let mut guard = lock();
    if let Some(mut child) = guard.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(pid) = guard.adopted_pid.take() {
        kill_pid(pid);
    }
    guard.port = 0;
    guard.state = State::Stopped;
    guard.message.clear();
    let _ = fs::remove_file(paths::pid_path());
    Ok(())
}

/// 宿主整站代理约定的端口探测方法：只报「正在服务」的端口，其余一律 0。
pub fn current_port() -> u16 {
    let mut guard = lock();
    let exited = match guard.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => false,
    };
    if exited {
        guard.child = None;
        guard.port = 0;
        guard.state = State::Failed;
        return 0;
    }
    if guard.state == State::Running {
        guard.port
    } else {
        0
    }
}

fn spawn_watchdog(pid: u32, port: u16) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            if is_healthy(port) {
                let mut guard = lock();
                if guard.port == port {
                    guard.state = State::Running;
                    guard.message.clear();
                }
                return;
            }
            let exited = {
                let mut guard = lock();
                match guard.child.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => false,
                }
            };
            if exited {
                let mut guard = lock();
                guard.child = None;
                guard.port = 0;
                guard.state = State::Failed;
                guard.message = format!(
                    "边车启动后立即退出（pid {pid}），日志见 {}",
                    paths::log_path().display()
                );
                return;
            }
            std::thread::sleep(HEALTH_INTERVAL);
        }
        let mut guard = lock();
        guard.state = State::Failed;
        guard.message = format!("边车在 {} 秒内没有就绪", HEALTH_TIMEOUT.as_secs());
    });
}

fn is_healthy(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buffer = [0u8; 64];
    match stream.read(&mut buffer) {
        Ok(read) if read > 0 => {
            let head = String::from_utf8_lossy(&buffer[..read]);
            head.starts_with("HTTP/1.")
                && (head.contains(" 200") || head.contains(" 302") || head.contains(" 304"))
        }
        _ => false,
    }
}

fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("分配端口失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取端口失败: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn read_pid_file() -> Option<(u32, u16)> {
    let text = fs::read_to_string(paths::pid_path()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let pid = value.get("pid").and_then(Value::as_u64)? as u32;
    let port = value.get("port").and_then(Value::as_u64)? as u16;
    if pid == 0 || port == 0 {
        return None;
    }
    Some((pid, port))
}

fn write_pid_file(pid: u32, port: u16) -> Result<(), String> {
    let path = paths::pid_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    let payload = json!({ "pid": pid, "port": port }).to_string();
    fs::write(&path, payload).map_err(|error| format!("写入 pid 文件失败: {error}"))
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

/// 日志尾部若干行，供启动页展示失败原因。
pub fn log_tail(lines: usize) -> Vec<String> {
    let Ok(mut file) = File::open(paths::log_path()) else {
        return Vec::new();
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut tail: Vec<String> = text
        .lines()
        .rev()
        .take(lines)
        .map(|line| line.trim_end().to_string())
        .collect();
    tail.reverse();
    tail
}
