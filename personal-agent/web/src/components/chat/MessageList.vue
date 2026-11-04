<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ConfirmCard, DisplayMessage } from '../../types'
import MessageItem from './MessageItem.vue'

const props = defineProps<{
  messages: DisplayMessage[]
  /** 确认卡上的允许/拒绝（穿自 useChat.answerConfirm） */
  onConfirm?: (card: ConfirmCard, approve: boolean) => void
}>()
const scroller = ref<HTMLElement | null>(null)

// 消息内容、流式增量、错误状态任一变化都滚到底
watch(
  () => props.messages,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true },
)
</script>

<template>
  <section ref="scroller" class="msgs">
    <div v-if="messages.length === 0" class="welcome">
      <b>个人 Agent 工作台</b><br />
      可以直接聊天；也可以贴图/上传附件后提问（图片需选「视觉」模型）。<br />
      Enter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴截图
    </div>
    <MessageItem v-for="message in messages" :key="message.id" :message="message" :on-confirm="onConfirm" />
  </section>
</template>

<style scoped>
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.welcome {
  margin: auto;
  max-width: 560px;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.9;
}

.welcome b {
  color: var(--text);
}
</style>
