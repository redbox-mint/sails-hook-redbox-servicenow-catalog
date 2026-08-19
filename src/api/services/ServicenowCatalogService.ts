import { Services as CoreServices } from '@researchdatabox/redbox-core';
import { Cause, Duration, Effect, Exit, Fiber } from 'effect';
import {
  SERVICENOW_CATALOG_CONFIG_KEY,
  type ServiceNowCatalogDefinition,
  type ServiceNowFieldMapping,
  type ValueBinding
} from '../configmodels/ServiceNowCatalogAppConfig';
import {
  ServiceNowAuditAction,
  completeCatalogAudit,
  failCatalogAudit,
  getCatalogIdempotencyDecision,
  registerServiceNowOutcomeMapper,
  startCatalogAudit,
  withIntegrationAudit,
  type IntegrationAuditContext
} from './servicenow/audit';
import { resolveServiceNowCatalog, isPlainObject } from './servicenow/configuration';
import {
  ServiceNowConfigTag,
  SubmitRunContextTag,
  type ServiceNowTriggerOptions,
  type SubmitRunContext
} from './servicenow/context';
import {
  CatalogTimeoutError,
  DuplicateSubmissionError,
  IdempotencyLookupError,
  MappingError,
  ParentAssociationError,
  ParentLookupError,
  ParentRecordRequiredError,
  ParentUpdateError,
  ServiceNowConfigError,
  UnknownCatalogError,
  WorkspaceUpdateError,
  causeMessage,
  errorDescription,
  errorHttpCode,
  type ServiceNowCatalogError
} from './servicenow/errors';
import { ServiceNowClientTag, type ServiceNowHttpResult } from './servicenow/http';
import {
  claimCatalogIdempotency,
  catalogIdempotencyClaimLeaseMs,
  catalogIdempotencyScope,
  concludeCatalogIdempotency,
  type CatalogIdempotencyClaim
} from './servicenow/idempotency';
import { applyFieldMappings, evaluateBinding } from './servicenow/mapping';
import { makeRuntimeLayer } from './servicenow/runtime';

