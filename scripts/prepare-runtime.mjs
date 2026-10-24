#!/usr/bin/env node
/**
 * 把上游 Toonflow 的构建产物 + Bun 运行时组装进插件目录。
 *
 * 布局必须和上游一致（不能搬动入口）：
 *   <plugin>/build/server/index.js   ← 上游 `build:server` 的产物
 *   <plugin>/build/web|tools|nodes|ext|providers|skills|mcp
 *   <plugin>/runtime/bun             ← 本脚本复制
 *   <plugin>/runtime/launch.mjs      ← 仓库自带
 *
 * 原因：上游 `apps/server/src/index.ts` 用 `import.meta.dirname` 反推应用根
 * （`build/server` 上跳两级 = 插件根），再据此定位 `build/web` 等目录。
 *
 * 用法：
 *   node scripts/prepare-runtime.mjs --from ~/code/Toonflow-app/build
 *   node scripts/prepare-runtime.mjs --upstream ~/code/Toonflow-app   # 先跑上游构建
 *   node scripts/prepare-runtime.mjs --from <dir> --bun ~/.bun/bin/bun
 */

import { cp, mkdir, readdir, rm, stat, copyFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(repoRoot, 'build');
const runtimeDir = join(repoRoot, 'runtime');

function parseArgs(argv) {
  const options = { from: '', upstream: '', bun: '', clean: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from') options.from = argv[++index] ?? '';
    else if (arg === '--upstream') options.upstream = argv[++index] ?? '';
    else if (arg === '--bun') options.bun = argv[++index] ?? '';
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/prepare-runtime.mjs [--from <build 目录>] [--upstream <Toonflow 源码根>] [--bun <bun 可执行文件>] [--clean]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

function formatSize(bytes) {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function resolveBunPath(explicit) {
  if (explicit) {
    const absolute = resolve(explicit);
    if (!(await exists(absolute))) throw new Error(`--bun 指向的文件不存在: ${absolute}`);
    return absolute;
  }
  const candidates = [
    process.env.BUN_BIN,
    join(process.env.HOME ?? '', '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('找不到 bun 可执行文件，请用 --bun 指定（CI 里通常显式下载固定版本）');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.from && !options.upstream) {
    throw new Error('必须给出 --from <已构建的 build 目录> 或 --upstream <Toonflow 源码根>');
  }

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true });
    await rm(join(runtimeDir, 'bun'), { force: true });
    await rm(join(runtimeDir, 'bun.exe'), { force: true });
  }

  let sourceBuild = options.from ? resolve(options.from) : '';
  if (options.upstream) {
    const upstreamRoot = resolve(options.upstream);
    if (!(await exists(join(upstreamRoot, 'apps', 'server')))) {
      throw new Error(`--upstream 不像 Toonflow 源码根（缺少 apps/server）: ${upstreamRoot}`);
    }
    console.log('[prepare] 运行上游构建: bun run build:server');
    execFileSync('bun', ['run', 'build:server'], { cwd: upstreamRoot, stdio: 'inherit' });
    sourceBuild = join(upstreamRoot, 'build');
  }

  if (!(await exists(join(sourceBuild, 'server', 'index.js')))) {
    throw new Error(`构建产物里没有 server/index.js: ${sourceBuild}`);
  }
  if (!(await exists(join(sourceBuild, 'web', 'index.html')))) {
    throw new Error(`构建产物里没有 web/index.html: ${sourceBuild}`);
  }

  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  console.log(`[prepare] 复制构建产物 ${sourceBuild} → ${buildDir}`);
  await cp(sourceBuild, buildDir, { recursive: true });

  const bunSource = await resolveBunPath(options.bun);
  const bunTarget = join(runtimeDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
  await mkdir(runtimeDir, { recursive: true });
  console.log(`[prepare] 复制 Bun 运行时 ${bunSource} → ${bunTarget}`);
  await copyFile(bunSource, bunTarget);
  await chmod(bunTarget, 0o755);

  const buildSize = await dirSize(buildDir);
  const bunSize = (await stat(bunTarget)).size;
  console.log('');
  console.log(`[prepare] 完成`);
  console.log(`  build/   ${formatSize(buildSize)}`);
  console.log(`  runtime/ ${formatSize(bunSize)} (bun)`);
  console.log(`  合计     ${formatSize(buildSize + bunSize)}`);
  console.log('');
  console.log('下一步：构建 native 库并打包，见 README「本地运行」。');
}

main().catch((error) => {
  console.error(`[prepare] 失败: ${error.message}`);
  process.exit(1);
});
