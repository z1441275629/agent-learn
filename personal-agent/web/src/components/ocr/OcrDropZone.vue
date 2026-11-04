<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Bbox } from '../../types'

const props = defineProps<{
  imageUrl: string
  box: Bbox | null
  /** 当前标签页是否可见——两个面板同时挂载，粘贴事件要按可见性分流 */
  active: boolean
}>()

const emit = defineEmits<{ file: [dataUrl: string] }>()

const fileInput = ref<HTMLInputElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)
const dragging = ref(false)

function readFile(file: File): void {
  const reader = new FileReader()
  reader.onload = () => emit('file', String(reader.result))
  reader.readAsDataURL(file)
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) readFile(file)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (file) readFile(file)
}

function onPaste(e: ClipboardEvent): void {
  if (!props.active) return
  for (const item of e.clipboardData?.items ?? []) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    e.preventDefault()
    readFile(file)
    return
  }
}

onMounted(() => document.addEventListener('paste', onPaste))
onBeforeUnmount(() => document.removeEventListener('paste', onPaste))

// bbox 是原图像素坐标 → 换算成显示尺寸下的覆盖层位置
const highlightStyle = computed(() => {
  const b = props.box
  const img = imgEl.value
  if (!b || !img || !img.naturalWidth) return { display: 'none' }
  const sx = img.clientWidth / img.naturalWidth
  const sy = img.clientHeight / img.naturalHeight
  return {
    display: 'block',
    left: b.x0 * sx + 'px',
    top: b.y0 * sy + 'px',
    width: (b.x1 - b.x0) * sx + 'px',
    height: (b.y1 - b.y0) * sy + 'px',
  }
})
</script>

<template>
  <div
    class="drop"
    :class="{ hover: dragging, 'has-img': !!imageUrl }"
    tabindex="0"
    @click="fileInput?.click()"
    @keydown.enter.prevent="fileInput?.click()"
    @keydown.space.prevent="fileInput?.click()"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div v-if="!imageUrl" class="hint">粘贴 / 拖入 / 点击选择截图</div>
    <div v-else class="imgwrap">
      <img ref="imgEl" :src="imageUrl" alt="截图预览" />
      <div class="hl" :style="highlightStyle"></div>
    </div>
    <input ref="fileInput" type="file" accept="image/*" hidden @change="onPick" />
  </div>
</template>

<style scoped>
.drop {
  border: 2px dashed #cbd5e1;
  border-radius: 10px;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  transition: 0.15s;
  padding: 16px;
}

.drop.hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.drop.has-img {
  border-style: solid;
  border-color: transparent;
  padding: 0;
}

.imgwrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.imgwrap img {
  max-width: 100%;
  display: block;
  border-radius: 8px;
}

.hl {
  position: absolute;
  border: 2px solid var(--accent);
  background: rgb(37 99 235 / 14%);
  border-radius: 3px;
  pointer-events: none;
}
</style>
