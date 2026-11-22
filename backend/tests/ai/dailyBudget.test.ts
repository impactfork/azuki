import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
	DynamoDBClient: vi.fn(() => ({ send })),
	GetItemCommand: vi.fn((input) => ({ kind: "get", input })),
	UpdateItemCommand: vi.fn((input) => ({ kind: "update", input })),
}));

const {
	dayKey,
	isDailyBudgetExhausted,
	recordTokenUsage,
	resetDailyBudgetCache,
} = await import("../../src/ai/dailyBudget.js");

beforeEach(() => {
	send.mockReset();
	resetDailyBudgetCache();
	process.env.LLM_BUDGET_TABLE = "budget";
	process.env.LLM_DAILY_TOKEN_LIMIT = "1000";
});

afterEach(() => {
	Reflect.deleteProperty(process.env, "LLM_BUDGET_TABLE");
	Reflect.deleteProperty(process.env, "LLM_DAILY_TOKEN_LIMIT");
});

describe("dailyBudget", () => {
	test("day key is the UTC date", () => {
		expect(dayKey(new Date("2026-11-22T23:30:00Z"))).toBe("2026-11-22");
	});

	test("inactive without table or limit", async () => {
		Reflect.deleteProperty(process.env, "LLM_BUDGET_TABLE");
		expect(await isDailyBudgetExhausted()).toBe(false);
		await recordTokenUsage(500);
		expect(send).not.toHaveBeenCalled();
	});

	test("below the limit allows calls", async () => {
		send.mockResolvedValueOnce({ Item: { tokens: { N: "999" } } });
		expect(await isDailyBudgetExhausted()).toBe(false);
	});

	test("at the limit blocks calls", async () => {
		send.mockResolvedValueOnce({ Item: { tokens: { N: "1000" } } });
		expect(await isDailyBudgetExhausted()).toBe(true);
	});

	test("recorded usage updates the cached total", async () => {
		send.mockResolvedValueOnce({ Item: { tokens: { N: "900" } } });
		expect(await isDailyBudgetExhausted()).toBe(false);
		send.mockResolvedValueOnce({});
		await recordTokenUsage(150);
		expect(await isDailyBudgetExhausted()).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
		const update = send.mock.calls[1][0];
		expect(update.input.ExpressionAttributeValues[":tokens"]).toEqual({
			N: "150",
		});
	});

	test("DynamoDB errors fail open", async () => {
		send.mockRejectedValueOnce(new Error("down"));
		expect(await isDailyBudgetExhausted()).toBe(false);
	});
});
