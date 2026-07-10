import { Effect } from 'effect';
import { handlebarsCompile, jsonataCompileAndEvaluate } from '@researchdatabox/sails-ng-common';
import type { ServiceNowFieldMapping, ValueBinding } from '../../configmodels/ServiceNowCatalogAppConfig';
import { MappingError } from './errors';

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
