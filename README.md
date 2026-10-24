# otools-toonflow

[Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) 的 OTools 独立插件。

Toonflow 是一个「自带后端的全栈应用」（Vue 3 前端 + Bun/Express 服务端 + 可扩展的节点/工具插件）。
本仓不重写它的任何业务代码，只做一件事：**把它的服务端当边车（sidecar）打包进插件，让 OTools 里点开就是一个能用的 Toonflow。**

## 形态

```
插件包
├── dist/                 ← 启动页（本仓 src/，Vite 构建）
├── lib/macOS.dylib 等     ← native 适配层（本仓 native/，cdylib）
├── build/                ← 上游 build:server 产物（web/server/tools/nodes/ext/providers/skills/mcp）
├── runtime/bun           ← 固定版本 Bun 运行时（按平台）
└── runtime/launch.mjs    ← 边车启动器（本仓自带）
```

运行链路：

1. 打开插件 → 启动页调 `toonflow_start`；
2. native 层分配回环端口、拉起 `runtime/bun runtime/launch.mjs`，日志写
   `~/.otools/local/toonflow/logs/sidecar.log`；
3. 看门狗轮询 `GET /` 直到就绪，前端跳转：
   - 桌面：`http://127.0.0.1:<port>/`；
   - Web/远程：`/api/otools/http/?plugin=otools-toonflow`（宿主同源反向代理，
     见 `ootools/tauri-remote-service` 的「插件本地服务反向代理」一节）。

`plugin_http_port` 是宿主整站代理约定的探测方法，返回 `{ "port": <u16> }`，未就绪时返回 0。

## 为什么是边车而不是重写

上游有三处绕不过去的 JS 运行时依赖，重写成 Rust 等于重写一个带 JS 扩展沙箱的 Agent 平台：

- 工具插件 `.tool.js` 由服务端 `await import(pathToFileURL(...))` 加载；
- 媒体供应商是用户可写的 `.ts`，经 `Bun.Transpiler` 转译后进 `node:vm` 沙箱执行；
- Agent 内核是第三方 SDK（`@earendil-works/pi-coding-agent` + `pi-ai`）。

边车方案下，上游一行不改，插件市场里的节点/工具/供应商照常可用。

## 本地运行

```bash
# 1. 前端启动页
npm install
npm run build            # → dist/

# 2. 原生库
cargo build --manifest-path native/Cargo.toml --release
mkdir -p lib && cp native/target/release/libotools_toonflow_native.dylib lib/macOS.dylib

# 3. 组装上游产物 + Bun 运行时
node scripts/prepare-runtime.mjs --from ~/code/Toonflow-app/build
# 或者让它顺带跑上游构建：
node scripts/prepare-runtime.mjs --upstream ~/code/Toonflow-app

# 4. 安装到本机插件目录
ln -sfn "$PWD" ~/.otools/plugins/otools-toonflow
```

首次打开会初始化内置节点/工具/技能，约 10–60 秒；进度和日志都在启动页可见。

## 数据

- 工作区与配置：`~/.otools/local/toonflow/data`（不放在插件目录，避免升级被替换）
- 日志：`~/.otools/local/toonflow/logs/sidecar.log`
- 运行标记：`~/.otools/local/toonflow/sidecar.json`（pid/port，用于宿主重启后接管）

## 已知边界

- **Web 模式插件页**：宿主目前的独立插件路由（`isStandalonePluginRouteUrl`）尚未接线，
  Web 模式下第三方插件前端不能内嵌渲染。此时可用「手动打开」在浏览器新标签打开代理地址，
  或直接用桌面端。
- **分块上传**：宿主代理暂不支持 `Transfer-Encoding: chunked` 请求，走 `Content-Length` 的上传正常。
- **孤儿进程**：宿主被强杀时插件收不到回调；靠 stdin 管道关闭让边车自杀，另有 pid 文件在下次启动时接管。
- **上游迭代**：Toonflow 版本推进很快，升级方式是重跑 `prepare-runtime.mjs`，不需要改本仓代码。

## 许可

本仓 MIT。上游 Toonflow 亦为 MIT，运行时随包分发 Bun（MIT）。
