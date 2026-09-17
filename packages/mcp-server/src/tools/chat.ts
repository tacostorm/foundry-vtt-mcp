import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface ChatToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class ChatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: ChatToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ChatTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-chat-message',
        description:
          'Speak an in-character line for an actor (e.g. ambient NPC dialogue/banter), or pass ' +
          '`lines` instead of the single-line fields to post a pre-authored sequence with real ' +
          "timing between entries - for a choreographed bit a single line can't pull off (e.g. a " +
          'setup line followed by several NPCs shouting a punchline back in near-unison). Each ' +
          "entry's delayMs is how long to wait before THAT line posts (a lead-in pause, not a " +
          'trailing one) — use 0 or omit for lines that should land together. ' +
          "By default a line ONLY shows a floating speech bubble over the actor's token on the " +
          'current scene - nothing is written to the chat log. Pass chatLog: true (per-line, or ' +
          'top-level for a single line) to post a real chat message instead. If a language is ' +
          'given and Polyglot is active, a chat-log message is tagged so Polyglot scrambles it for ' +
          "viewers who don't know that language; bubble-only lines just note the language as plain " +
          'text since Polyglot has no message to hook into.',
        inputSchema: {
          type: 'object',
          properties: {
            actorIdentifier: {
              type: 'string',
              description:
                'Name or ID of the actor speaking (resolves world actors and scene tokens). ' +
                'Required unless `lines` is given instead.',
            },
            content: {
              type: 'string',
              description:
                'The message text, in the language actually being spoken (not translated/bracketed). ' +
                'Required unless `lines` is given instead.',
            },
            language: {
              type: 'string',
              description:
                'Optional language key (matching the game system\'s language list, e.g. "osiriani", "necril") ' +
                'the line is spoken in. Omit for a message everyone understands regardless of language.',
            },
            chatLog: {
              type: 'boolean',
              description:
                'Post a real chat-log message (with its own auto-bubble) instead of the default ' +
                'bubble-only delivery. Defaults to false - requires the actor to have a placed ' +
                'token on the current scene when false.',
            },
            bubbleDurationMs: {
              type: 'number',
              description:
                'How long the bubble stays on screen, in milliseconds. Only meaningful for ' +
                'bubble-only delivery (ignored when chatLog is true). Defaults to 8000ms ' +
                "(matching the recommended gap between banter beats) regardless of the line's " +
                "word count, so a short punchline doesn't vanish before it registers - pass this " +
                "to go longer or shorter. Clamped to Foundry's own 1000-20000ms range either way.",
            },
            lines: {
              type: 'array',
              minItems: 1,
              description:
                'Alternative to the single-line fields above: a sequence of lines to post in ' +
                'order with real delays between them.',
              items: {
                type: 'object',
                properties: {
                  actorIdentifier: {
                    type: 'string',
                    description:
                      'Name or ID of the actor speaking (resolves world actors and scene tokens)',
                  },
                  content: {
                    type: 'string',
                    description:
                      'The message text, in the language actually being spoken (not translated/bracketed)',
                  },
                  language: {
                    type: 'string',
                    description:
                      'Optional language key (e.g. "osiriani", "necril") the line is spoken in. ' +
                      'Omit for a message everyone understands regardless of language.',
                  },
                  delayMs: {
                    type: 'number',
                    description:
                      'Milliseconds to wait before posting this line. Defaults to 0 (posts ' +
                      'immediately after the previous line resolves).',
                  },
                  chatLog: {
                    type: 'boolean',
                    description:
                      'Post this line as a real chat-log message instead of the default ' +
                      'bubble-only delivery. Defaults to false.',
                  },
                  bubbleDurationMs: {
                    type: 'number',
                    description:
                      "How long this line's bubble stays on screen, in milliseconds (ignored " +
                      'when chatLog is true). Defaults to 8000ms regardless of word count. ' +
                      "Clamped to Foundry's own 1000-20000ms range either way.",
                  },
                },
                required: ['actorIdentifier', 'content'],
              },
            },
          },
        },
      },
      {
        name: 'get-ambient-banter-state',
        description:
          "Read the current scene's ambient-banter state for the background-NPC-conversation " +
          "feature: which actors are enabled participants, the raw /banter director's-note log " +
          'in the order they were given, and the recent rolling transcript. Call this at the start ' +
          'of each beat to decide what happens next.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleGetAmbientBanterState(): Promise<any> {
    this.logger.info('Getting ambient banter state');

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.getAmbientBanterState', {});
      this.logger.debug('Ambient banter state retrieved', { result });
      return result;
    } catch (error) {
      this.logger.error('Failed to get ambient banter state', error);
      throw new Error(
        `Failed to get ambient banter state: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleCreateChatMessage(args: any): Promise<any> {
    const lineSchema = z.object({
      actorIdentifier: z.string(),
      content: z.string(),
      language: z.string().optional(),
      chatLog: z.boolean().optional(),
      delayMs: z.number().nonnegative().optional(),
      bubbleDurationMs: z.number().positive().optional(),
    });

    const schema = z.union([z.object({ lines: z.array(lineSchema).min(1) }), lineSchema]);

    const parsed = schema.parse(args);
    const lines = 'lines' in parsed ? parsed.lines : [parsed];
    const isScript = 'lines' in parsed;

    this.logger.info('Creating chat message', { lineCount: lines.length, isScript });

    const results: any[] = [];

    for (const line of lines) {
      if (line.delayMs) {
        await new Promise(resolve => setTimeout(resolve, line.delayMs));
      }

      try {
        const result = await this.foundryClient.query('foundry-mcp-bridge.createChatMessage', {
          actorIdentifier: line.actorIdentifier,
          content: line.content,
          language: line.language,
          chatLog: line.chatLog,
          bubbleDurationMs: line.bubbleDurationMs,
        });

        results.push(result);
      } catch (error) {
        this.logger.error('Failed to create chat message', { line, error });
        throw new Error(
          `Failed to create chat message for "${line.actorIdentifier}": ` +
            `${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    this.logger.debug('Chat message(s) created', { posted: results.length });

    return isScript ? { posted: results.length, results } : results[0];
  }
}
