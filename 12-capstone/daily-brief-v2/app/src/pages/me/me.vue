<template>
	<view class="page">
		<!-- 账号卡 -->
		<view class="card">
			<view class="row">
				<text class="username">{{ me?.username ?? '…' }}</text>
				<text v-if="me?.admin" class="badge">管理员</text>
				<view class="grow"></view>
				<button class="btn ghost sm" @click="doLogout">退出登录</button>
			</view>
			<text class="muted line">微信推送：{{ me?.sendkeyMasked ?? '未配置' }}</text>
		</view>

		<!-- Server酱推送 -->
		<view class="card">
			<text class="card-title">微信推送（Server酱）</text>
			<text class="muted line">日报生成后自动推到你的微信。去 sct.ftqq.com 免费注册拿 SendKey（SCT 开头）填这里，只有你自己能看（掩码回显）。</text>
			<view class="field">
				<input v-model="sendkey" :placeholder="me?.sendkeyMasked ?? 'SCTxxxxxxxxxxxxxxxx'" />
				<button class="btn block" :disabled="savingKey" @click="saveKey">{{ savingKey ? '保存中…' : '保存 SendKey' }}</button>
			</view>
		</view>

		<!-- 改密码 -->
		<view class="card">
			<text class="card-title">改密码</text>
			<view class="field"><text class="label">旧密码</text><input v-model="oldP" password /></view>
			<view class="field"><text class="label">新密码（至少 8 位）</text><input v-model="newP" password /></view>
			<view class="field"><text class="label">再输一遍新密码</text><input v-model="newP2" password /></view>
			<button class="btn block mt" :disabled="changingP" @click="doChangeP">{{ changingP ? '提交中…' : '改密码' }}</button>
		</view>

		<!-- admin 运营区：邀请码 + 今日预算 -->
		<view v-if="me?.admin" class="card">
			<view class="row">
				<text class="card-title">邀请码</text>
				<view class="grow"></view>
				<button class="btn ghost sm" :disabled="makingCode" @click="makeCode">{{ makingCode ? '生成中…' : '＋ 造码' }}</button>
			</view>
			<view v-for="(v, code) in invites" :key="code" class="row invite-row">
				<text class="code" selectable>{{ code }}</text>
				<view class="grow"></view>
				<text :class="v.usedBy ? 'muted' : 'usable'">{{ v.usedBy ? '已使用' : '可用' }}</text>
			</view>
			<view v-if="!Object.keys(invites).length" class="muted invite-empty">还没有邀请码，点「造码」生成一个</view>
			<view v-if="budget" class="budget">
				<text class="muted">今日预算：{{ budget.calls }}/{{ budget.limits.calls }} 次调用 · {{ budget.promptTokens + budget.completionTokens }}/{{ budget.limits.tokens }} tokens</text>
			</view>
		</view>
	</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { ref } from 'vue'
import { fetchMe, saveSendkey, changePassword, logout, createInvite, fetchInvites, fetchBudget, type Me } from '../../api'

const me = ref<Me | null>(null)
const sendkey = ref('')
const savingKey = ref(false)
const oldP = ref('')
const newP = ref('')
const newP2 = ref('')
const changingP = ref(false)
const invites = ref<Record<string, { usedBy?: string; usedAt?: string }>>({})
const budget = ref<any>(null)
const makingCode = ref(false)

onShow(refresh)

async function refresh() {
	try {
		me.value = await fetchMe()
		if (me.value.admin) {
			// admin 运营区并行拉（403 不会发生——admin 已验；网络错就空着，下次 onShow 再拉）
			fetchInvites().then((j) => (invites.value = j)).catch(() => {})
			fetchBudget().then((j) => (budget.value = j)).catch(() => {})
		}
	} catch {
		/* 401 已被 api 层拦截跳登录 */
	}
}

async function saveKey() {
	if (!sendkey.value.trim()) return uni.showToast({ title: '先填 SendKey', icon: 'none' })
	savingKey.value = true
	try {
		const r = await saveSendkey(sendkey.value.trim())
		uni.showToast({ title: `已保存（${r.sendkeyMasked ?? '已清除'}）`, icon: 'success' })
		sendkey.value = ''
		me.value = await fetchMe()
	} catch (err: any) {
		uni.showToast({ title: String(err?.message).slice(0, 40), icon: 'none' })
	} finally {
		savingKey.value = false
	}
}

async function doChangeP() {
	if (!oldP.value || !newP.value || !newP2.value) return uni.showToast({ title: '三个框都要填', icon: 'none' })
	if (newP.value.length < 8) return uni.showToast({ title: '新密码至少 8 位', icon: 'none' })
	if (newP.value !== newP2.value) return uni.showToast({ title: '两次新密码不一致', icon: 'none' })
	changingP.value = true
	try {
		await changePassword(oldP.value, newP.value)
		uni.showToast({ title: '密码已改，下次登录用新密码', icon: 'success' })
		oldP.value = newP.value = newP2.value = ''
	} catch (err: any) {
		uni.showToast({ title: String(err?.message).slice(0, 40), icon: 'none' })
	} finally {
		changingP.value = false
	}
}

async function doLogout() {
	await logout()
	uni.reLaunch({ url: '/pages/login/login' })
}

async function makeCode() {
	makingCode.value = true
	try {
		const r = await createInvite()
		invites.value = await fetchInvites()
		// showModal 把码亮出来方便核对抄送（人就在手机上，长按 selectable 可复制）
		uni.showModal({ title: '新邀请码', content: r.code, showCancel: false })
	} catch (err: any) {
		uni.showToast({ title: String(err?.message).slice(0, 40), icon: 'none' })
	} finally {
		makingCode.value = false
	}
}
</script>

<style>
.username {
	font-size: 20px;
	font-weight: 700;
}
.badge {
	font-size: 12px;
	color: #1f6feb;
	border: 1px solid #1f6feb;
	border-radius: 4px;
	padding: 0 6px;
}
.line {
	display: block;
	margin-top: 10px;
	line-height: 1.6;
}
.card-title {
	font-weight: 600;
}
.invite-row {
	padding: 10px 0;
	border-bottom: 1px dashed #eaeef2;
}
.invite-row:last-of-type {
	border-bottom: none;
}
.invite-empty {
	display: block;
	margin-top: 10px;
}
.code {
	font-family: monospace;
	font-size: 15px;
}
.usable {
	color: #1a7f37;
	font-size: 12px;
}
.budget {
	margin-top: 12px;
	border-top: 1px dashed #eaeef2;
	padding-top: 10px;
}
</style>
