import { afterEach, describe, expect, test } from "vitest";
import {
	DEFAULT_BEDROCK_MODEL_ID,
	getBedrockModelId,
	getLlmProvider,
	isLlmConfigured,
	stripCodeFence,
	toBedrockMessages,
} from "../../src/ai/llm.js";

const ENV_KEYS = ["LLM_PROVIDER", "OPENROUTER_API_KEY", "BEDROCK_MODEL_ID"];
const saved = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			Reflect.deleteProperty(process.env, key);
		} else {
			process.env[key] = saved[key];
		}
	}
});

describe("provider selection", () => {
	test("defaults to openrouter", () => {
		delete process.env.LLM_PROVIDER;
		expect(getLlmProvider()).toBe("openrouter");
	});

	test("selects bedrock case-insensitively", () => {
		process.env.LLM_PROVIDER = " Bedrock ";
		expect(getLlmProvider()).toBe("bedrock");
	});

	test("unknown values fall back to openrouter", () => {
		process.env.LLM_PROVIDER = "something-else";
		expect(getLlmProvider()).toBe("openrouter");
	});

	test("openrouter is configured only with an API key", () => {
		delete process.env.LLM_PROVIDER;
		delete process.env.OPENROUTER_API_KEY;
		expect(isLlmConfigured()).toBe(false);
		process.env.OPENROUTER_API_KEY = "test-key";
		expect(isLlmConfigured()).toBe(true);
	});

	test("bedrock needs no API key", () => {
		process.env.LLM_PROVIDER = "bedrock";
		delete process.env.OPENROUTER_API_KEY;
		expect(isLlmConfigured()).toBe(true);
	});

	test("bedrock model id defaults to the EU Sonnet profile", () => {
		delete process.env.BEDROCK_MODEL_ID;
		expect(getBedrockModelId()).toBe(DEFAULT_BEDROCK_MODEL_ID);
		expect(DEFAULT_BEDROCK_MODEL_ID.startsWith("eu.")).toBe(true);
		process.env.BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-5-5";
		expect(getBedrockModelId()).toBe("eu.anthropic.claude-haiku-5-5");
	});
});

describe("toBedrockMessages", () => {
	test("moves system messages into system blocks", () => {
		const result = toBedrockMessages(
			[
				{ role: "system", content: "Du bist AzuKi." },
				{ role: "user", content: "Hallo" },
			],
			false,
		);
		expect(result.system).toEqual([{ text: "Du bist AzuKi." }]);
		expect(result.messages).toEqual([
			{ role: "user", content: [{ text: "Hallo" }] },
		]);
	});

	test("adds a JSON instruction when json is requested", () => {
		const result = toBedrockMessages(
			[
				{ role: "system", content: "Prompt" },
				{ role: "user", content: "Frage" },
			],
			true,
		);
		expect(result.system).toHaveLength(2);
		expect(result.system[1].text).toContain("JSON");
	});
});

describe("stripCodeFence", () => {
	test("unwraps fenced JSON", () => {
		expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
	});

	test("leaves plain content untouched", () => {
		expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
		expect(stripCodeFence("Text mit ``` mittendrin")).toBe(
			"Text mit ``` mittendrin",
		);
	});
});
