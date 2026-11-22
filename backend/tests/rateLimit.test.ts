import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimiter, getClientIp } from "../src/rateLimit.js";

describe("createRateLimiter", () => {
	it("allows calls up to the max within the window", () => {
		const isAllowed = createRateLimiter({ windowMs: 1000, max: 3 });
		expect(isAllowed("a")).toBe(true);
		expect(isAllowed("a")).toBe(true);
		expect(isAllowed("a")).toBe(true);
	});

	it("blocks the call once max is exceeded within the window", () => {
		const isAllowed = createRateLimiter({ windowMs: 1000, max: 3 });
		isAllowed("a");
		isAllowed("a");
		isAllowed("a");
		expect(isAllowed("a")).toBe(false);
	});

	it("tracks each key independently", () => {
		const isAllowed = createRateLimiter({ windowMs: 1000, max: 1 });
		expect(isAllowed("a")).toBe(true);
		expect(isAllowed("b")).toBe(true);
		expect(isAllowed("a")).toBe(false);
		expect(isAllowed("b")).toBe(false);
	});

	it("allows calls again once the window has elapsed", () => {
		let currentTime = 0;
		const isAllowed = createRateLimiter({
			windowMs: 1000,
			max: 1,
			now: () => currentTime,
		});
		expect(isAllowed("a")).toBe(true);
		expect(isAllowed("a")).toBe(false);
		currentTime = 1001;
		expect(isAllowed("a")).toBe(true);
	});

	it("drops keys whose hits have all expired", () => {
		let currentTime = 0;
		const store = new Map<string, number[]>();
		const isAllowed = createRateLimiter({
			windowMs: 1000,
			max: 1,
			now: () => currentTime,
			store,
		});
		isAllowed("a");
		isAllowed("b");
		currentTime = 1001;
		isAllowed("c");
		expect([...store.keys()]).toEqual(["c"]);
	});
});

describe("getClientIp", () => {
	async function ipFor(headers: Record<string, string>): Promise<string> {
		const app = new Hono();
		app.get("/", (c) => c.text(getClientIp(c)));
		const res = await app.request("/", { headers });
		return res.text();
	}

	it("prefers CloudFront-Viewer-Address over a spoofable x-forwarded-for", async () => {
		expect(
			await ipFor({
				"cloudfront-viewer-address": "203.0.113.7:51234",
				"x-forwarded-for": "1.2.3.4, 203.0.113.7",
			}),
		).toBe("203.0.113.7");
	});

	it("strips the port from an IPv6 viewer address", async () => {
		expect(
			await ipFor({ "cloudfront-viewer-address": "2001:db8::1:443" }),
		).toBe("2001:db8::1");
	});

	it("falls back to the first x-forwarded-for entry", async () => {
		expect(await ipFor({ "x-forwarded-for": "198.51.100.2, 10.0.0.1" })).toBe(
			"198.51.100.2",
		);
	});
});
