/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GUEST,
  SUPPORTED_GUESTS,
  resolveGuest,
} from "../plugins/codex/scripts/lib/guest.mjs";

describe("resolveGuest", () => {
  it("defaults to codex when flag and env are unset", () => {
    assert.equal(DEFAULT_GUEST, "codex");
    assert.deepEqual([...SUPPORTED_GUESTS], ["codex", "grok"]);
    assert.equal(resolveGuest(undefined, {}), "codex");
    assert.equal(resolveGuest(null, {}), "codex");
    assert.equal(resolveGuest("", {}), "codex");
  });

  it("reads CC_GUEST when the CLI flag is omitted", () => {
    assert.equal(resolveGuest(undefined, { CC_GUEST: "grok" }), "grok");
    assert.equal(resolveGuest("  ", { CC_GUEST: "GROK" }), "grok");
  });

  it("lets an explicit --guest value override CC_GUEST", () => {
    assert.equal(resolveGuest("codex", { CC_GUEST: "grok" }), "codex");
    assert.equal(resolveGuest("Grok", { CC_GUEST: "codex" }), "grok");
  });

  it("ignores a blank CC_GUEST and keeps the default", () => {
    assert.equal(resolveGuest(undefined, { CC_GUEST: "  " }), "codex");
  });

  it("rejects unknown guests", () => {
    assert.throws(
      () => resolveGuest("claude", {}),
      /Unsupported guest "claude"/
    );
    assert.throws(
      () => resolveGuest(undefined, { CC_GUEST: "chatgpt" }),
      /Unsupported guest "chatgpt"/
    );
  });
});
