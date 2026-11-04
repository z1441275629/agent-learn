<script setup lang="ts">
import type { MemoryItem } from '../../types'

defineProps<{ items: MemoryItem[] }>()
const emit = defineEmits<{ close: []; remove: [id: string] }>()
</script>

<template>
  <!-- 透明遮罩：点面板外关闭；面板本体在遮罩之上 -->
  <div class="memory-backdrop" @click="emit('close')"></div>
  <div class="memory-panel">
    <div class="panel-head">
      <strong>长期记忆（{{ items.length }}）</strong>
      <div class="actions">
        <!-- 清空入口禁用：积累不易，误触一次全没了；真要清空删 data/memories.json -->
        <button class="ghost danger" disabled title="已禁用防误清空——真要清空，删除 data/memories.json 后重启">
          清空
        </button>
        <button class="ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
    <p class="hint">对话中关于你的持久事实/偏好会被自动抽取到这里，跨会话生效；记错了就删。</p>
    <ul v-if="items.length" class="memory-list">
      <li v-for="m in items" :key="m.id">
        <span class="text">{{ m.text }}</span>
        <button class="ghost del" title="删除这条" @click="emit('remove', m.id)">✕</button>
      </li>
    </ul>
    <p v-else class="empty">还没有记忆——聊聊你自己（偏好、事实、计划），它会自动记。</p>
  </div>
</template>

<style scoped>
.memory-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.memory-panel {
  position: absolute;
  top: 46px;
  right: 18px;
  z-index: 31;
  width: min(420px, calc(100vw - 36px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 12%);
  padding: 12px 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.actions {
  display: flex;
  gap: 6px;
}

.hint {
  margin: 6px 0 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.memory-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.memory-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.memory-list .text {
  flex: 1;
  word-break: break-all;
}

.ghost {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 8px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.ghost.danger {
  color: #c0392b;
}

.ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.del {
  padding: 0 6px;
}

.empty {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  padding: 18px 0;
}
</style>
