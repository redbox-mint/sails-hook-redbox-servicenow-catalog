import { Layer, Logger, References } from 'effect';
import type { ServiceNowCatalogDefinition } from '../../configmodels/ServiceNowCatalogAppConfig';
import { ServiceNowConfigTag, SubmitRunContextTag, type SubmitRunContext } from './context';
import { makeClientLayer, type ServiceNowClient } from './http';

type SailsLogShape = {
  log?: Record<string, ((...args: unknown[]) => void) | undefined>;
};

/**
 * Routes Effect's structured logging (`Effect.log*`, span annotations) to the
 * Sails logger so the runtime has exactly one log stream instead of a
 * decorative side-channel.
 */
const sailsLogger = Logger.make(({ logLevel, message, fiber }) => {
  const sailsInstance = (globalThis as { sails?: SailsLogShape }).sails;
  const log = sailsInstance?.log;
  if (log == null) {
    return;
  }
  const annotationEntries = Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(([key, value]) => `${key}=${String(value)}`);
  const text = [
    ...(Array.isArray(message) ? message.map(String) : [String(message)]),
    ...(annotationEntries.length > 0 ? [`[${annotationEntries.join(' ')}]`] : [])
  ].join(' ');

  if (logLevel === 'Fatal' || logLevel === 'Error') {
    log.error?.(text);
  } else if (logLevel === 'Warn') {
    log.warn?.(text);
  } else if (logLevel === 'Debug' || logLevel === 'Trace') {
    log.debug?.(text);
  } else if (log.verbose) {
    log.verbose(text);
  } else {
    log.info?.(text);
  }
});

export const sailsLoggerLayer = Logger.layer([sailsLogger, Logger.tracerLogger]);

export type ServiceNowRuntimeServices = ServiceNowCatalogDefinition | SubmitRunContext | ServiceNowClient;

export function makeRuntimeLayer(
  config: ServiceNowCatalogDefinition,
  runContext: SubmitRunContext
): Layer.Layer<ServiceNowRuntimeServices> {
  return Layer.mergeAll(
    Layer.succeed(ServiceNowConfigTag, config),
    Layer.succeed(SubmitRunContextTag, runContext),
    makeClientLayer(config, runContext),
    sailsLoggerLayer
  );
}