export interface WorkspaceRecord {
  metadata: Record<string, unknown>;
  metaMetadata?: { brandId?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TriggerResponse {
  code?: string;
  status?: boolean;
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

interface ResolvedBrand {
  brandId: string;
  brandName: string;
  brand: { id?: string; name?: string };
}

interface ResolvedSubmissionConfig {
  integrationEnabled: unknown;
  catalog?: ServiceNowCatalogDefinition;
}

interface BoundValueResult {
  value?: string;
  error?: ServiceNowCatalogError;
}

interface IdempotencyCheckResult {
  error?: DuplicateSubmissionError | IdempotencyLookupError;
  claim?: CatalogIdempotencyClaim;
}

const APP_CONFIG_PRESENT_KEYS_SYMBOL = Symbol.for('redbox.appConfig.presentKeys');

export namespace Services {
  export class ServicenowCatalog extends CoreServices.Core.Service {
    protected override _exportedMethods: string[] = [
      'init',
      'submitRequest',
      'remapData'
    ];

    private readonly inFlight = new Set<Fiber.RuntimeFiber<ServiceNowHttpResult, ServiceNowCatalogError>>();
    private readonly inFlightIdempotency = new Set<string>();
    private legacyConfigWarningEmitted = false;

    public init(): void {
      this.registerSailsHook('on', 'ready', () => this.registerOutcomeMapper());
      this.registerSailsHook('on', 'lower', () => this.interruptInFlight());
    }

    public async submitRequest(
      oid: string,
      workspaceData: WorkspaceRecord,
      options: ServiceNowTriggerOptions,
      user: { username?: string } | undefined,
      response: TriggerResponse
    ): Promise<TriggerResponse> {
      this.logger.verbose('ServiceNow catalog processing request for ' + oid + '.');

      const trigger = this.validateTriggerOptions(oid, options);
      if (trigger instanceof ServiceNowConfigError) {
        return this.failBeforeSubmission(response, trigger, {
          catalog: isPlainObject(options) ? options.catalog : undefined,
          event: isPlainObject(options) ? options.event : undefined
        }, undefined, user?.username);
      }

      const resolvedBrand = this.resolveBrand(oid, workspaceData);
      if (resolvedBrand instanceof ServiceNowConfigError) {
        return this.failBeforeSubmission(response, resolvedBrand, {
          catalog: trigger.catalog,
          event: trigger.event
        }, undefined, user?.username);
      }
      const { brandId, brandName, brand } = resolvedBrand;
      const resolved = this.resolveConfig(brandName, trigger.catalog);
      if (typeof resolved.integrationEnabled !== 'boolean') {
        return this.failBeforeSubmission(response, new ServiceNowConfigError({
          oid,
          reason: 'ServiceNow Catalog enabled configuration must be a boolean.'
        }), {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName
        }, brandId, user?.username);
      }
      if (!resolved.integrationEnabled) {
        this.logger.verbose(
          "ServiceNow catalog integration is disabled for brand '" + brandName + "'; skipping " + oid + '.'
        );
        return response;
      }
      if (resolved.catalog == null) {
        const error = new UnknownCatalogError({ oid, catalog: trigger.catalog });
        return this.failBeforeSubmission(response, error, {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName
        }, brandId, user?.username);
      }
      const config = resolved.catalog;
      if (typeof config.enabled !== 'boolean') {
        return this.failBeforeSubmission(response, new ServiceNowConfigError({
          oid,
          reason: "ServiceNow catalog '" + trigger.catalog + "' enabled configuration must be a boolean."
        }), {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName
        }, brandId, user?.username);
      }
      if (!config.enabled) {
        this.logger.verbose(
          "ServiceNow catalog '" + trigger.catalog + "' is disabled for brand '" + brandName + "'; skipping " + oid + '.'
        );
        return response;
      }

      const configError = this.validateConfig(oid, config);
      if (configError != null) {
        return this.failBeforeSubmission(response, configError, {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName
        }, brandId, user?.username);
      }

      const now = new Date().toISOString();
      const provisionalRunContext: SubmitRunContext = {
        oid,
        catalog: trigger.catalog,
        event: trigger.event,
        brandId,
        brandName,
        triggeredBy: user?.username,
        parentAudit: null,
        now
      };
      const provisionalMappingContext = this.mappingContext(
        workspaceData,
        undefined,
        provisionalRunContext
      );

      const parentResolution = await this.resolveParentRecordOid(
        oid,
        trigger,
        config,
        provisionalMappingContext
      );
      if (parentResolution.error != null) {
        return this.failBeforeSubmission(response, parentResolution.error, {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName
        }, brandId, user?.username);
      }
      const parentRecordOid = parentResolution.value;

      const idempotencyResolution = await this.resolveIdempotencyKey(
        oid,
        trigger,
        config,
        provisionalMappingContext
      );
      if (idempotencyResolution.error != null) {
        return this.failBeforeSubmission(response, idempotencyResolution.error, {
          catalog: trigger.catalog,
          event: trigger.event,
          brandName,
          parentRecordOid
        }, brandId, user?.username);
      }
      const idempotencyKey = idempotencyResolution.value;
      let idempotencyLock: string | undefined;
      let idempotencyClaim: CatalogIdempotencyClaim | undefined;
      if (config.idempotency?.enabled) {
        if (!idempotencyKey) {
          const error = new ServiceNowConfigError({
            oid,
            reason: "ServiceNow catalog '" + trigger.catalog + "' has idempotency enabled but no key resolved.",
            httpCode: '400'
          });
          return this.failBeforeSubmission(response, error, {
            catalog: trigger.catalog,
            event: trigger.event,
            brandName,
            parentRecordOid
          }, brandId, user?.username);
        }
        idempotencyLock = catalogIdempotencyScope({
          brandId,
          redboxOid: oid,
          catalog: trigger.catalog,
          idempotencyKey
        });
        if (this.inFlightIdempotency.has(idempotencyLock)) {
          const duplicate = new DuplicateSubmissionError({
            oid,
            catalog: trigger.catalog,
            idempotencyKey,
            state: 'in-progress'
          });
          return this.failBeforeSubmission(response, duplicate, {
            catalog: trigger.catalog,
            event: trigger.event,
            brandName,
            idempotencyKey,
            parentRecordOid
          }, brandId, user?.username);
        }
        this.inFlightIdempotency.add(idempotencyLock);
        const check = await this.checkIdempotency(
          oid,
          brandId,
          user?.username,
          trigger.catalog,
          trigger.event,
          idempotencyKey,
          config.connection.totalTimeoutMs
        );
        if (check.error != null) {
          this.inFlightIdempotency.delete(idempotencyLock);
          return this.failBeforeSubmission(response, check.error, {
            catalog: trigger.catalog,
            event: trigger.event,
            brandName,
            idempotencyKey,
            parentRecordOid
          }, brandId, user?.username);
        }
        idempotencyClaim = check.claim;
      }

      const parentAudit = startCatalogAudit(oid, ServiceNowAuditAction.submitCatalogRequest, {
        brandId,
        triggeredBy: user?.username,
        requestSummary: {
          catalog: trigger.catalog,
          event: trigger.event,
          idempotencyKey,
          parentRecordOid,
          brandName,
          url: config.connection.url
        }
      });
      const runContext: SubmitRunContext = {
        ...provisionalRunContext,
        idempotencyKey,
        parentRecordOid,
        parentAudit
      };

      const program = this.submitProgram(workspaceData, brand).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(config.connection.totalTimeoutMs),
          onTimeout: () => new CatalogTimeoutError({
            oid,
            timeoutMs: config.connection.totalTimeoutMs,
            phase: 'orchestration'
          })
        }),
        Effect.withSpan('servicenow.submitRequest', {
          attributes: {
            oid,
            catalog: trigger.catalog,
            event: trigger.event,
            brand: brandName
          }
        }),
        Effect.provide(makeRuntimeLayer(config, runContext))
      );

      const fiber = Effect.runFork(program);
      this.inFlight.add(fiber);
      let exit: Exit.Exit<ServiceNowHttpResult, ServiceNowCatalogError>;
      try {
        exit = await Effect.runPromise(Fiber.await(fiber));
      } finally {
        this.inFlight.delete(fiber);
      }

      try {
        return await this.concludeSubmit(oid, runContext, exit, response, idempotencyClaim);
      } finally {
        if (idempotencyLock != null) {
          this.inFlightIdempotency.delete(idempotencyLock);
        }
      }
    }

    /** Apply the shared ValueBinding model to a caller-provided stable context. */
    public remapData<T>(source: unknown, target: T, mappings: ServiceNowFieldMapping[]): Promise<T> {
      const context = this.withMappingHelpers(source);
      return Effect.runPromise(applyFieldMappings('remapData', mappings, context, target));
    }

    private submitProgram(
      workspaceData: WorkspaceRecord,
      brand: unknown
    ): Effect.Effect<
      ServiceNowHttpResult,
      ServiceNowCatalogError,
      ServiceNowCatalogDefinition | SubmitRunContext | import('./servicenow/http').ServiceNowClient
    > {
      return Effect.gen(this, function* (this: ServicenowCatalog) {
        const runContext = yield* SubmitRunContextTag;
        const config = yield* ServiceNowConfigTag;
        const client = yield* ServiceNowClientTag;
        const { oid, parentRecordOid } = runContext;
        let parentRecord: Record<string, unknown> | undefined;

        if (parentRecordOid != null) {
          parentRecord = yield* Effect.tryPromise({
            try: () => RecordsService.getMeta(parentRecordOid),
            catch: cause => new ParentLookupError({ oid, parentRecordOid, cause })
          }).pipe(
            Effect.withSpan('servicenow.getParentMeta', { attributes: { oid, parentRecordOid } }),
            withIntegrationAudit(oid, ServiceNowAuditAction.parentLookup, {
              brandId: runContext.brandId,
              triggeredBy: runContext.triggeredBy,
              parent: runContext.parentAudit,
              requestSummary: { catalog: runContext.catalog, parentRecordOid },
              onSuccess: () => ({ message: 'Parent record metadata loaded.' })
            })
          );

          yield* Effect.tryPromise({
            try: () => WorkspaceService.addWorkspaceToRecord(parentRecordOid, oid),
            catch: cause => new ParentAssociationError({ oid, parentRecordOid, cause })
          }).pipe(
            Effect.withSpan('servicenow.associateWorkspace', { attributes: { oid, parentRecordOid } }),
            withIntegrationAudit(oid, ServiceNowAuditAction.associateWorkspace, {
              brandId: runContext.brandId,
              triggeredBy: runContext.triggeredBy,
              parent: runContext.parentAudit,
              requestSummary: { catalog: runContext.catalog, parentRecordOid },
              onSuccess: () => ({ message: 'Workspace associated with its configured parent record.' })
            })
          );
        }

        const requestBody = yield* applyFieldMappings(
          oid,
          config.requestFields,
          this.mappingContext(workspaceData, parentRecord, runContext),
          structuredClone(config.bodyTemplate)
        );

        yield* Effect.logInfo('ServiceNow catalog submitting order for workspace ' + oid + '.').pipe(
          Effect.annotateLogs({
            oid,
            catalog: runContext.catalog,
            event: runContext.event,
            brand: runContext.brandName
          })
        );

        const result = yield* client.submitCatalogOrder(requestBody).pipe(
          withIntegrationAudit(oid, ServiceNowAuditAction.catalogOrderRequest, {
            brandId: runContext.brandId,
            triggeredBy: runContext.triggeredBy,
            parent: runContext.parentAudit,
            requestSummary: {
              catalog: runContext.catalog,
              event: runContext.event,
              idempotencyKey: runContext.idempotencyKey,
              url: config.connection.url,
              method: config.connection.method
            },
            onSuccess: httpResult => ({
              message: 'ServiceNow catalog order accepted.',
              httpStatusCode: httpResult.statusCode,
              responseSummary: isPlainObject(httpResult.data)
                ? httpResult.data
                : { rawResponseBody: httpResult.data }
            }),
            onFailure: error => ({
              message: 'ServiceNow catalog order failed.',
              httpStatusCode: error instanceof Object && 'statusCode' in error
                ? (error as { statusCode?: number }).statusCode
                : undefined
            })
          })
        );

        const responseContext = this.mappingContext(workspaceData, parentRecord, runContext, result.data);
        if (config.responseFields.workspace.length > 0) {
          const updatedWorkspace = yield* applyFieldMappings(
            oid,
            config.responseFields.workspace,
            responseContext,
            workspaceData
          );
          yield* Effect.tryPromise({
            try: () => RecordsService.updateMeta(brand, oid, updatedWorkspace),
            catch: cause => new WorkspaceUpdateError({ oid, cause })
          }).pipe(
            Effect.withSpan('servicenow.updateWorkspaceMeta', { attributes: { oid } }),
            withIntegrationAudit(oid, ServiceNowAuditAction.workspaceMetadataUpdate, {
              brandId: runContext.brandId,
              triggeredBy: runContext.triggeredBy,
              parent: runContext.parentAudit,
              requestSummary: { catalog: runContext.catalog },
              onSuccess: () => ({ message: 'Workspace metadata updated from the ServiceNow response.' })
            })
          );
        }

        const parentMappings = config.responseFields.parentRecord ?? [];
        if (parentRecordOid != null && parentRecord != null && parentMappings.length > 0) {
          const updatedParent = yield* applyFieldMappings(
            oid,
            parentMappings,
            responseContext,
            structuredClone(parentRecord)
          );
          yield* Effect.tryPromise({
            try: () => RecordsService.updateMeta(brand, parentRecordOid, updatedParent),
            catch: cause => new ParentUpdateError({ oid, parentRecordOid, cause })
          }).pipe(
            Effect.withSpan('servicenow.updateParentMeta', { attributes: { oid, parentRecordOid } }),
            withIntegrationAudit(oid, ServiceNowAuditAction.parentMetadataUpdate, {
              brandId: runContext.brandId,
              triggeredBy: runContext.triggeredBy,
              parent: runContext.parentAudit,
              requestSummary: { catalog: runContext.catalog, parentRecordOid },
              onSuccess: () => ({ message: 'Parent record metadata updated from the ServiceNow response.' })
            })
          );
        }

        return result;
      });
    }

    private async concludeSubmit(
      oid: string,
      runContext: SubmitRunContext,
      exit: Exit.Exit<ServiceNowHttpResult, ServiceNowCatalogError>,
      response: TriggerResponse,
      idempotencyClaim: CatalogIdempotencyClaim | undefined
    ): Promise<TriggerResponse> {
      if (Exit.isSuccess(exit)) {
        completeCatalogAudit(runContext.parentAudit, {
          message: 'ServiceNow catalog request completed.',
          httpStatusCode: exit.value.statusCode,
          requestSummary: {
            catalog: runContext.catalog,
            event: runContext.event,
            idempotencyKey: runContext.idempotencyKey,
            parentRecordOid: runContext.parentRecordOid
          },
          responseSummary: isPlainObject(exit.value.data)
            ? exit.value.data
            : { rawResponseBody: exit.value.data }
        });
        await this.concludeIdempotency(idempotencyClaim, 'completed');
        this.logger.verbose('ServiceNow catalog completed request for ' + oid + '.');
        return response;
      }

      if (Exit.isInterrupted(exit)) {
        failCatalogAudit(runContext.parentAudit, 'interrupted', {
          message: 'ServiceNow catalog request was interrupted during shutdown.',
          requestSummary: {
            catalog: runContext.catalog,
            event: runContext.event,
            idempotencyKey: runContext.idempotencyKey,
            submissionCertainty: 'uncertain'
          }
        });
        await this.concludeIdempotency(idempotencyClaim, 'uncertain');
        return this.fail(response, '503', 'ServiceNow catalog request for ' + oid + ' was interrupted during shutdown.');
      }

      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === 'Some') {
        const error = failure.value;
        const message = errorDescription(error);
        const uncertain = this.isUncertainSubmissionFailure(error);
        failCatalogAudit(runContext.parentAudit, error, {
          message,
          requestSummary: {
            catalog: runContext.catalog,
            event: runContext.event,
            idempotencyKey: runContext.idempotencyKey,
            ...(uncertain ? { submissionCertainty: 'uncertain' } : {})
          }
        });
        await this.concludeIdempotency(idempotencyClaim, uncertain ? 'uncertain' : 'failed');
        this.logger.error(
          'ServiceNow catalog request failed for workspace ' + oid + ' [' + error._tag + ']: ' + message
        );
        return this.fail(response, errorHttpCode(error), message);
      }

      const defect = Cause.squash(exit.cause);
      failCatalogAudit(runContext.parentAudit, defect, {
        message: 'ServiceNow catalog request failed with an unexpected defect.',
        requestSummary: {
          catalog: runContext.catalog,
          event: runContext.event,
          idempotencyKey: runContext.idempotencyKey,
          submissionCertainty: 'uncertain'
        }
      });
      await this.concludeIdempotency(idempotencyClaim, 'uncertain');
      this.logger.error('ServiceNow catalog request crashed for workspace ' + oid + ': ' + causeMessage(defect));
      return this.fail(response, '500', 'ServiceNow catalog request failed for workspace ' + oid + '; check the server logs.');
    }

