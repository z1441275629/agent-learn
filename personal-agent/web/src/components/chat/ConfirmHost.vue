<script setup lang="ts">
// 全局确认宿主：挂在 App 壳——后台会话的写入门也在这里弹出（卡面注明所属会话，可跳转可就地应答）
import { useRouter } from 'vue-router'
import { useChat } from '../../composables/useChat'
import ConfirmDialog from './ConfirmDialog.vue'

const router = useRouter()
const { globalConfirm, answerConfirm } = useChat()

function answer(approve: boolean, always: boolean): void {
  if (globalConfirm.value) void answerConfirm(globalConfirm.value.card, approve, always)
}

function goto(): void {
  if (globalConfirm.value) void router.push('/chat/' + globalConfirm.value.sid)
}
</script>

<template>
  <ConfirmDialog
    v-if="globalConfirm"
    :card="globalConfirm.card"
    :session-title="globalConfirm.title"
    @answer="answer"
    @goto="goto"
  />
</template>
