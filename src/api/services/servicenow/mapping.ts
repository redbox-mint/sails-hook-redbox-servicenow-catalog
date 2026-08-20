import { Effect } from 'effect';
import { handlebarsCompile, jsonataCompileAndEvaluate } from '@researchdatabox/sails-ng-common';
import type { ServiceNowFieldMapping, ValueBinding } from '../../configmodels/ServiceNowCatalogAppConfig';
import { MappingError } from './errors';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Field-mapping evaluation for the ServiceNow catalog integration.
 *
 * Replaces the legacy lodash `source_field`/`dest_template` mappings with the
 * `ValueBinding` DSL (path | handlebars | jsonata) shared with the core
 * figshare/doi publishing configuration.
 */

export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (isUnsafePathSegment(segment)) {
      return undefined;
    }
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setPath<T>(target: T, path: string, value: unknown): T {
  const segments = path.split('.');
  if (segments.length === 0 || segments.some(segment => segment === '' || isUnsafePathSegment(segment))) {
    throw new Error(`Unsafe or empty destination path '${path}'.`);
  }
  let current = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next == null || typeof next !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
  return target;
}

export function deletePath<T>(target: T, path: string): T {
  const segments = path.split('.');
  if (segments.length === 0 || segments.some(segment => segment === '' || isUnsafePathSegment(segment))) {
    throw new Error(`Unsafe or empty destination path '${path}'.`);
  }
  let current = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next == null || typeof next !== 'object') {
      return target;
    }
    current = next as Record<string, unknown>;
  }
  delete current[segments[segments.length - 1]];
  return target;
}

function isUnsafePathSegment(segment: string): boolean {
  return segment === '__proto__' || segment === 'prototype' || segment === 'constructor';
}

function evaluateBindingValue(binding: ValueBinding, context: unknown): Promise<unknown> {
  switch (binding.kind) {
    case 'path': {
      const value = getPath(context, binding.path);
      return Promise.resolve(value ?? binding.defaultValue);
    }
    case 'handlebars': {
      const compiled = handlebarsCompile(binding.template);
      const value = compiled(context);
      return Promise.resolve(value === '' ? binding.defaultValue : value);
    }
    case 'jsonata':
      return jsonataCompileAndEvaluate(binding.expression, context)
        .then(value => value ?? binding.defaultValue);
  }
}

export function evaluateBinding(
  oid: string,
  destination: string,
  binding: ValueBinding,
  context: unknown
): Effect.Effect<unknown, MappingError> {
  return Effect.tryPromise({
    try: () => evaluateBindingValue(binding, context),
    catch: cause => new MappingError({ oid, destination, cause })
  });
}

/**
 * Evaluates each mapping against `context` and writes the results into `target`.
 * Fails with the first `MappingError`, identifying the offending destination.
 */
export function applyFieldMappings<T>(
  oid: string,
  mappings: ServiceNowFieldMapping[],
  context: unknown,
  target: T
): Effect.Effect<T, MappingError> {
  return Effect.forEach(
    mappings,
    mapping =>
      Effect.gen(function* () {
        let value = yield* evaluateBinding(oid, mapping.destination, mapping.source, context);
        if (mapping.parseJson && typeof value === 'string') {
          value = yield* Effect.try({
            try: () => JSON.parse(value as string) as unknown,
            catch: cause => new MappingError({ oid, destination: mapping.destination, cause })
          });
        }
        yield* Effect.try({
          try: () => setPath(target, mapping.destination, value),
          catch: cause => new MappingError({ oid, destination: mapping.destination, cause })
        });
      }),
    { discard: true }
  ).pipe(
    Effect.as(target),
    Effect.withSpan('servicenow.applyFieldMappings', {
      attributes: { oid, mappingCount: mappings.length }
    })
  );
}

export function applyRequestFilters<T>(
  oid: string,
  filters: ServiceNowFieldMapping[],
  context: unknown,
  target: T
): Effect.Effect<T, MappingError> {
  return Effect.forEach(
    filters,
    filter =>
      Effect.gen(function* () {
        const value = getPath(target, filter.destination);
        const filterContext = isPlainObject(context)
          ? { ...context, value, request: target }
          : { context, value, request: target };
        const result = yield* evaluateBinding(oid, filter.destination, filter.source, filterContext);
        yield* Effect.try({
          try: () => result == null
            ? deletePath(target, filter.destination)
            : setPath(target, filter.destination, result),
          catch: cause => new MappingError({ oid, destination: filter.destination, cause })
        });
      }),
    { discard: true }
  ).pipe(
    Effect.as(target),
    Effect.withSpan('servicenow.applyRequestFilters', {
      attributes: { oid, filterCount: filters.length }
    })
  );
}

/**
 * Builds the outgoing ServiceNow body as one crosswalk phase. Filters run
 * after field mappings so they can inspect the mapped value and the complete
 * request, while the HTTP client only receives the finished result.
 */
export function applyRequestCrosswalk<T>(
  oid: string,
  mappings: ServiceNowFieldMapping[],
  filters: ServiceNowFieldMapping[],
  context: unknown,
  target: T
): Effect.Effect<T, MappingError> {
  return Effect.gen(function* () {
    const mappedTarget = yield* applyFieldMappings(oid, mappings, context, target);
    yield* applyRequestFilters(oid, filters, context, mappedTarget);
    return mappedTarget;
  }).pipe(
    Effect.withSpan('servicenow.applyRequestCrosswalk', {
      attributes: { oid, mappingCount: mappings.length, filterCount: filters.length }
    })
  );
}
