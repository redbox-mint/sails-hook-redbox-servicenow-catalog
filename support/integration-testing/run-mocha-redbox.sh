#!/usr/bin/env bash

set -euo pipefail

if [[ "${RBPORTAL_TRACE_RUNNER:-false}" == "true" ]]; then
  set -o xtrace
fi

cd /opt/redbox-portal

export TS_NODE_PROJECT=/opt/redbox-portal/support/integration-testing/tsconfig.json
export TS_NODE_TRANSPILE_ONLY=true
export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","esModuleInterop":true}'

export RBPORTAL_COVERAGE_DIR=${RBPORTAL_COVERAGE_DIR:-/tmp/redbox-coverage/mocha}
mkdir -p "$RBPORTAL_COVERAGE_DIR"

export NYC_OUTPUT=${NYC_OUTPUT:-/tmp/nyc_output}
mkdir -p "$NYC_OUTPUT"

export RBPORTAL_JUNIT_DIR=${RBPORTAL_JUNIT_DIR:-/tmp/redbox-junit/backend-mocha}
mkdir -p "$RBPORTAL_JUNIT_DIR"

ensure_test_dependencies() {
  if [[ -x node_modules/.bin/mocha \
    && -x node_modules/.bin/nyc \
    && -f node_modules/ts-node/register/index.js \
    && -f node_modules/chai/package.json ]]; then
    return 0
  fi

  npm install --no-save --legacy-peer-deps --ignore-scripts \
    mocha@11.7.6 \
    nyc@18.0.0 \
    ts-node@10.9.2 \
    chai@6.2.2 \
    mocha-junit-reporter@2.2.1
}

remove_sails_hook_scan_conflicts() {
  rm -rf node_modules/should
  if [[ -L node_modules/redbox-hook-dev && ! -e node_modules/redbox-hook-dev ]]; then
    rm -f node_modules/redbox-hook-dev
  fi
}

resolve_test_args() {
  local raw_arg=''
  local matches=()

  shopt -s globstar nullglob
  for raw_arg in "$@"; do
    matches=( $raw_arg )
    if [[ ${#matches[@]} -eq 0 ]]; then
      shopt -u globstar nullglob
      echo "No test files matched: $raw_arg" >&2
      return 1
    fi
    resolved_test_args+=("${matches[@]}")
  done
  shopt -u globstar nullglob
}

ensure_test_dependencies
remove_sails_hook_scan_conflicts

node -e "
  const { generateAllShims } = require('@researchdatabox/redbox-core');
  generateAllShims(process.cwd(), {
    forceRegenerate: true,
    verbose: process.env.SHIM_VERBOSE === 'true'
  }).catch(err => {
    console.error('Shim generation failed:', err);
    process.exit(1);
  });
"

test_args=()
if [[ -n "${RBPORTAL_MOCHA_TEST_PATHS:-}" ]]; then
  mapfile -t env_test_args <<< "${RBPORTAL_MOCHA_TEST_PATHS}"
  test_args+=("${env_test_args[@]}")
fi
if [[ ${#@} -gt 0 ]]; then
  test_args+=("$@")
fi
if [[ ${#test_args[@]} -eq 0 ]]; then
  test_args=(test/integration/**/*.test.ts)
fi

resolved_test_args=()
resolve_test_args "${test_args[@]}"

mocha_config_args=(
  --require ts-node/register
  --require chai
  --extension ts,js
  --recursive
  --timeout 120s
  --ui bdd
)
if [[ "${CI:-false}" == "true" ]]; then
  mocha_config_args+=(--reporter mocha-junit-reporter --reporter-option mochaFile="$RBPORTAL_JUNIT_DIR/backend-mocha.xml")
else
  mocha_config_args+=(--reporter spec)
fi

exec node_modules/.bin/nyc --no-clean \
  --temp-dir "$NYC_OUTPUT" \
  --report-dir "$RBPORTAL_COVERAGE_DIR" \
  --reporter=lcov --exclude-after-remap=false \
  node node_modules/.bin/mocha \
  "${mocha_config_args[@]}" \
  --exit support/integration-testing/bootstrap.test.ts "${resolved_test_args[@]}"
