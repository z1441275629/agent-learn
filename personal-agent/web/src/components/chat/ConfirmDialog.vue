<script setup lang="ts">
import { ref } from 'vue'
import type { ConfirmCard } from '../../types'

defineProps<{ card: ConfirmCard }>()
const emit = defineEmits<{ answer: [approve: boolean, always: boolean] }>()

// 「本会话内总是允许」勾选（卡片一张一张出，单值够用；只在点允许时读）
const alwaysAllow = ref(false)

// 参数展示：尽量美化成可读 JSON，失败就原样（与内联卡同一套规则）
function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}
</script>

<template>
  <!-- 模态确认：待决策的写入操作由弹窗接管（内联卡只留审计记录，不再放按钮）。
       点遮罩/Esc 不做任何事——写入操作的允许/拒绝都必须是明确点击，不给误触留通道 -->
  <div class="confirm-overlay">
    <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="写入操作确认">
      <div class="head">⚠️ 写入操作需要确认</div>
      <div class="tool">工具 <code>{{ card.name }}</code> 请求执行：</div>
      <pre class="args">{{ prettyArgs(card.args) }}</pre>
      <label class="always" title="只对当前会话生效（存在服务端内存，重启即失效）；对生面孔工具别勾">
        <input v-model="alwaysAllow" type="checkbox" />
        本会话内总是允许
      </label>
      <div class="btns">
        <button class="deny" @click="emit('answer', false, false)">拒绝</button>
        <button class="approve" @click="emit('answer', true, alwaysAllow)">允许</button>
      </div>
      <p class="hint">两分钟内无人应答将自动拒绝</p>
    </div>
  </div>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 50; /* 压过工具栏弹层（31）与遮罩（30），不压 toast */
  background: rgb(15 23 42 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.confirm-dialog {
  width: min(560px, 100%);
  background: #fff;
  border: 1px solid #fde68a;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 18%);
  padding: 16px 18px;
}

.head {
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 10px;
}

.tool {
  font-size: 13px;
  margin-bottom: 6px;
}

.tool code {
  font-family: ui-monospace, Consolas, monospace;
  background: #f1f3f5;
  padding: 1px 5px;
  border-radius: 4px;
}

.args {
  margin: 4px 0 10px;
  padding: 8px 10px;
  background: #f6f8fa;
  border-radius: 8px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 40vh;
  overflow-y: auto;
}

.always {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  margin-bottom: 12px;
}

.btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btns button {
  font: inherit;
  font-size: 14px;
  border-radius: 8px;
  padding: 6px 22px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: #fff;
}

.btns .approve {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btns .deny {
  color: var(--danger);
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
  text-align: right;
}
</style>
