<script setup lang="ts">
import type { ModelEntry } from '../../types'
import { speechRecognitionSupported } from '../../utils/voice'

defineProps<{
  models: ModelEntry[]
  memoryCount: number
  kbCount: number
  skillCount: number
  /** 大模型转写可用时的模型名（null = 没配端点，语音引擎切换整个隐藏） */
  asrModel: string | null
}>()
const emit = defineEmits<{ toggleMemory: []; toggleKb: []; toggleSkills: [] }>()

// Vue 3.4+ 的 defineModel：子组件里像普通 ref 一样用，父组件用 v-model:model-id 绑定
const modelId = defineModel<string>('modelId', { required: true })
const thinking = defineModel<string>('thinking', { required: true })
const elide = defineModel<boolean>('elide', { required: true })
const kbSearch = defineModel<boolean>('kbSearch', { required: true })
const tools = defineModel<boolean>('tools', { required: true })
const voiceEngine = defineModel<'browser' | 'asr'>('voiceEngine', { required: true })
</script>

<template>
  <div class="chat-toolbar">
    <button class="ghost" title="跨会话长期记忆（自动抽取，可查看/删除）" @click="emit('toggleMemory')">
      记忆 {{ memoryCount }}
    </button>
    <button class="ghost" title="个人笔记知识库（上传切块索引，对话时关键词检索注入）" @click="emit('toggleKb')">
      知识库 {{ kbCount }}
    </button>
    <button class="ghost" title="工作台技能（对话时 agent 调 use_skill 加载执行；这里看有哪些可用）" @click="emit('toggleSkills')">
      技能 {{ skillCount }}
    </button>

    <span class="divider"></span>

    <el-select v-model="modelId" class="picker" size="small" title="模型">
      <el-option
        v-for="m in models"
        :key="m.id"
        :value="m.id"
        :label="`${m.label} · ${m.model}${m.vision ? ' · 视觉' : ''}`"
      />
    </el-select>
    <el-select v-model="thinking" class="picker" size="small" title="思考强度（部分平台只区分开关）">
      <el-option value="off" label="思考：关" />
      <el-option value="low" label="思考：低" />
      <el-option value="medium" label="思考：中" />
      <el-option value="high" label="思考：高" />
    </el-select>
    <el-select
      v-if="asrModel"
      v-model="voiceEngine"
      class="picker"
      size="small"
      title="语音输入引擎：浏览器原生（免费、边说边出字，需 Chrome/Edge）vs 大模型转写（录音上传 /api/asr，说完约 1~2 秒出结果，按量计费）"
    >
      <el-option value="browser" label="语音：浏览器" :disabled="!speechRecognitionSupported()" />
      <el-option value="asr" label="语音：大模型" />
    </el-select>
    <el-tooltip content="聊天 API 无状态：历史图片每轮都会重新计费。开启后旧图替换成文字占位" placement="top">
      <label class="toggle">
        <el-switch v-model="elide" size="small" />
        <span>图片仅最近一轮</span>
      </label>
    </el-tooltip>
    <el-tooltip content="让模型调用工具（现在几点 / 检索知识库）。开启后知识库由模型自主检索，不再自动注入" placement="top">
      <label class="toggle">
        <el-switch v-model="tools" size="small" />
        <span>工具调用</span>
      </label>
    </el-tooltip>
    <el-tooltip content="提问时按关键词检索知识库，命中的笔记片段作为参考注入（本地 BM25，零 API 成本）。工具调用开启时此开关不生效" placement="top">
      <label class="toggle">
        <el-switch v-model="kbSearch" size="small" />
        <span>知识库检索</span>
      </label>
    </el-tooltip>
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
  width: 220px;
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

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
</style>
