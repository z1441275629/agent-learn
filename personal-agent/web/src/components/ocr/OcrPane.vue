<script setup lang="ts">
import { useOcr } from '../../composables/useOcr'
import { copyText } from '../../utils/clipboard'
import { toast } from '../../utils/toast'
import OcrDropZone from './OcrDropZone.vue'
import OcrLineList from './OcrLineList.vue'
import OcrToolbar from './OcrToolbar.vue'

defineProps<{ active: boolean }>()

const {
  engine,
  translate,
  imageUrl,
  result,
  busy,
  error,
  activeBbox,
  lines,
  translationMap,
  metaText,
  recognize,
  clear,
  hover,
} = useOcr()

async function copyLine(text: string, label: string): Promise<void> {
  toast((await copyText(text)) ? `已复制${label}` : '复制失败')
}

async function copyAll(): Promise<void> {
  const text = lines.value.map((l) => l.text).join('\n')
  toast((await copyText(text)) ? `已复制全文（${lines.value.length} 行）` : '复制失败')
}
</script>

<template>
  <div class="ocr-pane pane">
    <section class="card">
      <OcrDropZone :image-url="imageUrl" :box="activeBbox" :active="active" @file="recognize" />
      <OcrToolbar
        v-model:engine="engine"
        v-model:translate="translate"
        :can-copy="lines.length > 0"
        :can-clear="!!imageUrl"
        @copy="copyAll"
        @clear="clear"
      />
      <div class="meta">{{ metaText }}</div>
      <div v-if="error" class="err">{{ error }}</div>
    </section>
    <section class="card">
      <OcrLineList
        :lines="lines"
        :translations="translationMap"
        :busy="busy"
        :has-result="!!result"
        @copy="copyLine"
        @hover="hover"
      />
    </section>
  </div>
</template>

<style scoped>
.ocr-pane {
  display: grid;
  grid-template-columns: minmax(280px, 420px) 1fr;
  gap: 16px;
  padding: 14px 22px 24px;
  align-items: start;
  overflow-y: auto;
}

@media (max-width: 860px) {
  .ocr-pane {
    grid-template-columns: 1fr;
  }
}
</style>
