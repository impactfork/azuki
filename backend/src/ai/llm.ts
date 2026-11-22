import {
	BedrockRuntimeClient,
	ConverseCommand,
	type Message,
	type SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";

/**
 * Provider-neutral chat completion.
 *
 * AzuKi was built against OpenRouter (OpenAI-compatible API). This module
 * keeps that path as the default and adds Amazon Bedrock as an alternative,
 * selected via LLM_PROVIDER. Call sites only see chatCompletion(), so the
 * prompts, parsing and fallbacks stay identical for both providers.
 *
 * Environment:
 * - LLM_PROVIDER: "openrouter" (default) | "bedrock"
 * - OPENROUTER_API_KEY: required for openrouter
 * - BEDROCK_MODEL_ID: Bedrock model or inference profile id, default
 *   "eu.anthropic.claude-sonnet-5-5" (EU cross-region profile, data stays in
 *   EU regions). Credentials come from the default AWS chain (IAM role on
 *   Lambda, AWS_PROFILE locally).
 * - BEDROCK_REGION: default AWS_REGION, then "eu-central-1"
 */

export type LlmProvider = "openrouter" | "bedrock";

export const DEFAULT_BEDROCK_MODEL_ID = "eu.anthropic.claude-sonnet-5-5";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatRequest {
	/** OpenRouter model id. Ignored by Bedrock, which uses BEDROCK_MODEL_ID. */
	model: string;
	messages: ChatMessage[];
	/** Used by OpenRouter only; Claude 5.5 on Bedrock rejects it. */
	temperature?: number;
	maxTokens?: number;
	/** Ask for a JSON object response. */
	json?: boolean;
}

export interface ChatResponse {
	content: string;
	id: string;
	provider: LlmProvider;
	model: string;
	tokensInput?: number;
	tokensOutput?: number;
}

/** Bedrock requires max_tokens; OpenRouter falls back to the model limit. */
const BEDROCK_DEFAULT_MAX_TOKENS = 4096;

const JSON_INSTRUCTION =
	"Antworte ausschließlich mit einem gültigen JSON-Objekt. Kein Markdown, keine Code-Fences, kein Text davor oder danach.";

export function getLlmProvider(): LlmProvider {
	const value = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
	return value === "bedrock" ? "bedrock" : "openrouter";
}

export function getBedrockModelId(): string {
	return process.env.BEDROCK_MODEL_ID?.trim() || DEFAULT_BEDROCK_MODEL_ID;
}

/**
 * Whether LLM calls can be attempted. For Bedrock, credentials are resolved
 * lazily by the AWS SDK, so configuration errors surface on the first call
 * and are handled by the existing fallbacks at the call sites.
 */
export function isLlmConfigured(): boolean {
	if (getLlmProvider() === "bedrock") {
		return true;
	}
	return Boolean(process.env.OPENROUTER_API_KEY);
}

let _openRouter: OpenAI | null = null;
function getOpenRouter(): OpenAI {
	if (!_openRouter) {
		_openRouter = new OpenAI({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: process.env.OPENROUTER_API_KEY,
		});
	}
	return _openRouter;
}

let _bedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
	if (!_bedrock) {
		_bedrock = new BedrockRuntimeClient({
			region:
				process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "eu-central-1",
		});
	}
	return _bedrock;
}

export async function chatCompletion(
	request: ChatRequest,
): Promise<ChatResponse> {
	return getLlmProvider() === "bedrock"
		? bedrockCompletion(request)
		: openRouterCompletion(request);
}

async function openRouterCompletion(
	request: ChatRequest,
): Promise<ChatResponse> {
	const response = await getOpenRouter().chat.completions.create({
		model: request.model,
		messages: request.messages,
		temperature: request.temperature,
		...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
		...(request.json && {
			response_format: { type: "json_object" as const },
		}),
	});
	return {
		content: response.choices?.[0]?.message?.content ?? "",
		id: response.id,
		provider: "openrouter",
		model: response.model ?? request.model,
		tokensInput: response.usage?.prompt_tokens,
		tokensOutput: response.usage?.completion_tokens,
	};
}

/**
 * Splits OpenAI-style messages into Bedrock's system blocks and
 * conversation turns. Exported for tests.
 */
export function toBedrockMessages(
	messages: ChatMessage[],
	json: boolean,
): { system: SystemContentBlock[]; messages: Message[] } {
	const systemTexts = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content);
	if (json) {
		systemTexts.push(JSON_INSTRUCTION);
	}
	return {
		system: systemTexts.map((text) => ({ text })),
		messages: messages
			.filter((message) => message.role !== "system")
			.map((message) => ({
				role: message.role as "user" | "assistant",
				content: [{ text: message.content }],
			})),
	};
}

/**
 * Removes a Markdown code fence around a JSON answer. Bedrock has no
 * response_format, and models occasionally wrap JSON in ```json fences.
 * Exported for tests.
 */
export function stripCodeFence(content: string): string {
	const match = content.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	return match ? match[1].trim() : content;
}

async function bedrockCompletion(request: ChatRequest): Promise<ChatResponse> {
	const modelId = getBedrockModelId();
	const { system, messages } = toBedrockMessages(
		request.messages,
		Boolean(request.json),
	);
	const response = await getBedrock().send(
		new ConverseCommand({
			modelId,
			system,
			messages,
			// No temperature: Claude 5.5 models on Bedrock reject it as
			// deprecated ("`temperature` is deprecated for this model").
			inferenceConfig: {
				maxTokens: request.maxTokens ?? BEDROCK_DEFAULT_MAX_TOKENS,
			},
		}),
	);
	const text = (response.output?.message?.content ?? [])
		.map((block) => block.text ?? "")
		.join("");
	return {
		content: request.json ? stripCodeFence(text) : text,
		id: response.$metadata.requestId ?? "",
		provider: "bedrock",
		model: modelId,
		tokensInput: response.usage?.inputTokens,
		tokensOutput: response.usage?.outputTokens,
	};
}
