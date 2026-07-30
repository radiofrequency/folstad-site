import type { APIGatewayProxyResultV2 } from "aws-lambda";

const CORS = {
  "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...CORS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResultV2 {
  return { statusCode: 204, headers: { ...CORS }, body: "" };
}

export function error(
  statusCode: number,
  message: string,
  code?: string,
): APIGatewayProxyResultV2 {
  return json(statusCode, { error: message, code });
}

export type AuthUser = {
  sub: string;
  email: string;
  emailVerified: boolean;
};

export function getUser(event: {
  requestContext?: {
    authorizer?: {
      jwt?: { claims?: Record<string, string> };
      lambda?: { sub?: string; email?: string; email_verified?: string };
    };
  };
  headers?: Record<string, string | undefined>;
}): AuthUser | null {
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ??
    (event.requestContext?.authorizer?.lambda as Record<string, string> | undefined);

  if (claims?.sub) {
    const verifiedRaw = String(claims.email_verified ?? "").toLowerCase();
    // Access tokens often omit email_verified; Cognito only issues tokens after confirm.
    const email =
      String(claims.email ?? claims.username ?? claims["cognito:username"] ?? "").trim();
    const verified =
      verifiedRaw === "true" ||
      verifiedRaw === "1" ||
      // JWT authorizer present ⇒ user already authenticated with Cognito
      verifiedRaw === "";
    return {
      sub: String(claims.sub),
      email,
      emailVerified: verified || Boolean(email),
    };
  }

  // Local/dev mock: Authorization: Bearer mock:<sub>:<email>
  const auth =
    event.headers?.authorization ??
    event.headers?.Authorization ??
    "";
  const m = /^Bearer\s+mock:([^:]+):(.+)$/i.exec(auth);
  if (m) {
    return { sub: m[1], email: m[2], emailVerified: true };
  }

  return null;
}
