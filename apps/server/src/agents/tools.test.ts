import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { Actions } from '../modules/actions.js';
import { BusinessError, Learning } from '../modules/learning.js';
import { Projects } from '../modules/projects.js';
import { Library } from '../modules/library.js';
import { openDatabase } from '../storage/database.js';
import type { FrozenContext } from './context.js';
import { createScenario } from './scenarios.js';
import { createTask } from './tasks.js';
import { populated } from './test-support.js';
import { prepareTools } from './tools.js';

function tool(name: string): AgentTool {
  return { name, label: name, description: `Synthetic ${name}`, parameters: Type.Object({}),
    async execute() { assert.fail('Assembly must not execute tools.'); } };
}

test('all six scenes retain their ordered business tools across independent Skills and extension settings', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning);
  const actions = new Actions(learning, new Projects('/synthetic/data'));
  const expected = {
    intake: ['ask_user_question', 'write_research_document', 'submit_requirement_draft'],
    roadmap: ['add_route_stage', 'add_route_unit', 'update_route_stage', 'update_route_unit', 'remove_route_unit', 'remove_route_stage', 'submit_route_proposal'],
    tutor: ['read', 'ls', 'find', 'grep', 'propose_file_change', 'propose_command', 'submit_learning_conclusion'],
    lesson: ['read_learning_route', 'read_reference_lesson', 'submit_lesson'], assessment: ['submit_assessment'], evaluation: ['submit_evaluation'],
  } as const;
  try {
    for (const scenario of Object.keys(expected) as (keyof typeof expected)[]) {
      for (const initial of scenario === 'roadmap' ? [false, true] : [false])
      for (const hasSkills of [false, true]) for (const mcpEnabled of [false, true]) for (const searchEnabled of [false, true]) {
        const input: FrozenContext = { spaceId: space.id, sessionId: space.sessions[0]!.id, unitId: units[0]!.id,
          scenario, requirement: space.requirement, route: initial ? { ...space.route, content: null } : space.route, unit: units[0]!, lesson: null, lessonRefs: [], references: [] };
        const base = ['intake', 'roadmap', 'tutor'].includes(scenario)
          ? createScenario(learning, input, randomUUID(), '/synthetic/cwd', actions).tools : createTask(learning, input).tools;
        const mcp = tool('mcp__reference__lookup'), search = tool('web_search');
        const signal = new AbortController().signal;
        let cwdResolutions = 0;
        const prepared = await prepareTools({ scenarioTools: base, cwd: () => { cwdResolutions++; return '/synthetic/cwd'; }, hasSkills, signal,
          mcp: { async tools(received) { assert.equal(received, signal); return mcpEnabled ? [mcp] : []; } },
          search: { async tools(received) { assert.equal(received, signal); return searchEnabled ? [search] : []; } } });
        const inventory = [
          ...(initial ? ['submit_route'] : expected[scenario]).map((name) => ({ name, source: 'scenario' })),
          ...(hasSkills && scenario !== 'tutor' ? ['read', 'ls', 'find', 'grep'].map((name) => ({ name, source: 'skills-read' })) : []),
          ...(mcpEnabled ? [{ name: 'mcp__reference__lookup', source: 'mcp' }] : []),
          ...(searchEnabled ? [{ name: 'web_search', source: 'search' }] : []),
          { name: 'web_fetch', source: 'web-fetch' },
        ];
        const label = `${scenario}, initial=${initial}, skills=${hasSkills}, mcp=${mcpEnabled}, search=${searchEnabled}`;
        assert.deepEqual(prepared.inventory, inventory, label);
        assert.deepEqual(prepared.tools.map((t) => t.name), inventory.map((t) => t.name), label);
        assert.deepEqual(prepared.declarations.map((t) => t.name), inventory.map((t) => t.name), label);
        assert.equal(cwdResolutions, hasSkills ? 1 : 0, 'Only resolve cwd for Skills reads.');
        base.forEach((native, index) => assert.equal(prepared.tools[index], native, 'Keep stateful tool objects and their closures.'));
        if (mcpEnabled) assert.equal(prepared.tools.find((t) => t.name === mcp.name), mcp);
        if (searchEnabled) assert.equal(prepared.tools.at(-2), search);
        if (hasSkills && scenario !== 'tutor') assert.match(prepared.declarations[base.length]!.description, /Default cwd: \/synthetic\/cwd/);
      }
    }
  } finally { await actions.close(); db.close(); }
});

test('Skills only fill missing read tools and model declarations preserve asymmetric schemas without runtime fields', async () => {
  const read = { ...tool('read'), description: 'CUSTOM-READ-DESCRIPTION', parameters: Type.Object({ path: Type.String(), count: Type.Integer() }) };
  const ls = tool('ls');
  const outputSchema = Type.Object({ difference: Type.Number() });
  const mcp = { ...tool('mcp__math__subtract'), description: 'PRIVATE-CONFIG-MARKER',
    parameters: Type.Object({ left: Type.Number(), right: Type.Number() }), outputSchema };
  const scenarioTools: AgentTool[] = [read, ls], external: AgentTool[] = [mcp];
  const prepared = await prepareTools({ scenarioTools, cwd: () => '/synthetic/cwd', hasSkills: true,
    mcp: { async tools() { return external; } }, signal: new AbortController().signal });
  assert.deepEqual(prepared.inventory, [
    { name: 'read', source: 'scenario' }, { name: 'ls', source: 'scenario' },
    { name: 'find', source: 'skills-read' }, { name: 'grep', source: 'skills-read' },
    { name: 'mcp__math__subtract', source: 'mcp' }, { name: 'web_fetch', source: 'web-fetch' },
  ]);
  assert.equal(prepared.tools[0], read); assert.equal(prepared.tools[1], ls); assert.equal(prepared.tools[4], mcp);
  assert.deepEqual(prepared.declarations[0], { name: 'read', description: 'CUSTOM-READ-DESCRIPTION', parameters: read.parameters });
  assert.deepEqual(prepared.declarations[4], { name: 'mcp__math__subtract', description: 'PRIVATE-CONFIG-MARKER', parameters: mcp.parameters, outputSchema });
  assert.doesNotMatch(JSON.stringify(prepared.inventory), /PRIVATE-CONFIG-MARKER|description|parameters|outputSchema|label/);
  scenarioTools.push(tool('later_scene')); external.push(tool('later_mcp'));
  assert.deepEqual(prepared.tools.map((t) => t.name), ['read', 'ls', 'find', 'grep', 'mcp__math__subtract', 'web_fetch']);
});

