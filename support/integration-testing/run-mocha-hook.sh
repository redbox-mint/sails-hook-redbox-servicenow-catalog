#!/usr/bin/env bash

set -euo pipefail

cd /opt/redbox-portal

export RBPORTAL_MOCHA_TEST_PATHS=${RBPORTAL_MOCHA_TEST_PATHS:-$'test/integration/sails-hook-redbox-servicenow-catalog/**/*.test.ts'}

if [ ! -f node_modules/redoc/bundles/redoc.standalone.js ]; then
  npm install --no-save --ignore-scripts --legacy-peer-deps redoc@2.5.2
fi

if [ -d packages/redbox-hook-dev ]; then
  ln -sfn /opt/redbox-portal/packages/redbox-hook-dev /opt/redbox-portal/node_modules/redbox-hook-dev
fi

exec bash /opt/redbox-portal/support/integration-testing/run-mocha-redbox.sh
