import type { AxiosResponse } from 'axios';

const { expect } = require('chai') as { expect: Chai.ExpectStatic };
const { AxiosHeaders } = require('axios') as typeof import('axios');
const { gzipSync, deflateSync, deflateRawSync, zstdCompressSync } = require('node:zlib') as typeof import('node:zlib');
const { decodeResponse, ResponseDecodingError } = require(
  '../../dist/api/services/servicenow/decodeResponse.js'
) as typeof import('../../src/api/services/servicenow/decodeResponse');

function response(data: Buffer, encoding: string): AxiosResponse<Buffer> {
  return { data, status: 201, statusText: 'Created', headers: { 'content-encoding': encoding }, config: { headers: new AxiosHeaders() } };
}

describe('Strict ServiceNow response decoding', function () {
  for (const [encoding, compress] of [
    ['deflate', deflateRawSync], ['x-gzip', gzipSync], ['zstd', zstdCompressSync]
  ] as const) {
    it(`preserves axios support for ${encoding === 'deflate' ? 'raw deflate' : encoding}`, async function () {
      const decoded = await decodeResponse(response(compress(Buffer.from('{"result":{"number":"REQ1"}}')), encoding));
      expect(decoded).to.include({ status: 201 });
      expect(decoded.data).to.deep.equal({ result: { number: 'REQ1' } });
    });
  }

  it('preserves BOM-prefixed JSON, plain text and empty encoded responses', async function () {
    expect((await decodeResponse(response(Buffer.from('\uFEFF{"result":{}}'), ''))).data).to.deep.equal({ result: {} });
    expect((await decodeResponse(response(Buffer.from('not-json'), ''))).data).to.equal('not-json');
    expect((await decodeResponse({ ...response(Buffer.alloc(0), 'br'), status: 204 })).data).to.equal('');
  });

  it('rejects an empty Brotli body when HTTP requires a response body', async function () {
    let failure: unknown;
    try {
      await decodeResponse(response(Buffer.alloc(0), 'br'));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ResponseDecodingError);
  });

  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync]] as const) {
    it(`rejects truncated ${encoding} without retaining credentials or payloads`, async function () {
      const complete = compress(Buffer.from('{"password":"private-response-password"}'));
      let failure: unknown;
      try {
        await decodeResponse(response(complete.subarray(0, complete.length - 2), encoding));
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(ResponseDecodingError);
      expect(String(failure)).to.include(`could not be decompressed (${encoding})`);
      expect(JSON.stringify(failure)).not.to.include('private-response-password');
    });
  }
});
