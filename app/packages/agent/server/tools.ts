import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import type { ToolSchema } from './providers/types';

export interface ToolContext { userId: string | null; sessionId: string }

export type InlineTool = {
  name: string;
  description: string;
  args: unknown;
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
  gate?: 'auto' | 'ask';
};

export type AdoptedTool = {
  method: string;
  description: string;
  args: unknown;
  name?: string;
  gate?: 'auto' | 'ask';
};

export type ToolSpec = InlineTool | AdoptedTool | string;

export interface ResolvedTool {
  name: string;
  description: string;
  args: unknown;
  gate: 'auto' | 'ask';
  kind: 'inline' | 'adopted';
  method?: string;
  run?: (args: any, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: { error: string; reason?: string };
}

/**
 * Make a REAL MethodInvocation ambient. S2b: a plain object is enough to carry
 * userId, but a handler invoked with one dies on `this.unblock is not a
 * function`, and real method bodies call it.
 *
 * Nuance: the adopted-tool path in `runTool` goes through `Meteor.callAsync`,
 * which builds its OWN invocation for the handler's `this` and only reads
 * `.userId`/`.connection` off the ambient one — so that path alone would
 * tolerate a plain object here. The ambient invocation still has to be real
 * because nothing guarantees every future caller reaches a handler via
 * `callAsync`; code that invokes a handler directly with the ambient
 * invocation as `this` (as `Meteor.server.method_handlers` allows) needs
 * `this.unblock`/`this.setUserId` to exist.
 */
export function withInvocation<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  const invocation = new (DDPCommon as any).MethodInvocation({
    isSimulation: false,
    userId,
    connection: null,
    randomSeed: null,
  });
  return (DDP as any)._CurrentMethodInvocation.withValue(invocation, fn);
}

export function resolveTools(specs: ToolSpec[]): ResolvedTool[] {
  return specs.map((spec) => {
    if (typeof spec === 'string') {
      return {
        name: spec, description: '', args: { type: 'object', properties: {} },
        gate: 'auto' as const, kind: 'adopted' as const, method: spec,
      };
    }
    const hasMethod = 'method' in spec && spec.method !== undefined;
    const hasRun = 'run' in spec && spec.run !== undefined;
    if (hasMethod && hasRun) {
      const label = (spec as any).name ?? (spec as any).method ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has both "method" and "run" — pick one: ${label}`,
      );
    }
    if (!hasMethod && !hasRun) {
      const label = (spec as any).name ?? '(unnamed)';
      throw new Error(
        `[10thfloor:agent] Tool spec has neither "method" nor "run" — pick one: ${label}`,
      );
    }
    if (hasMethod) {
      const adopted = spec as AdoptedTool;
      const name = adopted.name ?? adopted.method;
      if (!name) {
        throw new Error(
          `[10thfloor:agent] Tool spec has no usable name: ${JSON.stringify(spec)}`,
        );
      }
      return {
        name,
        description: adopted.description,
        args: adopted.args,
        gate: adopted.gate ?? 'auto',
        kind: 'adopted' as const,
        method: adopted.method,
      };
    }
    const inline = spec as InlineTool;
    if (!inline.name) {
      throw new Error(
        `[10thfloor:agent] Tool spec is missing "name": ${JSON.stringify(spec)}`,
      );
    }
    return {
      name: inline.name,
      description: inline.description,
      args: inline.args,
      gate: inline.gate ?? 'auto',
      kind: 'inline' as const,
      run: inline.run,
    };
  });
}

export function toolSchemas(tools: ResolvedTool[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name, description: t.description, parameters: t.args,
  }));
}

export async function runTool(
  tool: ResolvedTool, args: unknown, ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const value = await withInvocation(ctx.userId, async () => {
      if (tool.kind === 'adopted') {
        // Meteor derives its own MethodInvocation here, inheriting userId from
        // the ambient one, and the method's own check() calls run as written.
        return Meteor.callAsync(tool.method!, args);
      }
      return tool.run!(args, ctx);
    });
    return { ok: true, value };
  } catch (e: any) {
    if (e instanceof Meteor.Error) {
      return { ok: false, error: { error: String(e.error), reason: e.reason } };
    }
    // Never let a raw stack or message into the transcript — it is published.
    return { ok: false, error: { error: 'tool-failed', reason: 'The tool failed to run.' } };
  }
}
