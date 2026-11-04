<script setup lang="ts">
import { computed } from 'vue'
import type { ChatUsage } from '../../types'
import { formatUsage } from '../../utils/usage'

const props = defineProps<{
  usage?: ChatUsage
  model?: string
  elapsedMs?: number
  interrupted?: boolean
}>()

const line = computed(() =>
  [
    props.model,
    formatUsage(props.usage),
    props.elapsedMs != null ? `${(props.elapsedMs / 1000).toFixed(1)}s` : '',
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
