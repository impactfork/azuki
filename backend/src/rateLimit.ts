import type { Context } from "hono";

interface RateLimiterOptions {
	windowMs: number;
	max: number;
	now?: () => number;
	store?: Map<string, number[]>;
}

export function createRateLimiter({
	windowMs,
	max,
	now = Date.now,
	store: hits = new Map(),
}: RateLimiterOptions): (key: string) => boolean {
	let lastSweep = now();

	return function isAllowed(key: string): boolean {
		const timestamp = now();
		if (timestamp - lastSweep >= windowMs) {
			for (const [storedKey, storedHits] of hits) {
				if (timestamp - storedHits[storedHits.length - 1] >= windowMs) {
					hits.delete(storedKey);
				}
			}
			lastSweep = timestamp;
		}
		const recent = (hits.get(key) ?? []).filter(
			(hit) => timestamp - hit < windowMs,
		);
		if (recent.length >= max) {
			hits.set(key, recent);
			return false;
		}
		recent.push(timestamp);
		hits.set(key, recent);
		return true;
	};
}

// Behind CloudFront (AWS deployment), x-forwarded-for keeps whatever the
// client sent and appends the real address, so its first entry is
// spoofable. CloudFront-Viewer-Address ("ip:port", set by CloudFront) is
// authoritative there and checked first.
// On Vercel, x-forwarded-for is edge-injected and unspoofable.
export function getClientIp(c: Context): string {
	const viewerAddress = c.req.header("cloudfront-viewer-address");
	if (viewerAddress) {
		const portSeparator = viewerAddress.lastIndexOf(":");
		return portSeparator > 0
			? viewerAddress.slice(0, portSeparator)
			: viewerAddress;
	}
	const forwardedFor = c.req.header("x-forwarded-for");
	if (forwardedFor) {
		return forwardedFor.split(",")[0].trim();
	}
	return c.req.header("x-real-ip") ?? "unknown";
}
