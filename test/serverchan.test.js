import test from "node:test";
import assert from "node:assert/strict";
import { classifySendKey, prepareServerChan, sendPreparedServerChan } from "../src/providers/serverchan.js";

test("classifies SCT and SC3 endpoints", () => {
  assert.equal(classifySendKey("SCTabc_123").endpoint, "https://sctapi.ftqq.com/SCTabc_123.send");
  assert.equal(classifySendKey("sctp12tabc_123").endpoint, "https://12.push.ft07.com/send/sctp12tabc_123.send");
  assert.throws(() => classifySendKey("bad-key"), { code: "configuration_invalid" });
});

test("maps SCT body and omits unsupported tags", () => {
  const prepared = prepareServerChan({
    sendKey: "SCTabc",
    channel: { delivery_channels: ["9", "66"], hide_caller_ip: true },
    message: { title: "Done", body: "Body", summary: "Short", tags: ["build"], url: "https://example.com" },
  });
  assert.deepEqual(prepared.body, {
    title: "Done",
    desp: "Body\n\nhttps://example.com",
    short: "Short",
    channel: "9|66",
    noip: 1,
  });
  assert.deepEqual(prepared.transformations, ["url_appended_to_body", "tags_omitted"]);
});

test("maps SC3 tags and rejects SCT-only options", () => {
  const prepared = prepareServerChan({
    sendKey: "sctp2tabc",
    channel: {},
    message: { title: "Done", body: "Body", tags: ["build", "success"] },
  });
  assert.equal(prepared.body.tags, "build|success");
  assert.throws(
    () => prepareServerChan({ sendKey: "sctp2tabc", channel: { hide_caller_ip: true }, message: { title: "Done", body: "Body" } }),
    { code: "configuration_invalid" },
  );
});

test("maps accepted, rejected, and ambiguous provider outcomes", async () => {
  const prepared = prepareServerChan({ sendKey: "SCTabc", channel: {}, message: { title: "Done", body: "Body" } });
  const accepted = await sendPreparedServerChan(prepared, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
  });
  assert.equal(accepted.status, "accepted");

  const rejected = await sendPreparedServerChan(prepared, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 1 }), { status: 200 }),
  });
  assert.equal(rejected.status, "rejected");

  const uncertain = await sendPreparedServerChan(prepared, {
    fetchImpl: async () => { throw new TypeError("network SCTabc"); },
  });
  assert.deepEqual(uncertain, { status: "uncertain", reason: "transport_ambiguous", transformations: [] });
});
