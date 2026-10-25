/**
 * 打包 Toonflow 插件为 .oplg（与宿主 park_install_offline_plugin 的产物格式一致）。
 * ------------------------------------------------------------------
 * `.oplg` 是一个 ZIP（扁平结构，plugin.json 在根），宿主「本地安装」或插件市场
 * 下载后解包即可运行。
 *
 * 与纯前端插件不同，本插件是**自带后端的全栈边车**，所以一个 .oplg 里要塞：
 *   dist/                  前端启动页（vite 产物，平台无关）
 *   lib/{macOS.dylib,Windows.dll,Linux.so}   native 适配层（三平台）
 *   build/                 上游 Toonflow 的 `build:server` 产物（平台无关 JS）
 *                          ——server/index.js、web/、nodes/、tools/、ext/、
 *                          providers/、skills/、server/node_modules/…
 *   runtime/{bun-*,launch.mjs}  各平台的 Bun 运行时 + 启动器
 *
 * 平台专属文件（lib/、runtime/bun-*）靠**命名**区分，宿主/native 层按当前
 * OS/arch 挑对应那份，因此**一份 .oplg 覆盖 macOS/Linux/Windows**，无需
 * 按平台出多个包。产物体积偏大（内嵌 Bun 与上游服务端）是换「开箱即用、
 * 离线可用」的必要成本。
 *
 * 用 `productionManifest` 去掉开发期配置（devUrl / quickDev），
 * 否则 OTools 的正式包校验会以「正式包不能启用开发模式」拒收。
 *
 * 用法：
 *   node scripts/pack-plugin.mjs [--out dist-pack] [--version 0.1.0]
 */
import { deflateRawSync, crc32 } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * 递归收集目录下的文件（返回包内相对路径，统一用 / 分隔）。
 *
 * 跟随符号链接并解引用：上游 build/ 来自 bun workspace，node_modules 里可能有
 * workspace 软链，装进 .oplg 必须落成真实文件（自包含，不能留悬空软链）。
 * 用 DFS 栈防软链成环；坏软链直接跳过。
 */
function walk(dir, base = dir, stack = new Set()) {
  const out = [];
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = dir;
  }
  if (stack.has(real)) return out;
  stack.add(real);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walk(full, base, stack));
    else if (stat.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  stack.delete(real);
  return out;
}

/** DOS 时间戳（ZIP 规范要求） */
function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/** 手写 ZIP（不引第三方库，CI 只要有 node 就能打包） */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(now.time, 12);
    dir.writeUInt16LE(now.day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * 生产清单：去掉开发期配置。
 *
 * OTools 的正式包校验会拒收带 `devUrl` 或 `quickDev` 的包，理由就是
 * 「正式包不能启用开发模式」。源仓库里的 plugin.json 保留它们
 * （本地 `pnpm dev` 调试要用），打进 .oplg 时换成这一份。
 */
export function productionManifest(manifest, version = '') {
  const next = version || String(manifest.version || '').trim();
  const entry = manifest.entry;
  if (typeof entry !== 'string' || !entry || entry.startsWith('/') || entry.includes('\\') || entry.includes(':')) {
    throw new Error('插件 entry 必须是包内相对路径');
  }
  if (entry.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error(`插件 entry 含非法路径段：${entry}`);
  }
  const result = { ...manifest, version: next };
  delete result.devUrl;
  delete result.quickDev;
  // native 插件的 autoReload 是开发期热重载开关（宿主监听动态库变化），
  // 正式包必须关掉，与 devUrl / quickDev 同理。
  if (result.native && typeof result.native === 'object') {
    result.native = { ...result.native, autoReload: false };
  }
  return result;
}

function main() {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const manifest = productionManifest(source, arg('version', source.version));
  const { version, packid } = manifest;

  const outDir = path.join(root, arg('out', 'dist-pack'));
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 包内 plugin.json（生产清单，版本号与文件名一致）
  const entries = [{ name: 'plugin.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }];

  // 2) 图标：插件市场/插件仓库要求根目录有 logo.svg
  for (const logo of ['logo.svg', 'logo.png']) {
    const full = path.join(root, logo);
    if (fs.existsSync(full)) entries.push({ name: logo, data: fs.readFileSync(full) });
  }

  // 3) 打进包的目录：前端产物、native 适配层、上游服务端、Bun 运行时。
  for (const name of ['dist', 'lib', 'build', 'runtime']) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    for (const relative of walk(dir)) {
      entries.push({ name: `${name}/${relative}`, data: fs.readFileSync(path.join(dir, relative)) });
    }
  }

  const names = entries.map((item) => item.name);

  // 4) 自检：关键文件必须真的在包里，缺一样都说明装配没跑完。
  const entryFile = String(manifest.entry || '').replace(/^\.?\//, '');
  if (!names.includes(entryFile)) {
    throw new Error(`manifest.entry 指向的文件不在包内：${entryFile}（请先执行 node scripts/build.mjs）`);
  }
  if (!names.includes('logo.svg')) throw new Error('插件根目录必须提供 logo.svg');
  if (!names.includes('build/server/index.js')) {
    throw new Error('包内缺少上游服务端 build/server/index.js（先跑 fetch-upstream.mjs）');
  }
  if (!names.includes('build/web/index.html')) {
    throw new Error('包内缺少上游前端 build/web/index.html');
  }
  if (!names.includes('runtime/launch.mjs')) throw new Error('包内缺少 runtime/launch.mjs');
  if (!names.some((name) => name.startsWith('runtime/bun'))) {
    throw new Error('包内没有任何 Bun 运行时（runtime/bun*，先 bundle-bun）');
  }
  const nativeLibs = names.filter((name) => /^lib\/(macOS\.dylib|Windows\.dll|Linux\.so)$/.test(name));
  for (const required of ['lib/macOS.dylib', 'lib/Windows.dll', 'lib/Linux.so']) {
    if (!nativeLibs.includes(required)) throw new Error(`包内缺少原生库 ${required}（先构建 native 适配层）`);
  }

  const output = path.join(outDir, `${packid}-${version}.oplg`);
  fs.writeFileSync(output, zip(entries));

  // 发布目录统一扁平结构：oplg + plugin.json + logo.svg + 摘要 + 元信息
  fs.writeFileSync(path.join(outDir, 'plugin.json'), entries[0].data);
  fs.copyFileSync(path.join(root, 'logo.svg'), path.join(outDir, 'logo.svg'));
  const releaseFiles = [path.basename(output), 'plugin.json', 'logo.svg'];
  const sums = releaseFiles.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  const meta = {
    packid,
    uuid: manifest.uuid,
    version,
    output,
    entries: entries.length,
    totalBytes: entries.reduce((sum, item) => sum + item.data.length, 0),
    nativeLibs,
    bunRuntimes: names.filter((name) => name.startsWith('runtime/bun')),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
