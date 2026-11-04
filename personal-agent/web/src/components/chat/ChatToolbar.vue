<script setup lang="ts">
import type { ModelEntry, SessionSummary } from '../../types'

defineProps<{
  models: ModelEntry[]
  sessions: SessionSummary[]
  sessionId: string | null
  memoryCount: number
  kbCount: number
}>()
const emit = defineEmits<{ open: [id: string]; newChat: []; toggleMemory: []; toggleKb: [] }>()

// Vue 3.4+ 的 defineModel：子组件里像普通 ref 一样用，父组件用 v-model:model-id 绑定
const modelId = defineModel<string>('modelId', { required: true })
const thinking = defineModel<string>('thinking', { required: true })
const elide = defineModel<boolean>('elide', { required: true })
const kbSearch = defineModel<boolean>('kbSearch', { required: true })

function openSession(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  if (id) emit('open', id)
}
</script>

<template>
  <div class="chat-toolbar">
    <select class="picker session-picker" :value="sessionId ?? ''" title="历史会话" @change="openSession">
      <option v-if="!sessionId" value="">新对话（未保存）</option>
      <option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
    </select>
    <button class="ghost" @click="emit('newChat')">新对话</button>
    <button class="ghost" title="跨会话长期记忆（自动抽取，可查看/删除）" @click="emit('toggleMemory')">
      记忆 {{ memoryCount }}
    </button>
    <button class="ghost" title="个人笔记知识库（上传切块索引，对话时关键词检索注入）" @click="emit('toggleKb')">
      知识库 {{ kbCount }}
    </button>

    <span class="divider"></span>

    <select v-model="modelId" class="picker" title="模型">
      <option v-for="m in models" :key="m.id" :value="m.id">
        {{ m.label }} · {{ m.model }}{{ m.vision ? ' · 视觉' : '' }}
      </option>
    </select>
    <select v-model="thinking" class="picker" title="思考强度（部分平台只区分开关）">
      <option value="off">思考：关</option>
      <option value="low">思考：低</option>
      <option value="medium">思考：中</option>
      <option value="high">思考：高</option>
    </select>
    <label class="toggle" title="聊天 API 无状态：历史图片每轮都会重新计费。开启后旧图替换成文字占位">
      <input v-model="elide" type="checkbox" />
      图片仅最近一轮
    </label>
    <label class="toggle" title="提问时按关键词检索知识库，命中的笔记片段作为参考注入（本地 BM25，零 API 成本）">
      <input v-model="kbSearch" type="checkbox" />
      知识库检索
    </label>
  </div>
</template>

<style scoped>
.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 18px;
  border-bottom: 1px solid var(--line);
  background: #fff;
}

.session-picker {
  max-width: 220px;
}

.picker {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  max-width: 260px;
}

.divider {
  width: 1px;
  height: 22px;
  background: var(--line);
  margin: 0 2px;
}

.ghost {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 8px;
  padding: 5px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
