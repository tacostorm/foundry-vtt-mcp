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

describe('stale-line gating (requires / expectDirectiveSeq)', () => {
  const roster = (names: string[], seq = 0) => ({
    participants: names.map((name, i) => ({ actorId: `id${i}`, name, enabled: true })),
    directiveLog: [],
    directiveSeq: seq,
    transcript: [],
  });

  function gatedTools(getState: () => any) {
    return makeTools(async (method: string, data: any) => {
      if (method.endsWith('getAmbientBanterState')) return getState();
      return { success: true, speakerName: data.actorIdentifier };
    });
  }
  const posted = (query: any) =>
    query.mock.calls.filter((c: any[]) => c[0].endsWith('createChatMessage'));

  it('does not query the roster at all when a line carries no gating fields', async () => {
    const { tools, query } = gatedTools(() => roster([]));
    await tools.handleCreateChatMessage({ actorIdentifier: 'A', content: 'hi', delayMs: 1 });
    expect(query.mock.calls.map(c => c[0])).toEqual(['foundry-mcp-bridge.createChatMessage']);
  });

  it('posts a line whose speaker and required participants are all enabled (partial, case-insensitive names)', async () => {
    const { tools, query } = gatedTools(() =>
      roster(['Ortagar Stitch-Skull', 'Berline Haldoli', 'Ilvenna Voss'])
    );
    const result = await tools.handleCreateChatMessage({
      actorIdentifier: 'Berline Haldoli',
      content: 'hello',
      requires: ['ortagar', 'ILVENNA'],
    });
    expect(posted(query)).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it('skips only the lines whose thread lost a participant, and keeps the rest', async () => {
    // Ilvenna has left; the Khenur/Vaskish thread is untouched.
    const { tools, query } = gatedTools(() => roster(['Ortagar', 'Berline', 'Khenur', 'Vaskish']));
    const result = await tools.handleCreateChatMessage({
      lines: [
        { actorIdentifier: 'Khenur', content: 'a', requires: ['Khenur', 'Vaskish'] },
        { actorIdentifier: 'Ortagar', content: 'b', requires: ['Ortagar', 'Berline', 'Ilvenna'] },
        { actorIdentifier: 'Vaskish', content: 'c', requires: ['Khenur', 'Vaskish'] },
        { actorIdentifier: 'Berline', content: 'd', requires: ['Ortagar', 'Berline', 'Ilvenna'] },
      ],
    });
    expect(posted(query).map((c: any[]) => c[1].actorIdentifier)).toEqual(['Khenur', 'Vaskish']);
    expect(result.posted).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.results[1]).toMatchObject({
      skipped: true,
      reason: 'Ilvenna is no longer in the roster',
    });
  });

  it('treats the speaker as a required participant too', async () => {
    const { tools, query } = gatedTools(() => roster(['Berline']));
    const result = await tools.handleCreateChatMessage({
      actorIdentifier: 'Ortagar',
      content: 'x',
      requires: ['Berline'],
    });
    expect(posted(query)).toHaveLength(0);
    expect(result).toMatchObject({ skipped: true });
  });

  it('ignores disabled roster entries', async () => {
    const { tools, query } = gatedTools(() => ({
      ...roster(['Ortagar', 'Ilvenna']),
      participants: [
        { actorId: 'a', name: 'Ortagar', enabled: true },
        { actorId: 'b', name: 'Ilvenna', enabled: false },
      ],
    }));
    const result = await tools.handleCreateChatMessage({
      actorIdentifier: 'Ortagar',
      content: 'x',
      requires: ['Ilvenna'],
    });
    expect(posted(query)).toHaveLength(0);
    expect(result).toMatchObject({ skipped: true });
  });

  it('skips a line written under an older directiveSeq, and the rest of the batch without waiting', async () => {
    let seq = 4;
    let postedCount = 0;
    const { tools, query } = makeTools(async (method: string, data: any) => {
      if (method.endsWith('getAmbientBanterState')) return roster(['A', 'B'], seq);
      postedCount += 1;
      // a new /banter note lands right after the second line posts
      if (postedCount === 2) seq = 5;
      return { success: true, speakerName: data.actorIdentifier };
    });
    const started = Date.now();
    const result = await tools.handleCreateChatMessage({
      lines: [
        { actorIdentifier: 'A', content: '1', expectDirectiveSeq: 4 },
        { actorIdentifier: 'B', content: '2', expectDirectiveSeq: 4, delayMs: 20 },
        { actorIdentifier: 'A', content: '3', expectDirectiveSeq: 4, delayMs: 30 },
        { actorIdentifier: 'B', content: '4', expectDirectiveSeq: 4, delayMs: 5000 },
      ],
    });
    expect(posted(query)).toHaveLength(2);
    expect(result.posted).toBe(2);
    expect(result.skipped).toBe(2);
    // The third line waited its 30ms and found the note; the fourth must not serve its 5s.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('remembers directiveSeq from a plain state read and skips stale lines instantly', async () => {
    const { tools, query } = gatedTools(() => roster(['A'], 7));
    await tools.handleGetAmbientBanterState();
    query.mockClear();
    const started = Date.now();
    const result = await tools.handleCreateChatMessage({
      actorIdentifier: 'A',
      content: 'old',
      expectDirectiveSeq: 6,
      delayMs: 5000,
    });
    expect(result).toMatchObject({ skipped: true, reason: 'superseded by a newer /banter note' });
    expect(query).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('get-ambient-banter-state transcriptLimit', () => {
  it('advertises transcriptLimit and forwards it to the bridge', async () => {
    const { tools, query } = makeTools(async () => ({ participants: [], transcript: [] }));
    const def = tools.getToolDefinitions().find(d => d.name === 'get-ambient-banter-state')!;
    expect((def.inputSchema.properties as any).transcriptLimit).toBeDefined();
    await tools.handleGetAmbientBanterState({ transcriptLimit: 0 });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getAmbientBanterState', {
      transcriptLimit: 0,
    });
  });

  it('advertises positions and forwards it only when requested', async () => {
    const { tools, query } = makeTools(async () => ({ participants: [], transcript: [] }));
    const def = tools.getToolDefinitions().find(d => d.name === 'get-ambient-banter-state')!;
    expect((def.inputSchema.properties as any).positions).toBeDefined();
    await tools.handleGetAmbientBanterState({ positions: true, transcriptLimit: 0 });
    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.getAmbientBanterState', {
      transcriptLimit: 0,
      positions: true,
    });
    await tools.handleGetAmbientBanterState({});
    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.getAmbientBanterState', {});
  });

  it('rejects a negative transcriptLimit', async () => {
    const { tools } = makeTools();
    await expect(tools.handleGetAmbientBanterState({ transcriptLimit: -1 })).rejects.toThrow();
  });
});
