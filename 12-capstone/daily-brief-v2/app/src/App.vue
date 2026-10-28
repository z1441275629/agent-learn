<script setup lang="ts">
// 全局壳：无 onLaunch 逻辑（登录态没有全局拦——各页 API 401 时由 api.ts 统一 reLaunch 到登录页），
// 只放公共样式（v1 同款：卡片/布局三页共用）
</script>

<style>
/* 公共基础样式：卡片/布局类，各页面共用（v1 原样） */
page {
	background: #f5f6f8;
	font-size: 15px;
	color: #24292f;
}
.card {
	background: #fff;
	border-radius: 10px;
	padding: 16px;
	margin: 12px 16px;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.row {
	display: flex;
	align-items: center;
	gap: 8px;
}
.grow {
	flex: 1;
}
.muted {
	color: #8b949e;
	font-size: 13px;
}
.btn {
	background: #1f6feb;
	color: #fff;
	border-radius: 6px;
	padding: 8px 14px;
	font-size: 14px;
	text-align: center;
	border: none;
}
.btn.warn {
	background: #d1242f;
}
.btn.ghost {
	background: #fff;
	color: #1f6feb;
	border: 1px solid #d0d7de;
}
.btn[disabled] {
	opacity: 0.5;
}
</style>
