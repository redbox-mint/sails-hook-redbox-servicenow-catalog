import sails from 'sails';
import _ from 'lodash';
import {DateTime} from 'luxon';
import {generateAllShims} from '@researchdatabox/redbox-core';

(global as any).DateTime = DateTime;

before(function (this: Mocha.Context, done) {
  import('chai')
    .then(chai => {
      (global as any).chai = chai;
      (global as any).should = (chai as any).should();
      (global as any).expect = (chai as any).expect;

      this.timeout(5 * 60 * 1000);

      generateAllShims(process.cwd(), {
        forceRegenerate: process.env.REGENERATE_SHIMS === 'true',
        verbose: process.env.SHIM_VERBOSE === 'true'
      })
        .then(() => {
          (sails as any).lift(
            {
              log: {level: process.env.RBPORTAL_SAILS_LOG_LEVEL ?? 'error'},
              hooks: {grunt: false},
              models: {datastore: 'mongodb', migrate: 'drop'},
              security: {csrf: false},
              auth: {
                default: {
                  local: {
                    default: {token: 'integration-token'}
                  }
                }
              }
            },
            (err: Error | undefined) => done(err, sails as any)
          );
        })
        .catch((err: Error) => done(err));
    })
    .catch(done);
});

after(function (done) {
  if (sails && _.isFunction((sails as any).lower)) {
    (sails as any).lower(done);
    return;
  }
  done();
});
