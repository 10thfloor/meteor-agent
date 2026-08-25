export type FromSchema<S> = S extends {
    enum: readonly (infer E)[];
} ? E : S extends {
    const: infer C;
} ? C : S extends {
    type: readonly (infer T)[] | (infer T)[];
} ? FromPrimitive<T, S> : S extends {
    type: infer T;
} ? FromPrimitive<T, S> : unknown;
type FromPrimitive<T, S> = (T extends 'string' ? string : never) | (T extends 'number' | 'integer' ? number : never) | (T extends 'boolean' ? boolean : never) | (T extends 'null' ? null : never) | (T extends 'array' ? (S extends {
    items: infer I;
} ? FromSchema<I>[] : unknown[]) : never) | (T extends 'object' ? FromObject<S> : never);
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
type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};
export {};
//# sourceMappingURL=schema.d.ts.map