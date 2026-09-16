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
          'Speak an in-character line for an actor (e.g. ambient NPC dialogue/banter). By default ' +
          "this ONLY shows a floating speech bubble over the actor's token on the current scene - " +
          'nothing is written to the chat log. Pass chatLog: true to also (or instead) post a real ' +
          'chat message. If a language is given and the Polyglot module is active, a chat-log message ' +
          "is tagged so Polyglot scrambles it for viewers who don't know that language; bubble-only " +
          'lines just note the language as plain text since Polyglot has no message to hook into.',
        inputSchema: {
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
          },
          required: ['actorIdentifier', 'content'],
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
      {
        name: 'play-banter-script',
        description:
          'Post a pre-authored sequence of in-character chat lines with real timing between them, ' +
          'for a choreographed bit a single ambient-banter beat is too slow or too coarse for ' +
          '(e.g. a setup line followed by several NPCs shouting a punchline back in near-unison). ' +
          "Lines post in order; each entry's delayMs is how long to wait before THAT line posts " +
          '(a lead-in pause, not a trailing one) — use 0 or omit for lines that should land together. ' +
          'Each line resolves and posts exactly like create-chat-message.',
        inputSchema: {
          type: 'object',
          properties: {
            lines: {
              type: 'array',
              minItems: 1,
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
                },
                required: ['actorIdentifier', 'content'],
              },
            },
          },
          required: ['lines'],
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
    const schema = z.object({
      actorIdentifier: z.string(),
      content: z.string(),
      language: z.string().optional(),
      chatLog: z.boolean().optional(),
    });

    const { actorIdentifier, content, language, chatLog } = schema.parse(args);

    this.logger.info('Creating chat message', { actorIdentifier, language, chatLog });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.createChatMessage', {
        actorIdentifier,
        content,
        language,
        chatLog,
      });

      this.logger.debug('Chat message created', { result });

      return result;
    } catch (error) {
      this.logger.error('Failed to create chat message', error);
      throw new Error(
        `Failed to create chat message: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handlePlayBanterScript(args: any): Promise<any> {
    const lineSchema = z.object({
      actorIdentifier: z.string(),
      content: z.string(),
      language: z.string().optional(),
      delayMs: z.number().nonnegative().optional(),
      chatLog: z.boolean().optional(),
    });

    const { lines } = z.object({ lines: z.array(lineSchema).min(1) }).parse(args);

    this.logger.info('Playing banter script', { lineCount: lines.length });

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
        });

        results.push(result);
      } catch (error) {
        this.logger.error('Failed to post banter script line', { line, error });
        throw new Error(
          `Failed to post banter script line for "${line.actorIdentifier}": ` +
            `${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    this.logger.debug('Banter script complete', { posted: results.length });

    return { posted: results.length, results };
  }
}
