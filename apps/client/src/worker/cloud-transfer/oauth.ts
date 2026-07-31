import { randomBase64Url, sha256Base64Url } from "./crypto";
import { providerFetch, responseJson, type Fetcher } from "./providers/provider";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkce(): Promise<PkcePair> {
  const verifier = randomBase64Url(64);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export function createOAuthState(): string {
  return randomBase64Url(32);
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  scope?: string;
}

interface AuthorizationInput {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

function expiresAt(expiresIn: unknown, now = Date.now()): string | undefined {
  const seconds = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(now + seconds * 1000).toISOString()
    : undefined;
}

export function buildDropboxAuthorizationUrl(input: AuthorizationInput): string {
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
  }).toString();
  return url.toString();
}

export function buildGoogleAuthorizationUrl(input: AuthorizationInput): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    include_granted_scopes: "false",
    prompt: "consent",
  }).toString();
  return url.toString();
}

interface CodeExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetch?: Fetcher;
}

interface RefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: Fetcher;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
  scope?: string;
}

async function tokenRequest(
  endpoint: string,
  parameters: Record<string, string>,
  operation: string,
  fetcher: Fetcher,
): Promise<TokenResponse> {
  const response = await providerFetch(fetcher, endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
  }, { operation });
  const token = await responseJson<TokenResponse>(response, operation);
  if (!token.access_token) throw new Error("authorization-token-invalid");
  return token;
}

function normalizeToken(token: TokenResponse): OAuthToken {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAt(token.expires_in),
    accountId: token.account_id,
    scope: token.scope,
  };
}

export async function exchangeDropboxCode(input: CodeExchangeInput): Promise<OAuthToken> {
  const token = await tokenRequest("https://api.dropboxapi.com/oauth2/token", {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  }, "dropbox-oauth-exchange", input.fetch ?? fetch);
  return normalizeToken(token);
}

export async function refreshDropboxToken(input: RefreshInput): Promise<OAuthToken> {
  const token = await tokenRequest("https://api.dropboxapi.com/oauth2/token", {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, "dropbox-oauth-refresh", input.fetch ?? fetch);
  return { ...normalizeToken(token), refreshToken: input.refreshToken };
}

export async function exchangeGoogleCode(input: CodeExchangeInput): Promise<OAuthToken> {
  const token = await tokenRequest("https://oauth2.googleapis.com/token", {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  }, "google-oauth-exchange", input.fetch ?? fetch);
  return normalizeToken(token);
}

export async function refreshGoogleToken(input: RefreshInput): Promise<OAuthToken> {
  const token = await tokenRequest("https://oauth2.googleapis.com/token", {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, "google-oauth-refresh", input.fetch ?? fetch);
  return { ...normalizeToken(token), refreshToken: input.refreshToken };
}
