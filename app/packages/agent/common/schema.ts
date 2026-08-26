// Maps a tool's JSON Schema `args` to a TypeScript type.
// Covers objects, arrays, primitives, type unions, enum, const; else unknown.
export type FromSchema<S> =
  // `enum` and `const` outrank `type`.
  S extends { enum: readonly (infer E)[] } ? E
    : S extends { const: infer C } ? C
      // A type array is JSON Schema's nullable: {type:['integer','null']}.
      : S extends { type: readonly (infer T)[] | (infer T)[] } ? FromPrimitive<T, S>
        : S extends { type: infer T } ? FromPrimitive<T, S>
          : unknown;

// One `type` keyword to its TS equivalent. Distributes over a union.
type FromPrimitive<T, S> =
  | (T extends 'string' ? string : never)
  | (T extends 'number' | 'integer' ? number : never)
  | (T extends 'boolean' ? boolean : never)
  | (T extends 'null' ? null : never)
  | (T extends 'array' ? (S extends { items: infer I } ? FromSchema<I>[] : unknown[]) : never)
  | (T extends 'object' ? FromObject<S> : never);

// Object schema. Keys not in `required` become optional. A schema with no
// `properties` widens to `Record<string, unknown>` rather than `{}`.
type FromObject<S> =
  S extends { properties: infer P }
    ? S extends { required: readonly (infer R)[] | (infer R)[] }
      ? Prettify<
        { [K in Extract<keyof P, R>]: FromSchema<P[K]> }
        & { [K in Exclude<keyof P, R>]?: FromSchema<P[K]> }
      >
      // No `required` — every property is optional.
      : Prettify<{ [K in keyof P]?: FromSchema<P[K]> }>
    : Record<string, unknown>;

// Flattens an intersection so hovers show `{ id: string; note?: string }`
// instead of the raw `{ id: string } & { note?: string }`.
type Prettify<T> = { [K in keyof T]: T[K] } & {};
