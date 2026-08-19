import axios, { type AxiosResponse } from 'axios';
import { Context, Duration, Effect, Layer, Ref, Schedule } from 'effect';
import type {
  ServiceNowCatalogDefinition,
  ServiceNowOAuthConfig
} from '../../configmodels/ServiceNowCatalogAppConfig';
import { normalizeServiceNowResponse } from './normalizeResponse';
import { ServiceNowAuditAction, withIntegrationAudit } from './audit';
import type { SubmitRunContext } from './context';
import { CatalogRequestError, CatalogTimeoutError, OAuthTokenError, causeMessage } from './errors';

export interface ServiceNowHttpResult {
  statusCode: number;
  data: unknown;
}

export type ServiceNowClientError = OAuthTokenError | CatalogRequestError | CatalogTimeoutError;

export interface ServiceNowClient {
  submitCatalogOrder(body: Record<string, unknown>): Effect.Effect<ServiceNowHttpResult, ServiceNowClientError>;
}

export const ServiceNowClientTag = Context.GenericTag<ServiceNowClient>('servicenow-catalog/Client');

function oauthRequestParams(oid: string, oauth: ServiceNowOAuthConfig): Effect.Effect<URLSearchParams, OAuthTokenError> {
  return Effect.suspend(() => {
    if (!oauth.url || !oauth.clientId || !oauth.clientSecret) {
      return Effect.fail(new OAuthTokenError({
        oid,
        reason: 'OAuth is enabled but its URL, client ID, or client secret is missing.'
      }));
    }
    const params = new URLSearchParams({
      grant_type: oauth.grantType,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret
    });
    if (oauth.scope) {
      params.set('scope', oauth.scope);
    }
    if (oauth.grantType === 'password') {
      if (!oauth.username || !oauth.password) {
        return Effect.fail(new OAuthTokenError({ oid, reason: 'Password OAuth requires a username and password.' }));
      }
      params.set('username', oauth.username);
      params.set('password', oauth.password);
    }
    if (oauth.grantType === 'refresh_token') {
      if (!oauth.refreshToken) {
        return Effect.fail(new OAuthTokenError({ oid, reason: 'Refresh-token OAuth requires a refresh token.' }));
      }
      params.set('refresh_token', oauth.refreshToken);
    }
    return Effect.succeed(params);
  });
}

function fetchOAuthToken(
  config: ServiceNowCatalogDefinition,
  runContext: SubmitRunContext
): Effect.Effect<string, OAuthTokenError | CatalogTimeoutError> {
  const { oid } = runContext;
  return Effect.gen(function* () {
    const params = yield* oauthRequestParams(oid, config.oauth);
    const response = yield* Effect.tryPromise({
      try: signal =>
        axios.post(config.oauth.url, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal,
          validateStatus: () => true
        }),
      catch: cause => new OAuthTokenError({ oid, reason: causeMessage(cause), cause })
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new OAuthTokenError({
        oid,
        reason: `Token endpoint responded with status ${response.status}.`,
        statusCode: response.status
      }));
    }
    const tokenData = typeof response.data === 'object' && response.data !== null
      ? response.data as Record<string, unknown>
      : {};
    const accessToken = String(tokenData.access_token ?? '');
    if (!accessToken) {
      return yield* Effect.fail(new OAuthTokenError({
        oid,
        reason: 'OAuth token response did not include an access token.',
        statusCode: response.status
      }));
    }
    return accessToken;
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(config.connection.timeoutMs),
      onTimeout: () => new CatalogTimeoutError({ oid, timeoutMs: config.connection.timeoutMs, phase: 'request' })
    }),
    Effect.withSpan('servicenow.http.oauthToken', {
      attributes: { oid, grantType: config.oauth.grantType }
    }),
    withIntegrationAudit(oid, ServiceNowAuditAction.oauthTokenRequest, {
      brandId: runContext.brandId,
      triggeredBy: runContext.triggeredBy,
      parent: runContext.parentAudit,
      requestSummary: { url: config.oauth.url, grantType: config.oauth.grantType },
      onSuccess: () => ({ message: 'ServiceNow OAuth token acquired.' }),
      onFailure: error => ({
        message: 'ServiceNow OAuth token request failed.',
        httpStatusCode: error instanceof OAuthTokenError ? error.statusCode : undefined
      })
    })
  );
}

