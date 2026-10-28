<template>
	<view class="page login-page">
		<view class="card">
			<text class="title">AI 情报日报</text>
			<text class="muted sub">各订各的源，各收各的报（邀请码注册）</text>

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

			<button class="btn submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : mode === 'login' ? '登录' : '注册并进入' }}</button>
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
.login-page {
	min-height: 100vh;
	display: flex;
	align-items: center;
}
.title {
	display: block;
	font-size: 24px;
	font-weight: 700;
	text-align: center;
}
.sub {
	display: block;
	text-align: center;
	margin: 6px 0 16px;
}
.mode-tabs {
	margin-bottom: 8px;
}
.submit {
	margin-top: 18px;
}
.err {
	display: block;
	margin-top: 10px;
	color: #d1242f;
	font-size: 13px;
	text-align: center;
}
.field {
	margin-top: 12px;
}
.label {
	display: block;
	font-size: 12px;
	color: #57606a;
	margin-bottom: 4px;
}
.field input {
	border: 1px solid #d0d7de;
	border-radius: 6px;
	padding: 7px 10px;
	font-size: 14px;
	background: #fafbfc;
}
</style>
