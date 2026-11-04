<script setup lang="ts">
import type { Engine } from '../../composables/useOcr'

defineProps<{ canCopy: boolean; canClear: boolean }>()
const emit = defineEmits<{ copy: []; clear: [] }>()

const engine = defineModel<Engine>('engine', { required: true })
const translate = defineModel<boolean>('translate', { required: true })

const engines: { key: Engine; label: string; title: string }[] = [
  { key: 'local', label: '本地', title: '本地 tesseract：免费离线、带坐标、可悬停定位' },
  { key: 'ai', label: 'AI 识别', title: '视觉 LLM：版式理解强，但无坐标、按图计费' },
]
</script>

<template>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="识别引擎">
      <button
        v-for="item in engines"
        :key="item.key"
        class="seg-btn"
        :class="{ on: engine === item.key }"
        :title="item.title"
        @click="engine = item.key"
      >
        {{ item.label }}
      </button>
    </div>
    <label class="toggle">
      <input v-model="translate" type="checkbox" />
      翻译成中文
    </label>
    <button :disabled="!canCopy" @click="emit('copy')">复制全文</button>
    <button :disabled="!canClear" @click="emit('clear')">清空</button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.seg-btn {
  border: 0 !important;
  border-radius: 0 !important;
  padding: 6px 12px;
  background: #fff;
  color: var(--muted);
}

.seg-btn.on {
  background: var(--accent);
  color: #fff;
}
</style>
