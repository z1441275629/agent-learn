import { ElMessage } from 'element-plus'

/** 全局轻提示：ElMessage 门面——调用方（useChat 等）的 toast('...') 签名不变 */
export function toast(msg: string): void {
  ElMessage({ message: msg, duration: 2600 })
}
