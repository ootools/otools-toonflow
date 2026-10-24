// Toonflow 边车启动器。
//
// 只做两件事：
// 1. 接管 stdin：宿主进程消失时管道关闭，这里收到 EOF 主动退出，
//    避免宿主被强杀后留下孤儿 Bun 进程（宿主没有可用的关机钩子）。
// 2. 以 `build/server/index.js` 的**文件位置**启动上游服务：上游靠
//    `import.meta.dirname` 反推应用根目录（`../..` → 插件根），所以入口不能搬走，
//    必须在 `<plugin>/build/server/` 下。
process.stdin.resume();

const shutdown = () => process.exit(0);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

await import("../build/server/index.js");
