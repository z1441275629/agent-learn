<script setup lang="ts">
defineOptions({ name: 'ChatPane' })
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useChat } from '../../composables/useChat'
import { useSessionRoute } from '../../composables/useSessionRoute'
import { useKb } from '../../composables/useKb'
import { useMemories } from '../../composables/useMemories'
import { useSkills } from '../../composables/useSkills'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
import KbPanel from './KbPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import SkillPanel from './SkillPanel.vue'
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
} = useMemories()
const { docs: kbDocs, open: kbOpen, load: loadKb, toggle: toggleKb, upload: uploadKb, remove: removeKb } = useKb()
const { skills: skillList, open: skillsOpen, load: loadSkills, toggle: toggleSkills } = useSkills()
void init().then(() => {
  void loadMemories()
  void loadKb()
  void loadSkills()
})

// 回答结束后抽空刷一次记忆数：抽取在服务端 done 之后异步跑（1~3 秒），这里等 2.5s 再取
watch(streaming, (now, was) => {
  if (was && !now) setTimeout(() => void loadMemories(), 2500)
})

</script>

<template>
  <div class="chat-pane pane">
    <SessionSidebar
      :sessions="sessions"
      :session-id="sessionId"
      :streaming-sessions="streamingSessions"
      @open="openFromList"
      @new-chat="router.push('/chat')"
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
        :memory-count="memoryItems.length"
        :kb-count="kbDocs.length"
        :skill-count="skillList.length"
        :asr-model="asrModel"
        @toggle-memory="toggleMemory"
        @toggle-kb="toggleKb"
        @toggle-skills="toggleSkills"
      />
      <div class="chat-body">
        <!-- 面板锚在 chat-body（紧贴工具栏下缘）：top 不依赖工具栏高度，工具栏换行也不会被面板盖住 -->
        <MemoryPanel v-if="memoryOpen" :items="memoryItems" @close="memoryOpen = false" @remove="removeMemory" />
        <KbPanel v-if="kbOpen" :docs="kbDocs" @close="kbOpen = false" @upload="uploadKb" @remove="removeKb" />
        <SkillPanel v-if="skillsOpen" :skills="skillList" @close="skillsOpen = false" />
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
  position: relative; /* 记忆/知识库/技能面板的定位锚 */
}
</style>