test('already-cancelled assembly never asks providers for tools', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const provider = { async tools() { calls++; return []; } };
  await assert.rejects(prepareTools({ scenarioTools: [], cwd: () => { assert.fail('Cancelled assembly must not resolve cwd.'); }, hasSkills: true,
    mcp: provider, search: provider, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cancellation after either provider wait rejects even when the provider ignores cancellation', async () => {
  for (const waiting of ['mcp', 'search'] as const) {
    const controller = new AbortController();
    let enter!: () => void, release!: (tools: AgentTool[]) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<AgentTool[]>((resolve) => { release = resolve; });
    let searchCalls = 0, cwdResolutions = 0;
    const prepared = prepareTools({ scenarioTools: [], cwd: () => { cwdResolutions++; return '/synthetic/cwd'; }, hasSkills: true, signal: controller.signal,
      mcp: { async tools(signal) {
        assert.equal(signal, controller.signal);
        if (waiting === 'mcp') { enter(); return held; }
        return [];
      } },
      search: { async tools(signal) {
        assert.equal(signal, controller.signal); searchCalls++;
        enter(); return held;
      } } });
    await entered;
    controller.abort(); release([tool('late_tool')]);
    await assert.rejects(prepared, { name: 'AbortError' });
    assert.equal(searchCalls, waiting === 'search' ? 1 : 0);
    assert.equal(cwdResolutions, waiting === 'search' ? 1 : 0, 'MCP cancellation must not resolve the Skills cwd.');
  }
});

test('same-name tools within a scene or across providers fail instead of overriding schemas or implementations', async () => {
  for (const source of ['scenario', 'mcp', 'search', 'web-fetch'] as const) {
    const name = source === 'web-fetch' ? 'web_fetch' : source === 'search' ? 'web_search' : 'mcp__math__subtract';
    const first = { ...tool(name), parameters: Type.Object({ path: Type.String() }) };
    const second = { ...tool(name), parameters: Type.Object({ count: Type.Integer() }) };
    await assert.rejects(prepareTools({ scenarioTools: source === 'scenario' ? [first, second] : [first],
      cwd: () => '/synthetic/cwd', hasSkills: false, signal: new AbortController().signal,
      mcp: { async tools() { return source === 'mcp' ? [second] : []; } },
      search: { async tools() { return source === 'search' ? [second] : []; } },
    }), (error: unknown) => error instanceof BusinessError && error.status === 422
      && error.message.includes(name) && error.message.includes(`scenario / ${source}`));
  }
});

test('all six scenes can list and read global documents and execute Bash by default without Skills', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-library-tools-')), db = openDatabase(':memory:');
  const learning = new Learning(db), library = new Library(root), { space, units } = populated(learning);
  const actions = new Actions(learning, new Projects(root));
  try {
    const file = await library.upload(randomUUID(), 'reference.md', new Response('GLOBAL-REFERENCE').body, new AbortController().signal);
    for (const scenario of ['intake', 'roadmap', 'tutor', 'lesson', 'assessment', 'evaluation'] as const) {
      const runId = randomUUID(), input: FrozenContext = { spaceId: space.id, sessionId: space.sessions[0]!.id, unitId: units[0]!.id,
        scenario, requirement: space.requirement, route: space.route, unit: units[0]!, lesson: null, lessonRefs: [], references: [] };
      const base = ['intake', 'roadmap', 'tutor'].includes(scenario)
        ? createScenario(learning, input, runId, root, actions).tools : createTask(learning, input).tools;
      const prepared = await prepareTools({ scenarioTools: base, cwd: () => root, hasSkills: false, library, runId, signal: new AbortController().signal });
      const names = prepared.declarations.map((t) => t.name);
      for (const name of ['read', 'ls', 'find', 'grep', 'list_library_files', 'bash']) assert.ok(names.includes(name), `${scenario}: ${name}`);
      assert.equal(names.includes('shell'), false);
      assert.equal(names.length, new Set(names).size);
      const listing = await prepared.tools.find((t) => t.name === 'list_library_files')!.execute('list', {});
      assert.match(JSON.stringify(listing.content), /reference.md/);
      const read = await prepared.tools.find((t) => t.name === 'read')!.execute('read', { path: file.path });
      assert.match(JSON.stringify(read.content), /GLOBAL-REFERENCE/);
      const bash = await prepared.tools.find((t) => t.name === 'bash')!.execute('bash', { command: `printf '${scenario}-default-bash'` });
      assert.equal(bash.content[0]?.type, 'text');
      assert.equal(bash.content[0]?.type === 'text' && bash.content[0].text, `${scenario}-default-bash`);
      library.release(runId);
    }
  } finally { await Promise.all([library.close(), actions.close()]); db.close(); rmSync(root, { recursive: true, force: true }); }
});
