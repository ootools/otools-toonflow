/**
 * 宿主原生能力入口。
 *
 * 插件页在两种运行时下都能拿到 `window.otools`：
 * - 桌面：宿主注入的插件桥；
 * - Web：`tauri-remote-service` 注入的 facade（`invokeNative` 走
 *   `POST /api/otools/native/invoke`）。
 *
 * 所以这里不判断运行时、也不引 `@tauri-apps/api`——同一条调用链两边都成立。
 */

type NativeInvoke = (method: string, payload?: unknown) => Promise<unknown>;

interface HostRuntime {
  invokeNative?: NativeInvoke;
  getPluginUuid?: () => string;
}

function runtime(): HostRuntime | undefined {
  const scope = window as unknown as { otools?: HostRuntime; utools?: HostRuntime };
  return scope.otools ?? scope.utools;
}

export async function invokeNative<T>(method: string, payload?: unknown): Promise<T> {
  const bridge = runtime()?.invokeNative;
  if (typeof bridge !== 'function') {
    throw new Error('宿主未提供 otools.invokeNative，插件桥不可用');
  }
  return (await bridge(method, payload ?? null)) as T;
}

export function isWebRuntime(): boolean {
  const scope = window as unknown as { __OToolsEnv?: { runtime?: string } };
  if (scope.__OToolsEnv?.runtime === 'web') {
    return true;
  }
  return location.protocol === 'http:' || location.protocol === 'https:';
}
