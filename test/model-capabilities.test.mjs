import assert from "node:assert/strict";
import test from "node:test";
import { catalogModels } from "../src/models.mjs";

const base = "https://api.krill-code.net/v1";
const model = (id, metadata) => catalogModels({ data: [{ id }] }, metadata ? [{ model_name: id, ...metadata }] : [], base)[id];

test("Krill's current GPT families expose the four documented reasoning levels to Magpie", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-fast", "gpt-6.1-sol-ultrafast", "gpt-6-astra", "gpt-6-astra-fast", "gpt-6-astra-ultrafast", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol-fast"]) {
    const m = model(id);
    assert.equal(m.api.npm, "@ai-sdk/openai");
    assert.equal(m.capabilities.reasoning, true);
    assert.equal(m.capabilities.toolcall, true);
    assert.deepEqual(Object.keys(m.variants), ["low", "medium", "high", "xhigh"]);
    for (const [effort, settings] of Object.entries(m.variants)) assert.equal(settings.reasoningEffort, effort);
  }
});

test("classic reasoning models use their common levels, without making every GPT ID adjustable", () => {
  for (const id of ["gpt-5", "gpt-5-mini", "o3", "o4-mini"]) {
    assert.deepEqual(Object.keys(model(id).variants), ["low", "medium", "high"]);
  }
  for (const id of ["codex-auto-review", "gpt-4o", "gpt-7-unknown", "gpt-6.1-sol-not-a-real-variant", "unknown-thinking-name"]) {
    assert.equal(model(id).capabilities.reasoning, false);
    assert.deepEqual(model(id).variants, {});
  }
});

test("Claude thinking capability does not fabricate OpenAI effort controls or mark old nonthinking models", () => {
  for (const id of ["claude-sonnet-4-5", "claude-opus-4-6", "claude-fable-5", "claude-haiku-4-5-20251001"]) {
    assert.equal(model(id).capabilities.reasoning, true);
    assert.deepEqual(model(id).variants, {});
  }
  assert.equal(model("claude-sonnet-3-5").capabilities.reasoning, false);
});

test("model modalities follow Krill metadata while unsupported tool capability remains off", () => {
  const gemini = model("gemini-3.1-pro-preview", { modalities: "text, image,VIDEO, audio,pdf, executable" });
  assert.deepEqual(gemini.capabilities.input, { text: true, image: true, audio: true, video: true, pdf: true });
  assert.equal(gemini.capabilities.toolcall, false);
  assert.deepEqual(model("unreported-model").capabilities.input, { text: true, image: false, audio: false, video: false, pdf: false });
});

test("media model output uses the declared type and does not inherit chat reasoning or token prices", () => {
  const m = catalogModels({ data: [{ id: "gpt-image-2" }] }, [{ model_name: "gpt-image-2", model_type: "image", modalities: "text,image", billing_mode: "request", request_price_usd: "0.1" }], base, [], { balance: true })["gpt-image-2"];
  assert.deepEqual(m.capabilities.output, { image: true });
  assert.equal(m.capabilities.input.image, true);
  assert.equal(m.capabilities.reasoning, false);
  assert.equal(m.capabilities.toolcall, false);
  assert.deepEqual(m.variants, {});
  assert.equal(m.cost, undefined);
  assert.equal(m.serviceTiers, undefined);
});
