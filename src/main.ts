import { invokeNative, isWebRuntime } from './host';

const PACKID = 'otools-toonflow';
const POLL_INTERVAL_MS = 600;
/** 启动阶段给的上限，超过就认为卡住，交给用户点重试。 */
const STARTUP_BUDGET_MS = 150_000;

type SidecarState = 'stopped' | 'starting' | 'running' | 'failed';

interface SidecarStatus {
  state: SidecarState;
  port: number;
  pid?: number | null;
  message?: string;
  dataDir?: string;
  logPath?: string;
  log?: string[];
}

const statusPill = document.getElementById('status') as HTMLSpanElement;
const messageNode = document.getElementById('message') as HTMLParagraphElement;
const logNode = document.getElementById('log') as HTMLPreElement;
const dataDirNode = document.getElementById('data-dir') as HTMLElement;
const retryButton = document.getElementById('retry') as HTMLButtonElement;
const stopButton = document.getElementById('stop') as HTMLButtonElement;
const openButton = document.getElementById('open') as HTMLButtonElement;

const STATE_TEXT: Record<SidecarState, string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '已就绪',
  failed: '启动失败',
};

let pollTimer: number | undefined;
let startedAt = 0;
let redirecting = false;

/** 目标地址：桌面直连回环端口，Web 走宿主同源反向代理。 */
function targetUrl(port: number): string {
  if (!isWebRuntime()) {
    return `http://127.0.0.1:${port}/`;
  }
  const params = new URLSearchParams({ plugin: PACKID });
  const token = new URLSearchParams(location.search).get('token');
  if (token) {
    params.set('token', token);
  }
  return `/api/otools/http/?${params.toString()}`;
}

function setState(state: SidecarState, text: string): void {
  statusPill.dataset.state = state;
  statusPill.textContent = STATE_TEXT[state];
  messageNode.textContent = text;
}

function renderLog(lines: string[] | undefined): void {
  if (!lines || lines.length === 0) {
    logNode.hidden = true;
    return;
  }
  logNode.hidden = false;
  logNode.textContent = lines.join('\n');
  logNode.scrollTop = logNode.scrollHeight;
}

function showActions(state: SidecarState, port: number): void {
  const failed = state === 'failed';
  retryButton.hidden = !failed && state !== 'stopped';
  stopButton.hidden = state !== 'running' && state !== 'starting';
  openButton.hidden = !(state === 'running' && port > 0);
}

function applyStatus(status: SidecarStatus): void {
  if (status.dataDir) {
    dataDirNode.textContent = status.dataDir;
  }
  renderLog(status.log);
  showActions(status.state, status.port);

  if (status.state === 'running' && status.port > 0) {
    if (redirecting) {
      return;
    }
    redirecting = true;
    stopPolling();
    setState('running', `本地服务已就绪（127.0.0.1:${status.port}），正在打开…`);
    location.replace(targetUrl(status.port));
    return;
  }

  if (status.state === 'failed') {
    stopPolling();
    setState('failed', status.message || '本地服务启动失败，请查看下方日志');
    return;
  }

  if (status.state === 'starting') {
    const elapsed = Date.now() - startedAt;
    if (elapsed > STARTUP_BUDGET_MS) {
      stopPolling();
      setState('failed', '启动超时。首次启动要初始化内置插件与技能，可点重试再等一会儿。');
      return;
    }
    setState('starting', '正在拉起本地服务（首次启动需要初始化内置插件，约 10–60 秒）…');
    return;
  }

  setState('stopped', '本地服务未运行');
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

async function poll(): Promise<void> {
  stopPolling();
  try {
    const status = await invokeNative<SidecarStatus>('toonflow_status');
    applyStatus(status);
    if (status.state === 'starting') {
      pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  } catch (error) {
    setState('failed', `读取状态失败：${(error as Error).message}`);
  }
}

async function start(): Promise<void> {
  startedAt = Date.now();
  redirecting = false;
  retryButton.hidden = true;
  stopButton.hidden = false;
  openButton.hidden = true;
  setState('starting', '正在拉起本地服务…');
  try {
    const status = await invokeNative<SidecarStatus>('toonflow_start');
    applyStatus(status);
    if (status.state === 'starting') {
      pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  } catch (error) {
    setState('failed', (error as Error).message);
    retryButton.hidden = false;
    stopButton.hidden = true;
    void poll();
  }
}

retryButton.addEventListener('click', () => {
  void start();
});

stopButton.addEventListener('click', async () => {
  try {
    const status = await invokeNative<SidecarStatus>('toonflow_stop');
    stopPolling();
    redirecting = false;
    applyStatus(status);
  } catch (error) {
    setState('failed', `停止失败：${(error as Error).message}`);
  }
});

openButton.addEventListener('click', async () => {
  const status = await invokeNative<SidecarStatus>('toonflow_status');
  if (status.port > 0) {
    window.open(targetUrl(status.port), '_blank', 'noopener');
  }
});

void start();
