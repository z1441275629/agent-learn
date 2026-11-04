// 工作台前端（Vue 3 + Vite）
//
// 开发：npm run pa:web → http://127.0.0.1:5173（/api 代理到 8798 的 Node 服务）
// 构建：npm run pa:build → 产物直接落到 ../public（Node 服务静态托管，无需第二个进程）
//
// 产物文件名固定（不加 hash）：个人工具没有 CDN/强缓存需求，固定名让 git diff 干净、也方便对照学习。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8798' },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? ''
          return name.endsWith('.css') ? 'assets/app.css' : 'assets/[name][extname]'
        },
      },
    },
  },
})
