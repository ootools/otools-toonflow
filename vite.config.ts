import { defineConfig } from 'vite';

// `base: './'` 不是可选项：
// - 桌面端插件页由 `otools-plugin://localhost/<uuid>/dist/index.html` 提供；
// - Web 端整站代理挂在 `/api/otools/http/` 前缀下。
// 绝对路径 `/assets/*` 在两种形态里都会打到错误的位置，相对基址两边都成立。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    strictPort: true,
  },
});