    private isUncertainSubmissionFailure(error: ServiceNowCatalogError): boolean {
      switch (error._tag) {
        case 'CatalogTimeoutError':
        case 'WorkspaceUpdateError':
        case 'ParentUpdateError':
          return true;
        case 'CatalogRequestError':
          return error.statusCode == null;
        default:
          return false;
      }
    }

    private async concludeIdempotency(
      claim: CatalogIdempotencyClaim | undefined,
      status: 'completed' | 'failed' | 'uncertain'
    ): Promise<void> {
      if (claim == null) {
        return;
      }
      try {
        await concludeCatalogIdempotency(claim, status);
      } catch (error) {
        // A failed update leaves the durable row claimed, which safely blocks retries.
        this.logger.error(
          'Failed to conclude ServiceNow idempotency claim ' + claim.id + ': ' + causeMessage(error)
        );
      }
    }

    private validateTriggerOptions(
      oid: string,
      options: ServiceNowTriggerOptions
    ): ServiceNowTriggerOptions | ServiceNowConfigError {
      if (!isPlainObject(options)) {
        return new ServiceNowConfigError({
          oid,
          reason: 'ServiceNow trigger options must be an object.',
          httpCode: '400'
        });
      }
      const catalog = String(options.catalog ?? '').trim();
      const event = String(options.event ?? '').trim();
      if (!catalog) {
        return new ServiceNowConfigError({
          oid,
          reason: 'ServiceNow trigger options require a catalog name.',
          httpCode: '400'
        });
      }
      if (!event) {
        return new ServiceNowConfigError({
          oid,
          reason: 'ServiceNow trigger options require an event.',
          httpCode: '400'
        });
      }
      return {
        catalog,
        event,
        idempotencyKey: this.optionalText(options.idempotencyKey),
        parentRecordOid: this.optionalText(options.parentRecordOid)
      };
    }

