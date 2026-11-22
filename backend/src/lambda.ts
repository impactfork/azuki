import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import app from "./app.js";
import { SPA_INDEX_HTML } from "./generated/spaIndexTemplate.js";

/**
 * AWS Lambda entry point (Function URL behind CloudFront, see sst.config.ts).
 * The Vercel deployment keeps using api/_handler.ts.
 *
 * Origin check: CloudFront adds x-azuki-origin with ORIGIN_SECRET to every
 * request. The Function URL itself is public, so requests without the secret
 * are rejected; otherwise callers could bypass CloudFront and spoof
 * CloudFront-Viewer-Address, which rate limiting trusts.
 *
 * /results/*: CloudFront routes by path prefix only, so every /results/*
 * request lands here. Vercel sends only /results/<id> to the backend
 * (server-rendered share preview); all other /results/* paths are
 * client-side routes of the SPA (e.g. /results/apprenticeships), so they get
 * the SPA shell.
 */
const OCCUPATION_PREVIEW_PATH = /^\/results\/\d+\/?$/;

export function isOccupationPreviewPath(path: string): boolean {
	return OCCUPATION_PREVIEW_PATH.test(path);
}

export function createLambdaApp(originSecret: string | undefined): Hono {
	const lambdaApp = new Hono();
	if (originSecret) {
		lambdaApp.use("*", async (c, next) => {
			if (c.req.header("x-azuki-origin") !== originSecret) {
				return c.text("Forbidden", 403);
			}
			return next();
		});
	}
	lambdaApp.get("/results/*", (c) =>
		isOccupationPreviewPath(c.req.path)
			? app.fetch(c.req.raw, c.env)
			: c.html(SPA_INDEX_HTML),
	);
	lambdaApp.all("*", (c) => app.fetch(c.req.raw, c.env));
	return lambdaApp;
}

export const handler = handle(createLambdaApp(process.env.ORIGIN_SECRET));
