import {Sails, Model} from 'sails';
import {Observable, from, of, throwError} from 'rxjs';
import * as numeral from 'numeral';
import moment = require('moment');
import axios from 'axios';
const util = require('util');
import { RecordsService, Services as services} from '@researchdatabox/redbox-core-types';
import {clientFactory, interceptorFactory} from '@scienta/axios-oauth2';

declare var sails: Sails;
declare var WorkspaceService, _;
declare var RecordsService: RecordsService, TranslationService, WorkflowStepsService;

export module Services {

  // Using configuration for (versioned API): https://developer.servicenow.com/dev.do#!/reference/api/newyork/rest/c_ServiceCatalogAPI#SCatAPIOrderNowPOST
  //
  // Official build info:
  //
  // Build name: Newyork
  // Build date: 06-05-2020_2026
  // Build tag: glide-newyork-06-26-2019__patch9-05-27-2020
  // MID buildstamp: newyork-06-26-2019__patch9-05-27-2020_06-05-2020_2026
  export class ServicenowCatalogService extends services.Core.Service {

    protected _exportedMethods: any = [
      'submitRequest',
    ];
    /**
     * Submits a ServiceNow catalog item request.
     *
     */
    public async submitRequest(oid, workspaceData, options, user, response) {
      sails.log.verbose(`ServiceNowCatalog processing request for: ${oid}`);
      sails.log.verbose("Global config:");
      sails.log.verbose(JSON.stringify(sails.config.servicenow));
      sails.log.verbose("Hook config:");
      sails.log.verbose(JSON.stringify(options));
      let catalogUrl = this.getConfig('catalog.axios.url', options);
      // let catalogUrl = this.getConfig('catalog.url', options);
      // TODO: validate if we have the right configuration
      if (_.isEmpty(catalogUrl)) {
        const errMsg = "Missing ServiceNow Catalog URL configuration.";
        sails.log.error(errMsg)
        response.code = "500";
        response.status = false;
        response.success = false;
        response.message = errMsg;
        return response;
      }
      // associate the workspace with the RDMP
      sails.log.verbose(`ServiceNowCatalog adding workspace to record...`);
      try {
        response = await WorkspaceService.addWorkspaceToRecord(workspaceData.metadata.rdmpOid, oid);
      } catch (err) {
        sails.log.error(`ServiceNowCatalog failed to associate workspace to record: ${workspaceData.metadata.rdmpOid}`);
        sails.log.error(JSON.stringify(err));
        return response;
      }
      let body_template = this.getConfig('catalog.body_template', options);
      sails.log.verbose(`ServiceNowCatalog body template:`);
      sails.log.verbose(JSON.stringify(body_template));
      // get the RDMP data
      const rdmpData = await RecordsService.getMeta(workspaceData.metadata.rdmpOid);
      const catalogFields = this.getConfig('catalog.fields', options);
      // prepare the request to ServiceNow
      const outgoingDataSource = {workspace: workspaceData, rdmp: rdmpData, oid:oid, moment: moment, numeral:numeral, translationService: TranslationService };
      body_template = this.runDataRemap(outgoingDataSource, body_template, catalogFields);
      sails.log.verbose(`ServiceNowCatalog sending request via: ${catalogUrl}, options:`);
      const axiosOptions = this.getConfig('catalog.axios', options);
      axiosOptions.data = body_template;
      sails.log.verbose(JSON.stringify(axiosOptions));
      
      let snResponse = null;
      try {
        const oauthOptions = this.getConfig('catalog.oauth', options);
        sails.log.verbose(JSON.stringify(oauthOptions));
        let oauthEnabled = _.get(oauthOptions, 'enabled', 'false');
        sails.log.verbose('OAuth enabled '+oauthEnabled);
        if(oauthEnabled == 'true') {
          let oauthUrl = _.get(oauthOptions, 'url');
          let oauthClientId = _.get(oauthOptions, 'clientId');
          let oauthClientSecret = _.get(oauthOptions, 'clientSecret');
          let oauthScope = _.get(oauthOptions, 'scope');
          let oauthGrantType = _.get(oauthOptions, 'grantType');
          sails.log.verbose('================================================');
          sails.log.verbose('oauthUrl '+oauthUrl);
          sails.log.verbose('oauthClientId '+oauthClientId);
          sails.log.verbose('oauthClientSecret '+oauthClientSecret);
          sails.log.verbose('oauthScope '+oauthScope);
          sails.log.verbose('oauthGrantType '+oauthGrantType);

          let oauthConfig = {};
          if(oauthGrantType == 'password') {
            let oauthUsername = _.get(oauthOptions, 'username');
            let oauthPassword = _.get(oauthOptions, 'password');
            sails.log.verbose('oauthUsername '+oauthUsername);
            sails.log.verbose('oauthPassword '+oauthPassword);
            oauthConfig = {
              url: oauthUrl,
              grant_type: oauthGrantType,
              client_id: oauthClientId,
              client_secret: oauthClientSecret,
              scope: oauthScope,
              username: oauthUsername,
              password: oauthPassword
            };
          } else if(oauthGrantType == 'refresh_token') {
            let oauthRefreshToken = _.get(oauthOptions, 'refreshToken');
            oauthConfig = {
              url: oauthUrl,
              grant_type: oauthGrantType,
              client_id: oauthClientId,
              client_secret: oauthClientSecret,
              scope: oauthScope,
              'refresh_token': oauthRefreshToken
            };
          } else {
            oauthConfig = {
              url: oauthUrl,
              grant_type: 'client_credentials',
              client_id: oauthClientId,
              client_secret: oauthClientSecret,
              scope: oauthScope
            };
          }

          //@ts-ignore
          const client = clientFactory(axios.create(), oauthConfig);
          const auth1 = await client();
          sails.log.verbose(JSON.stringify(auth1));
          sails.log.verbose('================================================');

          _.set(axiosOptions, 'headers.Authorization', 'Bearer '+ _.get(auth1, 'access_token'));
        } 
          
        snResponse = await axios(axiosOptions);

      } catch (err) {
        sails.log.error(`ServiceNowCatalog failed to submit to request for workspace OID: ${oid}, error is:`);
        sails.log.error(JSON.stringify(err));
        response.code = `${err.code}`;
        response.status = false;
        response.success = false;
        response.message = `ServiceNowCatalog failed to submit to request for workspace OID: ${oid}, check server logs.`;
      }
      if (!_.isNull(snResponse)) {
        if (snResponse.status == 200) {
          const updateSource = snResponse.data;
          // perform any updates to the workspace record ...
          workspaceData = this.runDataRemap(updateSource, workspaceData, this.getConfig('catalog.update_fields', options));
          await RecordsService.updateMeta(null, oid, workspaceData);
        } else {
          sails.log.error(`ServiceNowCatalog submit request failed for workspace OID: ${oid}, check server logs.`);
          sails.log.error(JSON.stringify(snResponse));
          response.code = `${snResponse.status}`;
          response.status = false;
          response.success = false;
          response.message = `ServiceNowCatalog failed to submit to request for workspace OID: ${oid}, check server logs.`;
        }
      }
      // all done!
      sails.log.verbose(`ServiceNowCatalog completed request for ${oid}`);
      return response;
    }

    private getConfig(fieldPath, options) {
      return _.get(options, fieldPath, _.get(sails.config.servicenow, fieldPath));
    }

    protected runDataRemap(source: any, target: any, fields: any[]) {
      for (const fieldDef of fields) {
        const source_field = _.get(fieldDef,'source_field');
        const dest_field = _.get(fieldDef,'dest_field');
        const dest_template = _.get(fieldDef,'dest_template');
        let parseObject = _.get(fieldDef, 'parseObject', false);
        let src_data = null;
        if (!_.isEmpty(source_field)) {
          src_data = _.get(source, source_field);
        }
        if (!_.isEmpty(dest_template)) {
          const imports = _.extend({data: src_data, config: fieldDef, moment: moment, numeral:numeral, translationService: TranslationService}, source);
          const templateData = {imports: imports};
          const template = _.template(dest_template, templateData);
          src_data = template();
        }
        if (!_.isEmpty(dest_field)) {
          if(parseObject) {
            let obj = JSON.parse(src_data);
            _.set(target, dest_field, obj);
          } else {
            _.set(target, dest_field, src_data);
          }
        }
      }
      return target;
    }
  }

}
module.exports = new Services.ServicenowCatalogService().exports();
