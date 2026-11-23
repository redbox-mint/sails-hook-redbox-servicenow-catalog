import type { IncomingMessage, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');

export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => res.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error == null ? resolve() : reject(error));
      server.closeAllConnections();
    })
  };
}

export async function rejectedSubmission(promise: Promise<unknown>) {
  const { ServiceNowSubmissionError } = require('@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/services/servicenow/errors') as typeof import('../../src/api/services/servicenow/errors');
  try { await promise; } catch (error) {
    if (!(error instanceof ServiceNowSubmissionError)) throw error;
    return error;
  }
  throw new Error('Expected ServiceNowSubmissionError');
}
