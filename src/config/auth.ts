import type { AuthBootstrapConfig } from '@researchdatabox/redbox-core';

export const auth: Partial<AuthBootstrapConfig> = {
  rules: [
    {
      path: '/:branding/:portal/ws/catalog(/*)',
      role: 'Researcher',
      can_update: true
    }
  ]
};
