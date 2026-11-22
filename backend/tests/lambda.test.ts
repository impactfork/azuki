import { describe, expect, test } from "vitest";
import { createLambdaApp, isOccupationPreviewPath } from "../src/lambda.js";

describe("isOccupationPreviewPath", () => {
	test("numeric occupation ids go to the server-rendered preview", () => {
		expect(isOccupationPreviewPath("/results/12345")).toBe(true);
		expect(isOccupationPreviewPath("/results/12345/")).toBe(true);
	});

	test("SPA routes under /results get the SPA shell", () => {
		expect(isOccupationPreviewPath("/results/apprenticeships")).toBe(false);
		expect(isOccupationPreviewPath("/results/vacancies")).toBe(false);
		expect(isOccupationPreviewPath("/results/vacancies/10001-123")).toBe(false);
	});
});

describe("origin check", () => {
	test("rejects requests without the CloudFront secret", async () => {
		const lambdaApp = createLambdaApp("s3cret");
		expect((await lambdaApp.request("/api/health")).status).toBe(403);
		expect(
			(
				await lambdaApp.request("/api/health", {
					headers: { "x-azuki-origin": "wrong" },
				})
			).status,
		).toBe(403);
	});

	test("passes requests with the secret through to the app", async () => {
		const lambdaApp = createLambdaApp("s3cret");
		const res = await lambdaApp.request("/api/health", {
			headers: { "x-azuki-origin": "s3cret" },
		});
		expect(res.status).toBe(200);
	});

	test("serves the SPA shell for non-numeric /results paths", async () => {
		const lambdaApp = createLambdaApp(undefined);
		const res = await lambdaApp.request("/results/apprenticeships");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});
});
