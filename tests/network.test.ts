import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFakeIpAddress,
  isPublicAddress,
  selectSafeAddresses,
} from "../server/network.js";

test("recognises only the IPv4 Fake-IP range, including mapped addresses", () => {
  for (const address of [
    "198.18.0.1",
    "198.19.255.254",
    "::ffff:198.18.4.45",
  ]) {
    assert.equal(isFakeIpAddress(address), true);
    assert.equal(isPublicAddress(address), false);
  }
  for (const address of [
    "198.17.255.255",
    "198.20.0.1",
    "127.0.0.1",
    "10.0.0.1",
    "::1",
    "bad-ip",
  ])
    assert.equal(isFakeIpAddress(address), false);
});

test("Fake-IP DNS answers are replaced with checked real addresses", async () => {
  const expected = [{ address: "1.1.1.1", family: 4 }];
  let called = 0;
  const result = await selectSafeAddresses(
    "subscription.example",
    [{ address: "198.18.4.45", family: 4 }],
    false,
    async (hostname) => {
      assert.equal(hostname, "subscription.example");
      called++;
      return expected;
    },
  );
  assert.equal(called, 1);
  assert.deepEqual(result, expected);
});

test("private, mixed and literal reserved addresses never trigger the Fake-IP fallback", async () => {
  const fallback = async () => {
    assert.fail("Fallback must not run for these inputs");
    return [];
  };
  for (const [hostname, addresses] of [
    ["internal.example", [{ address: "127.0.0.1", family: 4 }]],
    [
      "mixed.example",
      [
        { address: "198.18.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    ],
    ["198.18.1.1", [{ address: "198.18.1.1", family: 4 }]],
  ] as const)
    await assert.rejects(
      selectSafeAddresses(hostname, [...addresses], false, fallback),
      /公共网络/,
    );
});

test("DoH answers cannot turn a Fake-IP lookup into a private network request", async () => {
  for (const answers of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "::ffff:10.0.0.1", family: 6 }],
    [
      { address: "1.1.1.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
    [{ address: "198.18.1.1", family: 4 }],
  ]) {
    await assert.rejects(
      selectSafeAddresses(
        "subscription.example",
        [{ address: "198.18.1.1", family: 4 }],
        false,
        async () => answers,
      ),
      /公共网络/,
    );
  }
});

test("ordinary public answers and operator-trusted private hosts retain their behavior", async () => {
  const fallback = async () => {
    assert.fail("Unnecessary fallback");
    return [];
  };
  const publicAnswers = [{ address: "1.1.1.1", family: 4 }];
  const trustedAnswers = [{ address: "127.0.0.1", family: 4 }];
  assert.deepEqual(
    await selectSafeAddresses("public.example", publicAnswers, false, fallback),
    publicAnswers,
  );
  assert.deepEqual(
    await selectSafeAddresses(
      "trusted.internal",
      trustedAnswers,
      true,
      fallback,
    ),
    trustedAnswers,
  );
});
