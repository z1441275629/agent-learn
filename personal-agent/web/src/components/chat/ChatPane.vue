<script setup lang="ts">
import { computed, watch } from 'vue'
import { useChat } from '../../composables/useChat'
import { useKb } from '../../composables/useKb'
import { useMemories } from '../../composables/useMemories'
import { useSkills } from '../../composables/useSkills'
import ChatComposer from './ChatComposer.vue'
import ChatToolbar from './ChatToolbar.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import KbPanel from './KbPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import SkillPanel from './SkillPanel.vue'
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

// 待决策的确认卡：只在流式进行中的消息里找——交互由弹窗接管，内联卡只留审计记录。
// 不扫历史消息：服务端中途崩溃可能留下无 outcome 的陈旧卡，复活弹窗会点不动也关不掉（流已断，没有 outcome 帧来收场）
// 注意 script 里 Ref 必须取 .value（tsc 不查 .vue，写成 messages.length 会静默 undefined，弹窗永远不弹）
const pendingConfirm = computed(() => {
  const list = messages.value
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].streaming) continue
    const card = list[i].confirms?.find((c) => !c.outcome)
    if (card) return card
  }
  return null
})

function answerPending(approve: boolean, always: boolean): void {
  if (pendingConfirm.value) void answerConfirm(pendingConfirm.value, approve, always)
}
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
    <!-- 写入确认弹窗：decision 后 outcome 落定，v-if 自动收起。放根节点内（App.vue 对本组件用 v-show，须单根） -->
    <ConfirmDialog v-if="pendingConfirm" :card="pendingConfirm" @answer="answerPending" />
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
