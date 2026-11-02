<template>
	<view class="login-page">
		<view class="card login-card">
			<text class="title">AI 情报日报</text>
			<text class="muted sub">各订各的源，各收各的报</text>

			<view class="row mode-tabs">
				<button :class="['btn', 'grow', mode === 'login' ? '' : 'ghost']" @click="switchMode('login')">登录</button>
				<button :class="['btn', 'grow', mode === 'register' ? '' : 'ghost']" @click="switchMode('register')">注册</button>
			</view>

			<view class="field">
				<text class="label">用户名</text>
				<input v-model="username" placeholder="3~32 位，字母/数字/_/-" />
			</view>
			<!-- 重置模式：新密码占「密码」位，重置码单独一个框 -->
			<view class="field">
				<text class="label">{{ mode === 'reset' ? '新密码' : '密码' }}</text>
				<input v-model="password" password placeholder="至少 8 位" />
			</view>
			<view v-if="mode === 'register'" class="field">
				<text class="label">邀请码</text>
				<input v-model="inviteCode" placeholder="找管理员要" />
			</view>
			<view v-if="mode === 'reset'" class="field">
				<text class="label">重置码</text>
				<input v-model="resetCode" placeholder="找管理员要（说明是哪个用户名）" />
			</view>

			<button class="btn block submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : submitLabel }}</button>
			<text v-if="errText" class="err">{{ errText }}</text>

			<!-- 忘记密码的入口：常驻小字（不是模式 tab——低频操作不占主视觉） -->
			<text v-if="mode !== 'reset'" class="link" @click="switchMode('reset')">忘记密码？</text>
			<text v-else class="link" @click="switchMode('login')">返回登录</text>
		</view>
	</view>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { login, register, resetPassword } from '../../api'

type Mode = 'login' | 'register' | 'reset'
const mode = ref<Mode>('login')
const username = ref('')
const password = ref('')
const inviteCode = ref('')
const resetCode = ref('')
const busy = ref(false)
const errText = ref('')

const switchMode = (m: Mode) => {
	mode.value = m
	errText.value = ''
}

const submitLabel = computed(() => ({ login: '登录', register: '注册并进入', reset: '重置并登录' })[mode.value])

async function submit() {
	errText.value = ''
	if (!username.value.trim() || !password.value) return (errText.value = '用户名和密码都要填')
	if (mode.value === 'register' && !inviteCode.value.trim()) return (errText.value = '注册要邀请码（找管理员要）')
	if (mode.value === 'reset' && !resetCode.value.trim()) return (errText.value = '重置要重置码（找管理员要）')
	busy.value = true
	// 注册成功=已登录（server register 即发 cookie）；重置成功后紧跟一次真登录（重置会吊销全部旧 session，包括刚才能用的）
	const r =
		mode.value === 'login'
			? await login(username.value.trim(), password.value)
			: mode.value === 'register'
				? await register(username.value.trim(), password.value, inviteCode.value.trim())
				: await (async () => {
						const rr = await resetPassword(username.value.trim(), resetCode.value.trim(), password.value)
						return rr.ok ? await login(username.value.trim(), password.value) : rr
					})()
	busy.value = false
	if (r.ok) uni.reLaunch({ url: '/pages/report/report' })
	else errText.value = r.error ?? '失败'
}
</script>

<style>
/* 居中：页面撑满视口 + 纵向居中 + 卡片自己不叠 .card 的横向 margin（叠了就越出边距、看着偏） */
.login-page {
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	min-height: 100vh;
	box-sizing: border-box;
	padding: 24px 20px;
}
.login-card {
	width: 100%;
	max-width: 420px;
	margin: 0;
	padding: 26px 22px;
	box-sizing: border-box;
}
.title {
	display: block;
	font-size: 23px;
	font-weight: 700;
	text-align: center;
	letter-spacing: 0.5px;
}
.sub {
	display: block;
	text-align: center;
	margin: 8px 0 20px;
}
.mode-tabs {
	gap: 10px;
	margin-bottom: 4px;
}
.submit {
	margin-top: 22px;
}
.err {
	display: block;
	margin-top: 12px;
	color: #d1242f;
	font-size: 13px;
	text-align: center;
}
.link {
	display: block;
	margin-top: 16px;
	text-align: center;
	color: #1f6feb;
	font-size: 13px;
}
</style>
