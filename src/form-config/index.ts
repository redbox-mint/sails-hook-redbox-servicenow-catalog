import type { FormConfigFrame } from '@researchdatabox/sails-ng-common';
import draft from './servicenow-catalog-1.0-draft';
import provisioning from './servicenow-catalog-1.0-provisioning';
import provisioned from './servicenow-catalog-1.0-provisioned';

export const FormConfigExports: Record<string, FormConfigFrame> = {
  'servicenow-catalog-1.0-draft': draft,
  'servicenow-catalog-1.0-provisioning': provisioning,
  'servicenow-catalog-1.0-provisioned': provisioned
};
