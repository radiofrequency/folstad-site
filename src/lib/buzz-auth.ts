/**
 * Auth client via AWS Cognito IdP JSON API (email sign-up / sign-in / reset).
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

export type AuthConfig = {
  userPoolId: string;
  clientId: string;
  region: string;
};

/** Public SPA config (safe to ship). Override with PUBLIC_* env if needed. */
const DEFAULT_AUTH = {
  userPoolId: "us-west-2_MIDcSvkwq",
  clientId: "5klcs2rg7lmfgjggsl7bo2llkm",
  region: "us-west-2",
};

export function getAuthConfig(): AuthConfig {
  return {
    userPoolId:
      (import.meta.env.PUBLIC_COGNITO_USER_POOL_ID as string | undefined) ||
      DEFAULT_AUTH.userPoolId,
    clientId:
      (import.meta.env.PUBLIC_COGNITO_CLIENT_ID as string | undefined) ||
      DEFAULT_AUTH.clientId,
    region:
      (import.meta.env.PUBLIC_COGNITO_REGION as string | undefined) ||
      DEFAULT_AUTH.region,
  };
}

/** @deprecated use getAuthConfig */
export function getCognitoConfig(): AuthConfig {
  return getAuthConfig();
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
  if (/^\/(login|signup|confirm|forgot-password)(\/|\?|#|$)/i.test(value)) return fb;
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

// ——— IdP over fetch ———

type IdpErrorBody = {
  __type?: string;
  message?: string;
  Message?: string;
};

async function idpCall<T>(
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
    throw new Error(text || `Auth error (${res.status})`);
  }

  if (!res.ok) {
    const err = data as IdpErrorBody;
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

/** Normalize verification codes (strip spaces/dashes from email copy-paste). */
function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").trim();
}

function friendlyAuthError(
  err: unknown,
  context: "confirm" | "resend" | "signin" | "forgot" | "reset" | "signup",
): string {
  const code = String(
    (err as { code?: string; name?: string }).code ?? (err as { name?: string }).name ?? "",
  );
  const msg = err instanceof Error ? err.message : "Request failed";

  if (code === "CodeMismatchException") {
    return "That code doesn’t match. Check the latest email and try again.";
  }
  if (code === "ExpiredCodeException") {
    if (context === "confirm") {
      return "This code is expired or already used. If you already verified, sign in. Otherwise resend a new code.";
    }
    if (context === "reset") {
      return "This reset code expired. Request a new one.";
    }
    return "Code expired — request a new one.";
  }
  if (code === "UserNotFoundException") {
    if (context === "forgot") {
      return "If that email is registered, we sent a reset code.";
    }
    return "No account found for that email. Sign up first.";
  }
  if (code === "NotAuthorizedException") {
    if (/confirmed/i.test(msg) || /already/i.test(msg)) {
      return "This account is already verified — sign in.";
    }
    if (context === "forgot" || context === "reset") {
      return "Password reset isn’t available for this account. Try signing up again.";
    }
    if (context === "signin") {
      return "Incorrect email or password.";
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
    return "An account with this email already exists. Sign in or reset your password.";
  }
  if (code === "UserNotConfirmedException") {
    return "Email not verified yet. Enter the code from your email, or resend it.";
  }
  if (code === "InvalidPasswordException") {
    return msg || "Password does not meet requirements (min 8, upper, lower, number).";
  }
  return msg || "Something went wrong.";
}

export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  email = email.trim().toLowerCase();
  if (!email || !password) throw new Error("Email and password required");

  const cfg = getAuthConfig();
  try {
    await idpCall(cfg.region, "SignUp", {
      ClientId: cfg.clientId,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyAuthError(err, "signup")), {
      code: (err as { code?: string }).code,
    });
  }
  return { needsConfirm: true };
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  email = email.trim().toLowerCase();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Enter the verification code from your email.");

  const cfg = getAuthConfig();
  try {
    await idpCall(cfg.region, "ConfirmSignUp", {
      ClientId: cfg.clientId,
      Username: email,
      ConfirmationCode: normalized,
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyAuthError(err, "confirm")), {
      code: (err as { code?: string }).code,
    });
  }
}

export async function resendConfirmationCode(email: string): Promise<void> {
  email = email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");

  const cfg = getAuthConfig();
  try {
    await idpCall(cfg.region, "ResendConfirmationCode", {
      ClientId: cfg.clientId,
      Username: email,
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyAuthError(err, "resend")), {
      code: (err as { code?: string }).code,
    });
  }
}

export async function forgotPassword(email: string): Promise<{ message: string }> {
  email = email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");

  const cfg = getAuthConfig();
  try {
    await idpCall(cfg.region, "ForgotPassword", {
      ClientId: cfg.clientId,
      Username: email,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "UserNotFoundException" || code === "InvalidParameterException") {
      return { message: "If that email is registered, we sent a reset code." };
    }
    throw Object.assign(new Error(friendlyAuthError(err, "forgot")), { code });
  }

  return {
    message: "If that email is registered, we sent a reset code. Check your inbox (and spam).",
  };
}

export async function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  email = email.trim().toLowerCase();
  const normalized = normalizeCode(code);
  if (!email) throw new Error("Email is required");
  if (!normalized) throw new Error("Enter the reset code from your email.");
  if (!newPassword || newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const cfg = getAuthConfig();
  try {
    await idpCall(cfg.region, "ConfirmForgotPassword", {
      ClientId: cfg.clientId,
      Username: email,
      ConfirmationCode: normalized,
      Password: newPassword,
    });
  } catch (err) {
    throw Object.assign(new Error(friendlyAuthError(err, "reset")), {
      code: (err as { code?: string }).code,
    });
  }
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  email = email.trim().toLowerCase();
  const cfg = getAuthConfig();

  try {
    const result = await idpCall<{
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
    throw Object.assign(new Error(friendlyAuthError(err, "signin")), {
      code: (err as { code?: string }).code,
    });
  }
}

export function signOut() {
  setSession(null);
}
