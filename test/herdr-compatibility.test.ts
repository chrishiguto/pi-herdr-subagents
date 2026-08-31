import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_HERDR_PROTOCOL,
  classifyHerdrStatus,
  probeHerdrReadiness,
} from "../src/herdr/compatibility.ts";

describe("Herdr compatibility", () => {
  it("accepts Herdr >=0.8.2 releases on protocol 20", () => {
    assert.deepEqual(
      classifyHerdrStatus({ ok: true, version: "0.8.2", protocol: 20 }),
      { ready: true, version: "0.8.2", protocol: SUPPORTED_HERDR_PROTOCOL },
    );
    assert.equal(
      classifyHerdrStatus({ ok: true, version: "v0.8.9-preview.1", protocol: 20 }).ready,
      true,
    );
  });

  it("reports a stopped or unreachable server as not running", () => {
    const result = classifyHerdrStatus({ ok: false, version: null, protocol: null });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "not-running");
    assert.match(result.error, /server is not running or reachable/i);
    assert.match(result.error, /Herdr >=0\.8\.2 <0\.9.*protocol 20/);
  });

  it("rejects an unsupported Herdr version even on protocol 20", () => {
    const result = classifyHerdrStatus({ ok: true, version: "0.9.0", protocol: 20 });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "incompatible");
    assert.match(result.error, /detected version 0\.9\.0 with protocol 20/);
  });

  it("rejects Herdr 0.8.0/0.8.1 even on protocol 20", () => {
    const result = classifyHerdrStatus({ ok: true, version: "0.8.1", protocol: 20 });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "incompatible");
    assert.match(result.error, /detected version 0\.8\.1 with protocol 20/);
  });

  it("rejects a protocol mismatch even on Herdr 0.8.x", () => {
    const result = classifyHerdrStatus({ ok: true, version: "0.8.2", protocol: 18 });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "incompatible");
    assert.match(result.error, /detected version 0\.8\.2 with protocol 18/);
  });

  it("treats missing version or protocol metadata as incompatible", () => {
    const result = classifyHerdrStatus({ ok: true });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "incompatible");
    assert.match(result.error, /version unknown with protocol unknown/);
  });

  it("classifies ENOENT probe failures as a missing executable", async () => {
    const missing = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    const result = await probeHerdrReadiness(async () => {
      throw missing;
    });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "missing");
    assert.match(result.error, /executable was not found/i);
    assert.match(result.error, /available on PATH/);
  });

  it("classifies other probe failures as an unreachable server", async () => {
    const result = await probeHerdrReadiness(async () => {
      throw new Error("connection refused");
    });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, "not-running");
    assert.match(result.error, /could not be reached: connection refused/);
  });
});
