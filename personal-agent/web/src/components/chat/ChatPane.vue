<script setup lang="ts">
defineOptions({ name: 'ChatPane' })
import { useRouter } from 'vue-router'
import { useChat } from '../../composables/useChat'
import { useSessionRoute } from '../../composables/useSessionRoute'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
import MessageList from './MessageList.vue'
import SessionSidebar from './SessionSidebar.vue'

defineProps<{ active: boolean }>()

const router = useRouter()
// 路由 ↔ 会话绑定：路由参数是唯一事实源，侧栏点击/新对话都改成导航，由 watcher 翻译成打开动作
useSessionRoute()

function openFromList(id: string): void {
  void router.push('/chat/' + id)
}

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
  streamingSessions,
  total,
  hasMore,
  messages,
  pending,
  streaming,
  init,
  addImages,
  addDocs,
  removePending,
  send,
  stop,
  loadMoreSessions,
  deleteSession,
} = useChat()

void init()
</script>

<template>
  <div class="chat-pane pane">
    <SessionSidebar
      :sessions="sessions"
      :session-id="sessionId"
      :streaming-sessions="streamingSessions"
      :has-more="hasMore"
      :total="total"
      @open="openFromList"
      @new-chat="router.push('/chat')"
      @delete="deleteSession"
      @load-more="loadMoreSessions"
    />
    <div class="chat-main">
      <ChatToolbar
        v-model:model-id="modelId"
        v-model:thinking="thinking"
        v-model:elide="elideImages"
        v-model:kb-search="kbSearch"
        v-model:tools="toolsOn"
        v-model:voice-engine="voiceEngine"
        :models="models"
        :asr-model="asrModel"
      />
      <div class="chat-body">
        <MessageList :messages="messages" />
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
  </div>
</template>

<style scoped>
.chat-pane {
  display: flex;
  align-items: stretch;
}

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
