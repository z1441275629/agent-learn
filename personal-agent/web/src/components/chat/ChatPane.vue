<script setup lang="ts">
import { watch } from 'vue'
import { useChat } from '../../composables/useChat'
import { useKb } from '../../composables/useKb'
import { useMemories } from '../../composables/useMemories'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
import KbPanel from './KbPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import MessageList from './MessageList.vue'
import SessionSidebar from './SessionSidebar.vue'

defineProps<{ active: boolean }>()

const {
  models,
  modelId,
  thinking,
  elideImages,
  kbSearch,
  toolsOn,
  voiceEngine,
  asrModel,
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
  answerConfirm,
} = useChat()

const {
  items: memoryItems,
  open: memoryOpen,
  load: loadMemories,
  toggle: toggleMemory,
  remove: removeMemory,
} = useMemories()
const { docs: kbDocs, open: kbOpen, load: loadKb, toggle: toggleKb, upload: uploadKb, remove: removeKb } = useKb()
void init().then(() => {
  void loadMemories()
  void loadKb()
})

// 回答结束后抽空刷一次记忆数：抽取在服务端 done 之后异步跑（1~3 秒），这里等 2.5s 再取
watch(streaming, (now, was) => {
  if (was && !now) setTimeout(() => void loadMemories(), 2500)
})
</script>

<template>
  <div class="chat-pane pane">
    <SessionSidebar :sessions="sessions" :session-id="sessionId" @open="openSession" @new-chat="newChat" />
    <div class="chat-main">
      <ChatToolbar
        v-model:model-id="modelId"
        v-model:thinking="thinking"
        v-model:elide="elideImages"
        v-model:kb-search="kbSearch"
        v-model:tools="toolsOn"
        v-model:voice-engine="voiceEngine"
        :models="models"
        :memory-count="memoryItems.length"
        :kb-count="kbDocs.length"
        :asr-model="asrModel"
        @toggle-memory="toggleMemory"
        @toggle-kb="toggleKb"
      />
      <MemoryPanel v-if="memoryOpen" :items="memoryItems" @close="memoryOpen = false" @remove="removeMemory" />
      <KbPanel v-if="kbOpen" :docs="kbDocs" @close="kbOpen = false" @upload="uploadKb" @remove="removeKb" />
      <MessageList :messages="messages" :on-confirm="answerConfirm" />
      <ChatComposer
        :pending="pending"
        :streaming="streaming"
        :active="active"
        :voice-engine="voiceEngine"
        :asr-model="asrModel"
        @send="send"
        @stop="stop"
        @add-images="addImages"
        @add-docs="addDocs"
        @remove="removePending"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-pane {
  display: flex;
  align-items: stretch;
  position: relative; /* 记忆/知识库面板的定位锚 */
}

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
