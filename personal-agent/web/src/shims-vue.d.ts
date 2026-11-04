// 让 tsc 认识 .vue 导入（类型检查只覆盖 .ts；SFC 的类型由 Vite/编辑器接管）
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
