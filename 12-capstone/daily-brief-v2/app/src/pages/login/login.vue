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
			<view class="field">
				<text class="label">密码</text>
				<input v-model="password" password placeholder="至少 8 位" />
			</view>
			<view v-if="mode === 'register'" class="field">
				<text class="label">邀请码</text>
				<input v-model="inviteCode" placeholder="找管理员要" />
			</view>

			<button class="btn block submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : mode === 'login' ? '登录' : '注册并进入' }}</button>
			<text v-if="errText" class="err">{{ errText }}</text>
		</view>
	</view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { login, register } from '../../api'

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const inviteCode = ref('')
const busy = ref(false)
const errText = ref('')

const switchMode = (m: 'login' | 'register') => {
	mode.value = m
	errText.value = ''
}

async function submit() {
	errText.value = ''
	if (!username.value.trim() || !password.value) return (errText.value = '用户名和密码都要填')
	if (mode.value === 'register' && !inviteCode.value.trim()) return (errText.value = '注册要邀请码（找管理员要）')
	busy.value = true
	// 注册成功=已登录（server register 即发 cookie），两种模式成功后都直接进日报页
	const r = mode.value === 'login'
		? await login(username.value.trim(), password.value)
		: await register(username.value.trim(), password.value, inviteCode.value.trim())
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
</style>
