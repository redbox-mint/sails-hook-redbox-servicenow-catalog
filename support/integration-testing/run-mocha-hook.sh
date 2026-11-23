#!/usr/bin/env bash

set -euo pipefail

cd /opt/redbox-portal

export RBPORTAL_MOCHA_TEST_PATHS=${RBPORTAL_MOCHA_TEST_PATHS:-$'test/integration/sails-hook-redbox-servicenow-catalog/**/*.test.ts'}
export RBPORTAL_SAILS_LOG_LEVEL=${RBPORTAL_SAILS_LOG_LEVEL:-error}

exec bash /opt/redbox-portal/support/integration-testing/run-mocha-redbox.sh
