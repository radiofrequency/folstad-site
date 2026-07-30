/**
 * Cognito auth client (browser-native fetch to Cognito IdP API).
 * Falls back to local mock when PUBLIC_COGNITO_* env is unset.
 */

export type AuthSession = {
  sub: string;
  email: string;
  emailVerified: boolean;
  accessToken: string;
  idToken: string;
  refreshToken?: string;
};

const SESSION_KEY = "buzz-auth-session";
const MOCK_USERS_KEY = "buzz-mock-users";

export type CognitoConfig = {
  userPoolId: string;
  clientId: string;
  region: string;
};

export function getCognitoConfig(): CognitoConfig | null {
  const userPoolId = import.meta.env.PUBLIC_COGNITO_USER_POOL_ID as string | undefined;
  const clientId = import.meta.env.PUBLIC_COGNITO_CLIENT_ID as string | undefined;
  const region =
    (import.meta.env.PUBLIC_COGNITO_REGION as string | undefined) || "us-west-2";
  if (!userPoolId || !clientId) return null;
  return { userPoolId, clientId, region };
}

export function isMockAuth(): boolean {
  return getCognitoConfig() === null;
}

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

export function setSession(session: AuthSession | null) {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/** Join site base + path (`/dashboard`, `dashboard`, etc.). */
export function appPath(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const baseNorm = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${baseNorm}${p}` || p;
}

/**
 * Only allow same-app relative paths for post-login redirects.
 * Blocks open redirects and junk `next` values.
 */
export function safeReturnPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  const fb = appPath(fallback);
  if (!raw) return fb;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  // Absolute URLs → path only if same origin
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (u.origin !== window.location.origin) return fb;
      value = u.pathname + u.search + u.hash;
    } catch {
      return fb;
    }
  }
  if (!value.startsWith("/") || value.startsWith("//")) return fb;
  // Never bounce back to auth screens as the "destination"
  if (/^\/(login|signup|confirm)(\/|\?|#|$)/i.test(value)) return fb;
  return value;
}

export function requireSession(nextPath: string): AuthSession | null {
  const s = getSession();
  if (s?.emailVerified) return s;
  const dest = safeReturnPath(nextPath);
  const q = new URLSearchParams({ next: dest });
  if (s && !s.emailVerified) {
    window.location.replace(
      `${appPath("/confirm")}?${q}&email=${encodeURIComponent(s.email)}`,
    );
  } else {
    window.location.replace(`${appPath("/login")}?${q}`);
  }
  return null;
}

// ——— Cognito IdP over fetch (no amazon-cognito-identity-js) ———

type CognitoErrorBody = {
  __type?: string;
  message?: string;
  Message?: string;
};

async function cognitoCall<T>(
  region: string,
  target: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `Cognito error (${res.status})`);
  }

  if (!res.ok) {
    const err = data as CognitoErrorBody;
    const type = (err.__type ?? "").split("#").pop() ?? "Error";
    const msg = err.message ?? err.Message ?? type;
    throw Object.assign(new Error(msg), { code: type, name: type });
  }

  return data as T;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

// ——— Mock ———

type MockUser = {
  email: string;
  password: string;
  sub: string;
  verified: boolean;
  code: string;
};

function loadMockUsers(): MockUser[] {
  try {
    return JSON.parse(localStorage.getItem(MOCK_USERS_KEY) ?? "[]") as MockUser[];
  } catch {
    return [];
  }
}

function saveMockUsers(users: MockUser[]) {
  localStorage.setItem(MOCK_USERS_KEY, JSON.stringify(users));
}

function mockToken(sub: string, email: string): string {
  return `mock:${sub}:${email}`;
}

// ——— Public API ———

export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  email = email.trim().toLowerCase();
  if (!email || !password) throw new Error("Email and password required");

  const cfg = getCognitoConfig();
  if (!cfg) {
    const users = loadMockUsers();
    if (users.some((u) => u.email === email)) throw new Error("Account already exists");
    users.push({
      email,
      password,
      sub: crypto.randomUUID(),
      verified: false,
      code: "123456",
    });
    saveMockUsers(users);
    console.info("[buzz mock auth] verification code:", "123456");
    return { needsConfirm: true };
  }

  await cognitoCall(cfg.region, "SignUp", {
    ClientId: cfg.clientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: "email", Value: email }],
  });
  return { needsConfirm: true };
}

/** Normalize verification codes (strip spaces/dashes from email copy-paste). */
function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").trim();
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  email = email.trim().toLowerCase();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Enter the verification code from your email.");

  const cfg = getCognitoConfig();

  if (!cfg) {
    const users = loadMockUsers();
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error("Unknown account");
    if (normalized !== u.code) throw new Error("Invalid verification code (mock uses 123456)");
    u.verified = true;
    saveMockUsers(users);
    return;
  }

  try {
    await cognitoCall(cfg.region, "ConfirmSignUp", {
      ClientId: cfg.clientId,
      Username: email,
      ConfirmationCode: normalized,
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyCognitoError(err, "confirm")), {
      code: (err as { code?: string }).code,
    });
  }
}

/** Resend the signup verification email. */
export async function resendConfirmationCode(email: string): Promise<void> {
  email = email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");

  const cfg = getCognitoConfig();
  if (!cfg) {
    const users = loadMockUsers();
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error("Unknown account — sign up first");
    if (u.verified) throw new Error("Already verified — sign in instead");
    u.code = "123456";
    saveMockUsers(users);
    console.info("[buzz mock auth] verification code:", "123456");
    return;
  }

  try {
    await cognitoCall(cfg.region, "ResendConfirmationCode", {
      ClientId: cfg.clientId,
      Username: email,
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyCognitoError(err, "resend")), {
      code: (err as { code?: string }).code,
    });
  }
}

function friendlyCognitoError(err: unknown, context: "confirm" | "resend" | "signin"): string {
  const code = String((err as { code?: string; name?: string }).code ?? (err as { name?: string }).name ?? "");
  const msg = err instanceof Error ? err.message : "Request failed";

  if (code === "CodeMismatchException") {
    return "That code doesn’t match. Check the latest email and try again (digits only).";
  }
  if (code === "ExpiredCodeException") {
    if (context === "confirm") {
      return "This code is expired or already used. If you already verified, sign in. Otherwise resend a new code.";
    }
    return "Code expired — request a new one.";
  }
  if (code === "UserNotFoundException") {
    return "No account found for that email. Sign up first.";
  }
  if (code === "NotAuthorizedException") {
    if (/confirmed/i.test(msg) || /already/i.test(msg)) {
      return "This account is already verified — sign in.";
    }
    return msg || "Not authorized.";
  }
  if (code === "InvalidParameterException" && /confirmed/i.test(msg)) {
    return "This account is already verified — sign in.";
  }
  if (code === "LimitExceededException" || code === "TooManyRequestsException") {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (code === "UsernameExistsException") {
    return "An account with this email already exists. Sign in or confirm if pending.";
  }
  if (code === "UserNotConfirmedException") {
    return "Email not verified yet. Enter the code from your email, or resend it.";
  }
  if (code === "InvalidPasswordException") {
    return msg || "Password does not meet requirements.";
  }
  return msg || "Something went wrong.";
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  email = email.trim().toLowerCase();
  const cfg = getCognitoConfig();

  if (!cfg) {
    const users = loadMockUsers();
    const u = users.find((x) => x.email === email && x.password === password);
    if (!u) throw new Error("Incorrect email or password");
    if (!u.verified) {
      const pending: AuthSession = {
        sub: u.sub,
        email: u.email,
        emailVerified: false,
        accessToken: mockToken(u.sub, u.email),
        idToken: mockToken(u.sub, u.email),
      };
      setSession(pending);
      throw Object.assign(new Error("Email not verified"), { code: "EMAIL_UNVERIFIED" });
    }
    const session: AuthSession = {
      sub: u.sub,
      email: u.email,
      emailVerified: true,
      accessToken: mockToken(u.sub, u.email),
      idToken: mockToken(u.sub, u.email),
    };
    setSession(session);
    return session;
  }

  try {
    const result = await cognitoCall<{
      AuthenticationResult?: {
        AccessToken?: string;
        IdToken?: string;
        RefreshToken?: string;
      };
      ChallengeName?: string;
    }>(cfg.region, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cfg.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    if (result.ChallengeName) {
      throw new Error(`Unsupported auth challenge: ${result.ChallengeName}`);
    }

    const accessToken = result.AuthenticationResult?.AccessToken;
    const idToken = result.AuthenticationResult?.IdToken;
    if (!accessToken || !idToken) {
      throw new Error("Sign in failed: no tokens returned");
    }

    const payload = decodeJwtPayload(idToken);
    const session: AuthSession = {
      sub: String(payload.sub ?? ""),
      email: String(payload.email ?? email),
      emailVerified:
        payload.email_verified === true ||
        payload.email_verified === "true" ||
        true,
      accessToken,
      idToken,
      refreshToken: result.AuthenticationResult?.RefreshToken,
    };
    setSession(session);
    return session;
  } catch (err) {
    const code = (err as { code?: string; name?: string }).code ?? (err as { name?: string }).name;
    if (code === "UserNotConfirmedException") {
      throw Object.assign(new Error("Email not verified"), { code: "EMAIL_UNVERIFIED" });
    }
    if (code === "NotAuthorizedException") {
      throw new Error("Incorrect email or password.");
    }
    throw Object.assign(new Error(friendlyCognitoError(err, "signin")), {
      code: (err as { code?: string }).code,
    });
  }
}

export function signOut() {
  setSession(null);
}

export function authModeLabel(): string {
  return isMockAuth() ? "Local mock auth (code 123456)" : "AWS Cognito";
}
