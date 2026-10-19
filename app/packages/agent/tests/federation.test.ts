import { assert } from 'chai';
import {
  dispatchFederationMcp, federationTokenMatches, federationToolName,
  isLoopbackAddress, issueFederationToken,
  type FederationDependencies, type FederationGrant, type FederationTarget,
} from '../server/federation';

const token = 'a'.repeat(43);
const grant: FederationGrant = {
  ownerId: 'owner-a', agentIds: ['researcher'], missionIds: [], revision: 4,
};
const researcher: FederationTarget = {
  kind: 'agent', id: 'researcher', displayName: 'Researcher',
};

function dependencies(overrides: Partial<FederationDependencies> = {}): FederationDependencies {
  return {
    resolveGrant: async (candidate) => candidate === token ? grant : null,
    resolveTargets: async () => [researcher],
    invoke: async () => 'answer',
    ...overrides,
  };
}

describe('Constellation federation MCP', () => {
  it('issues opaque tokens and compares only their hashes', () => {
    const issued = issueFederationToken();
    assert.match(issued.token, /^[A-Za-z0-9_-]{40,64}$/);
    assert.match(issued.tokenHash, /^[a-f0-9]{64}$/);
    assert.equal(issued.tokenHint, issued.token.slice(-6));
    assert.isTrue(federationTokenMatches(issued.token, issued.tokenHash));
    assert.isFalse(federationTokenMatches(`${issued.token.slice(0, -1)}x`, issued.tokenHash));
  });

  it('accepts only socket-level loopback addresses', () => {
    for (const address of ['127.0.0.1', '127.20.30.40', '::1', '::ffff:127.0.0.1']) {
      assert.isTrue(isLoopbackAddress(address), address);
    }
    for (const address of ['0.0.0.0', '10.0.0.2', '::ffff:10.0.0.2', undefined]) {
      assert.isFalse(isLoopbackAddress(address), String(address));
    }
  });

  it('lists only live targets inside the durable grant', async () => {
    const result = await dispatchFederationMcp(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, dependencies({
      resolveTargets: async () => [
        researcher,
        { kind: 'agent', id: 'not-shared', displayName: 'Not shared' },
        { kind: 'mission', id: 'also-not-shared', displayName: 'No' },
      ],
    }));

    assert.equal(result.status, 200);
    const tools = (result.response as any).result.tools;
    assert.deepEqual(tools.map((tool: any) => tool.name), [federationToolName(researcher)]);
    assert.notInclude(JSON.stringify(result), 'not-shared');
  });

  it('rechecks revocation immediately before invoking a target', async () => {
    let authorizationChecks = 0;
    let invoked = false;
    const result = await dispatchFederationMcp(token, {
      jsonrpc: '2.0', id: 'call', method: 'tools/call',
      params: { name: federationToolName(researcher), arguments: { prompt: 'Do work.' } },
    }, dependencies({
      resolveGrant: async () => {
        authorizationChecks += 1;
        return authorizationChecks === 1 ? grant : null;
      },
      invoke: async () => { invoked = true; return 'must not run'; },
    }));

    assert.equal(authorizationChecks, 2);
    assert.equal(result.status, 401);
    assert.isFalse(invoked);
  });

  it('rechecks a changed target allowlist immediately before invocation', async () => {
    let targetChecks = 0;
    let invoked = false;
    const result = await dispatchFederationMcp(token, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: federationToolName(researcher), arguments: { prompt: 'Do work.' } },
    }, dependencies({
      resolveTargets: async () => {
        targetChecks += 1;
        return targetChecks === 1 ? [researcher] : [];
      },
      invoke: async () => { invoked = true; return 'must not run'; },
    }));

    assert.equal(targetChecks, 2);
    assert.equal(result.status, 401);
    assert.isFalse(invoked);
  });

  it('invokes an allowed target and never echoes tool arguments', async () => {
    let seen: unknown;
    const result = await dispatchFederationMcp(token, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: federationToolName(researcher), arguments: { prompt: 'Bounded task.' } },
    }, dependencies({
      invoke: async (target, prompt, current) => {
        seen = { target, prompt, current };
        return 'Finished.';
      },
    }));

    assert.equal(result.status, 200);
    assert.deepInclude(seen as any, { target: researcher, prompt: 'Bounded task.' });
    assert.deepEqual((result.response as any).result, {
      content: [{ type: 'text', text: 'Finished.' }], isError: false,
    });
  });
});

