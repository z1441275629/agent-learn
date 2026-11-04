<script setup lang="ts">
type Pane = 'chat' | 'ocr'
defineProps<{ active: Pane }>()
const emit = defineEmits<{ change: [pane: Pane] }>()

const tabs: { key: Pane; label: string }[] = [
  { key: 'chat', label: '对话' },
  { key: 'ocr', label: '截图取字' },
]
</script>

<template>
  <header class="header">
    <div class="brand">个人 Agent 工作台</div>
    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ on: active === tab.key }"
        @click="emit('change', tab.key)"
      >
        {{ tab.label }}
      </button>
    </nav>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 18px;
  background: #fff;
  border-bottom: 1px solid var(--line);
}

.brand {
  font-weight: 700;
  font-size: 15px;
}

.tabs {
  display: flex;
  gap: 4px;
}

.tab {
  border: 0;
  background: transparent;
  padding: 6px 12px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
}

.tab.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
</style>
