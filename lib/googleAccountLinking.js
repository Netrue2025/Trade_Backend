function normalizeNamePart(value, fallback) {
  return String(value || fallback || "")
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || fallback;
}

function buildGoogleIdentityName(profile = {}) {
  const fallbackName = String(profile.name || profile.email?.split("@")[0] || "Google User")
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstName = normalizeNamePart(profile.firstName || fallbackName.split(" ")[0], "Google");
  const lastName = normalizeNamePart(profile.lastName || fallbackName.split(" ").slice(1).join(" "), "User");
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.replace(/\s+/g, " ").trim(),
  };
}

function makeError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveGoogleAccount({
  users = [],
  profile = {},
  requestedRole = "user",
  exchange = "bybit",
  allowAdminSignup = false,
  idGenerator,
  clock,
} = {}) {
  const sub = String(profile.sub || "").trim();
  const email = String(profile.email || "").trim().toLowerCase();
  if (!sub || !email) {
    throw makeError("Google credential is missing account identity.", 401);
  }
  const now = typeof clock === "function" ? clock() : new Date().toISOString();
  const linkedBySub = users.find((user) => String(user.googleSub || "").trim() === sub);
  const linkedByEmail = users.find((user) => String(user.email || "").trim().toLowerCase() === email);
  let user = linkedBySub || linkedByEmail || null;

  if (linkedBySub && linkedByEmail && linkedBySub.id !== linkedByEmail.id) {
    throw makeError("This Google account conflicts with an existing NetrueFi account. Contact support.", 409);
  }
  if (user && user.googleSub && user.googleSub !== sub) {
    throw makeError("This email is already linked to another Google account. Contact support.", 409);
  }
  if (user && user.role !== requestedRole) {
    throw makeError(`This account is not registered as ${requestedRole}.`, 403);
  }

  const isNewUser = !user;
  if (!user) {
    if (requestedRole === "admin" && !allowAdminSignup) {
      throw makeError("Admin signup is disabled. Sign in with an existing admin account.", 403);
    }
    const identity = buildGoogleIdentityName(profile);
    user = {
      id: typeof idGenerator === "function" ? idGenerator() : "",
      email,
      name: identity.name,
      firstName: identity.firstName,
      lastName: identity.lastName,
      role: requestedRole,
      mirrorEnabled: requestedRole === "user",
      passwordSalt: "",
      passwordHash: "",
      authProvider: "google",
      googleSub: sub,
      googleEmailVerified: true,
      googleLinkedAt: now,
      googlePicture: profile.picture || "",
      preferredExchange: exchange,
      binance: null,
      bybit: null,
      createdAt: now,
    };
    users.push(user);
  } else {
    user.authProvider = user.authProvider || "google";
    user.googleSub = sub;
    user.googleEmailVerified = true;
    user.googleLinkedAt = user.googleLinkedAt || now;
    user.googleLastLoginAt = now;
    user.googlePicture = profile.picture || user.googlePicture || "";
    if (!user.firstName || !user.lastName || !user.name) {
      const identity = buildGoogleIdentityName(profile);
      user.firstName = user.firstName || identity.firstName;
      user.lastName = user.lastName || identity.lastName;
      user.name = user.name || identity.name;
    }
  }

  return {
    user,
    isNewUser,
    linkedByEmail: !!linkedByEmail,
  };
}

module.exports = {
  buildGoogleIdentityName,
  resolveGoogleAccount,
};
