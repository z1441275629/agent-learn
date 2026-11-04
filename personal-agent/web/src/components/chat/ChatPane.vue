<script setup lang="ts">
import { watch } from 'vue'
import { useChat } from '../../composables/useChat'
import { useMemories } from '../../composables/useMemories'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
import MemoryPanel from './MemoryPanel.vue'
import MessageList from './MessageList.vue'

defineProps<{ active: boolean }>()

const {
  models,
  modelId,
  thinking,
  elideImages,
  sessions,
  sessionId,
  messages,
  pending,
  streaming,
  init,
  openSession,
  newChat,
  addImages,
  addDocs,
  removePending,
  send,
  stop,
} = useChat()

const {
  items: memoryItems,
  open: memoryOpen,
  load: loadMemories,
  toggle: toggleMemory,
  remove: removeMemory,
  clearAll: clearMemories,
} = useMemories()
void init().then(() => loadMemories())

// 回答结束后抽空刷一次记忆数：抽取在服务端 done 之后异步跑（1~3 秒），这里等 2.5s 再取
watch(streaming, (now, was) => {
  if (was && !now) setTimeout(() => void loadMemories(), 2500)
})
</script>

<template>
  <div class="chat-pane pane">
    <ChatToolbar
      v-model:model-id="modelId"
      v-model:thinking="thinking"
      v-model:elide="elideImages"
      :models="models"
      :sessions="sessions"
      :session-id="sessionId"
      :memory-count="memoryItems.length"
      @open="openSession"
      @new-chat="newChat"
      @toggle-memory="toggleMemory"
    />
    <MemoryPanel
      v-if="memoryOpen"
      :items="memoryItems"
      @close="memoryOpen = false"
      @remove="removeMemory"
      @clear="clearMemories"
    />
    <MessageList :messages="messages" />
    <ChatComposer
      :pending="pending"
      :streaming="streaming"
      :active="active"
      @send="send"
      @stop="stop"
      @add-images="addImages"
      @add-docs="addDocs"
      @remove="removePending"
    />
  </div>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
}
</style>
