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
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
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
  proxyBaseUrl?: string;  // when set, routes calls through backend to bypass CORS
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
  system: Array<{ text: string }>;
  messages: any[];
} {
  const system: Array<{ text: string }> = [];
  const out: any[] = [];

  for (const msg of messages) {
    const type = msg._getType();

    if (type === 'system') {
      system.push({ text: String(msg.content) });
      continue;
    }

    if (type === 'human') {
      const textBlock = { text: String(msg.content) };
      const last = out[out.length - 1];
      if (last?.role === 'user') {
        // Merge into the previous user turn — Bedrock requires strictly alternating roles.
        // Consecutive user messages occur when a prior turn failed before producing an assistant reply.
        last.content.push(textBlock);
      } else {
        out.push({ role: 'user', content: [textBlock] });
      }
      continue;
    }

    if (type === 'ai') {
      const ai = msg as AIMessage;
      const content: any[] = [];

      // Text part
      if (ai.content && typeof ai.content === 'string' && ai.content.trim()) {
        content.push({ text: ai.content });
      }

      // Tool calls → nested toolUse blocks (Converse API format)
      for (const tc of ai.tool_calls ?? []) {
        content.push({
          toolUse: {
            toolUseId: tc.id,
            name: tc.name,
            input: tc.args,
          },
        });
      }

      if (content.length > 0) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }

    if (type === 'tool') {
      const tm = msg as ToolMessage;
      // Bedrock expects tool results as a user message with nested toolResult blocks
      const last = out[out.length - 1];
      const resultBlock = {
        toolResult: {
          toolUseId: tm.tool_call_id,
          content: [{ text: String(tm.content) }],
        },
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
    // Converse API uses nested format: { text: '...' } or { toolUse: { ... } }
    if (block.text) text += block.text;
    if (block.toolUse) {
      tool_calls.push({
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        args: block.toolUse.input,
        type: 'tool_call' as const,
      });
    }
  }

  return new AIMessage({ content: text, tool_calls });
}

// ─── AWS Event Stream parser (binary) ────────────────────────────────────────
// Binary framing: [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]
// Extracts :event-type from binary headers and wraps the JSON payload:
//   {"contentBlockDelta": { "delta": {"text":"..."}, "contentBlockIndex": 0 }}
// Used for direct Bedrock calls (no proxy).

function parseEventStreamHeaders(buf: Uint8Array, start: number, end: number): Record<string, string> {
  const headers: Record<string, string> = {};
  const decoder = new TextDecoder();
  let offset = start;
  while (offset < end) {
    const nameLen = buf[offset]; offset += 1;
    const name = decoder.decode(buf.slice(offset, offset + nameLen)); offset += nameLen;
    const valueType = buf[offset]; offset += 1;
    if (valueType === 7) { // string
      const valLen = (buf[offset] << 8) | buf[offset + 1]; offset += 2;
      headers[name] = decoder.decode(buf.slice(offset, offset + valLen)); offset += valLen;
    } else if (valueType === 6) { // bytes
      const valLen = (buf[offset] << 8) | buf[offset + 1]; offset += 2;
      offset += valLen;
    } else if (valueType === 0 || valueType === 1) { // bool
      // no value bytes
    } else if (valueType === 2) { offset += 1;  // byte
    } else if (valueType === 3) { offset += 2;  // short
    } else if (valueType === 4) { offset += 4;  // int
    } else if (valueType === 5 || valueType === 8) { offset += 8; // long / timestamp
    } else {
      break; // unknown type
    }
  }
  return headers;
}

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

        // Extract event type from binary headers
        const headers = parseEventStreamHeaders(buf, 12, 12 + headersLen);
        const eventType = headers[':event-type'] || '';

        if (payloadLen > 0) {
          const payload = buf.slice(payloadStart, payloadStart + payloadLen);
          try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            // Wrap with event type to match SDK format
            yield eventType ? { [eventType]: data } : data;
          } catch { /* skip malformed frame */ }
        }

        buf = buf.slice(totalLen);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── NDJSON parser ───────────────────────────────────────────────────────────
// Used when going through the proxy (which converts binary event stream → NDJSON).

async function* parseNDJSON(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, any>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            // Handle error frames forwarded by the proxy server
            if (parsed.__error) {
              throw new Error(`Bedrock: ${parsed.__error.message || parsed.__error.type || 'stream error'}`);
            }
            yield parsed;
          } catch (e) {
            // Re-throw Bedrock errors, skip malformed JSON
            if (e instanceof Error && e.message.startsWith('Bedrock:')) throw e;
          }
        }
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.__error) {
          throw new Error(`Bedrock: ${parsed.__error.message || parsed.__error.type || 'stream error'}`);
        }
        yield parsed;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Bedrock:')) throw e;
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
  private credentials: BedrockCredentials;
  private proxyBaseUrl?: string;
  readonly streaming: boolean;

  constructor(params: ChatBedrockBrowserParams) {
    super({});
    this.credentials = params.credentials;
    this.proxyBaseUrl = params.proxyBaseUrl;
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

  bindTools(tools: StructuredToolInterface[]) {
    return this.withConfig({ tools: toBedrockTools(tools) } as any);
  }

  private buildBody(messages: BaseMessage[], tools?: BedrockTool[]): string {
    const { system, messages: bedrockMessages } = toBedrockMessages(messages);
    const body: any = {
      messages: bedrockMessages,
      inferenceConfig: {
        temperature: this.temperature,
        ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
      },
    };
    if (system.length > 0) body.system = system;
    if (tools && tools.length > 0) {
      body.toolConfig = { tools };
    }
    return JSON.stringify(body);
  }

  private async proxyFetch(endpoint: 'converse' | 'converse-stream', bodyJson: string): Promise<Response> {
    // Timeout for getting initial response headers (not the stream body)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000); // 3 minutes
    try {
      const resp = await fetch(`${this.proxyBaseUrl}/api/bedrock/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          region: this.region,
          credentials: this.credentials,
          model: this.modelId,
          body: JSON.parse(bodyJson),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return resp;
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Bedrock proxy request timed out');
      throw err;
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const tools = (options as any).tools as BedrockTool[] | undefined;
    const bodyJson = this.buildBody(messages, tools);
    let resp: Response;

    if (this.proxyBaseUrl) {
      resp = await this.proxyFetch('converse', bodyJson);
    } else {
      const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse`;
      resp = await this.aws.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
      });
    }

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
    options: BaseChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const tools = (options as any).tools as BedrockTool[] | undefined;
    const bodyJson = this.buildBody(messages, tools);
    let resp: Response;

    if (this.proxyBaseUrl) {
      resp = await this.proxyFetch('converse-stream', bodyJson);
    } else {
      const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse-stream`;
      resp = await this.aws.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
      });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Bedrock error ${resp.status}: ${err}`);
    }

    if (!resp.body) throw new Error('Bedrock: no response body');

    // Accumulate tool use inputs per content block index
    const toolAccumulator: Record<number, { id: string; name: string; input: string }> = {};

    // Proxy returns NDJSON (text), direct calls return AWS Event Stream (binary)
    const eventSource = this.proxyBaseUrl ? parseNDJSON(resp.body) : parseEventStream(resp.body);

    for await (const event of eventSource) {
      if (event.contentBlockDelta?.delta?.text) {
        const text: string = event.contentBlockDelta.delta.text;
        await runManager?.handleLLMNewToken(text);
        yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });

      } else if (event.contentBlockStart?.start?.toolUse) {
        const { contentBlockIndex } = event.contentBlockStart;
        const { toolUseId, name } = event.contentBlockStart.start.toolUse;
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
          // Use tool_call_chunks (not tool_calls) so AIMessageChunk.concat() preserves them.
          // tool_call_chunks use string args; the constructor converts to parsed tool_calls.
          const tool_call_chunks = [{
            id: acc.id,
            name: acc.name,
            args: acc.input,
            index: idx,
            type: 'tool_call_chunk' as const,
          }];
          const toolChunk = new ChatGenerationChunk({
            text: '',
            message: new AIMessageChunk({ content: '', tool_call_chunks }),
          });
          await runManager?.handleLLMNewToken('', undefined, undefined, undefined, undefined, { chunk: toolChunk });
          yield toolChunk;
          delete toolAccumulator[idx];
        }

      } else if (
        event.internalServerException ||
        event.modelStreamErrorException ||
        event.validationException ||
        event.throttlingException ||
        event.serviceUnavailableException ||
        event.modelNotReadyException
      ) {
        // In-band Bedrock error — surface as a real error so the caller sees the message
        // instead of silently swallowing it and causing "Received empty response" from LangChain.
        const msg =
          event.internalServerException?.message ||
          event.modelStreamErrorException?.message ||
          event.validationException?.message ||
          event.throttlingException?.message ||
          event.serviceUnavailableException?.message ||
          event.modelNotReadyException?.message ||
          'Bedrock stream error';
        throw new Error(`Bedrock: ${msg}`);
      }
    }
  }
}
