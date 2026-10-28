// uniapp vite 配置（H5 优先；Android 包以后按需）——v1 同款两个关键决策：
//   ① dev proxy '/api' → 8788（v2 server）：页面里全部相对路径 fetch('/api/...')，dev 时 vite 转发，
//      prod（v2 server 托管构建产物）同源直连——零环境分支；登录态靠 cookie，同源下自动携带
//   ② default import 手工剥一层：@dcloudio/vite-plugin-uni 是 CJS 且 module.exports={default:fn,...}
//      形状（v1「uni is not a function」实录）。产物路径是插件约定 dist/build/h5（拗不过），server 按约定取
import { defineConfig } from 'vite'
import uniRaw from '@dcloudio/vite-plugin-uni'

const uni = (uniRaw as any).default ?? uniRaw

export default defineConfig({
	plugins: [uni()],
	server: {
		proxy: {
			'/api': 'http://localhost:8788',
		},
	},
})
