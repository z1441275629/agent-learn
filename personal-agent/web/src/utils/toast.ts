import { ref } from 'vue'

/** 全局轻提示：任何组件 toast('...')，由 App 里的 ToastHost 统一渲染 */
export const toastText = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

export function toast(msg: string): void {
  toastText.value = msg
  clearTimeout(timer)
  timer = setTimeout(() => {
    toastText.value = ''
  }, 1600)
}
