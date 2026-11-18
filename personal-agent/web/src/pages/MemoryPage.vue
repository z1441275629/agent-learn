<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { clearMemories, deleteMemory, listMemories } from '../api'
import type { MemoryItem } from '../types'
import { toast } from '../utils/toast'

defineOptions({ name: 'MemoryPage' })

const items = ref<MemoryItem[]>([])
const loading = ref(true)
const keyword = ref('')

const filtered = computed(() => {
  const k = keyword.value.trim()
  if (!k) return items.value
  return items.value.filter((m) => m.text.includes(k))
})

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await listMemories()
  } catch (e: any) {
    toast('记忆加载失败：' + (e?.message ?? e))
  } finally {
    loading.value = false
  }
}

async function remove(m: MemoryItem): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这条记忆？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteMemory(m.id)
    toast('已删除')
    await load()
  } catch (e: any) {
    toast('删除失败：' + (e?.message ?? e))
  }
}

async function clearAll(): Promise<void> {
  try {
    await ElMessageBox.confirm('清空全部 ' + items.value.length + ' 条记忆？不可恢复。', '危险操作', {
      type: 'error',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await clearMemories()
    toast('已清空')
    await load()
  } catch (e: any) {
    toast('清空失败：' + (e?.message ?? e))
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
      <h2>长期记忆</h2>
      <span class="desc">对话后自动抽取，对话时注入上下文。它记了什么，这里看得见、管得着。</span>
      <div class="actions">
        <el-input v-model="keyword" placeholder="搜索记忆内容…" clearable class="search" />
        <el-button type="danger" plain :disabled="!items.length" @click="clearAll">清空全部</el-button>
      </div>
    </header>
    <el-skeleton v-if="loading" :rows="6" animated class="skeleton" />
    <el-empty v-else-if="!items.length" description="还没有记忆——聊几轮天，或者直接让 agent 记点什么" />
    <template v-else>
      <el-table :data="filtered">
        <el-table-column prop="text" label="内容" min-width="420">
          <template #default="{ row }"><span class="mem-text">{{ row.text }}</span></template>
        </el-table-column>
        <el-table-column label="创建时间" width="150">
          <template #default="{ row }">{{ shortTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column width="90" align="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" text @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="!filtered.length" class="no-hit">没有匹配「{{ keyword }}」的记忆</p>
    </template>
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
.search {
  width: 220px;
}
.mem-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.no-hit {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 12px;
}
.skeleton {
  padding: 8px 0;
}
</style>
