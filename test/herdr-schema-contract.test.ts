import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const authorized = process.env.PI_RUN_HERDR_CONTRACT === "1";
const contract = authorized ? describe : describe.skip;

contract("Herdr protocol contract", () => {
  it("matches the protocol-20 methods and fields consumed by the extension", () => {
    const bin = process.env.HERDR_CONTRACT_BIN ?? "herdr";
    const schema = JSON.parse(
      execFileSync(bin, ["api", "schema", "--json"], { encoding: "utf8" }),
    );
    assert.equal(schema.protocol, 20);
    assert.equal(schema.schema_version, 1);

    const encoded = JSON.stringify(schema);
    for (const required of [
      "session.snapshot",
      "agent.start",
      "agent.prompt",
      "agent.send_keys",
      "pane.moved",
      "pane.agent_status_changed",
      "terminal_id",
      "agent_status",
    ]) {
      assert.ok(encoded.includes(required), `Herdr schema must contain ${required}`);
    }
  });
});
