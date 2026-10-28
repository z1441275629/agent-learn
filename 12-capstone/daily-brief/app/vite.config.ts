// uniapp vite 配置（H5 优先；Android 包以后按需）
// 两个关键决策：
//   ① dev proxy '/api' → 8787：页面里全部用相对路径 fetch('/api/...')——dev 时 vite 转发到 server，
//      prod（server 托管构建产物）同源直连——代码零环境分支，CORS 都不用想
//   ② default import 手工剥一层：@dcloudio/vite-plugin-uni 是 CJS 且 module.exports={default:fn,...}
//      形状，esbuild 打包 vite.config 时 default import 拿到整个对象（「uni is not a function」实录）。
//      产物路径是插件强制的约定 dist/build/h5（build.outDir 拗不过它），server.ts 按约定路径适配
import { defineConfig } from 'vite'
import uniRaw from '@dcloudio/vite-plugin-uni'

const uni = (uniRaw as any).default ?? uniRaw

export default defineConfig({
	plugins: [uni()],
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
		},
	},
})
