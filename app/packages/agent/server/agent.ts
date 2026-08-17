import { defineAgent, type AgentConfig } from './registry';
import { defineAgentMethod, type AdoptedTool, type AgentMethodOptions } from './tools';

export class Agent {
  constructor(public readonly name: string, config?: AgentConfig) {
    if (config) this.define(config);
  }

  define(config: AgentConfig): this {
    defineAgent(this.name, config);
    return this;
  }

  /**
   * §6. Register a Meteor method and get a tool handle for it in one
   * definition — see `defineAgentMethod`. STATIC because a co-registered method
   * belongs to the app, not to one agent: any number of agents may list the
   * handle it returns (or the bare method name), and your UI calls it directly.
   *
   *   const lookup = Agent.method('orders.lookup', { description, args, run });
   *   Support.define({ ..., tools: [lookup] });
   *   await Meteor.callAsync('orders.lookup', { id });   // same schema, same check
   */
  static method(name: string, options: AgentMethodOptions): AdoptedTool {
    return defineAgentMethod(name, options);
  }
}

export type { AgentConfig };
