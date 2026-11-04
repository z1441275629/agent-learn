<script setup lang="ts">
import { computed } from 'vue'
import type { PendingAttachment } from '../../types'

const props = defineProps<{ attachment: PendingAttachment }>()
const emit = defineEmits<{ remove: [] }>()

const label = computed(() => {
  const a = props.attachment
  return a.kind === 'image' ? a.name : `${a.name} · ${Math.ceil(a.text.length / 1000)}k 字`
})
</script>

<template>
  <span class="chip">
    <img v-if="attachment.kind === 'image'" :src="attachment.dataUrl" alt="" />
    <span class="name">{{ label }}</span>
    <button title="移除" @click="emit('remove')">✕</button>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  background: #fafbfc;
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--muted);
}

.chip img {
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 5px;
}

.chip button {
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--danger);
  font-size: 14px;
  padding: 0 2px;
}
</style>
