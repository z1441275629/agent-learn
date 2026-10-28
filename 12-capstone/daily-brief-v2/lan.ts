// v2 局域网地址探测——同 v1 语义（发送时刻探测跟随 IP 漂移；钉死逃生门走 V2_PUBLIC_URL，
// 缺省端口 V2_PORT）。独立复制不跨目录 import v1：两版独立演进，v1 保持可跑
import os from 'node:os'

const RFC1918 = (ip: string) => /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^192\.168\./.test(ip)

export function lanIPv4(): string | null {
	const ips = Object.values(os.networkInterfaces())
		.flat()
		.filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
		.map((n) => n.address)
	if (ips.length === 1) return ips[0]
	return ips.find((ip) => RFC1918(ip)) ?? null
}

// 通知链接解析优先级：V2_PUBLIC_URL 钉死（公网域名/内网穿透时用）> 自动探测 > null（不带链接）
export function publicURL(): string | null {
	const pinned = process.env.V2_PUBLIC_URL?.trim()
	if (pinned) return pinned
	const ip = lanIPv4()
	if (!ip) return null
	return `http://${ip}:${Number(process.env.V2_PORT || 8788)}`
}
