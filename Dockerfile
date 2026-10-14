ARG REDBOX_PORTAL_IMAGE=qcifengineering/redbox-portal:develop

FROM ${REDBOX_PORTAL_IMAGE} AS builder

USER root

COPY . /opt/sails-hook-redbox-servicenow-catalog

RUN --mount=type=cache,target=/root/.npm \
  cd /opt/sails-hook-redbox-servicenow-catalog \
  && npm install --include=dev --ignore-scripts --strict-peer-deps \
  && npm run compile \
  && HOOK_TARBALL="$(npm pack --ignore-scripts --pack-destination /tmp --silent)" \
  && mkdir -p /opt/redbox-portal/node_modules/@researchdatabox/sails-hook-redbox-servicenow-catalog \
  && tar -xzf "/tmp/${HOOK_TARBALL}" -C /opt/redbox-portal/node_modules/@researchdatabox/sails-hook-redbox-servicenow-catalog --strip-components=1 \
  && npm pkg set --prefix /opt/redbox-portal "dependencies.@researchdatabox/sails-hook-redbox-servicenow-catalog=1.0.0" \
  && rm -f "/tmp/${HOOK_TARBALL}"

FROM ${REDBOX_PORTAL_IMAGE} AS sails-hook-redbox-servicenow-catalog

USER root

COPY --from=builder --chown=node:node /opt/redbox-portal/package.json /opt/redbox-portal/package.json
COPY --from=builder --chown=node:node /opt/redbox-portal/node_modules/@researchdatabox/sails-hook-redbox-servicenow-catalog /opt/redbox-portal/node_modules/@researchdatabox/sails-hook-redbox-servicenow-catalog
COPY --from=builder --chown=node:node /opt/sails-hook-redbox-servicenow-catalog/language-defaults/ /opt/redbox-portal/language-defaults/

USER node
