<script setup lang="ts">
import { useChat } from '../../composables/useChat'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
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

void init()
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
      @open="openSession"
      @new-chat="newChat"
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
