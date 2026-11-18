<script setup lang="ts">
import { Setting } from '@element-plus/icons-vue'
import type { ModelEntry } from '../../types'
import { speechRecognitionSupported } from '../../utils/voice'

defineProps<{
  models: ModelEntry[]
  /** 大模型转写可用时的模型名（null = 没配端点，语音引擎切换整个隐藏） */
  asrModel: string | null
}>()

// Vue 3.4+ 的 defineModel：子组件里像普通 ref 一样用，父组件用 v-model:xxx 绑定
const modelId = defineModel<string>('modelId', { required: true })
const thinking = defineModel<string>('thinking', { required: true })
const elide = defineModel<boolean>('elide', { required: true })
const kbSearch = defineModel<boolean>('kbSearch', { required: true })
const tools = defineModel<boolean>('tools', { required: true })
const voiceEngine = defineModel<'browser' | 'asr'>('voiceEngine', { required: true })
</script>

<template>
  <div class="chat-toolbar">
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
    <el-popover placement="bottom-end" :width="320" trigger="click">
      <template #reference>
        <el-button class="cfg-btn" size="small" circle title="识别与检索设置">
          <el-icon :size="15"><Setting /></el-icon>
        </el-button>
      </template>
      <div class="cfg">
        <div class="cfg-row">
          <div class="cfg-text">
            <div class="cfg-label">图片仅最近一轮</div>
            <div class="cfg-desc">旧图替换成文字占位——聊天 API 无状态，历史图片每轮都重新计费</div>
          </div>
          <el-switch v-model="elide" size="small" />
        </div>
        <div class="cfg-row">
          <div class="cfg-text">
            <div class="cfg-label">工具调用</div>
            <div class="cfg-desc">模型可调工具（时间/知识库/文件等）；开启后知识库由模型自主检索，不再自动注入</div>
          </div>
          <el-switch v-model="tools" size="small" />
        </div>
        <div class="cfg-row">
          <div class="cfg-text">
            <div class="cfg-label">知识库检索</div>
            <div class="cfg-desc">提问时按关键词检索知识库，命中的片段自动注入（本地 BM25，零成本）；工具调用开启时不生效</div>
          </div>
          <el-switch v-model="kbSearch" size="small" />
        </div>
      </div>
    </el-popover>
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

.cfg-btn {
  margin-left: auto;
  color: var(--muted);
}

.cfg {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.cfg-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.cfg-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
}

.cfg-desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.5;
}
</style>