    private resolveBrand(oid: string, workspaceData: WorkspaceRecord): ResolvedBrand | ServiceNowConfigError {
      const brandId = String(workspaceData.metaMetadata?.brandId ?? '').trim();
      if (!brandId) {
        return new ServiceNowConfigError({
          oid,
          reason: 'Cannot resolve ServiceNow Catalog configuration because the workspace has no brand identifier.',
          httpCode: '400'
        });
      }
      const brandingService = typeof BrandingService === 'undefined' ? undefined : BrandingService;
      if (brandingService == null) {
        return new ServiceNowConfigError({
          oid,
          reason: 'Cannot resolve ServiceNow Catalog configuration because BrandingService is unavailable.'
        });
      }
      const brand = brandingService.getBrandById(brandId);
      if (brand?.name) {
        return { brandId, brandName: String(brand.name), brand };
      }
      return new ServiceNowConfigError({
        oid,
        reason: "Cannot resolve ServiceNow Catalog configuration for unknown brand '" + brandId + "'.",
        httpCode: '400'
      });
    }

    /** Brand application config overrides hook-level config; triggers select only a catalog. */
    private resolveConfig(brandName: string, catalogName: string): ResolvedSubmissionConfig {
      const sailsConfig = sails.config;
      const brandingAware = typeof sailsConfig.brandingAware === 'function'
        ? sailsConfig.brandingAware
        : undefined;
      const hookConfig = sailsConfig[SERVICENOW_CATALOG_CONFIG_KEY];
      let brandConfig: unknown;
      try {
        const brandSettings = brandingAware?.(brandName);
        if (brandSettings != null && typeof brandSettings === 'object') {
          const presentKeys = Reflect.get(brandSettings, APP_CONFIG_PRESENT_KEYS_SYMBOL);
          const hasStoredBrandConfig = !(presentKeys instanceof Set)
            || presentKeys.has(SERVICENOW_CATALOG_CONFIG_KEY);
          brandConfig = hasStoredBrandConfig
            ? Reflect.get(brandSettings, SERVICENOW_CATALOG_CONFIG_KEY)
            : undefined;
        }
      } catch (error) {
        this.logger.warn(
          "ServiceNow catalog could not load brand configuration for '" + brandName + "': " + causeMessage(error)
        );
      }
      const resolved = resolveServiceNowCatalog(
        catalogName,
        hookConfig,
        brandConfig,
        message => this.warnLegacyConfiguration(message)
      );
      return {
        integrationEnabled: resolved.enabled,
        catalog: resolved.catalog
      };
    }

