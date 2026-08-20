const { Cause, Effect, Exit } = require('effect') as typeof import('effect');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const { applyFieldMappings, applyRequestCrosswalk } = require('../../dist/api/services/servicenow/mapping.js') as
  typeof import('../../src/api/services/servicenow/mapping');

describe('ServiceNow value-binding mappings', function () {
  it('evaluates the stable workspace, parent, trigger, brand, translation, and date context', async function () {
    const target = { variables: {} };
    const result = await Effect.runPromise(applyFieldMappings(
      'workspace-1',
      [
        {
          destination: 'variables.title',
          source: { kind: 'path', path: 'workspace.metadata.title' }
        },
        {
          destination: 'variables.summary',
          source: {
            kind: 'handlebars',
            template: '{{workspace.metadata.title}} — {{parentRecord.metadata.title}} — {{trigger.event}}/{{trigger.catalog}}'
          }
        },
        {
          destination: 'variables.brand',
          source: { kind: 'path', path: 'brand' }
        },
        {
          destination: 'variables.translation',
          source: { kind: 'handlebars', template: '{{t "storage.label"}}' }
        },
        {
          destination: 'variables.formattedDate',
          source: {
            kind: 'jsonata',
            expression: '$luxonFormatDate(workspace.metadata.requestedAt, "dd/LL/yyyy")'
          }
        },
        {
          destination: 'variables.missing',
          source: { kind: 'path', path: 'workspace.metadata.missing', defaultValue: 'fallback' }
        },
        {
          destination: 'variables.locations',
          source: { kind: 'path', path: 'encodedLocations' },
          parseJson: true
        }
      ],
      {
        workspace: {
          metadata: {
            title: 'Research storage',
            requestedAt: '2026-08-18'
          }
        },
        parentRecord: { metadata: { title: 'Plan A' } },
        trigger: { event: 'create', catalog: 'storage-new' },
        brand: 'brand-a',
        now: '2026-08-18T00:00:00.000Z',
        translationService: { t: (key: string) => key === 'storage.label' ? 'Storage' : key },
        encodedLocations: '["Adelaide","Brisbane"]'
      },
      target
    ));

    expect(result).to.deep.equal({
      variables: {
        title: 'Research storage',
        summary: 'Research storage — Plan A — create/storage-new',
        brand: 'brand-a',
        translation: 'Storage',
        formattedDate: '18/08/2026',
        missing: 'fallback',
        locations: ['Adelaide', 'Brisbane']
      }
    });
  });

  it('maps normalized response data and configurable status only when mappings request it', async function () {
    const workspace = { metadata: { status: 'Draft', existing: 'keep' } };
    const noStatusResult = await Effect.runPromise(applyFieldMappings(
      'workspace-2',
      [{
        destination: 'metadata.requestNumber',
        source: { kind: 'path', path: 'response.result.number' }
      }],
      { response: { result: { number: 'REQ1', status: 'Accepted' } } },
      structuredClone(workspace)
    ));
    expect(noStatusResult).to.deep.equal({
      metadata: { status: 'Draft', existing: 'keep', requestNumber: 'REQ1' }
    });

    const statusResult = await Effect.runPromise(applyFieldMappings(
      'workspace-2',
      [{
        destination: 'metadata.status',
        source: { kind: 'path', path: 'response.result.status', defaultValue: 'Submitted' }
      }],
      { response: { result: { status: 'Accepted' } } },
      structuredClone(workspace)
    ));
    expect(statusResult).to.have.nested.property('metadata.status', 'Accepted');
  });

  it('filters outgoing values and removes a scalar when its filter returns null', async function () {
    const request = {
      variables: {
        requesterEmail: 'admin@example.com',
        contributors: [
          { email: 'ada@auckland.ac.nz' },
          { email: 'grace@example.com' }
        ]
      }
    };
    const result = await Effect.runPromise(applyRequestCrosswalk(
      'workspace-filter-1',
      [],
      [
        {
          destination: 'variables.requesterEmail',
          source: {
            kind: 'jsonata',
            expression: '$substringAfter($lowercase(value), "@") = "auckland.ac.nz" ? value : null'
          }
        },
        {
          destination: 'variables.contributors',
          source: {
            kind: 'jsonata',
            expression: '$append([], $filter(value, function($person) { $substringAfter($lowercase($string($person.email)), "@") = "auckland.ac.nz" }))'
          }
        }
      ],
      { workspace: { metadata: {} } },
      request
    ));

    expect(result).to.deep.equal({
      variables: {
        contributors: [{ email: 'ada@auckland.ac.nz' }]
      }
    });
  });

  it('returns a tagged MappingError for invalid parsed JSON', async function () {
    const exit = await Effect.runPromiseExit(applyFieldMappings(
      'workspace-3',
      [{
        destination: 'variables.value',
        source: { kind: 'path', path: 'encoded' },
        parseJson: true
      }],
      { encoded: '{not-json' },
      { variables: {} }
    ));

    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).to.equal('Some');
      if (failure._tag === 'Some') {
        expect(failure.value).to.include({
          _tag: 'MappingError',
          oid: 'workspace-3',
          destination: 'variables.value'
        });
      }
    }
  });

  it('rejects prototype-polluting destination paths', async function () {
    const exit = await Effect.runPromiseExit(applyFieldMappings(
      'workspace-4',
      [{
        destination: '__proto__.polluted',
        source: { kind: 'path', path: 'value' }
      }],
      { value: true },
      {}
    ));

    expect(Exit.isFailure(exit)).to.equal(true);
    expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
  });
});
