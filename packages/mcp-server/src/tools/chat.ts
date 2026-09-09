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
          'Post an in-character chat message spoken by an actor (e.g. ambient NPC dialogue/banter). ' +
          'If a language is given and the Polyglot module is active, the message is tagged so Polyglot ' +
          "scrambles it for viewers who don't know that language and shows it plainly to those who do. " +
          "If Polyglot is not active, the language is instead noted as plain text so the intent isn't lost.",
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
    });

    const { actorIdentifier, content, language } = schema.parse(args);

    this.logger.info('Creating chat message', { actorIdentifier, language });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.createChatMessage', {
        actorIdentifier,
        content,
        language,
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
}
