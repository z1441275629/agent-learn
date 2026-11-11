<script setup lang="ts">
import { computed } from 'vue'
import type { ChatUsage } from '../../types'
import { formatUsage } from '../../utils/usage'

const props = defineProps<{
  usage?: ChatUsage
  model?: string
  elapsedMs?: number
  ttftMs?: number
  interrupted?: boolean
}>()

// 「首字 0.4s · 总 3.2s」：两个秒数并排时分清谁是谁；只有总时长时保持原样不加前缀
const line = computed(() =>
  [
    props.model,
    formatUsage(props.usage),
    props.ttftMs != null ? `首字 ${(props.ttftMs / 1000).toFixed(1)}s` : '',
    props.elapsedMs != null
      ? `${props.ttftMs != null ? '总 ' : ''}${(props.elapsedMs / 1000).toFixed(1)}s`
      : '',
    props.interrupted ? '已停止' : '',
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>

<template>
  <div v-if="line" class="usage-meta">{{ line }}</div>
</template>

<style scoped>
.usage-meta {
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
  border-top: 1px dashed var(--line);
  padding-top: 6px;
}
</style>
