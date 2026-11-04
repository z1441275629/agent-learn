<script setup lang="ts">
import type { ModelEntry } from '../../types'

defineProps<{ models: ModelEntry[] }>()
const emit = defineEmits<{ clear: [] }>()

// Vue 3.4+ 的 defineModel：子组件里像普通 ref 一样用，父组件用 v-model:model-id 绑定
const modelId = defineModel<string>('modelId', { required: true })
const thinking = defineModel<string>('thinking', { required: true })
const elide = defineModel<boolean>('elide', { required: true })
</script>

<template>
  <div class="chat-toolbar">
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
    <div class="grow"></div>
    <button class="ghost" @click="emit('clear')">清空对话</button>
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

.ghost {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 8px;
  padding: 5px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
</style>
