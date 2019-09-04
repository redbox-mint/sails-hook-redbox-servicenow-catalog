declare var module;
declare var sails, Model;
declare var _;

import {Observable} from 'rxjs';
import 'rxjs/add/operator/map';

declare var BrandingService, WorkspaceService, CatalogService;
/**
 * Package that contains all Controllers.
 */
import controller = require('../core/CoreController');
import {Config} from '../Config';

export module Controllers {

  /**
   * Omero related features....
   *
   */
  export class CatalogController extends controller.Controllers.Core.Controller {

    protected _exportedMethods: any = [
      'info',
      'rdmpInfo',
      'request'
    ];

    protected config: Config;

    constructor() {
      super();
      this.config = new Config(sails.config.workspaces);
    }

    public info(req, res) {
      this.config.brandingAndPortalUrl = BrandingService.getFullPath(req);
      this.ajaxOk(req, res, null, {status: true});
    }

    rdmpInfo(req, res) {
      sails.log.debug('rdmpInfo');
      const userId = req.user.id;
      const rdmp = req.param('rdmp');
      let recordMetadata = {};
      this.config.brandingAndPortalUrl = BrandingService.getFullPath(req);
      return WorkspaceService.getRecordMeta(this.config, rdmp)
        .subscribe(response => {
          sails.log.debug('recordMetadata');
          recordMetadata = response;
          this.ajaxOk(req, res, null, {status: true, recordMetadata: recordMetadata});
        }, error => {
          sails.log.error('recordMetadata: error');
          sails.log.error(error);
          this.ajaxFail(req, res, error.message, {status: false, message: error.message});
        });
    }

    request(req, res) {
      sails.log.debug('request');
      this.config.brandingAndPortalUrl = BrandingService.getFullPath(req);

      const userId = req.user.id;
      const rdmp = req.param('rdmp');
      const request = req.param('request');
      let createTicket = null;
      const description = `
      Creating request from Stash
      
      Dear eResearch admin: Please verify this workspace request done via Stash in the next data management plan
      
      ${this.config.brandingAndPortalUrl}/record/view/${rdmp}
      
      Details:
      
      ${request.name}
      
      ${request.owner} : ${request.ownerEmail}
      
      Supervisor: ${request.supervisor}
      
      Retention Period: ${request.retention}
      
      Project Start: ${request.projectStart}
      
      Project End: ${request.projectEnd}
      `;
      // TODO: find the user opened_by ID with API
      const info = {
        "short_description": `Stash Service: ${request.type} : ${request.name}`,
        "description": description,
        "assigned_to": `${this.config.requesteeId}`,
        "opened_by": `${this.config.testRequestorId}`
      };

      sails.log.debug(JSON.stringify(info, null,2));
      return CatalogService.createServiceRecord(info)
        .subscribe(response => {
          sails.log.debug('createTicket');
          createTicket = response;
          this.ajaxOk(req, res, null, {status: true, createTicket: createTicket});
        }, error => {
          sails.log.error('createTicket: error');
          sails.log.error(error);
          this.ajaxFail(req, res, error.message, {status: false, message: error.message});
        });
    }
  }
}
module.exports = new Controllers.CatalogController().exports();