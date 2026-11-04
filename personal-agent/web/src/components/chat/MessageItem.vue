<script setup lang="ts">
import { ref } from 'vue'
import type { ConfirmCard, DisplayMessage } from '../../types'
import MarkdownView from '../common/MarkdownView.vue'
import UsageMeta from '../common/UsageMeta.vue'

defineProps<{
  message: DisplayMessage
  /** 确认卡上的允许/拒绝（穿自 useChat.answerConfirm） */
  onConfirm?: (card: ConfirmCard, approve: boolean, always: boolean) => void
}>()

// 工具痕迹默认收起：要点开才看参数/结果——痕迹是审计用的，不该淹没正文
const openTool = ref<number | null>(null)
// 「本会话总是允许」勾选（卡片一张一张出，单值够用；只在点允许时读）
const alwaysAllow = ref(false)

// 确认卡参数展示：尽量美化成可读 JSON，失败就原样
function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}
</script>

<template>
  <div class="msg" :class="message.role">
    <div class="avatar">{{ message.role === 'user' ? '我' : 'AI' }}</div>
    <div class="bubble" :class="{ error: !!message.error }">
      <template v-if="message.error">{{ message.error }}</template>

      <template v-else-if="message.role === 'user'">
        <div v-if="message.content" class="user-text">{{ message.content }}</div>
        <img v-for="(image, i) in message.images" :key="i" :src="image.src" :alt="image.name" />
      </template>

      <template v-else>
        <!-- 写入工具确认卡：批准前工具不跑；args 原文全量展示，人批的才是账上的 -->
        <div v-for="card in message.confirms" :key="card.confirmId" class="confirm-card" :class="card.outcome">
          <div class="confirm-head">⚠️ 写入确认 · {{ card.name }}</div>
          <pre class="confirm-args">{{ prettyArgs(card.args) }}</pre>
          <div v-if="!card.outcome" class="confirm-actions">
            <label class="always" title="只对当前会话生效（存在服务端内存，重启即失效）；后果自负的快捷方式">
              <input v-model="alwaysAllow" type="checkbox" />
              本会话内总是允许
            </label>
            <button class="approve" @click="onConfirm?.(card, true, alwaysAllow)">允许</button>
            <button class="deny" @click="onConfirm?.(card, false, false)">拒绝</button>
          </div>
          <div v-else class="confirm-outcome">
            {{ card.outcome === 'approved' ? '✓ 已允许' : card.outcome === 'denied' ? '✗ 已拒绝' : '⏱ 无人应答，已自动拒绝' }}
          </div>
        </div>

        <div v-if="message.tools?.length" class="tool-trace">
          <button
            v-for="(t, i) in message.tools"
            :key="i"
            class="tool-chip"
            :class="{ open: openTool === i }"
            @click="openTool = openTool === i ? null : i"
          >
            🔧 {{ t.name }} · {{ t.ms }}ms {{ openTool === i ? '▾' : '▸' }}
          </button>
          <div v-if="openTool !== null && message.tools[openTool]" class="tool-detail">
            <div class="row"><span class="k">参数</span><code>{{ message.tools[openTool].args || '（无）' }}</code></div>
            <div class="row"><span class="k">结果</span><pre>{{ message.tools[openTool].result }}</pre></div>
          </div>
        </div>
        <div v-if="message.streaming && !message.content" class="thinking"><span class="spin"></span>思考中…</div>
        <MarkdownView v-else :source="message.content" />
        <UsageMeta
          v-if="!message.streaming"
          :usage="message.usage"
          :model="message.model"
          :elapsed-ms="message.elapsedMs"
          :interrupted="message.interrupted"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  gap: 10px;
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
}

.msg.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  background: #e9edf3;
}

.msg.user .avatar {
  background: var(--accent);
  color: #fff;
}

.bubble {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  max-width: calc(100% - 48px);
  overflow-wrap: anywhere;
}

.msg.user .bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.msg.assistant .bubble {
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%);
}

.bubble.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: var(--danger);
}

.user-text {
  white-space: pre-wrap;
}

.bubble img {
  max-width: 260px;
  max-height: 200px;
  border-radius: 8px;
  display: block;
  margin: 6px 0;
  border: 1px solid rgb(0 0 0 / 8%);
}

.thinking {
  color: var(--muted);
}

.tool-trace {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.tool-chip {
  border: 1px solid var(--line);
  background: #f6f8fa;
  color: var(--muted);
  border-radius: 999px;
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.tool-chip.open {
  border-color: var(--accent);
  color: var(--accent);
}

.tool-detail {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f6f8fa;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--muted);
}

.tool-detail .row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.tool-detail .row + .row {
  margin-top: 6px;
}

.tool-detail .k {
  flex: none;
  font-weight: 600;
}

.tool-detail code,
.tool-detail pre {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.confirm-card {
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 8px;
  font-size: 13px;
}

.confirm-card.approved {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.confirm-card.denied,
.confirm-card.timeout {
  border-color: #fecaca;
  background: #fef2f2;
}

.confirm-head {
  font-weight: 600;
  margin-bottom: 4px;
}

.confirm-args {
  margin: 4px 0 8px;
  padding: 6px 8px;
  background: rgb(0 0 0 / 4%);
  border-radius: 6px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.confirm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.confirm-actions .always {
  margin-right: auto;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.confirm-actions button {
  font: inherit;
  font-size: 13px;
  border-radius: 8px;
  padding: 4px 14px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: #fff;
}

.confirm-actions .approve {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.confirm-actions .deny {
  color: var(--danger);
}

.confirm-outcome {
  color: var(--muted);
  font-size: 12px;
}
</style>
