import {
	DynamoDBClient,
	GetItemCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

/**
 * Daily token budget for LLM calls.
 *
 * On OpenRouter, AzuKi relied on a spend cap set on the API key. Bedrock has
 * no such cap, so this module enforces one: tokens (input + output) are
 * summed per UTC day in DynamoDB, and once LLM_DAILY_TOKEN_LIMIT is reached
 * the call sites take their existing no-LLM fallbacks until midnight UTC.
 *
 * Active only when both LLM_BUDGET_TABLE and LLM_DAILY_TOKEN_LIMIT are set.
 * Reads are cached briefly per instance, so concurrent instances can
 * overshoot the limit by a few calls; this is a cost brake, not billing.
 * DynamoDB errors fail open (logged), so an outage never blocks matching.
 */

const CACHE_MS = 30_000;
const RETENTION_DAYS = 90;

interface CachedUsage {
	day: string;
	tokens: number;
	fetchedAt: number;
}

let cache: CachedUsage | null = null;
let client: DynamoDBClient | null = null;

function getClient(): DynamoDBClient {
	client ??= new DynamoDBClient({});
	return client;
}

function getConfig(): { table: string; limit: number } | null {
	const table = process.env.LLM_BUDGET_TABLE?.trim();
	const limit = Number(process.env.LLM_DAILY_TOKEN_LIMIT);
	if (!table || !Number.isFinite(limit) || limit <= 0) {
		return null;
	}
	return { table, limit };
}

/** UTC day key, e.g. "2026-11-22". Exported for tests. */
export function dayKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** Resets the per-instance cache. Exported for tests. */
export function resetDailyBudgetCache(): void {
	cache = null;
}

async function currentUsage(table: string, day: string): Promise<number> {
	if (cache && cache.day === day && Date.now() - cache.fetchedAt < CACHE_MS) {
		return cache.tokens;
	}
	const result = await getClient().send(
		new GetItemCommand({ TableName: table, Key: { day: { S: day } } }),
	);
	const tokens = Number(result.Item?.tokens?.N ?? 0);
	cache = { day, tokens, fetchedAt: Date.now() };
	return tokens;
}

export async function isDailyBudgetExhausted(): Promise<boolean> {
	const config = getConfig();
	if (!config) {
		return false;
	}
	try {
		const used = await currentUsage(config.table, dayKey());
		if (used >= config.limit) {
			console.warn(
				`Daily LLM token budget exhausted (${used} / ${config.limit})`,
			);
			return true;
		}
		return false;
	} catch (err) {
		console.error("Daily budget check failed, allowing call:", err);
		return false;
	}
}

export async function recordTokenUsage(tokens: number): Promise<void> {
	const config = getConfig();
	if (!config || !Number.isFinite(tokens) || tokens <= 0) {
		return;
	}
	const day = dayKey();
	const expiresAt = Math.floor(Date.now() / 1000) + RETENTION_DAYS * 86_400;
	try {
		await getClient().send(
			new UpdateItemCommand({
				TableName: config.table,
				Key: { day: { S: day } },
				UpdateExpression:
					"ADD tokens :tokens, calls :one SET expiresAt = if_not_exists(expiresAt, :expiresAt)",
				ExpressionAttributeValues: {
					":tokens": { N: String(Math.round(tokens)) },
					":one": { N: "1" },
					":expiresAt": { N: String(expiresAt) },
				},
			}),
		);
		if (cache && cache.day === day) {
			cache.tokens += tokens;
		}
	} catch (err) {
		console.error("Recording LLM token usage failed:", err);
	}
}
