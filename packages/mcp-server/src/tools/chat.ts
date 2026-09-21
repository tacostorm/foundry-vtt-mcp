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
  // Highest /banter note counter seen so far. Lets a batch of already-queued lines all be
  // skipped without waiting once any one of them discovers a newer note.
  private latestDirectiveSeq = -1;

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
            requires: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional. Names or IDs of the ambient-banter participants this line depends on ' +
                '(the speaker and everyone in the same conversation). If any of them is no longer an ' +
                'enabled roster member when the line is due, the line is skipped instead of posted.',
            },
            expectDirectiveSeq: {
              type: 'number',
              description:
                'Optional. The `directiveSeq` from get-ambient-banter-state that this line was written ' +
                'under. If a newer /banter note has arrived since, the line (and any later line carrying ' +
                'the same or an older value) is skipped without waiting.',
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
                  requires: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Optional. Participants this line depends on; skipped if any has left the roster.',
                  },
                  expectDirectiveSeq: {
                    type: 'number',
                    description:
                      'Optional. Skipped if a newer /banter note than this directiveSeq has arrived.',
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
          'in the order they were given, a directiveSeq counter that increases with every note, and ' +
          'the recent rolling transcript. Call this at the start of each beat to decide what happens ' +
          'next.',
        inputSchema: {
          type: 'object',
          properties: {
            positions: {
              type: 'boolean',
              description:
                'Also return the scene grid and, for each enabled participant with a token, their ' +
                'current position and their distance in grid squares to every other participant. A ' +
                'snapshot: request it again as often as the scene needs (every block when NPCs are ' +
                'moving, rarely when everyone is stationary). Omitted by default.',
            },
            transcriptLimit: {
              type: 'number',
              description:
                'How many of the most recent transcript lines to return. Defaults to all (up to 40); ' +
                'pass 0 for a cheap poll that only needs the roster, notes and directiveSeq.',
            },
          },
        },
      },
    ];
  }

  async handleGetAmbientBanterState(args: any = {}): Promise<any> {
    this.logger.info('Getting ambient banter state');

    const { transcriptLimit, positions } = z
      .object({
        transcriptLimit: z.number().int().nonnegative().optional(),
        positions: z.boolean().optional(),
      })
      .parse(args ?? {});

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.getAmbientBanterState', {
        ...(transcriptLimit !== undefined ? { transcriptLimit } : {}),
        ...(positions ? { positions } : {}),
      });
      this.rememberDirectiveSeq(result);
      this.logger.debug('Ambient banter state retrieved', { result });
      return result;
    } catch (error) {
      this.logger.error('Failed to get ambient banter state', error);
      throw new Error(
        `Failed to get ambient banter state: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private rememberDirectiveSeq(state: any): void {
    const seq = state?.directiveSeq;
    if (typeof seq === 'number' && seq > this.latestDirectiveSeq) {
      this.latestDirectiveSeq = seq;
    }
  }

  /** A required participant matches an enabled roster entry by ID or by (partial) name. */
  private findMissingParticipant(state: any, identifiers: string[]): string | undefined {
    const enabled: Array<{ actorId?: string; name?: string }> = (state?.participants ?? []).filter(
      (p: any) => p?.enabled
    );
    return identifiers.find(id => {
      const wanted = id.toLowerCase();
      return !enabled.some(p => p.actorId === id || (p.name ?? '').toLowerCase().includes(wanted));
    });
  }

  async handleCreateChatMessage(args: any): Promise<any> {
    const lineSchema = z.object({
      actorIdentifier: z.string(),
      content: z.string(),
      language: z.string().optional(),
      chatLog: z.boolean().optional(),
      delayMs: z.number().nonnegative().optional(),
      bubbleDurationMs: z.number().positive().optional(),
      requires: z.array(z.string()).optional(),
      expectDirectiveSeq: z.number().int().optional(),
    });

    const schema = z.union([z.object({ lines: z.array(lineSchema).min(1) }), lineSchema]);

    const parsed = schema.parse(args);
    const lines = 'lines' in parsed ? parsed.lines : [parsed];
    const isScript = 'lines' in parsed;

    this.logger.info('Creating chat message', { lineCount: lines.length, isScript });

    const results: any[] = [];

    for (const line of lines) {
      const skipped = (reason: string) => ({
        success: false,
        skipped: true,
        reason,
        speaker: line.actorIdentifier,
      });

      // A newer /banter note than this line was written under: skip without waiting.
      if (
        line.expectDirectiveSeq !== undefined &&
        line.expectDirectiveSeq < this.latestDirectiveSeq
      ) {
        results.push(skipped('superseded by a newer /banter note'));
        continue;
      }

      if (line.delayMs) {
        await new Promise(resolve => setTimeout(resolve, line.delayMs));
      }

      // Re-check the roster and note counter AFTER the wait, so the line's slot in the
      // schedule is preserved (other threads keep their spacing) but a stale line never fires.
      if (line.requires?.length || line.expectDirectiveSeq !== undefined) {
        const state = await this.foundryClient.query('foundry-mcp-bridge.getAmbientBanterState', {
          transcriptLimit: 0,
        });
        this.rememberDirectiveSeq(state);

        if (
          line.expectDirectiveSeq !== undefined &&
          line.expectDirectiveSeq < this.latestDirectiveSeq
        ) {
          results.push(skipped('superseded by a newer /banter note'));
          continue;
        }
        if (line.requires?.length) {
          const missing = this.findMissingParticipant(state, [
            line.actorIdentifier,
            ...line.requires,
          ]);
          if (missing) {
            results.push(skipped(`${missing} is no longer in the roster`));
            continue;
          }
        }
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

    this.logger.debug('Chat message(s) created', { count: results.length });

    if (!isScript) return results[0];
    const skippedCount = results.filter(r => r?.skipped).length;
    return {
      posted: results.length - skippedCount,
      ...(skippedCount ? { skipped: skippedCount } : {}),
      results,
    };
  }
}