    private validateConfig(oid: string, config: ServiceNowCatalogDefinition): ServiceNowConfigError | null {
      const invalid = (reason: string, httpCode = '500') =>
        new ServiceNowConfigError({ oid, reason, httpCode });

      if (!isPlainObject(config.connection)) {
        return invalid('Missing ServiceNow Catalog connection configuration.');
      }
      if (!String(config.connection.url ?? '').trim()) {
        return invalid('Missing ServiceNow Catalog URL configuration.');
      }
      try {
        const url = new URL(config.connection.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return invalid('ServiceNow Catalog URL configuration must use HTTP or HTTPS.');
        }
      } catch {
        return invalid('ServiceNow Catalog URL configuration must be an absolute URL.');
      }
      const method = String(config.connection.method ?? '').trim().toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        return invalid('ServiceNow Catalog HTTP method configuration is invalid.');
      }
      if (!isPlainObject(config.connection.headers)) {
        return invalid('ServiceNow Catalog headers configuration must be an object.');
      }
      if (!Number.isFinite(config.connection.timeoutMs) || config.connection.timeoutMs <= 0) {
        return invalid('ServiceNow Catalog request timeout must be greater than zero.');
      }
      if (!Number.isFinite(config.connection.totalTimeoutMs) || config.connection.totalTimeoutMs <= 0) {
        return invalid('ServiceNow Catalog orchestration timeout must be greater than zero.');
      }
      const retry = config.connection.retry;
      if (!isPlainObject(retry)
        || !Number.isInteger(retry.maxAttempts)
        || retry.maxAttempts < 1
        || !Number.isFinite(retry.baseDelayMs)
        || retry.baseDelayMs < 0
        || !Number.isFinite(retry.maxDelayMs)
        || retry.maxDelayMs < retry.baseDelayMs
        || !Array.isArray(retry.retryOnStatusCodes)
        || retry.retryOnStatusCodes.some(status => !Number.isInteger(status) || status < 100 || status > 599)) {
        return invalid('ServiceNow Catalog retry configuration is invalid.');
      }
      if (!isPlainObject(config.bodyTemplate)) {
        return invalid('ServiceNow Catalog request body template must be an object.');
      }
      if (!Array.isArray(config.requestFields)
        || !isPlainObject(config.responseFields)
        || !Array.isArray(config.responseFields.workspace)
        || (config.responseFields.parentRecord != null && !Array.isArray(config.responseFields.parentRecord))) {
        return invalid('ServiceNow Catalog request and response field mappings must be arrays.');
      }
      const mappings = [
        ...config.requestFields,
        ...config.responseFields.workspace,
        ...(config.responseFields.parentRecord ?? [])
      ];
      for (const mapping of mappings) {
        if (!mapping || !String(mapping.destination ?? '').trim() || !isPlainObject(mapping.source)) {
          return invalid('ServiceNow Catalog field mappings require a destination and source binding.');
        }
        const bindingError = this.validateBinding(mapping.source, "Mapping '" + mapping.destination + "'");
        if (bindingError != null) {
          return invalid(bindingError);
        }
      }
      if (config.parentRecord != null) {
        if (!isPlainObject(config.parentRecord) || !isPlainObject(config.parentRecord.oid)) {
          return invalid('ServiceNow Catalog parent record configuration requires an OID binding.');
        }
        const bindingError = this.validateBinding(config.parentRecord.oid, 'Parent record OID');
        if (bindingError != null) {
          return invalid(bindingError);
        }
      }
      if (config.responseNormalization != null
        && (!isPlainObject(config.responseNormalization)
          || typeof config.responseNormalization.parseJsonString !== 'boolean')) {
        return invalid('ServiceNow Catalog response normalization configuration is invalid.');
      }
      if (config.idempotency != null) {
        if (!isPlainObject(config.idempotency) || typeof config.idempotency.enabled !== 'boolean') {
          return invalid('ServiceNow Catalog idempotency configuration is invalid.');
        }
        if (config.idempotency.key != null) {
          if (!isPlainObject(config.idempotency.key)) {
            return invalid('ServiceNow Catalog idempotency key must be a value binding.');
          }
          const bindingError = this.validateBinding(config.idempotency.key, 'Idempotency key');
          if (bindingError != null) {
            return invalid(bindingError);
          }
        }
      }
      if (!isPlainObject(config.oauth)) {
        return invalid('Missing ServiceNow Catalog OAuth configuration.');
      }
      if (!['client_credentials', 'password', 'refresh_token'].includes(config.oauth.grantType)) {
        return invalid('ServiceNow Catalog OAuth grant type is invalid.');
      }
      if (config.oauth.enabled) {
        if (!config.oauth.url || !config.oauth.clientId || !config.oauth.clientSecret) {
          return invalid('OAuth is enabled but its URL, client ID, or client secret is missing.');
        }
        try {
          const url = new URL(config.oauth.url);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return invalid('ServiceNow OAuth URL configuration must use HTTP or HTTPS.');
          }
        } catch {
          return invalid('ServiceNow OAuth URL configuration must be an absolute URL.');
        }
      }
      return null;
    }

    private validateBinding(binding: ValueBinding, label: string): string | null {
      if (binding.kind === 'path' && !String(binding.path ?? '').trim()) {
        return label + ' requires a source path.';
      }
      if (binding.kind === 'handlebars' && !String(binding.template ?? '').trim()) {
        return label + ' requires a Handlebars template.';
      }
      if (binding.kind === 'jsonata' && !String(binding.expression ?? '').trim()) {
        return label + ' requires a JSONata expression.';
      }
      if (!['path', 'handlebars', 'jsonata'].includes(binding.kind)) {
        return label + ' has an unsupported binding type.';
      }
      return null;
    }

    private async resolveParentRecordOid(
      oid: string,
      trigger: ServiceNowTriggerOptions,
      config: ServiceNowCatalogDefinition,
      mappingContext: unknown
    ): Promise<BoundValueResult> {
      if (trigger.parentRecordOid) {
        return { value: trigger.parentRecordOid };
      }
      if (config.parentRecord == null) {
        return {};
      }
      const result = await this.evaluateTextBinding(oid, 'parentRecord.oid', config.parentRecord.oid, mappingContext);
      if (result.error != null) {
        return result;
      }
      if (!result.value) {
        return { error: new ParentRecordRequiredError({ oid, catalog: trigger.catalog }) };
      }
      return result;
    }

    private async resolveIdempotencyKey(
      oid: string,
      trigger: ServiceNowTriggerOptions,
      config: ServiceNowCatalogDefinition,
      mappingContext: unknown
    ): Promise<BoundValueResult> {
      if (!config.idempotency?.enabled) {
        return {};
      }
      if (trigger.idempotencyKey) {
        return { value: trigger.idempotencyKey };
      }
      if (config.idempotency.key == null) {
        return {};
      }
      return this.evaluateTextBinding(oid, 'idempotency.key', config.idempotency.key, mappingContext);
    }

    private async evaluateTextBinding(
      oid: string,
      destination: string,
      binding: ValueBinding,
      context: unknown
    ): Promise<BoundValueResult> {
      const exit = await Effect.runPromiseExit(evaluateBinding(oid, destination, binding, context));
      if (Exit.isSuccess(exit)) {
        return { value: this.optionalText(exit.value) };
      }
      const failure = Cause.failureOption(exit.cause);
      return {
        error: failure._tag === 'Some'
          ? failure.value
          : new MappingError({ oid, destination, cause: Cause.squash(exit.cause) })
      };
    }

    private async checkIdempotency(
      oid: string,
      brandId: string,
      triggeredBy: string | undefined,
      catalog: string,
      event: string,
      idempotencyKey: string,
      totalTimeoutMs: number
    ): Promise<IdempotencyCheckResult> {
      const audit = startCatalogAudit(oid, ServiceNowAuditAction.idempotencyDecision, {
        brandId,
        triggeredBy,
        requestSummary: { catalog, event, idempotencyKey }
      });

      let claim: CatalogIdempotencyClaim | undefined;
      try {
        const claimDecision = await claimCatalogIdempotency(
          {
            redboxOid: oid,
            brandId,
            catalog,
            idempotencyKey
          },
          { leaseDurationMs: catalogIdempotencyClaimLeaseMs(totalTimeoutMs) }
        );
        if (claimDecision.decision !== 'claimed') {
          completeCatalogAudit(audit, {
            message: 'Durable duplicate submission rejected.',
            responseSummary: { decision: claimDecision.decision }
          });
          return {
            error: new DuplicateSubmissionError({
              oid,
              catalog,
              idempotencyKey,
              state: claimDecision.decision
            })
          };
        }
        claim = claimDecision.claim;

        const decision = await getCatalogIdempotencyDecision(oid, catalog, idempotencyKey);
        completeCatalogAudit(audit, {
          message: 'Persistent idempotency state checked.',
          responseSummary: { decision }
        });
        if (decision === 'clear') {
          return { claim };
        }
        await this.concludeIdempotency(claim, decision === 'completed' ? 'completed' : 'uncertain');
        return {
          error: new DuplicateSubmissionError({ oid, catalog, idempotencyKey, state: decision })
        };
      } catch (cause) {
        await this.concludeIdempotency(
          claim,
          claim?.recoveredStaleClaim ? 'uncertain' : 'failed'
        );
        const error = new IdempotencyLookupError({ oid, catalog, idempotencyKey, cause });
        failCatalogAudit(audit, error, { message: errorDescription(error) });
        return { error };
      }
    }

    private mappingContext(
      workspace: WorkspaceRecord,
      parentRecord: Record<string, unknown> | undefined,
      runContext: SubmitRunContext,
      response?: unknown
    ): Record<string, unknown> {
      const base: Record<string, unknown> = {
        workspace,
        parentRecord,
        oid: runContext.oid,
        brand: runContext.brandName,
        trigger: {
          catalog: runContext.catalog,
          event: runContext.event,
          idempotencyKey: runContext.idempotencyKey,
          parentRecordOid: runContext.parentRecordOid
        },
        now: runContext.now,
        translationService: typeof TranslationService === 'undefined' ? undefined : TranslationService
      };
      if (response === undefined) {
        return base;
      }
      return {
        ...base,
        ...(isPlainObject(response) ? response : {}),
        response
      };
    }

    private withMappingHelpers(source: unknown): unknown {
      if (!isPlainObject(source)) {
        return source;
      }
      return {
        ...source,
        now: source.now ?? new Date().toISOString(),
        translationService: source.translationService
          ?? (typeof TranslationService === 'undefined' ? undefined : TranslationService)
      };
    }

    private optionalText(value: unknown): string | undefined {
      const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
      return text || undefined;
    }

    private warnLegacyConfiguration(message: string): void {
      if (this.legacyConfigWarningEmitted) {
        return;
      }
      this.legacyConfigWarningEmitted = true;
      this.logger.warn(message);
    }

    private registerOutcomeMapper(): void {
      if (!registerServiceNowOutcomeMapper()) {
        this.logger.warn('ServiceNow catalog: IntegrationAuditService outcome mapper registration was unavailable.');
      }
    }

    private interruptInFlight(): void {
      if (this.inFlight.size === 0) {
        return;
      }
      this.logger.warn(
        'ServiceNow catalog interrupting ' + this.inFlight.size + ' in-flight submission(s) for shutdown.'
      );
      const fibers = [...this.inFlight];
      this.inFlight.clear();
      this.inFlightIdempotency.clear();
      Effect.runFork(Effect.forEach(fibers, fiber => Fiber.interrupt(fiber), { discard: true }));
    }

    private failBeforeSubmission(
      response: TriggerResponse,
      error: ServiceNowCatalogError,
      requestSummary: Record<string, unknown>,
      brandId?: string,
      triggeredBy?: string
    ): TriggerResponse {
      const message = errorDescription(error);
      const audit = startCatalogAudit(error.oid, ServiceNowAuditAction.submitCatalogRequest, {
        brandId,
        triggeredBy,
        requestSummary
      });
      failCatalogAudit(audit, error, { message, requestSummary });
      return this.fail(response, errorHttpCode(error), message);
    }

    private fail(response: TriggerResponse, code: string, message: string): TriggerResponse {
      this.logger.error(message);
      response.code = code;
      response.status = false;
      response.success = false;
      response.message = message;
      return response;
    }
  }
}

export type ServicenowCatalogService = Pick<
  Services.ServicenowCatalog,
  'init' | 'submitRequest' | 'remapData'
>;
export const ServicenowCatalogService = new Services.ServicenowCatalog().exports() as ServicenowCatalogService;

module.exports = ServicenowCatalogService;
