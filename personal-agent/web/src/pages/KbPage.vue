<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { addKb, deleteKb, listKb } from '../api'
import type { KbDoc } from '../types'
import { toast } from '../utils/toast'

defineOptions({ name: 'KbPage' })

const MAX_DOC_BYTES = 100 * 1024

const docs = ref<KbDoc[]>([])
const loading = ref(true)
const fileInput = ref<HTMLInputElement | null>(null)

async function load(): Promise<void> {
  loading.value = true
  try {
    docs.value = await listKb()
  } catch (e: any) {
    toast('知识库加载失败：' + (e?.message ?? e))
  } finally {
    loading.value = false
  }
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  void upload([...(input.files ?? [])])
  input.value = ''
}

/** 文本笔记进库：读文本走 addKb（切块+BM25 索引在服务端）。PDF 不支持，>100KB 先拆 */
async function upload(files: File[]): Promise<void> {
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      toast('PDF 暂不支持，先转成文本')
      continue
    }
    if (file.size > MAX_DOC_BYTES) {
      toast('「' + file.name + '」超过 100KB，先拆分')
      continue
    }
    try {
      const text = await file.text()
      await addKb(file.name, text)
      toast('「' + file.name + '」已入库')
    } catch (e: any) {
      toast('「' + file.name + '」入库失败：' + (e?.message ?? e))
    }
  }
  await load()
}

async function remove(doc: KbDoc): Promise<void> {
  try {
    await ElMessageBox.confirm('删除「' + doc.name + '」？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteKb(doc.id)
    toast('已删除')
    await load()
  } catch (e: any) {
    toast('删除失败：' + (e?.message ?? e))
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

onMounted(load)
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h2>知识库</h2>
      <span class="desc">个人笔记切块索引，对话时 BM25 检索注入。正文带自然问法词，检索命中更稳。</span>
      <div class="actions">
        <input ref="fileInput" type="file" multiple accept=".txt,.md,.markdown,text/plain" hidden @change="onPick" />
        <el-button type="primary" plain @click="fileInput?.click()">上传笔记</el-button>
      </div>
    </header>
    <el-skeleton v-if="loading" :rows="5" animated class="skeleton" />
    <el-empty v-else-if="!docs.length" description="还没有笔记——传几个 txt/md 进来，对话时就能被检索到" />
    <el-table v-else :data="docs">
      <el-table-column prop="name" label="名称" min-width="260" />
      <el-table-column prop="chunkCount" label="分块数" width="110" />
      <el-table-column label="创建时间" width="150">
        <template #default="{ row }">{{ shortTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column width="90" align="right">
        <template #default="{ row }">
          <el-button size="small" type="danger" text @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.page {
  padding: 20px 28px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.page-head h2 {
  margin: 0;
  font-size: 17px;
}
.desc {
  font-size: 13px;
  color: var(--muted);
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
}
.skeleton {
  padding: 8px 0;
}
</style>
