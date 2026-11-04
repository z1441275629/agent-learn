// 长期记忆状态：数量常驻工具栏（回答完成后服务端异步抽取，打开面板时刷新到最新）
//
// 抽取在服务端 done 之后才跑（1~3 秒），所以发送完成时刷新可能拿不到最新一条——
// 打开面板再刷一次是可靠口径；数量只是提示，不是精确实时。

import { ref } from 'vue'
import { clearMemories, deleteMemory, listMemories } from '../api'
import type { MemoryItem } from '../types'
import { toast } from '../utils/toast'

export function useMemories() {
  const items = ref<MemoryItem[]>([])
  const open = ref(false)

  async function load(): Promise<void> {
    try {
      items.value = await listMemories()
    } catch (e: any) {
      toast('记忆加载失败：' + (e?.message ?? e))
    }
  }

  function toggle(): void {
    open.value = !open.value
    if (open.value) void load()
  }

  async function remove(id: string): Promise<void> {
    try {
      await deleteMemory(id)
      items.value = items.value.filter((m) => m.id !== id)
    } catch (e: any) {
      toast('删除失败：' + (e?.message ?? e))
    }
  }

  async function clearAll(): Promise<void> {
    try {
      await clearMemories()
      items.value = []
      toast('已清空长期记忆')
    } catch (e: any) {
      toast('清空失败：' + (e?.message ?? e))
    }
  }

  return { items, open, load, toggle, remove, clearAll }
}
