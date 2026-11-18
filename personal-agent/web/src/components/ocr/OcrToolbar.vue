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
  <div class="toolbar-row">
    <el-radio-group v-model="engine" size="small">
      <el-radio-button v-for="item in engines" :key="item.key" :value="item.key" :title="item.title">
        {{ item.label }}
      </el-radio-button>
    </el-radio-group>
    <el-switch v-model="translate" size="small" />
    <span class="sw-label" @click="translate = !translate">翻译成中文</span>
    <span class="spacer" />
    <el-button size="small" :disabled="!canCopy" @click="emit('copy')">复制全文</el-button>
    <el-button size="small" :disabled="!canClear" @click="emit('clear')">清空</el-button>
  </div>
</template>

<style scoped>
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.sw-label {
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  margin-left: -4px;
}

.spacer {
  flex: 1;
}
</style>
