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
  messages,
  pending,
  streaming,
  loadModels,
  addImages,
  addDocs,
  removePending,
  send,
  clearChat,
} = useChat()

loadModels()
</script>

<template>
  <div class="chat-pane pane">
    <ChatToolbar
      v-model:model-id="modelId"
      v-model:thinking="thinking"
      v-model:elide="elideImages"
      :models="models"
      @clear="clearChat"
    />
    <MessageList :messages="messages" />
    <ChatComposer
      :pending="pending"
      :streaming="streaming"
      :active="active"
      @send="send"
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
