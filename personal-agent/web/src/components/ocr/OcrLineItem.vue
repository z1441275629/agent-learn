<script setup lang="ts">
import { computed } from 'vue'
import type { Bbox, OcrLine } from '../../types'

const props = defineProps<{ line: OcrLine; zh?: string }>()
const emit = defineEmits<{
  copy: [text: string, label: string]
  hover: [bbox: Bbox | null]
}>()

// 本地引擎才会给置信度；低于 60% 左边标黄提醒复核
const lowConfidence = computed(() => typeof props.line.confidence === 'number' && props.line.confidence < 60)
</script>

<template>
  <div
    class="line"
    :class="{ low: lowConfidence }"
    @click="emit('copy', line.text, '这一行')"
    @mouseenter="line.bbox && emit('hover', line.bbox)"
    @mouseleave="emit('hover', null)"
  >
    <span v-if="typeof line.confidence === 'number'" class="conf"> {{ Math.round(line.confidence) }}% </span>
    <div class="orig">{{ line.text }}</div>
    <div v-if="zh" class="zh" title="点击复制译文" @click.stop="emit('copy', zh, '译文')">
      {{ zh }}
    </div>
  </div>
</template>

<style scoped>
.line {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 10px;
  cursor: copy;
  transition: 0.12s;
}

.line:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.line.low {
  border-left: 3px solid var(--warn);
}

.conf {
  float: right;
  font-size: 11px;
  color: #9ca3af;
  margin-left: 8px;
}

.line.low .conf {
  color: var(--warn);
}

.orig {
  white-space: pre-wrap;
  word-break: break-word;
}

.zh {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
  color: var(--ok);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
