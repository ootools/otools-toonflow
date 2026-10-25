# otools-toonflow

[Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) 的 OTools 独立插件。

Toonflow 是一个「自带后端的全栈应用」（Vue 3 前端 + Bun/Express 服务端 + 可扩展的节点/工具插件）。
本仓不重写它的任何业务代码，只做一件事：**把它的服务端当边车（sidecar）打包进插件，让 OTools 里点开就是一个能用的 Toonflow。**

## 形态

```
插件包
├── dist/                 ← 启动页（本仓 src/，Vite 构建）
├── lib/macOS.dylib 等     ← native 适配层（本仓 native/，cdylib，三平台）
├── build/                ← 上游 build:server 产物（web/server/tools/nodes/ext/providers/skills/mcp）
├── runtime/bun-*         ← 各平台固定版本 Bun 运行时（macOS/Linux/Windows）
└── runtime/launch.mjs    ← 边车启动器（本仓自带）
```

平台专属文件靠**命名**区分（`lib/{macOS.dylib,Windows.dll,Linux.so}`、`runtime/bun-*`），
宿主/native 层按当前 OS/arch 挑对应那份，因此**一份 .oplg 覆盖所有平台**，无需按平台出多个包。

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

# 3. 组装上游产物（build/）
#    两种方式：已有构建好的 build 目录，或让脚本拉上游源码并 build:server。
#    后者需要能访问 npm registry（CI 上天然可用）。
node scripts/prepare-runtime.mjs --from ~/code/Toonflow-app/build
node scripts/fetch-upstream.mjs                 # 按 upstream.pin 拉取并构建

# 4. Bun 运行时（多平台；本地只要当前平台可加 --only）
node scripts/bundle-bun.mjs --only darwin-aarch64   # → runtime/bun-darwin-aarch64

# 5. 安装到本机插件目录
ln -sfn "$PWD" ~/.otools/plugins/otools-toonflow
```

首次打开会初始化内置节点/工具/技能，约 10–60 秒；进度和日志都在启动页可见。

## 构建与发布（CI）

`release-plugin.yml` 一条龙：四平台构建 native（macOS 双架构 `lipo` 成 universal）→
下载多平台 Bun → 按 `upstream.pin` 拉上游并 `build:server` → Vite 构建启动页 →
`pack-plugin.mjs` 打成 `.oplg` → `verify-plugin.mjs` 独立校验 → 建 GitHub Release →
`publish-market.mjs` 提交插件市场。

本地复刻打包与校验：

```bash
node scripts/pack-plugin.mjs --out dist-pack --version 0.1.0
node scripts/verify-plugin.mjs dist-pack
node --test scripts/*.test.mjs        # 发布脚本回归测试
```

发布市场：给仓库打 `v<semver>` 标签推送即自动走完整流程；仓库变量
`vars.OTOOLS_PUBLISH_MARKET=true` + 密秘密 `secrets.XYCLOUD_PAT` 已配置。
也可 `workflow_dispatch` 带 `publish_market=true`。上游版本固定在 `upstream.pin`，
升级上游只改这一行再重跑工作流。

## 数据

- 工作区与配置：`~/.otools/local/toonflow/data`（不放在插件目录，避免升级被替换）
- 日志：`~/.otools/local/toonflow/logs/sidecar.log`
- 运行标记：`~/.otools/local/toonflow/sidecar.json`（pid/port，用于宿主重启后接管）

## 已知边界

- **包体积**：一份 `.oplg` 内嵌多平台 Bun（~63MB/个）+ 上游自包含服务端，体积偏大，
  这是换「开箱即用、离线可用」的必要成本。默认打 macOS(arm64+x64)/Linux x64/Windows x64
  四个平台；**arm64 Linux 暂不在默认集**（在 `scripts/bundle-bun.mjs` 的 `TARGETS` 加一行即可）。
- **Web 模式插件页**：宿主目前的独立插件路由（`isStandalonePluginRouteUrl`）尚未接线，
  Web 模式下第三方插件前端不能内嵌渲染。此时可用「手动打开」在浏览器新标签打开代理地址，
  或直接用桌面端。
- **分块上传**：宿主代理暂不支持 `Transfer-Encoding: chunked` 请求，走 `Content-Length` 的上传正常。
- **孤儿进程**：宿主被强杀时插件收不到回调；靠 stdin 管道关闭让边车自杀，另有 pid 文件在下次启动时接管。
- **上游迭代**：Toonflow 版本推进很快，升级方式是改 `upstream.pin` 再重跑 release 工作流，不需要改本仓代码。

## 许可

本仓 MIT。上游 Toonflow 亦为 MIT，运行时随包分发 Bun（MIT）。
