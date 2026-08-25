/**
 * JSON Schema → TypeScript, so a tool's `run` knows its own arguments.
 *
 * Every tool already carries a JSON Schema in `args`, and the package already
 * compiles it into a runtime checker. This file makes the SAME object drive the
 * static type, so there is exactly one description of a tool's arguments and no
 * way for the checked shape and the written shape to drift apart.
 *
 * WHY A HELPER IS UNAVOIDABLE (and therefore why nothing here is a breaking
 * change): TypeScript infers a type argument from a function CALL, never from a
 * bare object literal checked against a type. Written straight into a
 * `tools: [...]` array, `args` is inferred as the wide `unknown` the loose type
 * declares, and `run(args)` is `any` — today's behaviour, exactly. Wrapping the
 * same literal in `tool(...)` is what gives inference something to bite on:
 *
 *     tools: [
 *       { name: 'a', args: {...}, run: async (args) => args.anything },   // any
 *       tool({ name: 'b', args: {...}, run: async (args) => args.typed }), // typed
 *     ]
 *
 * Both forms live in the same array, and the loose types below are untouched —
 * so no existing tool, in this package or in any app built on it, changes.
 *
 * The other reason `tool()` returns the ERASED type: a generic `InlineTool<S>`
 * is not assignable to `InlineTool<unknown>`, because the type parameter sits in
 * a contravariant position (`run`'s parameter). Making the spec types generic
 * would therefore break every internal signature that takes `ToolSpec[]`.
 * Erasing at the boundary keeps the inference inside the call and the variance
 * problem out of the package.
 */
/**
 * The type a validated argument object has, given its JSON Schema.
 *
 * Handles the subset of JSON Schema this package's tools actually use, which is
 * the subset typebox compiles: objects with `properties`/`required`, arrays with
 * `items`, the primitive types, type unions (`['integer','null']`), `enum` and
 * `const`. Anything it does not recognise widens to `unknown` rather than
 * guessing — an unhelpful type is recoverable, a wrong one is not.
 */
export type FromSchema<S> = S extends {
    enum: readonly (infer E)[];
} ? E : S extends {
    const: infer C;
} ? C : S extends {
    type: readonly (infer T)[] | (infer T)[];
} ? FromPrimitive<T, S> : S extends {
    type: infer T;
} ? FromPrimitive<T, S> : unknown;
/** One `type` keyword to its TypeScript equivalent. Distributes over a union so
 *  a type array becomes a type union. */
type FromPrimitive<T, S> = (T extends 'string' ? string : never) | (T extends 'number' | 'integer' ? number : never) | (T extends 'boolean' ? boolean : never) | (T extends 'null' ? null : never) | (T extends 'array' ? (S extends {
    items: infer I;
} ? FromSchema<I>[] : unknown[]) : never) | (T extends 'object' ? FromObject<S> : never);
/**
 * An object schema, with `required` deciding which keys are optional.
 *
 * A schema with no `properties` widens to an index signature rather than `{}`:
 * `{ type: 'object' }` genuinely means "some object", and typing it as `{}`
 * would make every property access an error on a tool that is deliberately
 * open-ended.
 */
type FromObject<S> = S extends {
    properties: infer P;
} ? S extends {
    required: readonly (infer R)[] | (infer R)[];
} ? Prettify<{
    [K in Extract<keyof P, R>]: FromSchema<P[K]>;
} & {
    [K in Exclude<keyof P, R>]?: FromSchema<P[K]>;
}> : Prettify<{
    [K in keyof P]?: FromSchema<P[K]>;
}> : Record<string, unknown>;
/** Flattens an intersection into a single object literal, so a hover shows
 *  `{ id: string; note?: string }` rather than the raw intersection. Purely
 *  cosmetic, and the cosmetics are most of the value of a type like this. */
type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};
export {};
//# sourceMappingURL=schema.d.ts.map