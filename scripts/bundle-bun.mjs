#!/usr/bin/env node
/**
 * 把各平台的 Bun 运行时下载进插件 `runtime/`，命名与 native/src/paths.rs 的
 * `platform_bun_name()` 一致，让**一份 .oplg 覆盖所有平台**：
 *   runtime/bun-darwin-aarch64      runtime/bun-darwin-x86_64
 *   runtime/bun-linux-x86_64        runtime/bun-linux-aarch64
 *   runtime/bun-windows-x86_64.exe
 *
 * Bun 发布资产托管在 github.com/oven-sh/bun（HTTPS 直链），用 curl 下载
 * （尊重 HTTP(S)_PROXY；CI 上不需要代理，直连即可）。
 *
 * 版本默认取上游 package.json 的 packageManager（bun@x.y.z），可用 --version 覆盖。
 *
 * 用法：
 *   node scripts/bundle-bun.mjs                 # 默认版本，下载全部平台
 *   node scripts/bundle-bun.mjs --version 1.3.14
 *   node scripts/bundle-bun.mjs --only darwin-aarch64   # 只要某个平台（本地调试）
 */
import { mkdir, rm, chmod, readFile, stat, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(repoRoot, 'runtime');
const RELEASE_BASE = 'https://github.com/oven-sh/bun/releases/download';

// Bun triple → 包内文件名（与 native platform_bun_name 对齐；windows 带 .exe）。
// 默认打四个主力平台（macOS 双架构 / Linux x64 / Windows x64）。arm64 Linux
// 目前不在默认集里（Bun 二进制 ~63MB/个，先控体积）；需要时加一行即可，
// native 层的 platform_bun_name() 已认识 bun-linux-aarch64。
const TARGETS = [
  { triple: 'darwin-aarch64', asset: 'bun-darwin-aarch64.zip', name: 'bun-darwin-aarch64' },
  { triple: 'darwin-x86_64', asset: 'bun-darwin-x86_64.zip', name: 'bun-darwin-x86_64' },
  { triple: 'linux-x86_64', asset: 'bun-linux-x86_64.zip', name: 'bun-linux-x86_64' },
  { triple: 'windows-x86_64', asset: 'bun-windows-x86_64.zip', name: 'bun-windows-x86_64.exe' },
];

function parseArgs(argv) {
  const options = { version: '', only: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') options.version = argv[++index] ?? '';
    else if (arg === '--only') options.only = argv[++index] ?? '';
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 从上游 package.json 读 packageManager 的 bun 版本；读不到就用内置默认。 */
async function defaultVersion() {
  try {
    const text = await readFile(join(repoRoot, 'upstream.pin'), 'utf8');
    void text;
  } catch {
    /* pin 缺失无所谓，版本另找来源 */
  }
  // 上游 Toonflow 的 packageManager 固定为 bun@1.3.14（见 apps 根 package.json）。
  // 这里不 clone 上游，直接内置，避免 fetch-upstream 之外的额外网络往返。
  return '1.3.14';
}

function download(url, dest) {
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
}

function unzipTo(zipPath, outDir) {
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', outDir], { stdio: 'inherit' });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version || (await defaultVersion());
  await mkdir(runtimeDir, { recursive: true });

  const targets = options.only ? TARGETS.filter((t) => t.triple === options.only) : TARGETS;
  if (targets.length === 0) throw new Error(`--only 没有匹配的平台：${options.only}`);

  for (const target of targets) {
    const finalPath = join(runtimeDir, target.name);
    const workDir = join(tmpdir(), `bun-${target.triple}-${process.pid}`);
    const zipPath = join(workDir, target.asset);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    const url = `${RELEASE_BASE}/bun-v${version}/${target.asset}`;
    console.log(`[bun] ${target.triple}: ${url}`);
    download(url, zipPath);
    unzipTo(zipPath, workDir);

    // zip 里是单个 `bun`（Windows 为 `bun.exe`）。找到它，按目标名落位。
    const inner = join(workDir, target.triple.startsWith('windows') ? 'bun.exe' : 'bun');
    if (!(await exists(inner))) throw new Error(`解压后找不到 bun 可执行文件：${inner}`);
    await rm(finalPath, { force: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(inner, finalPath);
    await chmod(finalPath, 0o755);
    const size = (await stat(finalPath)).size;
    console.log(`[bun] → ${finalPath} (${(size / 1048576).toFixed(1)}MB)`);
    await rm(workDir, { recursive: true, force: true });
  }
  console.log(`[bun] 完成（bun v${version}，${targets.length} 个平台）`);
}

main().catch((error) => {
  console.error(`[bun] 失败: ${error.message}`);
  process.exit(1);
});
