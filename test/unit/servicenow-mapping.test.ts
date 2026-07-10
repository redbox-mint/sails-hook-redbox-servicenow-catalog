const { Cause, Effect, Exit } = require('effect');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing');

describe('ServiceNow value-binding mappings', function () {
  let applyFieldMappings;

  beforeEach(() => {
    ({ applyFieldMappings } = require('../../dist/api/services/servicenow/mapping.js'));
  });

  it('evaluates path, Handlebars, JSONata, defaults, and parsed JSON bindings', async function () {
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
          source: { kind: 'handlebars', template: '{{workspace.metadata.title}} — {{rdmp.metadata.title}}' }
        },
        {
          destination: 'variables.uppercaseTitle',
          source: { kind: 'jsonata', expression: '$uppercase(workspace.metadata.title)' }
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
        workspace: { metadata: { title: 'Research storage' } },
        rdmp: { metadata: { title: 'Plan A' } },
        encodedLocations: '["Adelaide","Brisbane"]'
      },
      target
    ));

    expect(result).to.deep.equal({
      variables: {
        title: 'Research storage',
        summary: 'Research storage — Plan A',
        uppercaseTitle: 'RESEARCH STORAGE',
        missing: 'fallback',
        locations: ['Adelaide', 'Brisbane']
      }
    });
  });

  it('returns a tagged MappingError for invalid parsed JSON', async function () {
    const exit = await Effect.runPromiseExit(applyFieldMappings(
      'workspace-2',
      [{
        destination: 'variables.value',
        source: { kind: 'path', path: 'encoded' },
        parseJson: true
      }],
      { encoded: '{not-json' },
      { variables: {} }
    ));

    expect(Exit.isFailure(exit)).to.equal(true);
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).to.equal('Some');
    expect(failure.value).to.include({
      _tag: 'MappingError',
      oid: 'workspace-2',
      destination: 'variables.value'
    });
  });

  it('rejects prototype-polluting destination paths', async function () {
    const exit = await Effect.runPromiseExit(applyFieldMappings(
      'workspace-3',
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
