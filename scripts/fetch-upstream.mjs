#!/usr/bin/env node
/**
 * 拉取上游 Toonflow 并构建出自包含服务端产物，装配进插件 `build/`。
 *
 * 与纯前端插件的 fetch-upstream 不同：上游是 Bun monorepo，`build:server`
 * （= apps/server/scripts/buildStandalone.ts）会依次构建
 *   packages/{nodes,tools,ext} → build/{nodes,tools,ext}
 *   apps/web                    → build/web
 *   apps/server                 → build/server（含 node_modules、providers、skills）
 * 产物是平台无关的 JS，所以只需构建一次，四平台 .oplg 共用同一份。
 *
 * 固定提交写在 `upstream.pin`，避免上游一改插件包就漂移。
 *
 * 用法：
 *   node scripts/fetch-upstream.mjs                 # 按 upstream.pin 拉取并构建
 *   node scripts/fetch-upstream.mjs --ref v2.0.7    # 覆盖固定提交/标签
 *   node scripts/fetch-upstream.mjs --skip-install  # 已装好依赖，只重新构建
 *
 * 需要 bun（版本见上游 package.json 的 packageManager）。本仓不主动下载 bun：
 * 由 CI 或本机预先装好，否则 `bun install` 会失败。
 */
import { cp, mkdir, rm, stat, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(repoRoot, 'upstream.pin');
const upstreamUrl = 'https://github.com/HBAI-Ltd/Toonflow-app.git';

function parseArgs(argv) {
  const options = { ref: '', skipInstall: false, dest: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ref') options.ref = argv[++index] ?? '';
    else if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--dest') options.dest = argv[++index] ?? '';
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

async function readPin() {
  if (!(await exists(pinFile))) throw new Error(`缺少 upstream.pin：${pinFile}`);
  const text = await (await import('node:fs/promises')).readFile(pinFile, 'utf8');
  const line = text.split('\n').find((row) => row.trim() && !row.trim().startsWith('#'));
  if (!line) throw new Error('upstream.pin 里没有固定提交');
  const [sha, ref] = line.trim().split(/\s+/);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`upstream.pin 首列不是合法提交号：${sha}`);
  return { sha, ref: ref || sha };
}

function bunBin() {
  for (const candidate of [process.env.BUN_BIN, join(process.env.HOME ?? '', '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun', 'bun']) {
    if (candidate) return candidate;
  }
  return 'bun';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { sha, ref } = await readPin();
  const checkout = options.ref || ref;
  const dest = resolve(options.dest || join(repoRoot, '.upstream', 'toonflow'));

  // 1) 浅克隆指定提交（无历史），已存在则清理重来，保证与 pin 一致。
  console.log(`[fetch] 克隆上游 ${checkout} → ${dest}`);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  execFileSync('git', ['init', '-q', dest], { stdio: 'inherit' });
  execFileSync('git', ['-C', dest, 'remote', 'add', 'origin', upstreamUrl], { stdio: 'inherit' });
  // 直接按 SHA/tag fetch 单次提交，避免 clone 全量历史。
  const fetchable = /^[0-9a-f]{40}$/.test(checkout) ? checkout : checkout;
  execFileSync('git', ['-C', dest, 'fetch', '-q', '--depth', '1', 'origin', fetchable], { stdio: 'inherit' });
  execFileSync('git', ['-C', dest, 'checkout', '-q', 'FETCH_HEAD'], { stdio: 'inherit' });

  // 漂移保护：实际拉到的提交必须等于 pin，否则说明 ref 被强推/tag 迁移。
  const head = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!head.startsWith(sha) && !sha.startsWith(head)) {
    throw new Error(`上游提交与 pin 不一致：pin=${sha}，实际=${head}（请更新 upstream.pin）`);
  }

  // 2) 安装依赖（需要 npm registry 网络；CI 上天然可用）。
  if (!options.skipInstall) {
    console.log('[fetch] bun install');
    execFileSync(bunBin(), ['install', '--frozen-lockfile'], { cwd: dest, stdio: 'inherit' });
  }

  // 3) 构建自包含服务端（nodes/tools/ext/web/server → build/）。
  console.log('[fetch] bun run build:server');
  execFileSync(bunBin(), ['run', 'build:server'], { cwd: dest, stdio: 'inherit' });

  const sourceBuild = join(dest, 'build');
  if (!(await exists(join(sourceBuild, 'server', 'index.js')))) {
    throw new Error(`上游构建产物缺少 server/index.js：${sourceBuild}`);
  }

  // 4) 装配进插件 build/（与上游布局一致，native 层按此定位）。
  const target = join(repoRoot, 'build');
  console.log(`[fetch] 装配 ${sourceBuild} → ${target}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(sourceBuild, target, { recursive: true });
  console.log(`[fetch] 完成（固定提交 ${sha}）`);
}

main().catch((error) => {
  console.error(`[fetch] 失败: ${error.message}`);
  process.exit(1);
});
