import { assert } from "chai";
import {
  Agent,
  AgentSessions,
  ChannelBindings,
  loadPiAi,
  EXPERIENCE_RECALL_MAX,
  MEMORY_TEXT_MAX,
} from "meteor/10thfloor:agent";
import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";
import {
  CHANNEL_KINDS,
  CHANNEL_SCHEMAS,
  deriveRuntimeState,
  nextScheduledAt,
  normalizeSchedule,
  parseCron,
  scheduleLabel,
  slugifySkill,
} from "../imports/constellation/config.js";
import {
  assertCrewModelAvailable,
  buildModelCatalog,
  effectiveCrewModel,
  LOCAL_MODEL,
  modelIdsFromCatalog,
  PREFERRED_PROVIDER_MODELS,
} from "../imports/constellation/models.js";

const sorted = (values) => [...values].sort((left, right) => left - right);

const MCP_TEST_SERVER = "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;const q=JSON.parse(l);if(q.id===undefined)continue;let r={};if(q.method==='initialize')r={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};else if(q.method==='tools/list')r={tools:[{name:'runtime_status',description:'Runtime status',inputSchema:{type:'object',properties:{}}},{name:'format_checklist',description:'Format checklist',inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object','catalog.detail':true,properties:{title:{type:'string'},items:{type:'array',items:{type:'string'}}},required:['title','items']}}]};else if(q.method==='tools/call')r={content:[{type:'text',text:'ok'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:r})+'\\n')}});";

const MCP_DELAYED_EPHEMERAL_SERVER = "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;const q=JSON.parse(l);if(q.id===undefined)continue;let r={};if(q.method==='initialize')r={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'delayed-test',version:'1'}};else if(q.method==='tools/list')r={tools:[{name:'delayed_status',description:'Delayed status',inputSchema:{type:'object',properties:{}}}]};setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:r})+'\\n');if(q.method==='tools/list')setTimeout(()=>process.exit(0),25)},300)}});";

async function waitUntil(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function unsafeDocumentKeys(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unsafeDocumentKeys(item, [...path, index]));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.startsWith("$") || key.includes(".") ? [[...path, key].join(".")] : []),
    ...unsafeDocumentKeys(child, [...path, key]),
  ]);
}

describe("app", function () {
  it("package.json has correct name", async function () {
    const { name } = await import("../package.json");
    assert.strictEqual(name, "app");
  });

  if (Meteor.isClient) {
    it("client is not server", function () {
      assert.strictEqual(Meteor.isServer, false);
    });
  }

  if (Meteor.isServer) {
    it("server is not client", function () {
      assert.strictEqual(Meteor.isClient, false);
    });
  }
});

describe("Constellation model catalog", function () {
  it("publishes only sanitized configured models and annotates stale selections", function () {
    const catalog = buildModelCatalog({
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT 5 Mini", secret: "no" },
        { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      ],
      knownModels: [
        { provider: "mistral", id: "mistral-small-latest", name: "Mistral Small" },
      ],
      providerLabels: { openai: "OpenAI", anthropic: "Anthropic", mistral: "Mistral" },
      savedModels: ["default", "mistral/mistral-small-latest"],
    });
    assert.strictEqual(catalog.defaultModel, "anthropic/claude-haiku-4-5");
    assert.deepEqual(catalog.providers.map(({ id, label, kind }) => ({ id, label, kind })), [
      { id: "anthropic", label: "Anthropic", kind: "cloud" },
      { id: "openai", label: "OpenAI", kind: "cloud" },
    ]);
    assert.deepInclude(catalog.unavailableModels[0], {
      id: "mistral/mistral-small-latest",
      label: "Mistral Small",
      providerId: "mistral",
      providerLabel: "Mistral",
    });
    assert.notInclude(JSON.stringify(catalog), "secret");
    assert.notInclude(JSON.stringify(catalog), "API_KEY");
  });

  it("keeps offline mode strictly scripted and groups Ollama as a local provider", function () {
    const offlineCatalog = buildModelCatalog({
      availableModels: [{ provider: "ollama", id: "llama3.2:latest", name: "llama3.2:latest" }],
      providerLabels: { ollama: "Ollama" },
      providerKinds: { ollama: "local" },
      offline: true,
    });
    assert.strictEqual(offlineCatalog.defaultModel, LOCAL_MODEL);
    assert.deepEqual(offlineCatalog.providers.map((provider) => provider.id), ["constellation"]);

    const catalog = buildModelCatalog({
      availableModels: [{
        provider: "ollama", id: "llama3.2:latest", name: "llama3.2:latest",
        contextWindow: 32768,
        availabilityWarning: "Context window is below the recommended 64K for agent work.",
      }],
      providerLabels: { ollama: "Ollama" },
      providerKinds: { ollama: "local" },
    });
    assert.strictEqual(catalog.mode, "local");
    assert.strictEqual(catalog.defaultModel, LOCAL_MODEL);
    assert.sameMembers(catalog.providers.map((provider) => provider.id), ["constellation", "ollama"]);
    assert.isTrue(catalog.providers.every((provider) => provider.kind === "local"));
    assert.include(catalog.providers.find((provider) => provider.id === "ollama").models[0].warning, "64K");
    assert.strictEqual(effectiveCrewModel("ollama/llama3.2:latest", catalog), "ollama/llama3.2:latest");
  });

  it("allows a stale model to remain unchanged but blocks newly unavailable choices", function () {
    const available = modelIdsFromCatalog(buildModelCatalog({ offline: true }));
    assert.strictEqual(
      assertCrewModelAvailable("openai/retired", "openai/retired", available),
      "openai/retired",
    );
    assert.strictEqual(assertCrewModelAvailable("default", "default", available), "default");
    assert.strictEqual(
      effectiveCrewModel("openai/retired", buildModelCatalog({ offline: true })),
      "openai/retired",
    );
    let rejected;
    try {
      assertCrewModelAvailable("default", "openai/not-configured", available);
    } catch (error) {
      rejected = error;
    }
    assert.strictEqual(rejected?.code, "model-unavailable");
  });

  it("does not choose an arbitrary paid default for a provider without a preference", function () {
    const catalog = buildModelCatalog({
      availableModels: [{ provider: "future-provider", id: "a-first", name: "A First" }],
      providerLabels: { "future-provider": "Future Provider" },
    });
    assert.strictEqual(catalog.defaultModel, LOCAL_MODEL);
    assert.sameMembers(
      catalog.providers.map((provider) => provider.id),
      ["constellation", "future-provider"],
    );
  });
});

