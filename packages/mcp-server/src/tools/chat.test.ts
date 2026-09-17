/**
 * Ambient-banter chat tools tests.
 *
 * The actual bubble/chat-log delivery, word-count duration math, and token
 * resolution run browser-side (data-access.ts, no test harness for that
 * package - covered by live testing instead). These cover the MCP tool
 * layer: schema shape, the single-line-vs-`lines` union, delayMs pacing,
 * and correct forwarding to the bridge query with defaults applied.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatTools } from './chat.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true, id: 'msg1' })));
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  const foundryClient: any = { query };
  const tools = new ChatTools({ foundryClient, logger });
  return { tools, query };
}

describe('create-chat-message tool definition', () => {
  it('advertises both the single-line fields and lines as alternatives', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'create-chat-message')!;
    const props = def.inputSchema.properties as Record<string, any>;
    expect(props.actorIdentifier).toBeDefined();
    expect(props.content).toBeDefined();
    expect(props.lines).toBeDefined();
    expect(props.lines.items.properties.delayMs).toBeDefined();
    expect(props.bubbleDurationMs).toBeDefined();
    expect(props.lines.items.properties.bubbleDurationMs).toBeDefined();
  });
});

describe('handleCreateChatMessage - single line', () => {
  it('forwards actorIdentifier/content/language/chatLog/bubbleDurationMs to the bridge query', async () => {
    const { tools, query } = makeTools();
    await tools.handleCreateChatMessage({
      actorIdentifier: 'Senu',
      content: 'No!',
      language: 'osiriani',
      chatLog: true,
      bubbleDurationMs: 5000,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.createChatMessage', {
      actorIdentifier: 'Senu',
      content: 'No!',
      language: 'osiriani',
      chatLog: true,
      bubbleDurationMs: 5000,
    });
  });

  it('returns the single result directly, not wrapped in a posted/results envelope', async () => {
    const { tools } = makeTools(async () => ({ success: true, delivery: 'bubble' }));
    const result = await tools.handleCreateChatMessage({
      actorIdentifier: 'Senu',
      content: 'No!',
    });
    expect(result).toEqual({ success: true, delivery: 'bubble' });
  });

  it('rejects a call with neither the single-line fields nor lines', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleCreateChatMessage({})).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('handleCreateChatMessage - lines script', () => {
  it('posts every line in order and returns a posted/results envelope', async () => {
    const { tools, query } = makeTools(async (_method, data: any) => ({
      success: true,
      speakerName: data.actorIdentifier,
    }));

    const result = await tools.handleCreateChatMessage({
      lines: [
        { actorIdentifier: 'Wenet', content: 'Another round?' },
        { actorIdentifier: 'Senu', content: 'No!' },
        { actorIdentifier: 'Tamit', content: 'No!' },
      ],
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(call => call[1].actorIdentifier)).toEqual([
      'Wenet',
      'Senu',
      'Tamit',
    ]);
    expect(result).toEqual({
      posted: 3,
      results: [
        { success: true, speakerName: 'Wenet' },
        { success: true, speakerName: 'Senu' },
        { success: true, speakerName: 'Tamit' },
      ],
    });
  });

  it('waits delayMs before posting each line', async () => {
    const order: Array<{ actor: string; at: number }> = [];
    const start = Date.now();

    const { tools } = makeTools(async (_method, data: any) => {
      order.push({ actor: data.actorIdentifier, at: Date.now() - start });
      return { success: true };
    });

    await tools.handleCreateChatMessage({
      lines: [
        { actorIdentifier: 'A', content: 'first', delayMs: 0 },
        { actorIdentifier: 'B', content: 'second', delayMs: 30 },
      ],
    });

    expect(order.map(o => o.actor)).toEqual(['A', 'B']);
    expect(order[1].at - order[0].at).toBeGreaterThanOrEqual(25);
  });

  it('rejects an empty lines array', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleCreateChatMessage({ lines: [] })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('stops at the first failing line and reports which actor failed', async () => {
    const { tools, query } = makeTools(async (_method, data: any) => {
      if (data.actorIdentifier === 'Sahreg') throw new Error('no token on scene');
      return { success: true };
    });

    await expect(
      tools.handleCreateChatMessage({
        lines: [
          { actorIdentifier: 'Wenet', content: 'ok' },
          { actorIdentifier: 'Sahreg', content: 'boom' },
          { actorIdentifier: 'Tamit', content: 'never reached' },
        ],
      })
    ).rejects.toThrow(/Sahreg/);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('handleGetAmbientBanterState', () => {
  it('forwards to the bridge query with no arguments and returns its result', async () => {
    const state = {
      sceneName: 'The Marrow Hearth',
      participants: [{ actorId: 'a1', name: 'Senu', enabled: true }],
      directiveLog: ['tamit, senu and wenet complain about the ale'],
      transcript: [],
    };
    const { tools, query } = makeTools(async () => state);

    const result = await tools.handleGetAmbientBanterState();

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getAmbientBanterState', {});
    expect(result).toEqual(state);
  });

  it('wraps a bridge failure in a clear error', async () => {
    const { tools } = makeTools(async () => {
      throw new Error('No active scene');
    });
    await expect(tools.handleGetAmbientBanterState()).rejects.toThrow(/No active scene/);
  });
});
