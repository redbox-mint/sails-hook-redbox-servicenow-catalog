import { Layer, Logger, LogLevel } from 'effect';
import type { ServiceNowCatalogConfigData } from '../../configmodels/ServiceNowCatalogAppConfig';
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
const sailsLogger = Logger.make(({ logLevel, message, annotations }) => {
  const sailsInstance = (globalThis as { sails?: SailsLogShape }).sails;
  const log = sailsInstance?.log;
  if (log == null) {
    return;
  }
  const annotationEntries = Array.from(annotations).map(([key, value]) => `${key}=${String(value)}`);
  const text = [
    ...(Array.isArray(message) ? message.map(String) : [String(message)]),
    ...(annotationEntries.length > 0 ? [`[${annotationEntries.join(' ')}]`] : [])
  ].join(' ');

  if (logLevel === LogLevel.Fatal || logLevel === LogLevel.Error) {
    log.error?.(text);
  } else if (logLevel === LogLevel.Warning) {
    log.warn?.(text);
  } else if (logLevel === LogLevel.Debug || logLevel === LogLevel.Trace) {
    log.debug?.(text);
  } else if (log.verbose) {
    log.verbose(text);
  } else {
    log.info?.(text);
  }
});

export const sailsLoggerLayer = Logger.replace(Logger.defaultLogger, sailsLogger);

export type ServiceNowRuntimeServices = ServiceNowCatalogConfigData | SubmitRunContext | ServiceNowClient;

export function makeRuntimeLayer(
  config: ServiceNowCatalogConfigData,
  runContext: SubmitRunContext
): Layer.Layer<ServiceNowRuntimeServices> {
  return Layer.mergeAll(
    Layer.succeed(ServiceNowConfigTag, config),
    Layer.succeed(SubmitRunContextTag, runContext),
    makeClientLayer(config, runContext),
    sailsLoggerLayer
  );
}
