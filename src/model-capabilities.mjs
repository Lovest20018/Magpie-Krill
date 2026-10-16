const OPENAI_LEVELS = ["low", "medium", "high", "xhigh"];

// Krill's OpenCode guide documents these four levels for its current
// OpenAI channel. Keep the model families explicit; unknown IDs and the
// auto-review service must not acquire effort controls by name alone.
const KRILL_GPT = /^gpt-(?:5\.6-(?:luna|sol|terra)|6-(?:sol|astra)|6\.1-sol)(?:-(?:fast|ultrafast))?$/i;
const CLASSIC_REASONING = /^(?:gpt-5(?:-mini|-nano)?|o[134](?:-mini)?)$/i;
const CLAUDE_THINKING = /^claude-(?:(?:sonnet|opus|fable)-(?:[4-9]|[1-9]\d)|haiku-4[-.]5)/i;
const MODALITIES = ["text", "image", "audio", "video", "pdf"];

export function krillSpeedBase(id) {
  if (typeof id !== "string" || !KRILL_GPT.test(id) || !/-(?:fast|ultrafast)$/i.test(id)) return undefined;
  return id.replace(/-(?:fast|ultrafast)$/i, "");
}

export function modelCapabilities(id, price) {
  const documentedGPT = KRILL_GPT.test(id);
  const classic = CLASSIC_REASONING.test(id);
  const claude = CLAUDE_THINKING.test(id);
  const levels = documentedGPT ? OPENAI_LEVELS : classic ? OPENAI_LEVELS.slice(0, 3) : [];
  const declared = typeof price?.modalities === "string" ? price.modalities.split(",").map((value) => value.trim().toLowerCase()) : [];
  return {
    capabilities: {
      reasoning: documentedGPT || classic || claude,
      // Krill publishes coding/tool examples for these families. Other
      // models can still chat, without an unsupported tool-call promise.
      toolcall: documentedGPT || classic || /^claude[-.]/i.test(id),
      input: Object.fromEntries(MODALITIES.map((kind) => [kind, kind === "text" || declared.includes(kind)])),
      output: { text: true },
    },
    variants: Object.fromEntries(levels.map((effort) => [effort, { reasoningEffort: effort }])),
  };
}
