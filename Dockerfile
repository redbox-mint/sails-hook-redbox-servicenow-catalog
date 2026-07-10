ARG REDBOX_BASE_IMAGE=qcifengineering/redbox-portal:develop-pdfgen

FROM ${REDBOX_BASE_IMAGE} AS builder

USER root

COPY sails-hook-redbox-servicenow-catalog /opt/sails-hook-redbox-servicenow-catalog
COPY redbox-portal/packages/redbox-core /opt/redbox-portal/packages/redbox-core
COPY redbox-portal/packages/sails-ng-common /opt/redbox-portal/packages/sails-ng-common
COPY redbox-portal/packages/redbox-dev-tools /opt/redbox-portal/packages/redbox-dev-tools
COPY redbox-portal/packages/redbox-hook-dev /opt/redbox-portal/packages/redbox-hook-dev

RUN --mount=type=cache,target=/root/.npm \
  cd /opt/sails-hook-redbox-servicenow-catalog \
  && npm install --include=dev --ignore-scripts --legacy-peer-deps \
  && npm run compile \
  && HOOK_TARBALL="$(npm pack --pack-destination /tmp --silent)" \
  && cd /opt/redbox-portal \
  && npm install --legacy-peer-deps --ignore-scripts "/tmp/${HOOK_TARBALL}" \
  && if [ -d /opt/redbox-portal/packages/redbox-hook-dev ]; then ln -sfn /opt/redbox-portal/packages/redbox-hook-dev /opt/redbox-portal/node_modules/redbox-hook-dev; fi \
  && rm -f "/tmp/${HOOK_TARBALL}" \
  && mkdir -p /opt/redbox-portal/language-defaults /opt/redbox-portal/bootstrap-data \
  && cp -a /opt/sails-hook-redbox-servicenow-catalog/language-defaults/. /opt/redbox-portal/language-defaults/ \
  && cp -a /opt/sails-hook-redbox-servicenow-catalog/bootstrap-data/. /opt/redbox-portal/bootstrap-data/

FROM ${REDBOX_BASE_IMAGE} AS sails-hook-redbox-servicenow-catalog
USER root

COPY --from=builder --chown=node:node --chmod='u=rwx,g=rx,o=rx' /opt/redbox-portal /opt/redbox-portal

USER node
