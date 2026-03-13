/**
 * Browser-native AWS Bedrock Chat Model
 *
 * Uses aws4fetch for SigV4 request signing (no Node.js deps) and calls
 * the Bedrock Converse / Converse-Stream API directly via fetch.
 *
 * Supports:
 * - Streaming (AWS Event Stream binary format parsed inline)
 * - Tool calls (Bedrock Converse API toolUse/toolResult format)
 * - All Bedrock models that implement the Converse API
 */

import { AwsClient } from 'aws4fetch';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import {
  BaseMessage,
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { ChatResult, ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ─── Types ─────────────────────────────────────────────────────────────────

interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface ChatBedrockBrowserParams {
  region: string;
  credentials: BedrockCredentials;
  model: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
}

interface BedrockTool {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: object };
  };
}

// ─── Message format conversion ──────────────────────────────────────────────

function toBedrockMessages(messages: BaseMessage[]): {
  system: Array<{ type: 'text'; text: string }>;
  messages: any[];
} {
  const system: Array<{ type: 'text'; text: string }> = [];
  const out: any[] = [];

  for (const msg of messages) {
    const type = msg._getType();

    if (type === 'system') {
      system.push({ type: 'text', text: String(msg.content) });
      continue;
    }

    if (type === 'human') {
      out.push({ role: 'user', content: [{ type: 'text', text: String(msg.content) }] });
      continue;
    }

    if (type === 'ai') {
      const ai = msg as AIMessage;
      const content: any[] = [];

      // Text part
      if (ai.content && typeof ai.content === 'string' && ai.content.trim()) {
        content.push({ type: 'text', text: ai.content });
      }

      // Tool calls → toolUse blocks
      for (const tc of ai.tool_calls ?? []) {
        content.push({
          type: 'toolUse',
          toolUseId: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      if (content.length > 0) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }

    if (type === 'tool') {
      const tm = msg as ToolMessage;
      // Bedrock expects tool results as a user message with toolResult blocks
      const last = out[out.length - 1];
      const resultBlock = {
        type: 'toolResult',
        toolUseId: tm.tool_call_id,
        content: [{ type: 'text', text: String(tm.content) }],
      };
      if (last?.role === 'user') {
        last.content.push(resultBlock);
      } else {
        out.push({ role: 'user', content: [resultBlock] });
      }
    }
  }

  return { system, messages: out };
}

function toBedrockTools(tools: StructuredToolInterface[]): BedrockTool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: {
        json: t.schema instanceof z.ZodType
          ? zodToJsonSchema(t.schema, { $refStrategy: 'none' })
          : t.schema,
      },
    },
  }));
}

function fromBedrockMessage(msg: any): AIMessage {
  let text = '';
  const tool_calls: any[] = [];

  for (const block of msg.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'toolUse') {
      tool_calls.push({
        id: block.toolUseId,
        name: block.name,
        args: block.input,
        type: 'tool_call' as const,
      });
    }
  }

  return new AIMessage({ content: text, tool_calls });
}

// ─── AWS Event Stream parser ─────────────────────────────────────────────────
// Binary framing: [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]

async function* parseEventStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, any>> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;

      while (buf.length >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const totalLen = view.getUint32(0);
        if (buf.length < totalLen) break;

        const headersLen = view.getUint32(4);
        const payloadStart = 12 + headersLen;
        const payloadLen = totalLen - headersLen - 16; // prelude(12) + trailingCRC(4)

        if (payloadLen > 0) {
          const payload = buf.slice(payloadStart, payloadStart + payloadLen);
          try {
            yield JSON.parse(new TextDecoder().decode(payload));
          } catch { /* skip malformed frame */ }
        }

        buf = buf.slice(totalLen);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── ChatBedrockBrowser ──────────────────────────────────────────────────────

export class ChatBedrockBrowser extends BaseChatModel {
  private aws: AwsClient;
  private region: string;
  private modelId: string;
  private temperature: number;
  private maxTokens?: number;
  private boundTools?: BedrockTool[];
  readonly streaming: boolean;

  constructor(params: ChatBedrockBrowserParams) {
    super({});
    this.aws = new AwsClient({
      accessKeyId: params.credentials.accessKeyId,
      secretAccessKey: params.credentials.secretAccessKey,
      sessionToken: params.credentials.sessionToken,
      region: params.region,
      service: 'bedrock',
    });
    this.region = params.region;
    this.modelId = params.model;
    this.temperature = params.temperature ?? 0.1;
    this.maxTokens = params.maxTokens;
    this.streaming = params.streaming ?? true;
  }

  _llmType(): string {
    return 'bedrock';
  }

  bindTools(tools: StructuredToolInterface[]): this {
    const bound = Object.create(this) as this;
    (bound as any).boundTools = toBedrockTools(tools);
    return bound;
  }

  private buildBody(messages: BaseMessage[]): string {
    const { system, messages: bedrockMessages } = toBedrockMessages(messages);
    const body: any = {
      messages: bedrockMessages,
      inferenceConfig: {
        temperature: this.temperature,
        ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
      },
    };
    if (system.length > 0) body.system = system;
    if (this.boundTools && this.boundTools.length > 0) {
      body.toolConfig = { tools: this.boundTools };
    }
    return JSON.stringify(body);
  }

  async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse`;
    const resp = await this.aws.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: this.buildBody(messages),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Bedrock error ${resp.status}: ${err}`);
    }

    const data = (await resp.json()) as any;
    const message = fromBedrockMessage(data.output?.message ?? { content: [] });

    return {
      generations: [{ text: message.content as string, message }],
      llmOutput: { usage: data.usage },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse-stream`;
    const resp = await this.aws.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: this.buildBody(messages),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Bedrock error ${resp.status}: ${err}`);
    }

    if (!resp.body) throw new Error('Bedrock: no response body');

    // Accumulate tool use inputs per content block index
    const toolAccumulator: Record<number, { id: string; name: string; input: string }> = {};

    for await (const event of parseEventStream(resp.body)) {
      if (event.contentBlockDelta?.delta?.text) {
        const text: string = event.contentBlockDelta.delta.text;
        await runManager?.handleLLMNewToken(text);
        const { ChatGenerationChunk: CGC } = await import('@langchain/core/outputs');
        yield new CGC({ text, message: new AIMessageChunk(text) });

      } else if (event.contentBlockStart?.contentBlock?.type === 'tool_use') {
        const { contentBlockIndex } = event.contentBlockStart;
        const { toolUseId, name } = event.contentBlockStart.contentBlock;
        toolAccumulator[contentBlockIndex] = { id: toolUseId, name, input: '' };

      } else if (event.contentBlockDelta?.delta?.toolUse?.input != null) {
        const idx = event.contentBlockDelta.contentBlockIndex;
        if (toolAccumulator[idx]) {
          toolAccumulator[idx].input += event.contentBlockDelta.delta.toolUse.input;
        }

      } else if (event.contentBlockStop != null) {
        const idx = event.contentBlockStop.contentBlockIndex;
        const acc = toolAccumulator[idx];
        if (acc) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(acc.input); } catch { /* ignore */ }
          const tool_calls = [{ id: acc.id, name: acc.name, args, type: 'tool_call' as const }];
          const { ChatGenerationChunk: CGC } = await import('@langchain/core/outputs');
          yield new CGC({
            text: '',
            message: new AIMessageChunk({ content: '', tool_calls }),
          });
          delete toolAccumulator[idx];
        }
      }
    }
  }
}
