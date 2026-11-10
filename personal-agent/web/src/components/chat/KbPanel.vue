<script setup lang="ts">
import type { KbDoc } from '../../types'

defineProps<{ docs: KbDoc[] }>()
const emit = defineEmits<{ close: []; upload: [files: File[]]; remove: [id: string] }>()

// 选完立刻清空 input 的值：同名文件重复选择也要能触发 change
function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('upload', [...(input.files ?? [])])
  input.value = ''
}
</script>

<template>
  <div class="kb-backdrop" @click="emit('close')"></div>
  <div class="kb-panel">
    <div class="panel-head">
      <strong>知识库（{{ docs.length }}）</strong>
      <button class="ghost" @click="emit('close')">关闭</button>
    </div>
    <p class="hint">
      上传个人笔记（.txt / .md，≤1MB）自动切块索引；对话提问时按关键词检索，命中的片段会作为参考注入回答。
      只在本机检索，不上传到任何第三方。
    </p>
    <label class="upload">
      <input type="file" accept=".txt,.md,.markdown,.log,.json" multiple @change="onPick" />
      选择文件入库
    </label>
    <ul v-if="docs.length" class="kb-list">
      <li v-for="d in docs" :key="d.id">
        <div class="meta">
          <span class="name">{{ d.name }}</span>
          <span class="sub">{{ d.chunkCount }} 块 · {{ d.createdAt.slice(0, 10) }}</span>
        </div>
        <button class="ghost del" title="删除这个文档" @click="emit('remove', d.id)">✕</button>
      </li>
    </ul>
    <p v-else class="empty">还没有文档——把常用笔记传进来，之后问它就行。</p>
  </div>
</template>

<style scoped>
.kb-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.kb-panel {
  position: absolute;
  top: 8px;
  left: 18px;
  z-index: 31;
  width: min(440px, calc(100% - 36px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 12%);
  padding: 12px 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.hint {
  margin: 6px 0 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.upload {
  display: inline-block;
  margin-bottom: 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}

.upload input {
  display: none;
}

.kb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kb-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
}

.kb-list .meta {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.kb-list .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-list .sub {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.ghost {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 8px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.del {
  padding: 0 6px;
}

.empty {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  padding: 18px 0;
}
</style>
