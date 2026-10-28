// .vue 单文件组件的类型声明（模板自带缺口：main.ts import './App.vue' 在裸 tsc 下 TS2307）
declare module '*.vue' {
	import type { DefineComponent } from 'vue'
	const component: DefineComponent<{}, {}, any>
	export default component
}
