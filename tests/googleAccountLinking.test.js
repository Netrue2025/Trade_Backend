const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveGoogleAccount } = require("../lib/googleAccountLinking");

function profile(overrides = {}) {
  return {
    sub: "google-sub-1",
    email: "Ada@Example.com",
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    picture: "https://example.com/ada.png",
    ...overrides,
  };
}

test("Google account linking attaches a verified Google identity to an existing email user", () => {
  const users = [
    {
      id: "user-1",
      email: "ada@example.com",
      name: "Ada Existing",
      firstName: "Ada",
      lastName: "Existing",
      role: "user",
      preferredExchange: "bybit",
    },
  ];

  const result = resolveGoogleAccount({
    users,
    profile: profile(),
    requestedRole: "user",
    exchange: "binance",
    idGenerator: () => "new-user",
    clock: () => "2026-09-14T10:00:00.000Z",
  });

  assert.equal(result.user.id, "user-1");
  assert.equal(result.isNewUser, false);
  assert.equal(result.linkedByEmail, true);
  assert.equal(users.length, 1);
  assert.equal(users[0].googleSub, "google-sub-1");
  assert.equal(users[0].googleEmailVerified, true);
  assert.equal(users[0].preferredExchange, "bybit");
});

test("Google account linking creates a normal user when no account exists", () => {
  const users = [];

  const result = resolveGoogleAccount({
    users,
    profile: profile(),
    requestedRole: "user",
    exchange: "binance",
    idGenerator: () => "new-user",
    clock: () => "2026-09-14T10:00:00.000Z",
  });

  assert.equal(result.isNewUser, true);
  assert.equal(result.linkedByEmail, false);
  assert.equal(users.length, 1);
  assert.equal(result.user.id, "new-user");
  assert.equal(result.user.email, "ada@example.com");
  assert.equal(result.user.role, "user");
  assert.equal(result.user.mirrorEnabled, true);
  assert.equal(result.user.preferredExchange, "binance");
  assert.equal(result.user.googleSub, "google-sub-1");
});

test("Google account linking rejects conflicting Google identities", () => {
  const users = [
    {
      id: "user-1",
      email: "ada@example.com",
      role: "user",
      googleSub: "other-google-sub",
    },
  ];

  assert.throws(
    () => resolveGoogleAccount({ users, profile: profile(), requestedRole: "user" }),
    /already linked to another Google account/i
  );
  assert.equal(users.length, 1);
});

test("Google account linking reuses the same Google sub without creating duplicates", () => {
  const users = [
    {
      id: "user-1",
      email: "old-email@example.com",
      name: "",
      firstName: "",
      lastName: "",
      role: "user",
      googleSub: "google-sub-1",
    },
  ];

  const first = resolveGoogleAccount({
    users,
    profile: profile(),
    requestedRole: "user",
    idGenerator: () => "new-user-1",
    clock: () => "2026-09-14T10:00:00.000Z",
  });
  const second = resolveGoogleAccount({
    users,
    profile: profile({ picture: "https://example.com/ada-2.png" }),
    requestedRole: "user",
    idGenerator: () => "new-user-2",
    clock: () => "2026-09-14T10:05:00.000Z",
  });

  assert.equal(first.user.id, "user-1");
  assert.equal(second.user.id, "user-1");
  assert.equal(users.length, 1);
  assert.equal(users[0].name, "Ada Lovelace");
  assert.equal(users[0].googlePicture, "https://example.com/ada-2.png");
  assert.equal(users[0].googleLastLoginAt, "2026-09-14T10:05:00.000Z");
});