if (Meteor.isServer) {
  describe("Installed model defaults", function () {
    it("keeps every intentional provider default aligned with pi-ai", async function () {
      const { builtinModels } = await loadPiAi("providers/all");
      const models = builtinModels();
      for (const [provider, modelId] of Object.entries(PREFERRED_PROVIDER_MODELS)) {
        assert.ok(
          models.getModel(provider, modelId),
          `${provider}/${modelId} must exist in the installed pi-ai catalog`,
        );
      }
    });
  });

  describe("Crew model id validation", function () {
    let runtime;

    before(async function () {
      runtime = await import("../server/main.js");
    });

    it("accepts the shared boundary, rejects overflow, and preserves a stale legacy id", function () {
      const boundary = `p/${"m".repeat(318)}`;
      assert.lengthOf(boundary, 320);
      assert.strictEqual(runtime.cleanCrewModel(boundary, "default"), boundary);
      let overflow;
      try {
        runtime.cleanCrewModel(`${boundary}x`, "default");
      } catch (error) {
        overflow = error;
      }
      assert.strictEqual(overflow?.error, "invalid-crew");
      assert.strictEqual(runtime.cleanCrewModel(`${boundary}x`, `${boundary}x`), `${boundary}x`);
      assert.strictEqual(runtime.boundedAgentContextWindow(32768), 26214);
      assert.strictEqual(runtime.boundedAgentContextWindow(1000000), 120000);
      assert.strictEqual(runtime.boundedAgentContextWindow(undefined), 120000);
    });
  });

  describe("Radius model refresh", function () {
    let providers;

    before(async function () {
      providers = await import("../server/model-providers.js");
    });

    it("does not inspect auth or network when discovery is disabled", async function () {
      let touched = false;
      const result = await providers.refreshRadiusModels({
        enabled: false,
        models: {
          getProvider: () => { touched = true; },
          checkAuth: async () => { touched = true; },
          refresh: async () => { touched = true; },
        },
      });
      assert.deepEqual(result, { configured: false, attempted: false, refreshed: false });
      assert.isFalse(touched);
    });

    it("refreshes only Radius, and only after authoritative auth succeeds", async function () {
      const calls = [];
      const models = {
        getProvider(id) {
          calls.push(["provider", id]);
          return { refreshModels: async () => {} };
        },
        async checkAuth(id, options) {
          calls.push(["auth", id, options.signal instanceof AbortSignal]);
          return { type: "api_key" };
        },
        async refresh(options) {
          calls.push(["refresh", options]);
          return { aborted: false, errors: new Map() };
        },
      };
      const result = await providers.refreshRadiusModels({ models, timeoutMs: 100 });
      assert.deepEqual(result, { configured: true, attempted: true, refreshed: true });
      assert.deepEqual(calls[0], ["provider", "radius"]);
      assert.deepEqual(calls[1], ["auth", "radius", true]);
      assert.deepInclude(calls[2][1], {
        providers: ["radius"], allowNetwork: true, force: false,
      });
      assert.instanceOf(calls[2][1].signal, AbortSignal);

      calls.length = 0;
      models.checkAuth = async () => undefined;
      assert.deepEqual(
        await providers.refreshRadiusModels({ models, timeoutMs: 100 }),
        { configured: false, attempted: false, refreshed: false },
      );
      assert.isFalse(calls.some(([kind]) => kind === "refresh"));
    });

    it("aborts a stalled Radius refresh at the bounded deadline", async function () {
      let refreshSignal;
      const result = await providers.refreshRadiusModels({
        timeoutMs: 50,
        models: {
          getProvider: () => ({ refreshModels: async () => {} }),
          checkAuth: async () => ({ type: "api_key" }),
          refresh: async ({ signal }) => {
            refreshSignal = signal;
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            return { aborted: true, errors: new Map() };
          },
        },
      });
      assert.deepEqual(result, {
        configured: false, attempted: false, refreshed: false, timedOut: true,
      });
      assert.isTrue(refreshSignal.aborted);
    });
  });

  describe("Ollama model detection", function () {
    let ollama;

    before(async function () {
      ollama = await import("../server/ollama.js");
    });

    it("uses the fixed loopback endpoint and parses a bounded model list", async function () {
      const requests = [];
      const models = await ollama.detectOllamaModels({
        timeoutMs: 100,
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          if (url === ollama.OLLAMA_SHOW_URL) {
            const { model } = JSON.parse(options.body);
            const details = model === "llama3.2:latest"
              ? {
                capabilities: ["completion", "tools", "vision", "thinking"],
                model_info: { "llama.context_length": 131072 },
                parameters: "temperature 0.7\nnum_ctx 65536\n",
              }
              : model === "team/qwen2.5-coder:7b"
                ? {
                  capabilities: ["completion", "tools"],
                  model_info: { "qwen.context_length": 32768 },
                }
                : { capabilities: ["embedding"], model_info: {} };
            return {
              ok: true,
              headers: { get: () => "120" },
              text: async () => JSON.stringify(details),
            };
          }
          return {
            ok: true,
            headers: { get: () => "120" },
            text: async () => JSON.stringify({
              models: [
                { name: "llama3.2:latest" },
                { model: "team/qwen2.5-coder:7b" },
                { name: "llama3.2:latest" },
                { name: "../../unsafe model" },
                { name: "gpt-oss:120b-cloud" },
                { name: "nomic-embed-text:latest" },
              ],
            }),
          };
        },
      });
      assert.strictEqual(requests[0].url, "http://127.0.0.1:11434/api/tags");
      assert.strictEqual(requests[0].options.redirect, "error");
      assert.instanceOf(requests[0].options.signal, AbortSignal);
      assert.isTrue(requests.slice(1).every((request) => (
        request.url === "http://127.0.0.1:11434/api/show"
        && request.options.method === "POST"
        && Object.keys(JSON.parse(request.options.body)).join() === "model"
      )));
      assert.deepEqual(models.map((entry) => entry.id), [
        "llama3.2:latest", "team/qwen2.5-coder:7b",
      ]);
      assert.deepEqual(models[0].input, ["text", "image"]);
      assert.strictEqual(models[0].reasoning, true);
      assert.strictEqual(models[0].contextWindow, 65536);
      assert.notProperty(models[0], "availabilityWarning");
      assert.strictEqual(models[1].contextWindow, 4096);
      assert.include(models[1].availabilityWarning, "not reported");
      assert.include(models[1].availabilityWarning, "64K");
      for (const entry of models) {
        assert.strictEqual(entry.provider, "ollama");
        assert.strictEqual(entry.baseUrl, "http://127.0.0.1:11434/v1");
        assert.deepInclude(entry.compat, {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          supportsStrictMode: false,
          supportsLongCacheRetention: false,
          supportsReasoningEffort: false,
        });
      }
    });

    it("does not touch the network when detection is disabled", async function () {
      let calls = 0;
      const models = await ollama.detectOllamaModels({
        enabled: false,
        fetchImpl: async () => { calls += 1; },
      });
      assert.deepEqual(models, []);
      assert.strictEqual(calls, 0);
    });
  });

  describe("Standalone Channel linking", function () {
    it("rejects an unauthenticated remote connection before inspecting its bearer", async function () {
      const handler = Meteor.server?.method_handlers?.["constellation.linkChannel"];
      assert.isFunction(handler);
      let rejected;
      try {
        await handler.call(
          { userId: null, connection: { clientAddress: "203.0.113.42" } },
          "A23456789_bcdefghijk",
        );
      } catch (error) {
        rejected = error;
      }
      assert.strictEqual(rejected?.error, "not-authorized");
    });
  });

  describe("Constellation Mission participation", function () {
    let runtime;

    before(async function () {
      runtime = await import("../server/main.js");
    });

    it("sanitizes people and Mission surfaces and fences removed agent tools", async function () {
      const ownerId = `participation-owner-${Random.id()}`;
      const otherOwnerId = `participation-other-${Random.id()}`;
      const sessionId = `participation-session-${Random.id()}`;
      const memberId = `participation-member-${Random.id()}`;
      const participantId = `x:constellation:${memberId}`;
      const externalUserId = `U_PRIVATE_${Random.id()}`;
      const conversationRef = `C_PRIVATE_${Random.id()}`;
      const destinationSecret = `destination-${Random.id()}`;
      const now = new Date();
      const bindingId = `slack:${conversationRef}`;
      const crewConfigId = `participation-crew-${Random.id()}`;
      const privateMember = {
        _id: memberId,
        userId: ownerId,
        participantId,
        displayName: "Dana",
        title: "Product",
        connection: "channel",
        surfaceKinds: ["slack"],
        identity: { kind: "slack", externalUserId },
        assurance: "none",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };

      try {
        await runtime.WorkspaceMembers.insertAsync(privateMember);
        await runtime.CrewConfigs.insertAsync({
          _id: crewConfigId,
          userId: ownerId,
          agent: "researcher",
          enabled: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await AgentSessions.insertAsync({
          _id: sessionId,
          agent: "orchestrator",
          userId: ownerId,
          phase: "idle",
          model: "mock",
          nextSeq: 0,
          usage: { input: 0, output: 0, cost: 0 },
          participants: [
            {
              id: `h:${ownerId}`,
              kind: "human",
              role: "owner",
              userId: ownerId,
              displayName: "Owner",
              joinedAt: now,
            },
            {
              id: "m:orchestrator",
              kind: "model",
              role: "member",
              agent: "orchestrator",
              displayName: "Atlas",
              joinedAt: now,
            },
            {
              id: "m:researcher",
              kind: "model",
              role: "member",
              agent: "researcher",
              displayName: "Signal",
              joinedAt: now,
            },
            {
              id: participantId,
              kind: "human",
              role: "member",
              identity: { kind: "slack", externalUserId },
              assurance: "none",
              displayName: "Dana",
              joinedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        });
        await ChannelBindings.insertAsync({
          _id: bindingId,
          kind: "slack",
          conversationRef,
          destination: { channel: destinationSecret, thread: "private-thread" },
          audience: "group",
          agent: "orchestrator",
          sessionId,
          userId: ownerId,
          admits: "members",
          member: true,
          participant: participantId,
          deliveredSeq: 0,
          createdAt: now,
          updatedAt: now,
        });

        const publicMember = runtime.workspaceMemberPublic(privateMember);
        assert.deepEqual(Object.keys(publicMember).sort(), [
          "_id", "connection", "createdAt", "displayName", "revision",
          "surfaceKinds", "title", "updatedAt",
        ]);
        assert.notInclude(JSON.stringify(publicMember), externalUserId);

        const view = await runtime.missionParticipationView(ownerId, sessionId);
        assert.strictEqual(view.missionId, sessionId);
        assert.deepInclude(
          view.participants.find((participant) => participant.memberId === memberId),
          {
            kind: "human",
            role: "participant",
            displayName: "Dana",
            connection: "channel",
            surfaceKinds: ["slack"],
          },
        );
        assert.deepInclude(view.surfaces[0], {
          kind: "slack",
          audience: "group",
          status: "bound",
          participantKey: `member:${memberId}`,
        });
        const serialized = JSON.stringify(view);
        assert.notInclude(serialized, externalUserId);
        assert.notInclude(serialized, conversationRef);
        assert.notInclude(serialized, destinationSecret);
        assert.isNull(await runtime.missionParticipationView(otherOwnerId, sessionId));

        assert.isTrue(await runtime.missionAllowsAgent(
          { userId: ownerId, sessionId }, "researcher",
        ));
        await AgentSessions.updateAsync(
          sessionId, { $pull: { participants: { id: "m:researcher" } } },
        );
        assert.isFalse(await runtime.missionAllowsAgent(
          { userId: ownerId, sessionId }, "researcher",
        ));
      } finally {
        await ChannelBindings.removeAsync(bindingId);
        await runtime.WorkspaceMembers.removeAsync(memberId);
        await runtime.CrewConfigs.removeAsync(crewConfigId);
        await AgentSessions.removeAsync(sessionId);
      }
    });

    it("reserves consequential approvals for the workspace owner", async function () {
      let workspace = await runtime.WorkspaceState.findOneAsync("local");
      const temporaryOwner = !workspace;
      if (!workspace) {
        workspace = {
          _id: "local",
          ownerUserId: `approval-owner-${Random.id()}`,
          createdAt: new Date(),
        };
        await runtime.WorkspaceState.insertAsync(workspace);
      }
      try {
        assert.isTrue(await runtime.workspaceOwnerCanApprove({
          userId: workspace.ownerUserId,
        }));
        assert.isFalse(await runtime.workspaceOwnerCanApprove({
          userId: `mission-member-${Random.id()}`,
        }));
        assert.isFalse(await runtime.workspaceOwnerCanApprove({ userId: null }));
      } finally {
        if (temporaryOwner) {
          await runtime.WorkspaceState.removeAsync({
            _id: "local", ownerUserId: workspace.ownerUserId,
          });
        }
      }
    });

    it("rechecks each live Tool entitlement instead of trusting a prepared runtime", async function () {
      const userId = `entitlement-owner-${Random.id()}`;
      const sessionId = `entitlement-session-${Random.id()}`;
      const configId = `entitlement-agent-${Random.id()}`;
      const skillId = `entitlement-skill-${Random.id()}`;
      const mcpId = `entitlement-mcp-${Random.id()}`;
      const catalogId = `entitlement-catalog-${Random.id()}`;
      const mcpAlias = `mcp_entitlement_${Random.id(8)}`;
      const now = new Date();
      const context = { userId, sessionId, toolCallId: 'call-1' };

      try {
        await runtime.CrewConfigs.insertAsync({
          _id: configId,
          userId,
          agent: "orchestrator",
          primary: true,
          enabled: true,
          status: "available",
          capabilities: { inspect: true, memory: true, publish: false },
          experience: {
            record: true, recall: true, recent: 3, scope: "owner", approval: "ask",
          },
          practice: {
            acquire: false, approval: "ask", allowScopedEvidencePromotion: false,
          },
          createdAt: now,
          updatedAt: now,
        });
        await AgentSessions.insertAsync({
          _id: sessionId,
          agent: "orchestrator",
          userId,
          phase: "idle",
          model: "mock",
          nextSeq: 0,
          usage: { input: 0, output: 0, cost: 0 },
          createdAt: now,
          updatedAt: now,
        });
        await runtime.SkillConfigs.insertAsync({
          _id: skillId,
          userId,
          name: "Entitlement skill",
          slug: "entitlement-skill",
          description: "Test exact live Skill access.",
          content: "Test instructions.",
          agents: ["orchestrator"],
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
        await runtime.McpConfigs.insertAsync({
          _id: mcpId,
          userId,
          enabled: true,
          trusted: true,
          status: "ready",
          approval: "ask",
          agents: ["orchestrator"],
          toolMode: "selected",
          selectedTools: ["runtime_status"],
          createdAt: now,
          updatedAt: now,
        });
        await runtime.ToolCatalog.insertAsync({
          _id: catalogId,
          userId,
          source: "workspace-mcp",
          name: mcpAlias,
          serverId: mcpId,
          remoteName: "runtime_status",
          createdAt: now,
          updatedAt: now,
        });

        assert.isTrue(await runtime.configuredToolEntitlement(
          "inspect_workspace", context, "orchestrator",
        ));
        assert.isFalse(await runtime.configuredToolEntitlement(
          "publish_brief", context, "orchestrator",
        ));
        assert.isTrue(await runtime.configuredToolEntitlement(
          "memory_save", context, "orchestrator",
        ));
        assert.isTrue(await runtime.configuredToolEntitlement(
          "experience_propose", context, "orchestrator",
        ));
        assert.isTrue(await runtime.configuredToolEntitlement(
          "experience_search", context, "orchestrator",
        ));
        assert.isFalse(await runtime.configuredToolEntitlement(
          "practice_propose", context, "orchestrator",
        ));
        await runtime.CrewConfigs.updateAsync(configId, { $set: {
          practice: {
            acquire: true, approval: "auto", allowScopedEvidencePromotion: false,
          },
        } });
        assert.isTrue(await runtime.configuredToolEntitlement(
          "practice_propose", context, "orchestrator",
        ));
        await runtime.CrewConfigs.updateAsync(configId, { $set: {
          "practice.acquire": false,
        } });
        assert.isFalse(await runtime.configuredToolEntitlement(
          "practice_propose", context, "orchestrator",
        ));
        await runtime.CrewConfigs.updateAsync(configId, { $set: {
          "practice.acquire": true,
        } });
        assert.isTrue(await runtime.configuredToolEntitlement(
          "skill", { ...context, args: { name: "entitlement-skill" } }, "orchestrator",
        ));
        assert.isFalse(await runtime.configuredToolEntitlement(
          "skill", { ...context, args: { name: "another-skill" } }, "orchestrator",
        ));
        assert.isTrue(await runtime.configuredToolEntitlement(
          mcpAlias, context, "orchestrator",
        ));
        assert.isFalse(await runtime.configuredToolEntitlement(
          "unregistered_tool", context, "orchestrator",
        ));

        await runtime.CrewConfigs.updateAsync(configId, { $set: {
          capabilities: { inspect: false, memory: false, publish: false },
          experience: {
            record: false, recall: false, recent: 3, scope: "owner", approval: "ask",
          },
        } });
        await runtime.SkillConfigs.updateAsync(skillId, { $set: { enabled: false } });
        await runtime.McpConfigs.updateAsync(mcpId, { $set: { selectedTools: [] } });

        for (const tool of [
          "inspect_workspace", "memory_save", "experience_propose", "experience_search",
          "practice_propose",
        ]) {
          assert.isFalse(await runtime.configuredToolEntitlement(tool, context, "orchestrator"));
        }
        assert.isFalse(await runtime.configuredToolEntitlement(
          "skill", { ...context, args: { name: "entitlement-skill" } }, "orchestrator",
        ));
        assert.isFalse(await runtime.configuredToolEntitlement(
          mcpAlias, context, "orchestrator",
        ));

        await runtime.CrewConfigs.updateAsync(configId, {
          $set: { status: "archived", enabled: false },
        });
        assert.isFalse(await runtime.configuredToolEntitlement(
          "inspect_workspace", context, "orchestrator",
        ));
      } finally {
        await runtime.ToolCatalog.removeAsync(catalogId);
        await runtime.McpConfigs.removeAsync(mcpId);
        await runtime.SkillConfigs.removeAsync(skillId);
        await runtime.CrewConfigs.removeAsync(configId);
        await AgentSessions.removeAsync(sessionId);
      }
    });

    it("preserves Channel-added humans and bindings during exact Crew reconciliation", async function () {
      const ownerId = `external-crew-owner-${Random.id()}`;
      const sessionId = `external-crew-session-${Random.id()}`;
      const managedParticipantId = `x:constellation:${Random.id()}`;
      const externalUserId = `U_EXTERNAL_${Random.id()}`;
      const externalParticipantId = `x:slack:${externalUserId}`;
      const bindingId = `slack:external-thread-${Random.id()}`;
      const now = new Date();
      try {
        await AgentSessions.insertAsync({
          _id: sessionId,
          agent: "orchestrator",
          userId: ownerId,
          phase: "idle",
          model: "mock",
          nextSeq: 0,
          usage: { input: 0, output: 0, cost: 0 },
          participants: [
            {
              id: `h:${ownerId}`,
              kind: "human",
              role: "owner",
              userId: ownerId,
              displayName: "Owner",
              joinedAt: now,
            },
            {
              id: "m:orchestrator",
              kind: "model",
              role: "member",
              agent: "orchestrator",
              displayName: "Atlas",
              joinedAt: now,
            },
            {
              id: managedParticipantId,
              kind: "human",
              role: "member",
              displayName: "Directory person",
              joinedAt: now,
            },
            {
              id: externalParticipantId,
              kind: "human",
              role: "member",
              identity: { kind: "slack", externalUserId },
              assurance: "none",
              displayName: "External participant",
              joinedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        });
        await ChannelBindings.insertAsync({
          _id: bindingId,
          kind: "slack",
          conversationRef: `external-thread-${Random.id()}`,
          destination: { channel: "external-channel" },
          audience: "group",
          agent: "orchestrator",
          sessionId,
          userId: ownerId,
          admits: "members",
          member: true,
          participant: externalParticipantId,
          deliveredSeq: 0,
          createdAt: now,
          updatedAt: now,
        });

        await runtime.reconcileMissionMembers(
          ownerId,
          sessionId,
          [],
          new Set([managedParticipantId]),
        );
        const after = await AgentSessions.findOneAsync(sessionId);
        assert.notOk(after.participants.some((row) => row.id === managedParticipantId));
        assert.ok(after.participants.some((row) => row.id === externalParticipantId));
        assert.ok(
          await ChannelBindings.findOneAsync(bindingId),
          "an unmanaged participant's Channel binding must survive a directory Crew save",
        );
      } finally {
        await ChannelBindings.removeAsync(bindingId);
        await AgentSessions.removeAsync(sessionId);
      }
    });
  });

  describe("Mission execution fences", function () {
    let runtime;

    before(async function () {
      runtime = await import("../server/main.js");
    });

    it("adds restrained response formatting once to replies, never compaction", function () {
      const request = { model: "mock", system: "Base instructions", messages: [], tools: [] };
      const styled = runtime.withResponseStyle(request, { purpose: "think" });
      assert.include(styled.system, "## Response style");
      assert.include(styled.system, "triple-backtick fences with a language tag");
      assert.include(styled.system, "native tool calls");
      assert.strictEqual(
        runtime.withResponseStyle(styled, { purpose: "think" }).system,
        styled.system,
        "provider retries must not accumulate the style block",
      );
      assert.strictEqual(
        runtime.withResponseStyle(request, { purpose: "compaction" }),
        request,
        "compaction owns its exact output shape",
      );
    });

    it("blocks think and compaction Providers for an inactive root Mission", async function () {
      const rootId = `mission-fence-${Random.id()}`;
      const childId = `mission-child-${Random.id()}`;
      const userId = `mission-owner-${Random.id()}`;
      const now = new Date();
      let providerCalls = 0;
      const baseProvider = {
        capabilities: { imageInput: () => true },
        async *stream(request) {
          providerCalls += 1;
          assert.isUndefined(request[runtime.MISSION_EXECUTION_SESSION]);
          yield { kind: "done", usage: { input: 1, output: 1 } };
        },
      };
      const provider = runtime.missionScopedProvider(baseProvider);
      const request = { model: "mock", system: "test", messages: [], tools: [] };
      const run = async (sessionId, purpose) => {
        const tagged = runtime.withMissionExecutionContext(request, {
          agent: sessionId === rootId ? "orchestrator" : "researcher",
          sessionId,
          purpose,
        });
        for await (const chunk of provider.stream(tagged)) assert.strictEqual(chunk.kind, "done");
      };

      try {
        await AgentSessions.insertAsync({
          _id: rootId,
          agent: "orchestrator",
          userId,
          phase: "idle",
          model: "mock",
          nextSeq: 0,
          usage: { input: 0, output: 0, cost: 0 },
          budgetSpent: { turns: 0, toolCalls: 0 },
          createdAt: now,
          updatedAt: now,
        });
        await AgentSessions.insertAsync({
          _id: childId,
          agent: "researcher",
          userId,
          phase: "idle",
          model: "mock",
          nextSeq: 0,
          usage: { input: 0, output: 0, cost: 0 },
          budgetSpent: { turns: 0, toolCalls: 0 },
          parent: { sessionId: rootId, toolCallId: "delegate-1" },
          depth: 1,
          createdAt: now,
          updatedAt: now,
        });
        await runtime.MissionConfigs.insertAsync({
          _id: rootId,
          sessionId: rootId,
          userId,
          title: "Provider fence test",
          status: "paused",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });

        for (const [sessionId, purpose] of [[rootId, "think"], [childId, "compaction"]]) {
          let rejected;
          try {
            await run(sessionId, purpose);
          } catch (error) {
            rejected = error;
          }
          assert.strictEqual(rejected?.error, "mission-inactive");
        }
        assert.strictEqual(providerCalls, 0, "inactive work must not reach the adapter");

        await runtime.MissionConfigs.updateAsync(rootId, { $set: { status: "active" } });
        await run(childId, "think");
        assert.strictEqual(providerCalls, 1, "active Mission work should reach the adapter");
        assert.strictEqual(await provider.capabilities.imageInput("mock"), true);

        await runtime.MissionConfigs.removeAsync(rootId);
        await run(rootId, "think");
        assert.strictEqual(providerCalls, 2, "a durable root should initialize its control record");
        assert.strictEqual(
          (await runtime.MissionConfigs.findOneAsync(rootId))?.status,
          "active",
          "missing Mission state must be initialized, never treated as an implicit allow",
        );
      } finally {
        await runtime.MissionConfigs.removeAsync(rootId);
        await AgentSessions.removeAsync({ _id: { $in: [rootId, childId] } });
      }
    });

    it("keeps reactivation behind a stopped Turn's Lease and active child", async function () {
      const sessionId = `mission-stop-${Random.id()}`;
      const userId = `mission-owner-${Random.id()}`;
      const now = new Date();
      await AgentSessions.insertAsync({
        _id: sessionId,
        agent: "orchestrator",
        userId,
        phase: "stopped",
        model: "mock",
        nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        activeChild: { sessionId: "stopping-child", toolCallId: "delegate-1" },
        lease: { serverId: "stopping-server", until: new Date(Date.now() + 60_000) },
        createdAt: now,
        updatedAt: now,
      });

      try {
        let settled = false;
        const waiting = runtime.waitForMissionQuiescence(
          userId,
          sessionId,
          { timeoutMs: 500, pollMs: 10 },
        ).then((session) => {
          settled = true;
          return session;
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.isFalse(settled, "reactivation must not outrun child cleanup");

        await AgentSessions.updateAsync(
          sessionId,
          { $unset: { activeChild: "", lease: "" }, $set: { updatedAt: new Date() } },
        );
        const quiescent = await waiting;
        assert.strictEqual(quiescent._id, sessionId);
        assert.isTrue(settled);
      } finally {
        await AgentSessions.removeAsync(sessionId);
      }
    });

    it("clears only an expired Lease and its exact stopped-child marker", async function () {
      const sessionId = `mission-stale-root-${Random.id()}`;
      const childId = `mission-stale-child-${Random.id()}`;
      const userId = `mission-owner-${Random.id()}`;
      const now = new Date();
      const marker = { sessionId: childId, toolCallId: "delegate-stale" };
      await AgentSessions.insertAsync({
        _id: sessionId,
        agent: "orchestrator",
        userId,
        phase: "stopped",
        model: "mock",
        nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        activeChild: marker,
        lease: { serverId: "expired-server", until: new Date(Date.now() - 1_000) },
        createdAt: now,
        updatedAt: now,
      });
      await AgentSessions.insertAsync({
        _id: childId,
        agent: "researcher",
        userId,
        phase: "stopped",
        model: "mock",
        nextSeq: 0,
        usage: { input: 0, output: 0, cost: 0 },
        budgetSpent: { turns: 0, toolCalls: 0 },
        parent: { sessionId, toolCallId: marker.toolCallId },
        depth: 1,
        createdAt: now,
        updatedAt: now,
      });

      try {
        await runtime.waitForMissionQuiescence(
          userId,
          sessionId,
          { timeoutMs: 500, pollMs: 10 },
        );
        const root = await AgentSessions.findOneAsync(sessionId);
        assert.isUndefined(root?.lease, "expired authority should not block Reactivate");
        assert.isUndefined(root?.activeChild, "the exact stopped-child hint should be cleared");
        assert.strictEqual((await AgentSessions.findOneAsync(childId))?.phase, "stopped");
      } finally {
        await AgentSessions.removeAsync({ _id: { $in: [sessionId, childId] } });
      }
    });
  });
}

describe("Constellation configuration", function () {
  describe("interval schedules", function () {
    it("normalizes form values and advances from the supplied instant", function () {
      assert.deepEqual(
        normalizeSchedule({ kind: "interval", every: "4", unit: "hours" }),
        { kind: "interval", every: 4, unit: "hours" },
      );

      const start = new Date("2026-01-15T12:30:45.000Z");
      assert.strictEqual(
        nextScheduledAt({ kind: "interval", every: 90, unit: "minutes" }, start).getTime(),
        start.getTime() + 90 * 60_000,
      );
      assert.strictEqual(
        nextScheduledAt({ kind: "interval", every: 2, unit: "days" }, start).getTime(),
        start.getTime() + 2 * 24 * 60 * 60_000,
      );
    });

    it("rejects invalid interval values and units", function () {
      assert.throws(() => normalizeSchedule(null), /Schedule is required/);
      assert.throws(
        () => normalizeSchedule({ kind: "interval", every: 0, unit: "minutes" }),
        /between 1 and 10,080/,
      );
      assert.throws(
        () => normalizeSchedule({ kind: "interval", every: 1.5, unit: "hours" }),
        /between 1 and 10,080/,
      );
      assert.throws(
        () => normalizeSchedule({ kind: "interval", every: 1, unit: "weeks" }),
        /Unknown interval unit/,
      );
      assert.throws(
        () => normalizeSchedule({ kind: "interval", every: 366, unit: "days" }),
        /cannot exceed one year/,
      );
      assert.throws(
        () => nextScheduledAt(
          { kind: "interval", every: 1, unit: "hours" },
          new Date("not-a-date"),
        ),
        /Invalid schedule start time/,
      );
      assert.throws(
        () => normalizeSchedule({ kind: "calendar", every: 1, unit: "days" }),
        /interval or cron/,
      );
    });
  });

  describe("cron schedules", function () {
    it("parses lists, ranges, steps, and Sunday aliases", function () {
      const parsed = parseCron("*/15 9-17/2 1,15 1-12/3 5-7");
      assert.strictEqual(parsed.expression, "*/15 9-17/2 1,15 1-12/3 5-7");
      assert.deepEqual(sorted(parsed.minutes), [0, 15, 30, 45]);
      assert.deepEqual(sorted(parsed.hours), [9, 11, 13, 15, 17]);
      assert.deepEqual(sorted(parsed.days), [1, 15]);
      assert.deepEqual(sorted(parsed.months), [1, 4, 7, 10]);
      assert.deepEqual(sorted(parsed.weekdays), [0, 5, 6]);
      assert.strictEqual(parsed.dayWildcard, false);
      assert.strictEqual(parsed.weekdayWildcard, false);
    });

    it("normalizes whitespace and returns the next local wall-clock minute", function () {
      assert.deepEqual(
        normalizeSchedule({ kind: "cron", expression: "  0   10  * * * " }),
        { kind: "cron", expression: "0 10 * * *" },
      );

      const after = new Date(2026, 0, 15, 9, 0, 30, 250);
      const next = nextScheduledAt({ kind: "cron", expression: "0 10 * * *" }, after);
      assert.deepEqual(
        [next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes(), next.getSeconds()],
        [2026, 0, 15, 10, 0, 0],
      );
    });

    it("uses weekday-only and day-of-month-only semantics when the other field is wildcard", function () {
      const sunday = new Date(2026, 5, 14, 10, 0, 0, 0);
      assert.strictEqual(sunday.getDay(), 0);

      const monday = nextScheduledAt({ kind: "cron", expression: "0 9 * * 1" }, sunday);
      assert.deepEqual(
        [monday.getFullYear(), monday.getMonth(), monday.getDate(), monday.getHours(), monday.getMinutes()],
        [2026, 5, 15, 9, 0],
      );

      const fifteenth = nextScheduledAt({ kind: "cron", expression: "0 9 15 * *" }, sunday);
      assert.deepEqual(
        [fifteenth.getFullYear(), fifteenth.getMonth(), fifteenth.getDate(), fifteenth.getHours(), fifteenth.getMinutes()],
        [2026, 5, 15, 9, 0],
      );
    });

    it("uses cron OR semantics when day-of-month and weekday are both restricted", function () {
      const julyFirst = new Date(2026, 6, 1, 10, 0, 0, 0);
      assert.strictEqual(julyFirst.getDay(), 3);

      const next = nextScheduledAt({ kind: "cron", expression: "0 9 15 * 1" }, julyFirst);
      assert.deepEqual(
        [next.getFullYear(), next.getMonth(), next.getDate(), next.getDay(), next.getHours(), next.getMinutes()],
        [2026, 6, 6, 1, 9, 0],
      );
    });

    it("treats weekday 7 as Sunday", function () {
      const saturday = new Date(2026, 5, 13, 10, 0, 0, 0);
      assert.strictEqual(saturday.getDay(), 6);
      const next = nextScheduledAt({ kind: "cron", expression: "0 9 * * 7" }, saturday);
      assert.deepEqual(
        [next.getFullYear(), next.getMonth(), next.getDate(), next.getDay(), next.getHours()],
        [2026, 5, 14, 0, 9],
      );
    });

    it("rejects malformed cron expressions", function () {
      assert.throws(() => parseCron("0 9 * *"), /five fields/);
      assert.throws(() => parseCron("60 9 * * *"), /out of range/);
      assert.throws(() => parseCron("0 24 * * *"), /out of range/);
      assert.throws(() => parseCron("0 9 0 * *"), /out of range/);
      assert.throws(() => parseCron("0 9 * 13 *"), /out of range/);
      assert.throws(() => parseCron("0 9 * * 8"), /out of range/);
      assert.throws(() => parseCron("*/0 9 * * *"), /positive integers/);
      assert.throws(() => parseCron("10-5 9 * * *"), /out of range/);
      assert.throws(() => parseCron("soon 9 * * *"), /support/);
    });
  });

  describe("display helpers", function () {
    it("labels normalized interval and cron schedules", function () {
      assert.strictEqual(
        scheduleLabel({ kind: "interval", every: 1, unit: "minutes" }),
        "Every minute",
      );
      assert.strictEqual(
        scheduleLabel({ kind: "interval", every: 4, unit: "hours" }),
        "Every 4 hours",
      );
      assert.strictEqual(
        scheduleLabel({ kind: "cron", expression: " 0  9 * * 1 " }),
        "0 9 * * 1",
      );
    });

    it("turns skill names into stable provider-safe slugs", function () {
      assert.strictEqual(slugifySkill("  Decision Bríef / V2  "), "decision-brief-v2");
      assert.strictEqual(slugifySkill("Already-safe"), "already-safe");
      assert.strictEqual(slugifySkill("---"), "");
      assert.strictEqual(slugifySkill(null), "");
      assert.strictEqual(slugifySkill("A".repeat(80)), "a".repeat(64));
      assert.match(slugifySkill("Evidence + Counterargument"), /^[a-z0-9-]{1,64}$/);
    });
  });

  describe("mission runtime states", function () {
    it("distinguishes an unavailable session, ready idle, and queued operator work", function () {
      assert.deepInclude(deriveRuntimeState(null), {
        key: "loading", label: "Loading", runtimePhase: "idle",
      });
      assert.deepInclude(deriveRuntimeState({ phase: "idle", agent: "orchestrator" }), {
        key: "ready", label: "Ready", agent: null,
      });
      assert.deepInclude(deriveRuntimeState(
        { phase: "idle", agent: "orchestrator" },
        [{ seq: 1, role: "user", content: "@critic review this", to: "m:critic" }],
      ), {
        key: "loading", label: "Loading", detail: "Queued", agent: "critic",
      });
      assert.deepInclude(deriveRuntimeState(
        { phase: "idle", agent: "orchestrator" },
        [{ seq: 2, role: "user", kind: "crew-note", content: "Decision logged" }],
      ), {
        key: "ready", label: "Ready", agent: null,
      });
    });

    it("moves a streaming turn from thinking to responding when text arrives", function () {
      const session = { phase: "streaming", agent: "orchestrator" };
      assert.deepInclude(deriveRuntimeState(session, [{
        seq: 1, role: "assistant", content: "", streaming: true,
        from: { participant: "m:researcher" },
      }]), {
        key: "thinking", label: "Thinking", agent: "researcher",
      });
      assert.deepInclude(deriveRuntimeState(session, [{
        seq: 1, role: "assistant", content: "Drafting", streaming: true,
        from: { participant: "m:researcher" },
      }]), {
        key: "working", label: "Working", detail: "Responding", agent: "researcher",
      });
    });

    it("attributes a live delegated run from its exact parent tool call", function () {
      const state = deriveRuntimeState(
        {
          phase: "calling",
          agent: "orchestrator",
          activeChild: { sessionId: "child-1", toolCallId: "call-1" },
        },
        [{
          seq: 1,
          role: "assistant",
          content: "Delegating",
          toolCalls: [{ id: "call-1", name: "researcher", args: { prompt: "Inspect" } }],
          from: { participant: "m:orchestrator" },
        }],
      );
      assert.deepInclude(state, {
        key: "working", label: "Working", detail: "researcher run", agent: "researcher",
      });
    });

    it("maps approval, retry, and durable wake markers to waiting or loading", function () {
      assert.deepInclude(deriveRuntimeState({
        phase: "awaiting",
        agent: "orchestrator",
        pending: { name: "publish_brief", agent: "orchestrator" },
      }), {
        key: "waiting", label: "Approval needed", detail: "Approval · publish brief",
      });
      assert.deepInclude(deriveRuntimeState({ phase: "retrying", agent: "orchestrator" }), {
        key: "retrying", label: "Retrying",
      });
      assert.deepInclude(deriveRuntimeState({
        phase: "idle", agent: "orchestrator", pendingSystem: { agent: "critic" },
      }), {
        key: "loading", detail: "Pulse queued", agent: "critic",
      });
      assert.deepInclude(deriveRuntimeState({
        phase: "idle", agent: "orchestrator", pendingRelay: { agent: "operator" },
      }), {
        key: "loading", detail: "Handoff queued", agent: "operator",
      });
    });

    it("surfaces terminal states and the latest transcript error", function () {
      assert.deepInclude(deriveRuntimeState(
        { phase: "error", agent: "orchestrator" },
        [{ seq: 1, role: "assistant", kind: "error", error: { reason: "Provider unavailable" } }],
      ), {
        key: "error", label: "Error", detail: "Provider unavailable",
      });
      assert.deepInclude(deriveRuntimeState({ phase: "stopped", agent: "orchestrator" }), {
        key: "stopped", label: "Stopped", detail: "Run stopped",
      });
    });
  });

  describe("channel schemas", function () {
    it("exposes only the fixed adapter allowlist", function () {
      assert.deepEqual(CHANNEL_KINDS, ["slack", "telegram", "whatsapp", "sms", "email"]);
      assert.strictEqual(Object.isFrozen(CHANNEL_KINDS), true);
      assert.strictEqual(Object.isFrozen(CHANNEL_SCHEMAS), true);
      assert.deepEqual(Object.keys(CHANNEL_SCHEMAS), CHANNEL_KINDS);
    });

    it("keeps credential metadata immutable and free of credential values", function () {
      const allowedFieldKeys = new Set(["key", "label", "secret", "placeholder", "type"]);
      for (const kind of CHANNEL_KINDS) {
        const schema = CHANNEL_SCHEMAS[kind];
        assert.strictEqual(Object.isFrozen(schema), true, `${kind} schema must be frozen`);
        assert.strictEqual(Object.isFrozen(schema.fields), true, `${kind} fields must be frozen`);
        assert.ok(schema.label.length > 0);
        assert.ok(schema.fields.length > 0);

        const names = new Set();
        for (const field of schema.fields) {
          assert.match(field.key, /^[a-z][A-Za-z0-9]*$/);
          assert.ok(field.label.length > 0);
          assert.strictEqual(typeof field.secret, "boolean");
          assert.strictEqual(names.has(field.key), false, `${kind}.${field.key} must be unique`);
          names.add(field.key);
          assert.ok(Object.keys(field).every((key) => allowedFieldKeys.has(key)));
          assert.strictEqual("value" in field, false);
          assert.strictEqual("default" in field, false);
          if (field.type !== undefined) assert.ok(["email", "url"].includes(field.type));
        }
      }
    });

    it("marks every actual channel credential as secret", function () {
      const flags = Object.fromEntries(CHANNEL_KINDS.map((kind) => [
        kind,
        Object.fromEntries(CHANNEL_SCHEMAS[kind].fields.map((field) => [field.key, field.secret])),
      ]));
      assert.deepEqual(flags, {
        slack: { botToken: true, signingSecret: true },
        telegram: { botToken: true, webhookSecret: true },
        whatsapp: { accessToken: true, appSecret: true, verifyToken: true },
        sms: { accountSid: true, authToken: true, webhookUrl: false },
        email: {
          serverToken: true,
          from: false,
          inboundAddress: false,
          webhookUser: true,
          webhookPassword: true,
        },
      });
    });
  });
});

if (Meteor.isClient) {
  describe("Constellation control methods", function () {
    this.timeout(20_000);

    before(async function () {
      const started = Date.now();
      while (!Meteor.userId() && Date.now() - started < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(Meteor.userId(), "the local test identity should be ready");
      await Meteor.callAsync("constellation.bootstrap");
    });

    it("exposes truthful Agent learning controls and recovery actions", function () {
      assert.strictEqual(document.getElementById("crew-experience-recent")?.min, "1");
      for (const id of [
        "crew-experience-automatic",
        "crew-practice-acquire",
        "crew-practice-automatic",
        "crew-practice-scoped-promotion",
      ]) {
        const control = document.getElementById(id);
        assert.instanceOf(control, HTMLInputElement, `${id} should be a form control`);
        assert.strictEqual(control.type, "checkbox");
      }
      assert.strictEqual(
        document.getElementById("crew-experience-automatic")?.getAttribute("aria-describedby"),
        "crew-experience-automatic-hint",
      );
      assert.strictEqual(
        document.getElementById("crew-practice-automatic")?.getAttribute("aria-describedby"),
        "crew-practice-automatic-hint",
      );
      assert.strictEqual(
        document.getElementById("crew-practice-scoped-promotion")?.getAttribute("aria-describedby"),
        "crew-practice-scoped-promotion-hint",
      );
      assert.strictEqual(
        document.getElementById("experience-learning-settings")?.getAttribute("aria-labelledby"),
        "experience-learning-settings-title",
      );
      assert.strictEqual(
        document.getElementById("practice-learning-settings")?.getAttribute("aria-labelledby"),
        "practice-learning-settings-title",
      );
      assert.include(
        document.getElementById("crew-learning-next-turn-note")?.textContent ?? "",
        "next turn",
      );
      assert.ok(document.getElementById("agent-detail-tab-frames"));
      assert.ok(document.getElementById("restore-crew-agent-learning"));
      assert.ok(document.getElementById("experience-policy-badge"));
      assert.ok(document.getElementById("practice-policy-badge"));
      assert.strictEqual(
        document.querySelector('[data-learning-configure="experience"]')?.getAttribute("aria-label"),
        "Configure Experience learning",
      );
      assert.strictEqual(
        document.getElementById("reviews-list")?.getAttribute("aria-live"),
        "polite",
      );
      assert.strictEqual(document.getElementById("reviews-list")?.getAttribute("role"), "list");
      assert.strictEqual(document.getElementById("reviews-recent-list")?.getAttribute("role"), "list");
      assert.strictEqual(
        document.getElementById("reviews-needs-title")?.textContent,
        "Needs attention",
      );
      assert.strictEqual(
        document.getElementById("reviews-recent-title")?.textContent,
        "Recent learning",
      );
      assert.strictEqual(
        document.getElementById("open-learning-reviews")?.getAttribute("aria-controls"),
        "crew-dialog",
      );
      assert.strictEqual(
        document.querySelector('[data-command="reviews"]')?.textContent.includes("Learning reviews"),
        true,
      );
      assert.strictEqual(
        document.getElementById("memory-frame-list")?.getAttribute("aria-live"),
        "polite",
      );
      assert.strictEqual(
        document.getElementById("agent-learning-error")?.getAttribute("role"),
        "alert",
      );
      assert.strictEqual(
        document.getElementById("agent-learning-error-action")?.type,
        "button",
      );
      assert.include(
        document.getElementById("practice-scope-note")?.textContent ?? "",
        "Agent-identity-wide",
      );
      assert.include(
        document.getElementById("agent-experience-stat")?.nextElementSibling?.textContent ?? "",
        "Experience active",
      );
      assert.strictEqual(
        document.getElementById("crew-settings-list")?.getAttribute("role"),
        "listbox",
      );
      assert.strictEqual(
        document.getElementById("crew-new-agent")?.getAttribute("aria-controls"),
        "crew-form",
      );
      assert.isNull(
        document.getElementById("add-crew-agent"),
        "Directory should expose one unambiguous add-Agent action",
      );
      assert.strictEqual(
        document.getElementById("mission-more-trigger")?.getAttribute("aria-haspopup"),
        "menu",
      );
      assert.include(document.getElementById("compact-mission")?.textContent ?? "", "Reduce context");
      assert.strictEqual(document.getElementById("constitution-compose")?.tagName, "DETAILS");
      assert.strictEqual(document.getElementById("practice-compose")?.tagName, "DETAILS");
      assert.ok(document.getElementById("constitution-draft-state"));
      assert.ok(document.getElementById("practice-draft-state"));
      assert.strictEqual(document.getElementById("pulse-schedule-preview")?.getAttribute("role"), "status");
      assert.strictEqual(
        document.getElementById("toast-region")?.getAttribute("popover"),
        "manual",
        "toasts need their own browser top-layer host",
      );
      const missionApprovalCopy = document.getElementById("mission-config-approvals")
        ?.closest("label")?.textContent ?? "";
      assert.include(missionApprovalCopy, "Require approval for mission-controlled actions");
      assert.include(missionApprovalCopy, "Other tool approval policies stay unchanged");
      assert.notMatch(missionApprovalCopy, /Atlas|Publish brief/i);
    });

    it("routes Memory and local account controls to existing workspace surfaces", async function () {
      await waitUntil(
        () => document.getElementById("app-frame")?.dataset.startupState === "ready",
        "Constellation client did not finish startup",
      );
      const shell = document.getElementById("workspace-shell");
      const crewDialog = document.getElementById("crew-dialog");
      const accountDialog = document.getElementById("account-dialog");
      document.querySelector('[data-view="memory"]').click();
      assert.strictEqual(shell.dataset.currentView, "memory");
      assert.strictEqual(
        document.getElementById("memory-hub-nav")?.getAttribute("aria-label"),
        "Memory sections",
      );
      assert.strictEqual(
        document.getElementById("memory-facts-current")?.getAttribute("aria-current"),
        "page",
      );
      assert.match(document.getElementById("memory-reviews-count")?.textContent ?? "", /^(—|\d+)$/);

      document.getElementById("memory-open-agent-learning").click();
      await waitUntil(() => crewDialog.open, "Agent learning did not open the Directory");
      assert.strictEqual(
        document.getElementById("crew-directory-tab-agents")?.getAttribute("aria-selected"),
        "true",
      );
      assert.strictEqual(
        document.getElementById("agent-detail-tab-experience")?.getAttribute("aria-selected"),
        "true",
      );
      document.getElementById("close-crew-dialog").click();
      await waitUntil(() => !crewDialog.open, "Directory did not close");

      document.getElementById("memory-open-reviews").click();
      await waitUntil(() => crewDialog.open, "Memory Reviews did not open the Directory");
      assert.strictEqual(
        document.getElementById("crew-directory-tab-reviews")?.getAttribute("aria-selected"),
        "true",
      );
      document.getElementById("close-crew-dialog").click();
      await waitUntil(() => !crewDialog.open, "Reviews did not close");

      const profile = document.getElementById("profile-button");
      assert.strictEqual(profile.getAttribute("aria-haspopup"), "dialog");
      assert.strictEqual(profile.getAttribute("aria-controls"), "account-dialog");
      profile.click();
      await waitUntil(() => accountDialog.open, "Local workspace details did not open");
      assert.include(accountDialog.textContent, "Workspace owner");
      assert.include(accountDialog.textContent, "This local workspace");
      assert.include(accountDialog.textContent, document.getElementById("runtime-label").textContent);
      assert.strictEqual(accountDialog.querySelectorAll('input[type="password"]').length, 0);

      document.getElementById("account-open-channels").click();
      assert.isFalse(accountDialog.open);
      assert.strictEqual(shell.dataset.currentView, "channels");

      profile.click();
      await waitUntil(() => accountDialog.open, "Local workspace details did not reopen");
      document.getElementById("account-open-directory").click();
      await waitUntil(() => crewDialog.open, "Account Directory action did not open");
      assert.strictEqual(
        document.getElementById("crew-directory-tab-people")?.getAttribute("aria-selected"),
        "true",
      );
      document.getElementById("close-crew-dialog").click();
      document.querySelector('[data-view="missions"]').click();
    });

    it("exposes consistent dirty-state status for configuration editors", function () {
      for (const id of [
        "mission-form-status",
        "pulse-form-status",
        "skill-form-status",
        "mcp-form-status",
        "channel-form-status",
      ]) {
        const status = document.getElementById(id);
        assert.instanceOf(status, HTMLElement, `${id} should be visible editor status`);
        assert.strictEqual(status.getAttribute("role"), "status");
        assert.strictEqual(status.getAttribute("aria-live"), "polite");
      }
    });

    it("creates an MCP server with Save & test and exposes tool selection in place", async function () {
      const mcp = Mongo.getCollection("constellation_mcp_configs");
      const dialog = document.getElementById("mcp-dialog");
      const form = document.getElementById("mcp-form");
      const submit = document.getElementById("mcp-submit");
      let configId = null;
      try {
        await waitUntil(
          () => document.getElementById("app-frame")?.dataset.startupState === "ready",
          "Constellation client did not finish startup",
        );
        document.getElementById("add-mcp-server").click();
        await waitUntil(() => dialog.open, "MCP editor did not open");
        assert.strictEqual(submit.textContent, "Save & test");
        assert.isTrue(document.getElementById("mcp-trust-local").required);
        assert.isTrue(document.getElementById("mcp-test-discover").disabled);

        const setValue = (id, value) => {
          const control = document.getElementById(id);
          control.value = value;
          control.dispatchEvent(new Event("input", { bubbles: true }));
        };
        setValue("mcp-name", `MCP setup flow ${Random.id(6)}`);
        setValue("mcp-command", "node");
        for (const argument of ["-e", MCP_TEST_SERVER]) {
          document.getElementById("add-mcp-arg").click();
          const rows = document.querySelectorAll('#mcp-args-rows [name="mcpArg"]');
          const input = rows[rows.length - 1];
          input.value = argument;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const trust = document.getElementById("mcp-trust-local");
        trust.checked = true;
        trust.dispatchEvent(new Event("change", { bubbles: true }));
        const enabled = document.getElementById("mcp-enabled");
        enabled.checked = true;
        enabled.dispatchEvent(new Event("change", { bubbles: true }));
        assert.isFalse(submit.disabled);

        submit.click();
        await waitUntil(
          () => document.getElementById("mcp-server-id").value
            && document.querySelectorAll("#mcp-tool-options input").length === 2
            && !form.inert,
          "Save & test did not expose discovered MCP tools",
          15_000,
        );
        configId = document.getElementById("mcp-server-id").value;
        await waitUntil(() => mcp.findOne(configId), "Created MCP server did not publish");
        assert.isTrue(dialog.open, "Save & test should keep the editor open");
        await waitUntil(
          () => document.getElementById("toast-region").matches(":popover-open")
            && document.getElementById("toast-region").textContent.includes("tools discovered")
            && document.getElementById("toast-region").parentElement === dialog,
          "MCP result toast did not enter the top layer above its open dialog",
        );
        assert.isFalse(mcp.findOne(configId).enabled, "initial creation must stay disabled");
        assert.isTrue(enabled.checked, "the requested enable step should remain visible");
        assert.strictEqual(submit.textContent, "Enable server");
        assert.strictEqual(form.dataset.dirty, "true");
        assert.strictEqual(
          form.querySelector('[data-error-code="mcp-no-selected-tools"]')?.textContent.includes(
            "Choose at least one discovered tool",
          ),
          true,
        );

        const runtimeTool = [...document.querySelectorAll("#mcp-tool-options input")]
          .find((input) => input.value === "runtime_status");
        assert.ok(runtimeTool, "runtime_status should be selectable without reopening the editor");
        runtimeTool.checked = true;
        runtimeTool.dispatchEvent(new Event("change", { bubbles: true }));
        assert.notExists(form.querySelector('[data-error-code="mcp-no-selected-tools"]'));
        assert.isFalse(submit.disabled);

        submit.click();
        await waitUntil(() => !dialog.open, "Enable server did not finish");
        await waitUntil(
          () => mcp.findOne(configId)?.enabled === true,
          "Selected MCP server was not enabled",
        );
        assert.deepEqual(mcp.findOne(configId).selectedTools, ["runtime_status"]);
      } finally {
        if (dialog.open) dialog.close();
        const current = configId && mcp.findOne(configId);
        if (current) await Meteor.callAsync("constellation.mcpRemove", configId, current.revision);
      }
    });

    it("keeps an MCP draft and guarded baseline after discovery fails", async function () {
      const mcp = Mongo.getCollection("constellation_mcp_configs");
      const dialog = document.getElementById("mcp-dialog");
      const form = document.getElementById("mcp-form");
      const submit = document.getElementById("mcp-submit");
      const nameValue = `Unavailable MCP ${Random.id(6)}`;
      const commandValue = `constellation-missing-command-${Random.id(6)}`;
      let configId = null;
      try {
        document.getElementById("add-mcp-server").click();
        await waitUntil(() => dialog.open, "MCP editor did not reopen");
        const name = document.getElementById("mcp-name");
        const command = document.getElementById("mcp-command");
        name.value = nameValue;
        name.dispatchEvent(new Event("input", { bubbles: true }));
        command.value = commandValue;
        command.dispatchEvent(new Event("input", { bubbles: true }));
        const timeout = document.getElementById("mcp-timeout-ms");
        timeout.value = "500";
        timeout.dispatchEvent(new Event("input", { bubbles: true }));
        const trust = document.getElementById("mcp-trust-local");
        trust.checked = true;
        trust.dispatchEvent(new Event("change", { bubbles: true }));

        submit.click();
        await waitUntil(
          () => document.getElementById("mcp-server-id").value
            && document.getElementById("mcp-dialog-runtime-status").textContent.includes("Unavailable")
            && !form.inert,
          "Failed MCP discovery did not return control to the editor",
          15_000,
        );
        configId = document.getElementById("mcp-server-id").value;
        await waitUntil(() => mcp.findOne(configId), "Failed-test MCP server did not publish");
        assert.isTrue(dialog.open);
        assert.strictEqual(name.value, nameValue);
        assert.strictEqual(command.value, commandValue);
        assert.strictEqual(timeout.value, "500");
        assert.strictEqual(submit.textContent, "Save server");
        assert.strictEqual(form.dataset.dirty, "false");
        assert.strictEqual(document.getElementById("mcp-form-status").textContent, "Saved");
        assert.strictEqual(mcp.findOne(configId).revision, 1);
        assert.isFalse(mcp.findOne(configId).enabled);
        assert.ok(form.querySelector(":scope > .form-inline-error"));
      } finally {
        if (dialog.open) dialog.close();
        const current = configId && mcp.findOne(configId);
        if (current) await Meteor.callAsync("constellation.mcpRemove", configId, current.revision);
      }
    });

    it("keeps an unsaved editor open until discard is confirmed", async function () {
      const dialog = document.getElementById("pulse-dialog");
      const form = document.getElementById("pulse-form");
      const name = document.getElementById("pulse-name");
      const status = document.getElementById("pulse-form-status");
      const cancel = document.getElementById("cancel-pulse-edit");
      const submit = form.querySelector('[type="submit"]');
      const originalConfirm = window.confirm;
      const decisions = [false, false, true];
      let confirmations = 0;
      window.confirm = () => {
        confirmations += 1;
        return decisions.shift();
      };
      try {
        await waitUntil(
          () => document.getElementById("app-frame")?.dataset.startupState === "ready",
          "Constellation client did not finish startup",
        );
        document.getElementById("add-pulse").click();
        await waitUntil(() => dialog.open, "Pulse editor did not open");
        assert.isTrue(submit.disabled, "an unchanged editor should not offer a no-op save");

        name.value = "Unsaved guard test";
        name.dispatchEvent(new Event("input", { bubbles: true }));
        assert.strictEqual(form.dataset.dirty, "true");
        assert.strictEqual(status.textContent, "Unsaved changes");
        assert.strictEqual(cancel.textContent, "Discard changes");
        assert.isFalse(submit.disabled);

        document.getElementById("close-pulse-dialog").click();
        assert.isTrue(dialog.open, "Close should preserve a draft when discard is declined");
        assert.strictEqual(name.value, "Unsaved guard test");

        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        assert.isTrue(dialog.open, "Escape should preserve a draft when discard is declined");

        cancel.click();
        assert.isFalse(dialog.open, "Cancel should close after discard is confirmed");
        assert.strictEqual(confirmations, 3);
      } finally {
        window.confirm = originalConfirm;
        if (dialog.open) dialog.close();
      }
    });

    it("keeps Crew save actions visible on Learning tabs and guards Archive", async function () {
      const crew = Mongo.getCollection("constellation_crew_configs");
      const dialog = document.getElementById("crew-dialog");
      const originalConfirm = window.confirm;
      window.confirm = () => false;
      try {
        document.getElementById("configure-crew").click();
        await waitUntil(() => dialog.open, "Crew editor did not open");
        const config = crew.find({ agent: { $ne: "orchestrator" }, status: { $ne: "archived" } })
          .fetch()[0];
        assert.ok(config, "a configurable workspace Agent should be available");
        const row = [...document.querySelectorAll(".crew-settings-row")]
          .find((candidate) => candidate.dataset.configId === config._id);
        assert.ok(row, "the configurable Agent should be listed");
        row.click();

        const name = document.getElementById("crew-name");
        name.value = `${name.value} draft`;
        name.dispatchEvent(new Event("input", { bubbles: true }));
        assert.strictEqual(document.getElementById("crew-edit-state").textContent, "Unsaved changes");

        document.getElementById("agent-detail-tab-experience").click();
        assert.isFalse(
          document.getElementById("crew-form-actions").hidden,
          "save and discard should remain visible while Profile changes are pending",
        );
        assert.isFalse(document.querySelector('#crew-form [type="submit"]').disabled);

        document.getElementById("archive-crew-agent").click();
        assert.isFalse(
          document.getElementById("crew-archive-dialog").open,
          "Archive impact should not replace an unconfirmed draft",
        );
        assert.strictEqual(name.value, `${config.displayName} draft`);
      } finally {
        window.confirm = () => true;
        if (dialog.open) document.getElementById("cancel-crew-edit").click();
        window.confirm = originalConfirm;
      }
    });

    it("owner-gates Agent learning mutations to Crew identities", async function () {
      let error;
      try {
        await Meteor.callAsync(
          "constellation.constitutionRevise",
          "not-a-workspace-agent",
          1,
          "Untrusted constitution",
          "Authorization test",
        );
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "not-authorized");
    });

    it("requires hardening evidence only for the harden transition", async function () {
      let missingEvidence;
      try {
        await Meteor.callAsync(
          "constellation.practiceTransition",
          "input-contract-agent",
          "input-contract-practice",
          "hardened",
          "Exercise the hardening evidence contract.",
        );
      } catch (error) {
        missingEvidence = error;
      }
      assert.strictEqual(missingEvidence?.error, "invalid-practice-transition");

      let misplacedEvidence;
      try {
        await Meteor.callAsync(
          "constellation.practiceTransition",
          "input-contract-agent",
          "input-contract-practice",
          "rejected",
          "Exercise the non-hardening evidence contract.",
          "unexpected-experience",
        );
      } catch (error) {
        misplacedEvidence = error;
      }
      assert.strictEqual(misplacedEvidence?.error, "invalid-practice-transition");
    });

    it("persists versioned Mission configuration and synchronizes the session title", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission config test" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const saved = await Meteor.callAsync(
        "constellation.missionSave",
        sessionId,
        1,
        {
          title: "Configured mission",
          objective: "Ship one verified local workflow.",
          status: "active",
          primaryAgent: "orchestrator",
          budget: { turns: 42, toolCalls: 12, spend: 3.5 },
          autoTitle: false,
          continuity: false,
          approvals: true,
        },
      );
      assert.strictEqual(saved.revision, 2);
      assert.strictEqual(saved.objective, "Ship one verified local workflow.");
      assert.deepEqual(saved.budget, { turns: 42, toolCalls: 12, spend: 3.5 });
      assert.strictEqual(saved.continuity, false);
      assert.strictEqual(AgentSessions.findOne(sessionId)?.title, "Configured mission");

      const pulseId = await Meteor.callAsync("constellation.pulseCreate", {
        name: "Mission state test pulse",
        prompt: "Return a mission state test receipt.",
        agent: "orchestrator",
        sessionId,
        schedule: { kind: "interval", every: 1, unit: "hours" },
        enabled: true,
      });
      const paused = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 2, { status: "paused" },
      );
      assert.strictEqual(paused.revision, 3);
      assert.deepEqual(
        await Meteor.callAsync("constellation.pulseRun", pulseId),
        { ok: false, reason: "mission-inactive" },
      );
      const active = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 3, { status: "active" },
      );
      assert.strictEqual(active.revision, 4);
      assert.strictEqual((await Meteor.callAsync("constellation.pulseRun", pulseId)).ok, true);
      const completed = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 4, { status: "completed" },
      );
      assert.strictEqual(completed.revision, 5);
      assert.deepEqual(
        await Meteor.callAsync("constellation.pulseRun", pulseId),
        { ok: false, reason: "mission-inactive" },
      );
      const reactivated = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 5, { status: "active" },
      );
      assert.strictEqual(reactivated.revision, 6);
      assert.strictEqual(await Meteor.callAsync("constellation.pulseRemove", pulseId, 5), true);

      let error;
      try {
        await Meteor.callAsync("constellation.missionSave", sessionId, 1, { title: "Stale" });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "stale-mission");
    });

    it("archives a Mission off the list by completing it first, and Reactivate returns it", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission archive test" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const pulseId = await Meteor.callAsync("constellation.pulseCreate", {
        name: "Mission archive test pulse",
        prompt: "Return a mission archive test receipt.",
        agent: "orchestrator",
        sessionId,
        schedule: { kind: "interval", every: 1, unit: "hours" },
        enabled: true,
      });

      const archived = await Meteor.callAsync("constellation.missionArchive", sessionId);
      assert.strictEqual(archived.status, "completed", "archiving completes a running Mission first");
      assert.strictEqual(archived.continuity, false, "an archived Mission is never the resume candidate");
      assert.strictEqual(archived.revision, 2);
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.archived instanceof Date,
        "the session should carry the package's archived stamp",
      );
      assert.deepEqual(
        await Meteor.callAsync("constellation.pulseRun", pulseId),
        { ok: false, reason: "mission-inactive" },
      );
      let continuityError;
      try {
        await Meteor.callAsync("constellation.missionContinuitySet", sessionId, true);
      } catch (caught) {
        continuityError = caught;
      }
      assert.strictEqual(continuityError?.error, "mission-completed");

      const again = await Meteor.callAsync("constellation.missionArchive", sessionId);
      assert.strictEqual(again.revision, archived.revision, "archiving twice changes nothing");

      const restored = await Meteor.callAsync("constellation.missionUnarchive", sessionId);
      assert.strictEqual(restored.status, "completed", "unarchive lists the Mission again without reopening it");
      assert.strictEqual(restored.revision, archived.revision);
      await waitUntil(
        () => AgentSessions.findOne(sessionId) && !AgentSessions.findOne(sessionId).archived,
        "unarchive should clear the archived stamp",
      );

      await Meteor.callAsync("constellation.missionArchive", sessionId);
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.archived instanceof Date,
        "the session should be archived again",
      );
      const reactivated = await Meteor.callAsync(
        "constellation.missionSave", sessionId, restored.revision, { status: "active" },
      );
      assert.strictEqual(reactivated.status, "active");
      await waitUntil(
        () => AgentSessions.findOne(sessionId) && !AgentSessions.findOne(sessionId).archived,
        "reactivating an archived Mission must return it to the list",
      );
      assert.strictEqual((await Meteor.callAsync("constellation.pulseRun", pulseId)).ok, true);

      let missing;
      try {
        await Meteor.callAsync("constellation.missionArchive", Random.id());
      } catch (caught) {
        missing = caught;
      }
      assert.strictEqual(missing?.error, "no-session");
    });

    it("CRUDs people and configures human and agent Mission participants", async function () {
      const members = Mongo.getCollection("constellation_workspace_members")
        ?? new Mongo.Collection("constellation_workspace_members");
      const participation = Mongo.getCollection("constellation_mission_participation")
        ?? new Mongo.Collection("constellation_mission_participation");
      const externalUserId = `U_CLIENT_PRIVATE_${Random.id()}`;
      const directorySubscription = Meteor.subscribe("constellation.workspaceMembers");
      await waitUntil(
        () => directorySubscription.ready(),
        "Workspace people subscription did not become ready",
      );

      const memberId = await Meteor.callAsync("constellation.workspaceMemberCreate", {
        displayName: "Dana",
        title: "Product lead",
        identity: { kind: "slack", externalUserId },
      });
      await waitUntil(() => members.findOne(memberId), "Created person did not reach the client");
      const publishedMember = members.findOne(memberId);
      assert.deepEqual(Object.keys(publishedMember).sort(), [
        "_id", "connection", "createdAt", "displayName", "revision",
        "surfaceKinds", "title", "updatedAt",
      ]);
      assert.deepInclude(publishedMember, {
        displayName: "Dana",
        title: "Product lead",
        connection: "channel",
        surfaceKinds: ["slack"],
        revision: 1,
      });
      assert.notInclude(JSON.stringify(publishedMember), externalUserId);

      const saved = await Meteor.callAsync(
        "constellation.workspaceMemberSave",
        memberId,
        1,
        { displayName: "Dana Park", title: "Product" },
      );
      assert.deepInclude(saved, { displayName: "Dana Park", title: "Product", revision: 2 });
      assert.notInclude(JSON.stringify(saved), externalUserId);
      let staleError;
      try {
        await Meteor.callAsync(
          "constellation.workspaceMemberSave", memberId, 1, { title: "Stale" },
        );
      } catch (error) {
        staleError = error;
      }
      assert.strictEqual(staleError?.error, "stale-member");

      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission participation CRUD test" });
      const missionSubscription = workspace.subscribe(sessionId);
      await waitUntil(
        () => missionSubscription.ready(),
        "Mission participation transcript did not become ready",
      );
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const participationSubscription = Meteor.subscribe(
        "constellation.missionParticipation", sessionId,
      );
      await waitUntil(
        () => participationSubscription.ready() && participation.findOne(sessionId),
        "Mission participation projection did not become ready",
      );

      const withoutResearcher = await Meteor.callAsync(
        "constellation.missionAgentRemove", sessionId, "researcher",
      );
      assert.notInclude(
        withoutResearcher.participants.map((participant) => participant.agent).filter(Boolean),
        "researcher",
      );
      await waitUntil(
        () => !AgentSessions.findOne(sessionId)?.participants
          ?.some((participant) => participant.agent === "researcher"),
        "Removed Mission agent remained in the authoritative roster",
      );
      await workspace.send(sessionId, "Research this market for the Mission crew gate test.");
      await waitUntil(
        () => workspace.messages(sessionId).fetch().some(
          (message) => message.role === "tool"
            && message.error?.error === "not-allowed",
        ),
        "The final entitlement fence did not refuse a removed Mission agent",
      );
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "idle",
        "Denied Mission delegation did not settle",
      );
      const withResearcher = await Meteor.callAsync(
        "constellation.missionAgentAdd", sessionId, "researcher",
      );
      assert.include(
        withResearcher.participants.map((participant) => participant.agent).filter(Boolean),
        "researcher",
      );

      const withPerson = await Meteor.callAsync(
        "constellation.missionMemberAdd", sessionId, memberId,
      );
      assert.deepInclude(
        withPerson.participants.find((participant) => participant.memberId === memberId),
        {
          kind: "human",
          role: "participant",
          displayName: "Dana Park",
          connection: "channel",
          surfaceKinds: ["slack"],
        },
      );
      assert.notInclude(JSON.stringify(withPerson), externalUserId);
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.participants
          ?.some((participant) => participant.displayName === "Dana Park"),
        "Added person did not reach the authoritative Mission roster",
      );

      const renamed = await Meteor.callAsync(
        "constellation.workspaceMemberSave",
        memberId,
        2,
        { displayName: "Dana Lee" },
      );
      assert.strictEqual(renamed.revision, 3);
      await waitUntil(
        () => participation.findOne(sessionId)?.participants
          ?.some((participant) => participant.memberId === memberId
            && participant.displayName === "Dana Lee"),
        "Person rename did not update the Mission participation projection",
      );

      const withoutPerson = await Meteor.callAsync(
        "constellation.missionMemberRemove", sessionId, memberId,
      );
      assert.notOk(
        withoutPerson.participants.some((participant) => participant.memberId === memberId),
      );
      assert.strictEqual(
        await Meteor.callAsync("constellation.workspaceMemberRemove", memberId, 3),
        true,
      );
      await waitUntil(() => !members.findOne(memberId), "Removed person remained visible");

      participationSubscription.stop();
      missionSubscription.stop();
      directorySubscription.stop();
      workspace.stop(sessionId);
    });

    it("edits a person's private connection without changing Mission identity", async function () {
      const members = Mongo.getCollection("constellation_workspace_members")
        ?? new Mongo.Collection("constellation_workspace_members");
      const directorySubscription = Meteor.subscribe("constellation.workspaceMembers");
      await waitUntil(
        () => directorySubscription.ready(),
        "Editable connection directory subscription did not become ready",
      );
      const firstSlackIdentity = `U_EDIT_FIRST_${Random.id()}`;
      const conflictingIdentity = `U_EDIT_CONFLICT_${Random.id()}`;
      const telegramIdentity = `TG_EDIT_${Random.id()}`;
      const memberId = await Meteor.callAsync("constellation.workspaceMemberCreate", {
        displayName: "Sam",
        title: "Research",
      });
      const conflictingMemberId = await Meteor.callAsync(
        "constellation.workspaceMemberCreate",
        {
          displayName: "Taylor",
          title: "Review",
          identity: { kind: "slack", externalUserId: conflictingIdentity },
        },
      );
      await waitUntil(
        () => members.findOne(memberId) && members.findOne(conflictingMemberId),
        "Editable connection people did not reach the client",
      );

      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Editable connection Mission" });
      const transcriptSubscription = workspace.subscribe(sessionId);
      await waitUntil(
        () => transcriptSubscription.ready(),
        "Editable connection Mission transcript did not become ready",
      );
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      await Meteor.callAsync("constellation.missionMemberAdd", sessionId, memberId);
      const originalParticipant = AgentSessions.findOne(sessionId)?.participants
        ?.find((participant) => participant.displayName === "Sam");
      assert.ok(originalParticipant);
      const stableParticipantId = originalParticipant.id;
      assert.notProperty(originalParticipant, "identity");

      const connected = await Meteor.callAsync(
        "constellation.workspaceMemberSave",
        memberId,
        1,
        { identity: { kind: "slack", externalUserId: firstSlackIdentity } },
      );
      assert.deepInclude(connected, {
        _id: memberId,
        connection: "channel",
        surfaceKinds: ["slack"],
        revision: 2,
      });
      assert.notInclude(JSON.stringify(connected), firstSlackIdentity);
      await waitUntil(() => {
        const participant = AgentSessions.findOne(sessionId)?.participants
          ?.find((row) => row.id === stableParticipantId);
        return participant?.identity?.kind === "slack";
      }, "Unlinked person did not gain Channel authorization in its Mission roster");
      assert.notProperty(
        AgentSessions.findOne(sessionId).participants
          .find((row) => row.id === stableParticipantId).identity,
        "externalUserId",
      );

      const moved = await Meteor.callAsync(
        "constellation.workspaceMemberSave",
        memberId,
        2,
        { identity: { kind: "telegram", externalUserId: telegramIdentity } },
      );
      assert.deepInclude(moved, {
        connection: "channel",
        surfaceKinds: ["telegram"],
        revision: 3,
      });
      assert.notInclude(JSON.stringify(moved), telegramIdentity);
      await waitUntil(() => {
        const participant = AgentSessions.findOne(sessionId)?.participants
          ?.find((row) => row.id === stableParticipantId);
        return participant?.identity?.kind === "telegram";
      }, "Changed Channel identity did not reconcile the Mission roster");

      let conflictError;
      try {
        await Meteor.callAsync(
          "constellation.workspaceMemberSave",
          memberId,
          3,
          { identity: { kind: "slack", externalUserId: conflictingIdentity } },
        );
      } catch (error) {
        conflictError = error;
      }
      assert.strictEqual(conflictError?.error, "member-exists");
      assert.strictEqual(members.findOne(memberId).revision, 3);
      assert.strictEqual(
        AgentSessions.findOne(sessionId).participants
          .find((row) => row.id === stableParticipantId).identity?.kind,
        "telegram",
      );

      let staleError;
      try {
        await Meteor.callAsync(
          "constellation.workspaceMemberSave", memberId, 2, { clearIdentity: true },
        );
      } catch (error) {
        staleError = error;
      }
      assert.strictEqual(staleError?.error, "stale-member");
      assert.strictEqual(members.findOne(memberId).revision, 3);

      const cleared = await Meteor.callAsync(
        "constellation.workspaceMemberSave", memberId, 3, { clearIdentity: true },
      );
      assert.deepInclude(cleared, {
        connection: "unlinked",
        surfaceKinds: [],
        revision: 4,
      });
      await waitUntil(() => {
        const participant = AgentSessions.findOne(sessionId)?.participants
          ?.find((row) => row.id === stableParticipantId);
        return participant && !participant.identity && !participant.userId;
      }, "Cleared Channel identity remained authorized in the Mission roster");
      assert.strictEqual(
        AgentSessions.findOne(sessionId).participants
          .find((row) => row.id === stableParticipantId).id,
        stableParticipantId,
      );

      assert.strictEqual(
        await Meteor.callAsync("constellation.workspaceMemberRemove", memberId, 4),
        true,
      );
      assert.strictEqual(
        await Meteor.callAsync("constellation.workspaceMemberRemove", conflictingMemberId, 1),
        true,
      );
      transcriptSubscription.stop();
      directorySubscription.stop();
      workspace.stop(sessionId);
    });

    it("saves an exact Mission crew once with revision, scope, and cap fences", async function () {
      const members = Mongo.getCollection("constellation_workspace_members")
        ?? new Mongo.Collection("constellation_workspace_members");
      const missions = Mongo.getCollection("constellation_mission_configs")
        ?? new Mongo.Collection("constellation_mission_configs");
      const directorySubscription = Meteor.subscribe("constellation.workspaceMembers");
      const missionConfigSubscription = Meteor.subscribe("constellation.missions");
      await waitUntil(
        () => directorySubscription.ready() && missionConfigSubscription.ready(),
        "Mission crew configuration subscriptions did not become ready",
      );
      const firstMemberId = await Meteor.callAsync("constellation.workspaceMemberCreate", {
        displayName: "Avery",
        title: "Design",
      });
      const secondMemberId = await Meteor.callAsync("constellation.workspaceMemberCreate", {
        displayName: "Morgan",
        title: "Operations",
      });
      await waitUntil(
        () => members.findOne(firstMemberId) && members.findOne(secondMemberId),
        "Mission crew test people did not reach the client",
      );

      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Atomic Mission crew test" });
      const transcriptSubscription = workspace.subscribe(sessionId);
      await waitUntil(
        () => transcriptSubscription.ready(),
        "Atomic Mission crew transcript did not become ready",
      );
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      await waitUntil(() => missions.findOne(sessionId), "Mission config did not reach the client");
      const startingRevision = missions.findOne(sessionId).revision;

      const custom = await Meteor.callAsync(
        "constellation.missionCrewSave",
        sessionId,
        startingRevision,
        { memberIds: [firstMemberId], agentMode: "custom", agents: ["critic"] },
      );
      assert.deepEqual(Object.keys(custom).sort(), ["agentMode", "participation", "revision"]);
      assert.strictEqual(custom.revision, startingRevision + 1);
      assert.strictEqual(custom.agentMode, "custom");
      assert.strictEqual(custom.participation.agentMode, "custom");
      assert.sameMembers(
        custom.participation.participants
          .filter((participant) => participant.kind === "agent")
          .map((participant) => participant.agent),
        ["orchestrator", "critic"],
      );
      assert.deepInclude(
        custom.participation.participants
          .find((participant) => participant.memberId === firstMemberId),
        { kind: "human", role: "participant", displayName: "Avery" },
      );
      assert.notOk(
        custom.participation.participants
          .some((participant) => participant.memberId === secondMemberId),
      );
      await waitUntil(
        () => missions.findOne(sessionId)?.revision === custom.revision,
        "Atomic Mission crew revision did not reach the client",
      );
      assert.deepEqual(missions.findOne(sessionId).agents, ["critic"]);
      assert.deepEqual(missions.findOne(sessionId).memberIds, [firstMemberId]);

      const impact = await Meteor.callAsync(
        "constellation.workspaceMemberImpact", firstMemberId,
      );
      assert.deepEqual(Object.keys(impact).sort(), ["displayName", "memberId", "missions"]);
      assert.deepInclude(impact, { memberId: firstMemberId, displayName: "Avery" });
      assert.deepInclude(
        impact.missions.find((mission) => mission.sessionId === sessionId),
        { title: "Atomic Mission crew test", status: "active" },
      );

      const rosterSignature = () => AgentSessions.findOne(sessionId)?.participants
        ?.map((participant) => participant.id).sort();
      const exactRoster = rosterSignature();
      let staleError;
      try {
        await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          startingRevision,
          { memberIds: [secondMemberId], agentMode: "custom", agents: ["operator"] },
        );
      } catch (error) {
        staleError = error;
      }
      assert.strictEqual(staleError?.error, "stale-mission");
      assert.deepEqual(rosterSignature(), exactRoster);

      let invalidMemberError;
      try {
        await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          custom.revision,
          { memberIds: ["missing-member"], agentMode: "custom", agents: ["critic"] },
        );
      } catch (error) {
        invalidMemberError = error;
      }
      assert.strictEqual(invalidMemberError?.error, "no-member");
      assert.strictEqual(missions.findOne(sessionId).revision, custom.revision);
      assert.deepEqual(rosterSignature(), exactRoster);

      let invalidAgentError;
      try {
        await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          custom.revision,
          { memberIds: [firstMemberId], agentMode: "custom", agents: ["missing-agent"] },
        );
      } catch (error) {
        invalidAgentError = error;
      }
      assert.strictEqual(invalidAgentError?.error, "no-agent");
      assert.strictEqual(missions.findOne(sessionId).revision, custom.revision);
      assert.deepEqual(rosterSignature(), exactRoster);

      let capError;
      try {
        await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          custom.revision,
          {
            memberIds: Array.from({ length: 15 }, (_, index) => `capacity-${index}`),
            agentMode: "inherit",
            agents: [],
          },
        );
      } catch (error) {
        capError = error;
      }
      assert.strictEqual(capError?.error, "mission-crew-full");
      assert.strictEqual(missions.findOne(sessionId).revision, custom.revision);
      assert.deepEqual(rosterSignature(), exactRoster);

      const inherited = await Meteor.callAsync(
        "constellation.missionCrewSave",
        sessionId,
        custom.revision,
        {
          memberIds: [firstMemberId, secondMemberId],
          agentMode: "inherit",
          agents: [],
        },
      );
      assert.strictEqual(inherited.agentMode, "inherit");
      assert.strictEqual(inherited.participation.agentMode, "inherit");
      assert.sameMembers(
        inherited.participation.participants
          .filter((participant) => participant.kind === "agent")
          .map((participant) => participant.agent),
        ["orchestrator", "researcher", "operator", "critic"],
      );
      await waitUntil(
        () => missions.findOne(sessionId)?.revision === inherited.revision,
        "Inherited Mission crew revision did not reach the client",
      );
      assert.notProperty(missions.findOne(sessionId), "agents");

      assert.strictEqual(
        await Meteor.callAsync("constellation.workspaceMemberRemove", firstMemberId, 1),
        true,
      );
      assert.strictEqual(
        await Meteor.callAsync("constellation.workspaceMemberRemove", secondMemberId, 1),
        true,
      );
      transcriptSubscription.stop();
      directorySubscription.stop();
      missionConfigSubscription.stop();
      workspace.stop(sessionId);
    });

    it("swaps a managed person for a specialist at the 16-participant cap", async function () {
      const workspace = new Agent("orchestrator");
      const memberIds = [];
      let sessionId;
      try {
        for (let index = 0; index < 14; index += 1) {
          memberIds.push(await Meteor.callAsync("constellation.workspaceMemberCreate", {
            displayName: `Capacity person ${index + 1}`,
            title: "Participant",
          }));
        }
        sessionId = await workspace.start({ title: "Full-cap Mission crew swap" });
        await Meteor.callAsync("constellation.prepareSession", sessionId);

        const full = await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          1,
          { memberIds, agentMode: "custom", agents: [] },
        );
        assert.strictEqual(full.participation.participants.length, 16);

        const swapped = await Meteor.callAsync(
          "constellation.missionCrewSave",
          sessionId,
          full.revision,
          {
            memberIds: memberIds.slice(0, 13),
            agentMode: "custom",
            agents: ["critic"],
          },
        );
        assert.strictEqual(swapped.participation.participants.length, 16);
        assert.sameMembers(
          swapped.participation.participants
            .filter((participant) => participant.kind === "agent")
            .map((participant) => participant.agent),
          ["orchestrator", "critic"],
        );
        assert.strictEqual(
          swapped.participation.participants
            .filter((participant) => participant.kind === "human"
              && participant.role === "participant").length,
          13,
        );
        assert.notOk(
          swapped.participation.participants
            .some((participant) => participant.memberId === memberIds[13]),
        );
      } finally {
        for (const memberId of memberIds) {
          try {
            await Meteor.callAsync("constellation.workspaceMemberRemove", memberId, 1);
          } catch {
            // Keep cleanup best-effort so the original regression remains visible.
          }
        }
        if (sessionId) workspace.stop(sessionId);
      }
    });

    it("defaults, persists, and validates per-Mission debug traces", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission debug trace test" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);

      const defaults = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 1, { title: "Mission debug trace test" },
      );
      assert.strictEqual(defaults.debugTraces, false);
      assert.strictEqual(defaults.revision, 2);

      const enabled = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 2, { debugTraces: true },
      );
      assert.strictEqual(enabled.debugTraces, true);
      assert.strictEqual(enabled.revision, 3);

      let error;
      try {
        await Meteor.callAsync(
          "constellation.missionSave", sessionId, 3, { debugTraces: "verbose" },
        );
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "invalid-mission");

      const disabled = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 3, { debugTraces: false },
      );
      assert.strictEqual(disabled.debugTraces, false);
      assert.strictEqual(disabled.revision, 4);
    });

    it("stops a parked approval when its Mission is paused", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission pause fence test" });
      const subscription = workspace.subscribe(sessionId);
      await waitUntil(() => subscription.ready(), "Mission subscription did not become ready");
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      await workspace.send(
        sessionId,
        "Build a launch plan and prepare a brief for approval.",
      );
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "awaiting",
        "Mission never reached its approval gate",
      );
      const heldToolCallId = AgentSessions.findOne(sessionId)?.pending?.toolCallId;
      assert.isString(heldToolCallId, "the approval should name its exact tool call");

      const paused = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 1, { status: "paused" },
      );
      assert.strictEqual(paused.status, "paused");
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "stopped",
        "Paused Mission did not stop",
      );
      assert.strictEqual(
        AgentSessions.findOne(sessionId)?.pending?.toolCallId,
        heldToolCallId,
        "pause must preserve the exact approval",
      );

      let error;
      try {
        await workspace.approve(sessionId);
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "no-pending");
      const active = await Meteor.callAsync(
        "constellation.missionSave", sessionId, 2, { status: "active" },
      );
      assert.strictEqual(active.status, "active");
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "awaiting",
        "Reactivated Mission did not restore its held approval",
      );
      assert.strictEqual(
        AgentSessions.findOne(sessionId)?.pending?.toolCallId,
        heldToolCallId,
        "reactivation must restore the same approval, not fabricate another",
      );
      await workspace.deny(sessionId, "Not ready to publish yet.", heldToolCallId);
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "idle",
        "Denied restored approval did not finish",
      );
      workspace.stop(sessionId);
    });

    it("runs a consequential tool without parking when approval gates are disabled", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Mission approval policy test" });
      const subscription = workspace.subscribe(sessionId);
      await waitUntil(() => subscription.ready(), "Mission subscription did not become ready");
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      await Meteor.callAsync(
        "constellation.missionSave", sessionId, 1, { approvals: false },
      );
      await workspace.send(
        sessionId,
        "Build a launch plan and publish the finished brief.",
      );
      await waitUntil(
        () => workspace.messages(sessionId).fetch().some(
          (message) => message.role === "tool" && /Published .*\.md/.test(message.content ?? ""),
        ),
        "Approval-free Mission did not publish its brief",
      );
      await waitUntil(
        () => AgentSessions.findOne(sessionId)?.phase === "idle",
        "Approval-free Mission did not finish",
      );
      assert.notStrictEqual(AgentSessions.findOne(sessionId)?.phase, "awaiting");
      workspace.stop(sessionId);
    });

    it("creates, updates, runs, and deletes a Pulse", async function () {
      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Pulse CRUD test" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const id = await Meteor.callAsync("constellation.pulseCreate", {
        name: "Test pulse",
        prompt: "Return a compact scheduler test receipt.",
        agent: "orchestrator",
        sessionId,
        schedule: { kind: "interval", every: 2, unit: "hours" },
        enabled: false,
      });
      assert.ok(id);
      assert.strictEqual(await Meteor.callAsync(
        "constellation.pulseSave",
        id,
        1,
        {
          name: "Updated test pulse",
          prompt: "Return a compact scheduler test receipt.",
          agent: "orchestrator",
          sessionId,
          schedule: { kind: "cron", expression: "0 8 * * 1-5" },
          enabled: true,
        },
      ), true);
      const outcome = await Meteor.callAsync("constellation.pulseRun", id);
      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(await Meteor.callAsync("constellation.pulseRemove", id, 2), true);
    });

    it("creates, updates, and deletes an assigned Skill", async function () {
      const id = await Meteor.callAsync("constellation.skillCreate", {
        name: "Test evidence pass",
        description: "Test-only evidence formatting.",
        content: "List evidence, inference, uncertainty, and the next verification step.",
        enabled: true,
        agents: ["orchestrator"],
      });
      assert.ok(id);
      assert.strictEqual(await Meteor.callAsync(
        "constellation.skillSave",
        id,
        1,
        {
          name: "Test evidence brief",
          description: "Test-only decision evidence formatting.",
          content: "List evidence, inference, uncertainty, and the next verification step.",
          enabled: false,
          agents: ["orchestrator"],
        },
      ), true);
      assert.strictEqual(await Meteor.callAsync("constellation.skillRemove", id, 2), true);
    });

    it("defaults learning governance and persists its automatic policies independently", async function () {
      const catalog = Mongo.getCollection("constellation_tool_catalog");
      const crew = Mongo.getCollection("constellation_crew_configs");
      assert.ok(catalog, "the client Tool Catalog collection should be registered");
      assert.ok(crew, "the client Crew collection should be registered");
      const catalogSubscription = Meteor.subscribe("constellation.toolCatalog");
      const crewSubscription = Meteor.subscribe("constellation.crew");
      const workspace = new Agent("orchestrator");
      let sessionId;
      let configId;
      try {
        await waitUntil(
          () => catalogSubscription.ready() && crewSubscription.ready(),
          "Learning governance subscriptions did not become ready",
        );
        sessionId = await workspace.start({ title: "Learning governance policy test" });
        await Meteor.callAsync("constellation.prepareSession", sessionId);
        configId = await Meteor.callAsync("constellation.crewCreate", sessionId);
        await waitUntil(() => crew.findOne(configId), "Governed Agent did not reach the Crew");
        const created = crew.findOne(configId);
        const agent = created.agent;
        assert.deepEqual(created.experience, {
          record: true,
          recall: true,
          recent: 4,
          scope: "owner",
          approval: "ask",
        });
        assert.deepEqual(created.practice, {
          acquire: false,
          approval: "ask",
          allowScopedEvidencePromotion: false,
        });
        await waitUntil(
          () => catalog.findOne({ source: "framework", name: "experience_propose" })
            ?.learningAssignments?.some((assignment) => assignment.agent === agent),
          "Default Experience policy did not reach the Tool Catalog",
        );
        assert.deepInclude(
          catalog.findOne({ source: "framework", name: "experience_propose" })
            .learningAssignments.find((assignment) => assignment.agent === agent),
          { agent, approval: "ask" },
        );
        assert.notInclude(
          catalog.findOne({ source: "framework", name: "practice_propose" })?.agents ?? [],
          agent,
        );

        await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
          expectedRevision: created.revision,
          experience: { approval: "auto" },
        });
        await waitUntil(
          () => crew.findOne(configId)?.experience?.approval === "auto"
            && catalog.findOne({ source: "framework", name: "experience_propose" })
              ?.learningAssignments?.some((assignment) => (
                assignment.agent === agent && assignment.approval === "auto"
              )),
          "Automatic Experience policy did not reach Crew and Tool Catalog",
        );
        const experienceAutomatic = crew.findOne(configId);
        assert.deepEqual(experienceAutomatic.practice, {
          acquire: false,
          approval: "ask",
          allowScopedEvidencePromotion: false,
        });
        assert.strictEqual(
          catalog.findOne({ source: "framework", name: "experience_propose" }).approval,
          "conditional",
        );

        await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
          expectedRevision: experienceAutomatic.revision,
          practice: {
            acquire: true,
            approval: "auto",
            allowScopedEvidencePromotion: true,
          },
        });
        await waitUntil(
          () => crew.findOne(configId)?.practice?.approval === "auto"
            && catalog.findOne({ source: "framework", name: "practice_propose" })
              ?.learningAssignments?.some((assignment) => (
                assignment.agent === agent
                && assignment.practice?.approval === "auto"
                && assignment.practice?.allowScopedEvidencePromotion === true
              )),
          "Automatic Practice policy did not reach Crew and Tool Catalog",
        );
        const practiceAutomatic = crew.findOne(configId);
        assert.strictEqual(practiceAutomatic.experience.approval, "auto");
        assert.deepEqual(practiceAutomatic.practice, {
          acquire: true,
          approval: "auto",
          allowScopedEvidencePromotion: true,
        });
        assert.include(
          catalog.findOne({ source: "framework", name: "practice_propose" }).agents,
          agent,
        );
      } finally {
        const standing = configId ? crew.findOne(configId) : null;
        if (standing && standing.status !== "archived" && sessionId) {
          const impact = await Meteor.callAsync("constellation.crewImpact", configId);
          await Meteor.callAsync(
            "constellation.crewArchive",
            sessionId,
            configId,
            impact.agent,
            impact.configRevision,
            impact.digest,
          );
        }
        if (sessionId) workspace.stop(sessionId);
        crewSubscription.stop();
        catalogSubscription.stop();
      }
    });

    it("rejects invalid learning approval policies without changing Crew state", async function () {
      const crew = Mongo.getCollection("constellation_crew_configs");
      assert.ok(crew, "the client Crew collection should be registered");
      const subscription = Meteor.subscribe("constellation.crew");
      const workspace = new Agent("orchestrator");
      let sessionId;
      try {
        await waitUntil(() => subscription.ready(), "Crew subscription did not become ready");
        sessionId = await workspace.start({ title: "Learning governance validation test" });
        await Meteor.callAsync("constellation.prepareSession", sessionId);
        const primary = crew.findOne({ agent: "orchestrator" });
        assert.ok(primary, "the primary Agent configuration should be published");
        for (const patch of [
          { experience: { approval: "sometimes" } },
          { practice: { approval: "review" } },
        ]) {
          let rejected;
          try {
            await Meteor.callAsync("constellation.crewSave", sessionId, primary._id, {
              expectedRevision: primary.revision,
              ...patch,
            });
          } catch (error) {
            rejected = error;
          }
          assert.strictEqual(rejected?.error, "invalid-crew");
        }
        assert.strictEqual(crew.findOne(primary._id).revision, primary.revision);
        assert.strictEqual(crew.findOne(primary._id).experience.approval, "ask");
        assert.strictEqual(crew.findOne(primary._id).practice.approval, "ask");
      } finally {
        if (sessionId) workspace.stop(sessionId);
        subscription.stop();
      }
    });

    it("publishes effective framework tools and keeps access reactive", async function () {
      const catalog = Mongo.getCollection("constellation_tool_catalog");
      const crew = Mongo.getCollection("constellation_crew_configs");
      const identities = Mongo.getCollection("agent_identities");
      assert.ok(catalog, "the client Tool Catalog collection should be registered");
      assert.ok(crew, "the client Crew collection should be registered");
      assert.ok(identities, "the client Agent Identity collection should be registered");
      const catalogSubscription = Meteor.subscribe("constellation.toolCatalog");
      const crewSubscription = Meteor.subscribe("constellation.crew");
      const learningSubscription = Meteor.subscribe("constellation.learning");
      await waitUntil(
        () => catalogSubscription.ready() && crewSubscription.ready()
          && learningSubscription.ready(),
        "Framework Tool Catalog subscriptions did not become ready",
      );
      await waitUntil(
        () => catalog.find({ source: "framework" }).count() >= 7,
        "Framework-managed tools did not reach the client Tool Catalog",
      );

      const delegations = catalog.find({ source: "framework", category: "delegation" }).fetch();
      assert.sameMembers(
        delegations.map((tool) => tool.targetAgent),
        ["researcher", "operator", "critic"],
      );
      assert.isTrue(delegations.every((tool) => (
        tool.locked === true
        && tool.status === "ready"
        && tool.approval === "auto"
        && tool.agents.length === 1
        && tool.agents[0] === "orchestrator"
        && tool.inputSchema?.required?.[0] === "prompt"
      )));
      assert.deepEqual(delegations[0].inputSchema, {
        type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"],
      });

      const skill = catalog.findOne({ source: "framework", name: "skill" });
      assert.ok(skill);
      assert.sameMembers(skill.agents, ["orchestrator", "operator"]);
      assert.sameMembers(skill.skillNames, ["decision-brief", "mission-framing"]);
      assert.strictEqual(skill.approval, "auto");
      assert.deepEqual(skill.inputSchema.required, ["name"]);

      const publish = catalog.findOne({ source: "app", name: "publish_brief" });
      assert.strictEqual(publish.approval, "conditional");
      assert.strictEqual(publish.approvalSummary, "Mission approvals on: Ask · off: Auto");

      const memory = catalog.find({ source: "framework", category: "memory" }).fetch();
      assert.sameMembers(
        memory.map((tool) => tool.name),
        ["memory_save", "memory_search", "memory_forget"],
      );
      for (const tool of memory) {
        assert.sameMembers(tool.agents, ["orchestrator", "researcher", "operator", "critic"]);
        assert.strictEqual(tool.accessMode, "root-mission");
        assert.strictEqual(tool.inheritedFrom, "orchestrator");
        assert.include(tool.availabilityNote, "not injected into delegated child runs");
      }
      assert.strictEqual(
        catalog.findOne({ source: "framework", name: "memory_save" }).approval,
        "conditional",
      );
      assert.strictEqual(
        catalog.findOne({ source: "framework", name: "memory_save" })
          .inputSchema.properties.text.maxLength,
        MEMORY_TEXT_MAX,
      );
      const learning = catalog.find({ source: "framework", category: "learning" }).fetch();
      assert.sameMembers(
        learning.map((tool) => tool.name),
        ["experience_search", "experience_propose"],
      );
      for (const tool of learning) {
        assert.sameMembers(tool.agents, ["orchestrator", "researcher", "operator", "critic"]);
        assert.strictEqual(tool.accessMode, "memory-frame");
        assert.include(tool.availabilityNote, "delegated child turns");
        assert.include(tool.availabilityNote, "Agent.ask turns");
        assert.include(tool.availabilityNote, "erases its throwaway Frame");
        assert.isTrue(tool.learningAssignments.every((assignment) => assignment.scope === "owner"));
      }
      assert.strictEqual(
        catalog.findOne({ source: "framework", name: "experience_search" }).approval,
        "auto",
      );
      assert.strictEqual(
        catalog.findOne({ source: "framework", name: "experience_search" })
          .inputSchema.properties.limit.maximum,
        EXPERIENCE_RECALL_MAX,
      );
      assert.strictEqual(
        catalog.findOne({ source: "framework", name: "experience_propose" }).approval,
        "ask",
      );
      assert.include(
        catalog.findOne({ source: "framework", name: "experience_propose" }).approvalSummary,
        "survives chat deletion",
      );
      assert.notOk(catalog.findOne({ source: "framework", name: "read_attachment" }));

      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "Framework catalog reactivity test" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const configId = await Meteor.callAsync("constellation.crewCreate", sessionId);
      await waitUntil(() => crew.findOne(configId), "Created framework test agent did not arrive");
      const agent = crew.findOne(configId).agent;
      const delegationId = `framework:${Meteor.userId()}:delegate:${agent}`;
      await waitUntil(
        () => catalog.findOne(delegationId),
        "New delegation tool did not reach the framework catalog",
      );
      await waitUntil(
        () => catalog.findOne({ source: "framework", name: "memory_search" })
          ?.agents?.includes(agent),
        "Primary memory access was not inherited by the addressed root agent",
      );
      await waitUntil(
        () => catalog.findOne({ source: "framework", name: "experience_search" })
          ?.agents?.includes(agent),
        "New Agent learning access did not reach the framework catalog",
      );
      assert.deepInclude(
        catalog.findOne({ source: "framework", name: "memory_search" })
          .memoryAssignments.find((assignment) => assignment.agent === agent),
        { agent, access: "inherited" },
      );
      let missingRevision;
      try {
        await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
          experience: { record: false },
        });
      } catch (error) {
        missingRevision = error;
      }
      assert.strictEqual(missingRevision?.error, "invalid-crew");
      const learningRevision = crew.findOne(configId).revision;
      let invalidRecall;
      try {
        await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
          expectedRevision: learningRevision,
          experience: { recall: true, recent: 0 },
        });
      } catch (error) {
        invalidRecall = error;
      }
      assert.strictEqual(invalidRecall?.error, "invalid-crew");
      assert.include(invalidRecall?.reason ?? invalidRecall?.message, "at least 1");
      assert.strictEqual(crew.findOne(configId).revision, learningRevision);
      await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
        expectedRevision: learningRevision,
        flexibility: 5,
        experience: { record: false, recall: true, recent: 2, scope: "session" },
      });
      await waitUntil(
        () => !catalog.findOne({ source: "framework", name: "experience_propose" })
          ?.agents?.includes(agent)
          && catalog.findOne({ source: "framework", name: "experience_search" })
            ?.learningAssignments?.some((assignment) => assignment.agent === agent
              && assignment.scope === "session" && assignment.recent === 2),
        "Agent learning configuration did not reach the effective Tool Catalog",
      );
      assert.deepInclude(crew.findOne(configId).experience, {
        record: false, recall: true, recent: 2, scope: "session",
      });
      await waitUntil(
        () => identities.findOne(configId)?.flexibility?.capacity === 5,
        "Agent Practice capacity did not reach its durable Identity",
      );
      const constitutionGeneration = identities.findOne(configId).generation;
      await Meteor.callAsync(
        "constellation.constitutionRevise",
        configId,
        constitutionGeneration,
        "Verify durable evidence before making a final claim.",
        "Exercise optimistic Constitution editing.",
      );
      let constitutionConflict;
      try {
        await Meteor.callAsync(
          "constellation.constitutionRevise",
          configId,
          constitutionGeneration,
          "This stale draft must not overwrite the current Constitution.",
          "Exercise conflict recovery.",
        );
      } catch (error) {
        constitutionConflict = error;
      }
      assert.strictEqual(constitutionConflict?.error, "identity-generation-conflict");
      assert.include(constitutionConflict?.reason ?? constitutionConflict?.message, "Rebase");
      let staleSave;
      try {
        await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
          expectedRevision: learningRevision,
          displayName: "Stale identity overwrite",
          flexibility: 8,
        });
      } catch (error) {
        staleSave = error;
      }
      assert.strictEqual(staleSave?.error, "stale-agent");
      assert.notStrictEqual(crew.findOne(configId).displayName, "Stale identity overwrite");
      assert.notStrictEqual(identities.findOne(configId).displayName, "Stale identity overwrite");
      assert.strictEqual(identities.findOne(configId).flexibility.capacity, 5);

      const [skillId, companionSkillId] = await Promise.all([
        Meteor.callAsync("constellation.skillCreate", {
          name: "Framework catalog test skill",
          description: "A skill used to verify effective loader access.",
          content: "Return one bounded framework catalog test receipt.",
          enabled: true,
          agents: [agent],
        }),
        Meteor.callAsync("constellation.skillCreate", {
          name: "Framework catalog companion",
          description: "A second skill used to exercise concurrent catalog reconciliation.",
          content: "Return a second bounded framework catalog test receipt.",
          enabled: true,
          agents: [agent],
        }),
      ]);
      await waitUntil(
        () => catalog.findOne({ source: "framework", name: "skill" })?.agents?.includes(agent),
        "Assigning an enabled Skill did not add derived skill-loader access",
      );
      assert.sameMembers(
        catalog.findOne({ source: "framework", name: "skill" }).skillAssignments
          .find((assignment) => assignment.agent === agent).skills,
        ["framework-catalog-test-skill", "framework-catalog-companion"],
      );
      assert.strictEqual(catalog.findOne(delegationId)._id, delegationId);

      const primaryConfig = crew.findOne({ agent: "orchestrator" });
      await Meteor.callAsync("constellation.crewSave", sessionId, primaryConfig._id, {
        expectedRevision: primaryConfig.revision,
        capabilities: { memory: false },
      });
      await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
        expectedRevision: crew.findOne(configId).revision,
        capabilities: { memory: true },
      });
      await waitUntil(
        () => catalog.findOne({ source: "framework", name: "memory_search" })
          ?.agents?.length === 1,
        "Specialist-owned root memory access was not reflected",
      );
      const specialistMemory = catalog.findOne({ source: "framework", name: "memory_search" });
      assert.deepEqual(specialistMemory.agents, [agent]);
      assert.notProperty(specialistMemory, "inheritedFrom");
      assert.deepInclude(specialistMemory.memoryAssignments[0], { agent, access: "configured" });
      await Meteor.callAsync("constellation.crewSave", sessionId, primaryConfig._id, {
        expectedRevision: crew.findOne(primaryConfig._id).revision,
        capabilities: { memory: true },
      });
      await waitUntil(
        () => catalog.findOne({ source: "framework", name: "memory_search" })
          ?.agents?.includes("researcher"),
        "Restored primary memory did not restore inherited root access",
      );

      await Meteor.callAsync("constellation.crewSave", sessionId, configId, {
        expectedRevision: crew.findOne(configId).revision,
        enabled: false,
      });
      await waitUntil(
        () => !catalog.findOne(delegationId)
          && !catalog.findOne({ source: "framework", name: "skill" })?.agents?.includes(agent)
          && !catalog.findOne({ source: "framework", name: "memory_search" })?.agents?.includes(agent)
          && !catalog.findOne({ source: "framework", name: "experience_search" })?.agents?.includes(agent),
        "Disabling the agent did not remove effective framework access",
      );

      assert.deepEqual(
        await Promise.all([
          Meteor.callAsync("constellation.skillRemove", skillId, 1),
          Meteor.callAsync("constellation.skillRemove", companionSkillId, 1),
        ]),
        [true, true],
      );
      const archiveImpact = await Meteor.callAsync("constellation.crewImpact", configId);
      assert.strictEqual(await Meteor.callAsync(
        "constellation.crewArchive", sessionId, configId, archiveImpact.agent,
        archiveImpact.configRevision, archiveImpact.digest,
      ), true);
      workspace.stop(sessionId);
      crewSubscription.stop();
      catalogSubscription.stop();
      learningSubscription.stop();
    });

    it("archives a crew agent, preserves its identity, and removes it from future work", async function () {
      const crew = Mongo.getCollection("constellation_crew_configs");
      const skills = Mongo.getCollection("constellation_skills");
      const pulses = Mongo.getCollection("constellation_pulses");
      const mcp = Mongo.getCollection("constellation_mcp_configs");
      const identities = Mongo.getCollection("agent_identities");
      assert.ok(crew, "the client Crew collection should be registered");
      assert.ok(identities, "the client Agent Identity collection should be registered");
      const crewSubscription = Meteor.subscribe("constellation.crew");
      const learningSubscription = Meteor.subscribe("constellation.learning");
      const skillSubscription = Meteor.subscribe("constellation.skills");
      const pulseSubscription = Meteor.subscribe("constellation.pulses");
      const mcpSubscription = Meteor.subscribe("constellation.mcp");
      await waitUntil(
        () => crewSubscription.ready() && learningSubscription.ready() && skillSubscription.ready()
          && pulseSubscription.ready() && mcpSubscription.ready(),
        "Crew impact subscriptions did not become ready",
      );

      const firstView = new Agent("orchestrator");
      const secondView = new Agent("orchestrator");
      const firstId = await firstView.start({ title: "Crew removal primary test" });
      const secondId = await secondView.start({ title: "Crew removal sibling test" });
      const firstSubscription = firstView.subscribe(firstId);
      const secondSubscription = secondView.subscribe(secondId);
      await waitUntil(
        () => firstSubscription.ready() && secondSubscription.ready(),
        "Crew removal Mission subscriptions did not become ready",
      );
      await Meteor.callAsync("constellation.prepareSession", firstId);

      const configId = await Meteor.callAsync("constellation.crewCreate", firstId, {
        displayName: "Workspace removal specialist",
        role: "Removal test",
      });
      await waitUntil(() => crew.findOne(configId), "Created crew agent did not reach the client");
      const agent = crew.findOne(configId).agent;
      await waitUntil(
        () => identities.findOne(configId)?.lifecycle === "active",
        "Created Crew config did not acquire a published active Agent Identity",
      );
      await waitUntil(
        () => [firstId, secondId].every((sessionId) => AgentSessions.findOne(sessionId)
          ?.participants?.some((participant) => participant.agent === agent)),
        "Workspace crew creation did not update every Mission roster",
      );
      await Meteor.callAsync("constellation.crewSave", firstId, configId, {
        expectedRevision: crew.findOne(configId).revision,
        displayName: "Renamed workspace specialist",
      });
      await waitUntil(
        () => [firstId, secondId].every((sessionId) => AgentSessions.findOne(sessionId)
          ?.participants?.some((participant) => participant.agent === agent
            && participant.displayName === "Renamed workspace specialist")),
        "Workspace crew save did not update every Mission roster",
      );

      const skillId = await Meteor.callAsync("constellation.skillCreate", {
        name: "Removal impact skill",
        description: "Verifies exact crew removal impact.",
        content: "Return a removal-impact test receipt.",
        enabled: true,
        agents: [agent],
      });
      const pulseId = await Meteor.callAsync("constellation.pulseCreate", {
        name: "Removal impact pulse",
        prompt: "Return a removal-impact test receipt.",
        agent,
        sessionId: firstId,
        schedule: { kind: "interval", every: 1, unit: "hours" },
        enabled: true,
      });
      const mcpCreated = await Meteor.callAsync("constellation.mcpCreate", {
        name: "Removal impact MCP",
        command: "node",
        args: ["mcp/workspace-server.mjs"],
        agents: [agent],
        enabled: false,
        trusted: false,
      });
      const mcpId = mcpCreated._id;
      let impact = await Meteor.callAsync("constellation.crewImpact", configId);
      assert.deepInclude(impact, {
        configId,
        agent,
        displayName: "Renamed workspace specialist",
      });
      assert.includeMembers(impact.missions.map((row) => row.id), [firstId, secondId]);
      assert.deepInclude(impact.skills.find((row) => row.id === skillId), {
        name: "Removal impact skill",
      });
      assert.deepInclude(impact.mcpServers.find((row) => row.id === mcpId), {
        name: "Removal impact MCP",
      });
      assert.deepInclude(impact.pulses.find((row) => row.id === pulseId), {
        name: "Removal impact pulse",
        missionId: firstId,
      });

      let staleArchive;
      try {
        await Meteor.callAsync(
          "constellation.crewArchive", firstId, configId, "different-agent",
          impact.configRevision, impact.digest,
        );
      } catch (error) {
        staleArchive = error;
      }
      assert.strictEqual(staleArchive?.error, "stale-agent");
      assert.ok(crew.findOne(configId), "A stale archive target must not change the agent");

      await Meteor.callAsync(
        "constellation.skillSave", skillId, skills.findOne(skillId).revision,
        { description: "Updated after the archive impact was reviewed." },
      );
      let staleImpact;
      try {
        await Meteor.callAsync(
          "constellation.crewArchive", firstId, configId, agent,
          impact.configRevision, impact.digest,
        );
      } catch (error) {
        staleImpact = error;
      }
      assert.strictEqual(staleImpact?.error, "stale-impact");
      assert.notStrictEqual(crew.findOne(configId)?.status, "archived");
      impact = await Meteor.callAsync("constellation.crewImpact", configId);

      const [archiveRace, skillRace] = await Promise.allSettled([
        Promise.race([
          Meteor.callAsync(
            "constellation.crewArchive", firstId, configId, agent,
            impact.configRevision, impact.digest,
          ),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Crew archive did not settle within five seconds")), 5_000,
          )),
        ]),
        Meteor.callAsync(
          "constellation.skillSave", skillId, skills.findOne(skillId).revision,
          { description: "Concurrent with archive confirmation." },
        ),
      ]);
      let archived;
      if (archiveRace.status === "fulfilled") {
        archived = archiveRace.value;
        assert.strictEqual(
          skillRace.status, "rejected",
          "an assignment mutation queued after the archive fence must not commit",
        );
      } else {
        assert.strictEqual(archiveRace.reason?.error, "stale-impact");
        assert.strictEqual(
          skillRace.status, "fulfilled",
          "an assignment mutation that wins first must invalidate the archive receipt",
        );
        impact = await Meteor.callAsync("constellation.crewImpact", configId);
        archived = await Meteor.callAsync(
          "constellation.crewArchive", firstId, configId, agent,
          impact.configRevision, impact.digest,
        );
      }
      assert.strictEqual(archived, true);
      await waitUntil(
        () => crew.findOne(configId)?.status === "archived",
        "Archived Agent identity did not remain available for history and restore",
      );
      assert.strictEqual(crew.findOne(configId).agent, agent);
      assert.strictEqual(crew.findOne(configId).enabled, false);
      assert.ok(crew.findOne(configId).archivedAt);
      assert.notProperty(
        crew.findOne(configId), "archiveCleanupPending",
        "archive must not report completion while durable cleanup remains pending",
      );
      await waitUntil(
        () => identities.findOne(configId)?.lifecycle === "archived",
        "Crew archival did not fence the package Agent Identity",
      );
      await waitUntil(
        () => [firstId, secondId].every((sessionId) => !AgentSessions.findOne(sessionId)
          ?.participants?.some((participant) => participant.agent === agent)),
        "Archived crew agent remained in a Mission roster",
      );
      await waitUntil(
        () => !skills.findOne(skillId)?.agents?.includes(agent)
          && !mcp.findOne(mcpId)?.agents?.includes(agent)
          && pulses.findOne(pulseId)?.agent === "orchestrator"
          && pulses.findOne(pulseId)?.enabled === false,
        "Crew archive references did not settle before the method returned",
      );

      assert.strictEqual(
        await Meteor.callAsync(
          "constellation.crewArchive", firstId, configId, agent,
          impact.configRevision, impact.digest,
        ), true,
        "retrying a completed archive should adopt the durable result",
      );

      const archivedRevision = crew.findOne(configId).revision;
      let missingRestoreRevision;
      try {
        await Meteor.callAsync("constellation.crewRestore", configId);
      } catch (error) {
        missingRestoreRevision = error;
      }
      assert.strictEqual(missingRestoreRevision?.error, "invalid-crew");
      let staleRestore;
      try {
        await Meteor.callAsync("constellation.crewRestore", configId, archivedRevision - 1);
      } catch (error) {
        staleRestore = error;
      }
      assert.strictEqual(staleRestore?.error, "stale-agent");
      assert.strictEqual(crew.findOne(configId).status, "archived");
      assert.strictEqual(
        await Meteor.callAsync("constellation.crewRestore", configId, archivedRevision), true,
      );
      await waitUntil(
        () => crew.findOne(configId)?.status === "unavailable",
        "Restored Agent did not return with the same identity",
      );
      assert.strictEqual(crew.findOne(configId).agent, agent);
      assert.strictEqual(crew.findOne(configId).enabled, false,
        "restore must not silently reassign the Agent to work");
      await waitUntil(
        () => identities.findOne(configId)?.lifecycle === "active",
        "Crew restore did not reactivate the same package Agent Identity",
      );

      await Meteor.callAsync("constellation.skillRemove", skillId, skills.findOne(skillId).revision);
      await Meteor.callAsync("constellation.pulseRemove", pulseId, pulses.findOne(pulseId).revision);
      await Meteor.callAsync("constellation.mcpRemove", mcpId, mcp.findOne(mcpId).revision);

      firstView.stop(firstId);
      secondView.stop(secondId);
      crewSubscription.stop();
      learningSubscription.stop();
      skillSubscription.stop();
      pulseSubscription.stop();
      mcpSubscription.stop();
    });

    it("requires explicit trust and rejects dangerous MCP environment overrides", async function () {
      let error;
      try {
        await Meteor.callAsync("constellation.mcpCreate", {
          name: "Untrusted MCP test",
          command: "node",
          args: ["mcp/workspace-server.mjs"],
          agents: ["orchestrator"],
          enabled: true,
          trusted: false,
        });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "mcp-untrusted");

      const created = await Meteor.callAsync("constellation.mcpCreate", {
        name: "MCP validation test",
        command: "node",
        args: ["mcp/workspace-server.mjs"],
        agents: ["orchestrator"],
        toolMode: "selected",
        selectedTools: ["runtime_status"],
        approval: "ask",
        enabled: false,
        trusted: false,
      });
      assert.deepInclude(created, {
        managed: "workspace",
        locked: false,
        enabled: false,
        trusted: false,
        status: "disabled",
        revision: 1,
      });
      assert.deepEqual(created.envKeys, []);

      error = undefined;
      try {
        await Meteor.callAsync(
          "constellation.mcpSave", created._id, 1, { env: { NODE_OPTIONS: "--inspect" } },
        );
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "invalid-mcp");

      error = undefined;
      try {
        await Meteor.callAsync(
          "constellation.mcpSave",
          created._id,
          1,
          { enabled: true, trusted: true, toolMode: "selected", selectedTools: [] },
        );
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "invalid-mcp");

      const renamed = await Meteor.callAsync(
        "constellation.mcpSave", created._id, 1, { name: "MCP validation renamed" },
      );
      assert.strictEqual(renamed.revision, 2);
      error = undefined;
      try {
        await Meteor.callAsync(
          "constellation.mcpSave", created._id, 1, { name: "Stale MCP update" },
        );
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.error, "stale-mcp");
      assert.strictEqual(
        await Meteor.callAsync("constellation.mcpRemove", created._id, 2), true,
      );
    });

    it("discovers, assigns, disables, and removes a trusted local MCP server", async function () {
      const catalog = Mongo.getCollection("constellation_tool_catalog");
      assert.ok(catalog, "the client Tool Catalog collection should be registered");
      const catalogSubscription = Meteor.subscribe("constellation.toolCatalog");
      await waitUntil(() => catalogSubscription.ready(), "Tool Catalog subscription did not become ready");
      await waitUntil(
        () => catalog.findOne({ source: "app-mcp", remoteName: "format_checklist" }),
        "The app-managed format_checklist tool did not reach the client Tool Catalog",
      );
      const managedChecklist = catalog.findOne({
        source: "app-mcp", remoteName: "format_checklist",
      });
      assert.notProperty(managedChecklist.inputSchema, "$schema");
      assert.deepEqual(unsafeDocumentKeys(managedChecklist.inputSchema), []);
      const created = await Meteor.callAsync("constellation.mcpCreate", {
        name: "Workspace MCP integration test",
        command: "node",
        args: ["-e", MCP_TEST_SERVER],
        agents: ["orchestrator"],
        toolMode: "selected",
        selectedTools: ["runtime_status"],
        approval: "ask",
        timeoutMs: 5_000,
        cooldownMs: 0,
        enabled: false,
        trusted: true,
      });
      assert.strictEqual(created.status, "disabled");

      const enabled = await Meteor.callAsync(
        "constellation.mcpSave", created._id, 1, { enabled: true },
      );
      assert.deepInclude(enabled, {
        enabled: true,
        trusted: true,
        status: "ready",
        catalogCount: 2,
        revision: 2,
      });

      const tested = await Meteor.callAsync("constellation.mcpTest", created._id);
      assert.strictEqual(tested.ok, true, tested.reason);
      assert.strictEqual(tested.status, "ready");
      assert.sameMembers(
        tested.tools.map((tool) => tool.name),
        ["runtime_status", "format_checklist"],
      );
      assert.ok(tested.tools.every((tool) => tool.inputSchema?.type === "object"));
      const testedChecklist = tested.tools.find((tool) => tool.name === "format_checklist");
      assert.notProperty(testedChecklist.inputSchema, "$schema");
      assert.deepEqual(unsafeDocumentKeys(testedChecklist.inputSchema), []);
      assert.deepInclude(tested.runtime, { registered: true, state: "connected", toolCount: 2 });

      await waitUntil(
        () => catalog.find({ serverId: created._id }).count() === 2,
        "Both discovered MCP tools did not reach the client Tool Catalog",
      );
      const published = catalog.find({ serverId: created._id }).fetch();
      assert.sameMembers(
        published.map((tool) => tool.remoteName),
        ["runtime_status", "format_checklist"],
      );
      const publishedChecklist = published.find((tool) => tool.remoteName === "format_checklist");
      assert.notProperty(publishedChecklist.inputSchema, "$schema");
      assert.property(publishedChecklist.inputSchema, "catalog%2Edetail");
      assert.deepEqual(unsafeDocumentKeys(publishedChecklist.inputSchema), []);
      const publishedStatus = published.find((tool) => tool.remoteName === "runtime_status");
      assert.strictEqual(publishedStatus.selected, true);
      assert.sameMembers(publishedStatus.agents, ["orchestrator"]);
      assert.sameMembers(publishedStatus.assignedAgents, ["orchestrator"]);
      assert.strictEqual(publishedChecklist.selected, false);
      assert.deepEqual(publishedChecklist.agents, []);
      assert.sameMembers(publishedChecklist.assignedAgents, ["orchestrator"]);

      const reselected = await Meteor.callAsync(
        "constellation.mcpSave", created._id, 2, { selectedTools: ["format_checklist"] },
      );
      assert.deepInclude(reselected, { status: "ready", revision: 3 });
      await waitUntil(() => {
        const statusTool = catalog.findOne({ serverId: created._id, remoteName: "runtime_status" });
        const checklistTool = catalog.findOne({
          serverId: created._id, remoteName: "format_checklist",
        });
        return statusTool?.selected === false
          && statusTool.agents?.length === 0
          && checklistTool?.selected === true
          && checklistTool.agents?.includes("orchestrator");
      }, "Changing the MCP selection did not update effective tool access");

      const disabled = await Meteor.callAsync(
        "constellation.mcpSave", created._id, 3, { enabled: false },
      );
      assert.deepInclude(disabled, { enabled: false, status: "disabled", revision: 4 });
      await waitUntil(
        () => catalog.find({ serverId: created._id }).fetch()
          .every((tool) => tool.agents?.length === 0),
        "Disabled MCP tools retained effective agent access",
      );
      assert.strictEqual(
        await Meteor.callAsync("constellation.mcpRemove", created._id, 4), true,
      );
      catalogSubscription.stop();
    });

    it("serializes MCP testing and bootstrap reconciliation against removal", async function () {
      const catalog = Mongo.getCollection("constellation_tool_catalog");
      const mcp = Mongo.getCollection("constellation_mcp_configs");
      const crew = Mongo.getCollection("constellation_crew_configs");
      assert.ok(catalog, "the client Tool Catalog collection should be registered");
      assert.ok(mcp, "the client MCP configuration collection should be registered");
      assert.ok(crew, "the client Crew configuration collection should be registered");
      const catalogSubscription = Meteor.subscribe("constellation.toolCatalog");
      const mcpSubscription = Meteor.subscribe("constellation.mcp");
      const crewSubscription = Meteor.subscribe("constellation.crew");
      await waitUntil(
        () => catalogSubscription.ready() && mcpSubscription.ready() && crewSubscription.ready(),
        "MCP concurrency subscriptions did not become ready",
      );

      const testing = await Meteor.callAsync("constellation.mcpCreate", {
        name: "MCP test removal serialization",
        command: "node",
        args: ["-e", MCP_DELAYED_EPHEMERAL_SERVER],
        agents: ["orchestrator"],
        enabled: false,
        trusted: true,
        timeoutMs: 5_000,
      });
      const testPromise = Meteor.callAsync("constellation.mcpTest", testing._id);
      await waitUntil(
        () => mcp.findOne(testing._id)?.status === "connecting",
        "MCP test did not enter its observable reconciliation window",
      );
      const removeDuringTest = Meteor.callAsync(
        "constellation.mcpRemove", testing._id, testing.revision,
      );
      const [testResult, testRemoval] = await Promise.all([testPromise, removeDuringTest]);
      assert.strictEqual(testResult.ok, true, testResult.reason);
      assert.strictEqual(testRemoval, true);
      await waitUntil(
        () => !mcp.findOne(testing._id)
          && catalog.find({ serverId: testing._id }).count() === 0,
        "MCP testing replayed state after the serialized removal",
      );

      const workspace = new Agent("orchestrator");
      const sessionId = await workspace.start({ title: "MCP test archive serialization" });
      await Meteor.callAsync("constellation.prepareSession", sessionId);
      const configId = await Meteor.callAsync("constellation.crewCreate", sessionId, {
        displayName: "MCP archive race specialist",
      });
      await waitUntil(() => crew.findOne(configId), "MCP archive race Agent did not arrive");
      const agent = crew.findOne(configId).agent;
      const archiveTesting = await Meteor.callAsync("constellation.mcpCreate", {
        name: "MCP test archive serialization",
        command: "node",
        args: ["-e", MCP_DELAYED_EPHEMERAL_SERVER],
        agents: [agent],
        enabled: false,
        trusted: true,
        timeoutMs: 5_000,
      });
      const completionOrder = [];
      const testBeforeArchive = Meteor.callAsync("constellation.mcpTest", archiveTesting._id)
        .then((result) => {
          completionOrder.push("test");
          return result;
        });
      await waitUntil(
        () => mcp.findOne(archiveTesting._id)?.status === "connecting",
        "MCP archive test did not enter its observable reconciliation window",
      );
      const impact = await Meteor.callAsync("constellation.crewImpact", configId);
      const archiveDuringTest = Meteor.callAsync(
        "constellation.crewArchive", sessionId, configId, agent,
        impact.configRevision, impact.digest,
      ).then((result) => {
        completionOrder.push("archive");
        return result;
      });
      const [archiveTestResult, archiveResult] = await Promise.all([
        testBeforeArchive, archiveDuringTest,
      ]);
      assert.strictEqual(archiveTestResult.ok, true, archiveTestResult.reason);
      assert.strictEqual(archiveResult, true);
      assert.deepEqual(completionOrder, ["test", "archive"]);
      await waitUntil(
        () => !mcp.findOne(archiveTesting._id)?.agents?.includes(agent)
          && catalog.find({ serverId: archiveTesting._id }).fetch()
            .every((tool) => !tool.agents?.includes(agent)),
        "MCP testing restored access after the serialized Agent archive",
      );
      await Meteor.callAsync(
        "constellation.mcpRemove", archiveTesting._id, mcp.findOne(archiveTesting._id).revision,
      );
      workspace.stop(sessionId);

      const bootstrapping = await Meteor.callAsync("constellation.mcpCreate", {
        name: "MCP bootstrap removal serialization",
        command: "node",
        args: ["-e", MCP_DELAYED_EPHEMERAL_SERVER],
        agents: ["orchestrator"],
        enabled: true,
        trusted: true,
        timeoutMs: 5_000,
        cooldownMs: 0,
      });
      assert.deepInclude(
        await Meteor.callAsync("constellation.testMcpDisconnect", bootstrapping._id),
        { registered: true, state: "disconnected" },
      );
      const bootstrapPromise = Meteor.callAsync("constellation.bootstrap");
      await waitUntil(
        () => mcp.findOne(bootstrapping._id)?.status === "connecting",
        "Bootstrap did not enter its observable MCP reconciliation window",
      );
      const removeDuringBootstrap = Meteor.callAsync(
        "constellation.mcpRemove", bootstrapping._id, bootstrapping.revision,
      );
      const [bootstrapResult, bootstrapRemoval] = await Promise.all([
        bootstrapPromise, removeDuringBootstrap,
      ]);
      assert.isObject(bootstrapResult);
      assert.strictEqual(bootstrapRemoval, true);
      await waitUntil(
        () => !mcp.findOne(bootstrapping._id)
          && catalog.find({ serverId: bootstrapping._id }).count() === 0,
        "Bootstrap replayed MCP state after the serialized removal",
      );

      catalogSubscription.stop();
      mcpSubscription.stop();
      crewSubscription.stop();
    });

    it("updates safe Channel fields and explicitly clears credentials", async function () {
      assert.deepInclude(
        await Meteor.callAsync("constellation.channelTest", "sms"),
        { ok: false, status: "incomplete" },
      );
      assert.strictEqual(await Meteor.callAsync(
        "constellation.channelSave",
        "sms",
        1,
        { enabled: false, fields: { webhookUrl: "https://example.test/agent/channels/sms" } },
      ), "disabled");
      assert.strictEqual(await Meteor.callAsync("constellation.channelClear", "sms", 2), true);
    });
  });
}
