// 知识库状态：上传（文本读入后 POST）、列表、删除
//
// 文档只在服务端切块索引；这里不碰检索——检索是每轮对话在服务端自动做的。

import { ref } from 'vue'
import { addKb, deleteKb, listKb } from '../api'
import type { KbDoc } from '../types'
import { toast } from '../utils/toast'

const MAX_KB_BYTES = 1024 * 1024

export function useKb() {
  const docs = ref<KbDoc[]>([])
  const open = ref(false)

  async function load(): Promise<void> {
    try {
      docs.value = await listKb()
    } catch (e: any) {
      toast('知识库加载失败：' + (e?.message ?? e))
    }
  }

  function toggle(): void {
    open.value = !open.value
    if (open.value) void load()
  }

  async function upload(files: File[]): Promise<void> {
    for (const file of files) {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        toast('PDF 暂不支持，先转成文本或图片')
        continue
      }
      if (file.size > MAX_KB_BYTES) {
        toast(`「${file.name}」超过 1MB，先拆分`)
        continue
      }
      try {
        const text = await file.text()
        const doc = await addKb(file.name, text)
        docs.value = [...docs.value, doc]
        toast(`已入库《${doc.name}》（${doc.chunkCount} 块）`)
      } catch (e: any) {
        toast('入库失败：' + (e?.message ?? e))
      }
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await deleteKb(id)
      docs.value = docs.value.filter((d) => d.id !== id)
    } catch (e: any) {
      toast('删除失败：' + (e?.message ?? e))
    }
  }

  return { docs, open, load, toggle, upload, remove }
}