function isRetryable(error: ServiceNowClientError): boolean {
  if (error._tag === 'CatalogRequestError') {
    return error.retryable;
  }
  // Per-attempt timeouts are transient by definition; OAuth failures are not
  // retried here because a bad token request usually means bad configuration.
  return error._tag === 'CatalogTimeoutError' && error.phase === 'request';
}

function retryPolicy(config: ServiceNowCatalogDefinition) {
  const retry = config.connection.retry;
  // Exponential backoff capped at maxDelayMs (union takes the smaller delay),
  // jittered to avoid thundering herds, bounded by maxAttempts - 1 retries.
  return Schedule.exponential(Duration.millis(retry.baseDelayMs), 2).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(retry.maxDelayMs))),
    Schedule.jittered,
    Schedule.intersect(Schedule.recurs(Math.max(0, retry.maxAttempts - 1)))
  );
}

export function makeLiveClient(
  config: ServiceNowCatalogDefinition,
  runContext: SubmitRunContext
): ServiceNowClient {
  const { oid } = runContext;
  const retryStatusCodes = config.connection.retry.retryOnStatusCodes;

  const performRequest = (
    body: Record<string, unknown>,
    accessToken: string | undefined,
    attempt: number
  ): Effect.Effect<ServiceNowHttpResult, CatalogRequestError | CatalogTimeoutError> =>
    Effect.tryPromise({
      try: (signal): Promise<AxiosResponse<unknown>> =>
        axios({
          url: config.connection.url,
          method: config.connection.method,
          headers: {
            ...config.connection.headers,
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          },
          data: body,
          signal,
          validateStatus: () => true
        }),
      catch: cause => new CatalogRequestError({ oid, retryable: true, cause })
    }).pipe(
      Effect.filterOrFail(
        response => response.status >= 200 && response.status < 300,
        response => new CatalogRequestError({
          oid,
          statusCode: response.status,
          responseBody: response.data,
          retryable: retryStatusCodes.includes(response.status)
        })
      ),
      Effect.map(response => ({
        statusCode: response.status,
        data: normalizeServiceNowResponse(response.data, config)
      })),
      Effect.timeoutFail({
        duration: Duration.millis(config.connection.timeoutMs),
        onTimeout: () => new CatalogTimeoutError({ oid, timeoutMs: config.connection.timeoutMs, phase: 'request' })
      }),
      Effect.withSpan('servicenow.http.orderCatalogItem', {
        attributes: {
          oid,
          method: config.connection.method,
          url: config.connection.url,
          attempt
        }
      })
    );

  return {
    submitCatalogOrder: body =>
      Effect.gen(function* () {
        // Memoize the token so retried request attempts reuse it instead of
        // hammering the token endpoint once it has succeeded.
        const cachedToken = yield* Effect.cached(fetchOAuthToken(config, runContext));
        const attemptCounter = yield* Ref.make(0);
        const attemptOnce = Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attemptCounter, n => n + 1);
          const token = config.oauth.enabled ? yield* cachedToken : undefined;
          if (attempt > 1) {
            yield* Effect.logWarning(`ServiceNow catalog retrying request for ${oid} (attempt ${attempt}).`);
          }
          return yield* performRequest(body, token, attempt);
        });
        return yield* attemptOnce.pipe(
          Effect.retry({ schedule: retryPolicy(config), while: isRetryable })
        );
      })
  };
}

export function makeClientLayer(
  config: ServiceNowCatalogDefinition,
  runContext: SubmitRunContext
): Layer.Layer<ServiceNowClient> {
  return Layer.succeed(ServiceNowClientTag, makeLiveClient(config, runContext));
}
