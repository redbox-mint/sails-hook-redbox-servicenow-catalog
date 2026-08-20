import { Controllers as CoreControllers } from '@researchdatabox/redbox-core';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

interface CatalogItemConfig {
  name: string;
  id: string;
}

interface LegacyWorkspaceCatalogConfig {
  portal?: {
    authorization?: string;
  };
  provisionerUser?: string;
  parentRecord?: string;
  catalog?: {
    recordType?: string;
    workflowStage?: string;
    domain?: string;
    taskURL?: string;
    user?: string;
    password?: string;
    assignedToEmail?: string;
    items?: CatalogItemConfig[];
  };
}

interface CatalogRequestField {
  variable: string;
  value: unknown;
}

interface CatalogRequestInfo {
  workspaceTitle?: string;
  workspaceDescription?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export namespace Controllers {
  export class Catalog extends CoreControllers.Core.Controller {
    protected override _exportedMethods: string[] = [
      'info',
      'rdmpInfo',
      'request',
      'requestToVariables'
    ];

    public info(req: Sails.Req, res: Sails.Res): unknown {
      BrandingService.getFullPath(req);
      return this.legacyResponse(req, res, '', { status: true });
    }

    public async rdmpInfo(req: Sails.Req, res: Sails.Res): Promise<unknown> {
      try {
        const rdmp = String(req.param('rdmp') ?? '');
        if (!rdmp) {
          return this.legacyResponse(req, res, 'A plan identifier is required.', { status: false });
        }

        const record = await RecordsService.getMeta(rdmp);
        const recordMetadata = asRecord(record.metadata ?? record);
        return this.legacyResponse(req, res, '', { status: true, recordMetadata });
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(`Unable to load ServiceNow catalog parent plan: ${message}`);
        return this.legacyResponse(req, res, message, { status: false, message });
      }
    }

    public async request(req: Sails.Req, res: Sails.Res): Promise<unknown> {
      try {
        const workspaces = asRecord(sails.config.workspaces) as LegacyWorkspaceCatalogConfig;
        const config = workspaces.catalog ?? {};
        const domain = String(config.domain ?? '').replace(/\/$/, '');
        const username = String(req.user?.username ?? '');
        const rdmp = String(req.param('rdmp') ?? '');
        const catalogName = String(req.param('catalogName') ?? '');
        const request = asRecord(req.param('request')) as Record<string, CatalogRequestField>;
        const workspaceInfo = asRecord(req.param('workspaceInfo')) as CatalogRequestInfo;
        const workspaceType = String(req.param('workspaceType') ?? '');

        if (!domain || !config.user || !config.password) {
          return this.legacyResponse(req, res, 'ServiceNow credentials are not configured.', { status: false });
        }
        if (!String(config.recordType ?? '').trim() || !String(config.workflowStage ?? '').trim()) {
          return this.legacyResponse(
            req,
            res,
            'The legacy ServiceNow catalog record type and workflow stage are not configured.',
            { status: false }
          );
        }
        if (!rdmp || !username) {
          return this.legacyResponse(req, res, 'A plan and authenticated user are required.', { status: false });
        }

        const catalogItem = config.items?.find(item => item.name === catalogName);
        if (!catalogItem) {
          return this.legacyResponse(req, res, 'No matching ServiceNow catalog item was found.', { status: false });
        }

        const requestedByEmail = this.fieldValue(request.data_manager);
        const affectedContact = this.fieldValue(request.data_supervisor);
        if (!requestedByEmail || !affectedContact) {
          return this.legacyResponse(
            req,
            res,
            'The plan must include both a data manager and supervisor.',
            { status: false }
          );
        }

        const assignedTo = await this.lookupServiceNowUserId(
          domain,
          String(config.assignedToEmail ?? ''),
          config.user,
          config.password
        );
        const requestedBy = await this.lookupServiceNowUserId(
          domain,
          requestedByEmail,
          config.user,
          config.password
        );

        const variables = this.requestToVariables(request);
        const brandingAndPortalUrl = BrandingService.getFullPath(req);
        variables.rdmp = `${brandingAndPortalUrl}/record/view/${rdmp}`;
        variables.requestor = requestedByEmail.split('.')[0] || 'ReDBox User';
        variables.user_id = requestedBy;
        variables.opened_by = requestedBy;
        variables.requested_for = requestedBy;
        if (assignedTo) {
          variables.assigned_to = assignedTo;
        }
        variables.affected_contact = affectedContact;

        const serviceNowResult = await this.orderCatalogItem(
          domain,
          catalogItem.id,
          variables,
          config.user,
          config.password
        );
        const requestNumber = String(serviceNowResult.request_number ?? serviceNowResult.number ?? '');
        const serviceNowId = String(serviceNowResult.sys_id ?? '');
        const workspaceLocation = serviceNowId
          ? `${domain}${String(config.taskURL ?? '')}${serviceNowId}`
          : domain;

        const parentRecord = await RecordsService.getMeta(rdmp);
        const parentMetadata = asRecord(parentRecord.metadata ?? parentRecord);
        const recordType = String(config.recordType);
        const workflowStage = String(config.workflowStage);
        const project = {
          rdmpOid: rdmp,
          rdmpTitle: String(parentMetadata.title ?? ''),
          title: String(workspaceInfo.workspaceTitle ?? requestNumber),
          location: workspaceLocation,
          description: `${requestNumber} : ${workspaceType} ${String(workspaceInfo.workspaceDescription ?? '')}`.trim(),
          type: recordType
        };
        const createConfig = {
          brandingAndPortalUrl,
          redboxHeaders: {
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            ...(workspaces.portal?.authorization
              ? { Authorization: workspaces.portal.authorization }
              : {})
          }
        };
        const createdResponse = await firstValueFrom(
          WorkspaceService.createWorkspaceRecord(createConfig, username, project, recordType, workflowStage)
        );
        const workspaceOid = this.extractOid(createdResponse.data);
        if (!workspaceOid) {
          throw new Error('ReDBox created the workspace but did not return its identifier.');
        }
        await WorkspaceService.addWorkspaceToRecord(rdmp, workspaceOid);

        return this.legacyResponse(req, res, '', {
          status: true,
          createTicket: serviceNowResult,
          request_number: requestNumber,
          workspaceLocation,
          workspaceOid
        });
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(`Unable to submit ServiceNow catalog request: ${message}`);
        return this.legacyResponse(
          req,
          res,
          message,
          {
            status: false,
            message: 'There was an error submitting your request. Please contact the support team.'
          }
        );
      }
    }

    /** Preserve the legacy payload contract while using the standard response pipeline. */
    private legacyResponse(
      req: Sails.Req,
      res: Sails.Res,
      _message: string,
      data: unknown
    ): unknown {
      return this.sendResp(req, res, {
        data,
        headers: this.getNoCacheHeaders()
      });
    }

    public requestToVariables(request: Record<string, CatalogRequestField>): Record<string, unknown> {
      const variables: Record<string, unknown> = {};
      for (const field of Object.values(request)) {
        if (!field || !field.variable) {
          continue;
        }
        const valueRecord = asRecord(field.value);
        let value: unknown = valueRecord.name ?? field.value;
        if (Array.isArray(value) && value.length === 1) {
          value = value[0];
        }
        variables[field.variable] = value;
      }
      return variables;
    }

    private fieldValue(field: CatalogRequestField | undefined): string {
      if (!field) {
        return '';
      }
      const valueRecord = asRecord(field.value);
      return String(valueRecord.name ?? field.value ?? '');
    }

    private async lookupServiceNowUserId(
      domain: string,
      email: string,
      username: string,
      password: string
    ): Promise<string> {
      if (!email) {
        return '';
      }
      const response = await axios.get(`${domain}/api/now/table/sys_user`, {
        auth: { username, password },
        params: {
          sysparm_query: `email=${email}`,
          sysparm_fields: 'sys_id',
          sysparm_limit: 1
        }
      });
      const result = asRecord(response.data).result;
      const first = Array.isArray(result) ? asRecord(result[0]) : {};
      const sysId = String(first.sys_id ?? '');
      if (!sysId) {
        throw new Error(`Cannot find the configured ServiceNow user for ${email}.`);
      }
      return sysId;
    }

    private async orderCatalogItem(
      domain: string,
      catalogId: string,
      variables: Record<string, unknown>,
      username: string,
      password: string
    ): Promise<Record<string, unknown>> {
      const response = await axios.post(
        `${domain}/api/sn_sc/servicecatalog/items/${encodeURIComponent(catalogId)}/order_now`,
        {
          sysparm_quantity: '1',
          variables
        },
        {
          auth: { username, password }
        }
      );
      return asRecord(asRecord(response.data).result);
    }

    private extractOid(value: unknown): string {
      const response = asRecord(value);
      const data = asRecord(response.data);
      return String(response.oid ?? response.redboxOid ?? data.oid ?? data.redboxOid ?? '');
    }
  }
}

export type CatalogController = Pick<
  Controllers.Catalog,
  'info' | 'rdmpInfo' | 'request' | 'requestToVariables'
>;
export const CatalogController = new Controllers.Catalog().exports() as CatalogController;

module.exports = CatalogController;
