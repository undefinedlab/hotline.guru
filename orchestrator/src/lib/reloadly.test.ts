import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearReloadlyTokenCache,
  countryIsoFromE164,
  e164Digits,
  reloadlyAudience,
  reloadlyEnv,
} from "./reloadly.js";

describe("reloadly helpers", () => {
  it("maps Irish and US MSISDNs to ISO", () => {
    const prev = process.env.RELOADLY_DEFAULT_COUNTRY;
    delete process.env.RELOADLY_DEFAULT_COUNTRY;
    try {
      assert.equal(countryIsoFromE164("+353899494966"), "IE");
      assert.equal(countryIsoFromE164("+15551230001"), "US");
      assert.equal(countryIsoFromE164("+447911123456"), "GB");
      assert.equal(countryIsoFromE164("+2348012345678"), "NG");
    } finally {
      if (prev === undefined) delete process.env.RELOADLY_DEFAULT_COUNTRY;
      else process.env.RELOADLY_DEFAULT_COUNTRY = prev;
    }
  });

  it("strips plus for Reloadly phone field", () => {
    assert.equal(e164Digits("+353899494966"), "353899494966");
  });

  it("defaults to sandbox audience", () => {
    const prev = process.env.RELOADLY_ENV;
    delete process.env.RELOADLY_ENV;
    delete process.env.AIRTIME_RELOADLY_ENV;
    clearReloadlyTokenCache();
    assert.equal(reloadlyEnv(), "sandbox");
    assert.equal(reloadlyAudience(), "https://topups-sandbox.reloadly.com");
    process.env.RELOADLY_ENV = "live";
    assert.equal(reloadlyEnv(), "live");
    assert.equal(reloadlyAudience(), "https://topups.reloadly.com");
    if (prev === undefined) delete process.env.RELOADLY_ENV;
    else process.env.RELOADLY_ENV = prev;
  });
});
