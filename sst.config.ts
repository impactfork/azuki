/// <reference path="./.sst/platform/config.d.ts" />

/**
 * AWS deployment of AzuKi (operated by impactfork for JOBLINGE).
 * Everything runs in eu-central-1; LLM calls go to Amazon Bedrock via the EU
 * cross-region inference profile, so data stays in EU regions.
 *
 * Deploy:  npm run aws:deploy   (builds frontend + SPA template, then sst deploy)
 * Secrets: npx sst secret set AppPassword <value> --stage production
 *          npx sst secret set HubspotFormsSubmitUrl <url> --stage production
 *
 * The Vercel deployment (vercel.json, api/_handler.ts) is left untouched.
 */
export default $config({
	app(input) {
		return {
			name: "azuki",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				aws: {
					region: "eu-central-1",
					defaultTags: { tags: { Project: "azuki" } },
				},
			},
		};
	},
	async run() {
		// Guards the internal /api/eval and /api/personas routes; production
		// refuses to start without it.
		const appPassword = new sst.Secret("AppPassword");
		// Contact form → JOBLINGE HubSpot. Empty: everything else works, the
		// contact form returns an error.
		const hubspotFormsSubmitUrl = new sst.Secret("HubspotFormsSubmitUrl", "");
		// Shared secret CloudFront adds to every request (router edge injection
		// below). The Lambda rejects requests without it, so its public Function
		// URL can't be called directly and CloudFront-Viewer-Address (used for
		// rate limiting) can't be spoofed.
		const originSecret = new sst.Secret("OriginSecret");

		// Daily token budget (backend/src/ai/dailyBudget.ts), one item per UTC day
		const llmBudget = new sst.aws.Dynamo("LlmBudget", {
			fields: { day: "string" },
			primaryIndex: { hashKey: "day" },
			ttl: "expiresAt",
		});

		// Model choice from the 2026-11-22 bake-off on the repo's eval personas:
		// Sonnet 5.5 with low effort had the fewest no-go hits at ~9 ct/ranking.
		const bedrockModel = "eu.anthropic.claude-sonnet-5-5";
		const bedrockFoundationModel = "anthropic.claude-sonnet-5-5";
		const { accountId } = await aws.getCallerIdentity({});

		const api = new sst.aws.Function("Api", {
			handler: "backend/src/lambda.handler",
			runtime: "nodejs22.x",
			architecture: "arm64",
			memory: "1024 MB",
			// Ranking takes ~10–20 s; matches Vercel's maxDuration
			timeout: "60 seconds",
			url: true,
			link: [llmBudget],
			environment: {
				NODE_ENV: "production",
				LLM_PROVIDER: "bedrock",
				BEDROCK_MODEL_ID: bedrockModel,
				BEDROCK_EFFORT: "low",
				LLM_BUDGET_TABLE: llmBudget.name,
				// ~270 rankings or ~25–30 USD per day, like the former OpenRouter cap
				LLM_DAILY_TOKEN_LIMIT: "10000000",
				APP_PASSWORD: appPassword.value,
				HUBSPOT_FORMS_SUBMIT_URL: hubspotFormsSubmitUrl.value,
				ORIGIN_SECRET: originSecret.value,
			},
			permissions: [
				{
					// EU inference profile plus the EU regions it routes to; no
					// global profile, no other models
					actions: ["bedrock:InvokeModel"],
					resources: [
						`arn:aws:bedrock:eu-central-1:${accountId}:inference-profile/${bedrockModel}`,
						`arn:aws:bedrock:eu-*::foundation-model/${bedrockFoundationModel}`,
					],
				},
			],
		});

		// Role for the quarterly BERUFENET refresh in GitHub Actions
		// (.github/workflows/refresh-berufe.yml), via GitHub OIDC — no stored
		// keys. Only this repo's main branch, only the EU Sonnet profile.
		const githubOidcProvider = `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;
		const dataRefreshRole = new aws.iam.Role("DataRefreshRole", {
			description: "AzuKi BERUFENET refresh (GitHub Actions) - Bedrock only",
			maxSessionDuration: 3600,
			assumeRolePolicy: JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Federated: githubOidcProvider },
						Action: "sts:AssumeRoleWithWebIdentity",
						Condition: {
							StringEquals: {
								"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
								"token.actions.githubusercontent.com:sub":
									"repo:impactfork/azuki:ref:refs/heads/main",
							},
						},
					},
				],
			}),
		});
		new aws.iam.RolePolicy("DataRefreshBedrock", {
			role: dataRefreshRole.id,
			policy: JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: "bedrock:InvokeModel",
						Resource: [
							`arn:aws:bedrock:eu-central-1:${accountId}:inference-profile/${bedrockModel}`,
							`arn:aws:bedrock:eu-*::foundation-model/${bedrockFoundationModel}`,
						],
					},
				],
			}),
		});

		// One CloudFront distribution: /api and /results to the Lambda, the rest
		// to the static frontend (unknown paths fall back to index.html).
		const router = new sst.aws.Router("Router", {
			edge: {
				viewerRequest: {
					// Overwrites any client-sent value
					injection: $interpolate`event.request.headers["x-azuki-origin"] = { value: ${originSecret.value.apply((value) => JSON.stringify(value))} };`,
				},
			},
		});
		router.route("/api", api.url, { readTimeout: "60 seconds" });
		router.route("/results", api.url, { readTimeout: "60 seconds" });

		new sst.aws.StaticSite("Web", {
			path: "frontend/dist",
			router: { instance: router },
		});

		return {
			url: router.url,
			api: api.url,
			dataRefreshRoleArn: dataRefreshRole.arn,
		};
	},
});
