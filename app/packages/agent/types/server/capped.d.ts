/** Create the delta collection as capped. On NamespaceExists (code 48),
 *  verifies capped-ness via collStats and fails loudly if it isn't —
 *  an uncapped delta store grows without limit. */
export declare function ensureCapped(): Promise<void>;
//# sourceMappingURL=capped.d.ts.map