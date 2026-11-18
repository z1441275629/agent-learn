<script setup lang="ts">
defineOptions({ name: 'OcrPane' })
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
    <header class="pane-head">
      <h2>截图取字</h2>
      <span class="desc">粘贴 / 拖入截图 → 本地或 AI 识别 → 逐行点击复制；本地引擎可悬停定位回原图，可顺手中译</span>
    </header>
    <div class="ocr-grid">
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
  </div>
</template>

<style scoped>
/* 与三个管理页同一骨架：页头（标题+说明）+ 内容区 */
.ocr-pane {
  display: flex;
  flex-direction: column;
  padding: 20px 28px 24px;
  height: 100%;
  overflow-y: auto;
}

.pane-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.pane-head h2 {
  margin: 0;
  font-size: 17px;
}

.desc {
  font-size: 13px;
  color: var(--muted);
}

.ocr-grid {
  display: grid;
  grid-template-columns: minmax(280px, 420px) 1fr;
  gap: 16px;
  align-items: start;
}

@media (max-width: 860px) {
  .ocr-grid {
    grid-template-columns: 1fr;
  }
}
</style>
