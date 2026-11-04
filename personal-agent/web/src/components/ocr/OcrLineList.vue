<script setup lang="ts">
import type { Bbox, OcrLine } from '../../types'
import OcrLineItem from './OcrLineItem.vue'

defineProps<{
  lines: OcrLine[]
  translations: Map<number, string>
  busy: boolean
  /** 已经识别过（包括 0 行）——用来区分「还没开始」和「真没识别到」 */
  hasResult: boolean
}>()

const emit = defineEmits<{
  copy: [text: string, label: string]
  hover: [bbox: Bbox | null]
}>()
</script>

<template>
  <div v-if="busy" class="empty"><span class="spin"></span>识别中…</div>
  <div v-else-if="lines.length === 0" class="empty">
    {{ hasResult ? '没识别到文字——试试更清晰/更大字号的截图' : '识别结果会出现在这里' }}
  </div>
  <div v-else class="lines">
    <OcrLineItem
      v-for="line in lines"
      :key="line.id"
      :line="line"
      :zh="translations.get(line.id)"
      @copy="(text, label) => emit('copy', text, label)"
      @hover="(bbox) => emit('hover', bbox)"
    />
  </div>
</template>

<style scoped>
.lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty {
  color: var(--muted);
  padding: 24px 8px;
  text-align: center;
}
</style>
