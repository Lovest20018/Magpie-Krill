import { createProvider } from "./src/provider.mjs";

// Magpie treats every exported function as a plugin. Export the two
// providers only; shared services and helpers belong in src/.
export const KrillUsagePlugin = async (input, options = {}) => createProvider("krill", options, input);
export const KrillBalancePlugin = async (input, options = {}) => createProvider("krill-balance", options, input);
