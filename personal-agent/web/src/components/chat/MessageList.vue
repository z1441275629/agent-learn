<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DisplayMessage } from '../../types'
import MessageItem from './MessageItem.vue'

const props = defineProps<{ messages: DisplayMessage[] }>()
const scroller = ref<HTMLElement | null>(null)

// 自动滚动只在「贴底」时跟随：用户上翻查历史时，流式增量不再把视角拽回底部。
// 距底 80px 内都算贴底——留一点弹性，避免亚像素 rounding 误判成上翻。
const pinned = ref(true)

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(): void {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

function jumpToLatest(): void {
  pinned.value = true
  scrollToBottom()
}

// 内容不满一屏（没有可滚动余量）时贴底无条件成立——「最新」按钮在短页面上没有意义。
// 光靠 scroll 事件不够：视口变大（窗口最大化/输入框收回/工具栏不换行了）时若 scrollTop 本来就是 0，
// 浏览器不会触发 scroll 事件，pinned 会卡在 false，按钮就挂在短页面上
function recheck(): void {
  const el = scroller.value
  if (el && el.scrollHeight - el.clientHeight <= 0) pinned.value = true
}

// 滚动区自身尺寸变化（窗口缩放、输入框长高/收回挤压消息区）都要重判
let ro: ResizeObserver | undefined
onMounted(() => {
  if (!scroller.value) return
  ro = new ResizeObserver(() => recheck())
  ro.observe(scroller.value)
})
onBeforeUnmount(() => ro?.disconnect())

// 流式增量/消息内容变化：贴底才跟随
watch(
  () => props.messages,
  async (msgs) => {
    // 用户自己刚发消息：无条件贴底（发的那条和随后的回答都得看得见，哪怕发之前在翻历史）
    if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') pinned.value = true
    await nextTick()
    recheck()
    if (!pinned.value) return
    scrollToBottom()
  },
  { deep: true },
)

// 换会话/新对话（首条消息 id 变了 = 整个数组被替换）：重置贴底并定位到最新
watch(
  () => props.messages[0]?.id,
  async () => {
    pinned.value = true
    await nextTick()
    scrollToBottom()
  },
)
</script>

<template>
  <section ref="scroller" class="msgs" @scroll="onScroll">
    <div v-if="messages.length === 0" class="welcome">
      <b>个人 Agent 工作台</b><br />
      可以直接聊天；也可以贴图/上传附件后提问（图片需选「视觉」模型）。<br />
      Enter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴截图
    </div>
    <MessageItem v-for="message in messages" :key="message.id" :message="message" />
    <!-- 上翻时悬浮在可视区底部的回底入口；sticky 定位，钉在可视区下缘 -->
    <button v-if="!pinned" class="jump-latest" title="回到最新消息" @click="jumpToLatest">↓ 最新</button>
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

.jump-latest {
  position: sticky;
  bottom: 12px;
  align-self: flex-end;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 999px;
  padding: 4px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgb(0 0 0 / 12%);
}
</style>
