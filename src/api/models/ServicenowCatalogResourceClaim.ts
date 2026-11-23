import 'reflect-metadata';
import { Attr, Entity, PrimaryKey, toWaterlineModelDef } from '@researchdatabox/redbox-core';

export type ResourceClaimState = 'reserved' | 'dispatching' | 'submitted' | 'uncertain';

@Entity('servicenowcatalogresourceclaim', { datastore: 'redboxStorage' })
export class ServicenowCatalogResourceClaimClass {
  @PrimaryKey({ type: 'string', columnName: '_id' }) public id!: string;
  @Attr({ type: 'string', required: true }) public brandId!: string;
  @Attr({ type: 'string', required: true }) public parentOid!: string;
  @Attr({ type: 'string', required: true }) public resourceKey!: string;
  @Attr({ type: 'string', required: true }) public requestOid!: string;
  @Attr({ type: 'string', required: true }) public catalog!: string;
  @Attr({ type: 'string', required: true }) public claimToken!: string;
  @Attr({ type: 'string', required: true }) public state!: ResourceClaimState;
  @Attr({ type: 'string', autoCreatedAt: true }) public createdAt!: string;
  @Attr({ type: 'string', autoUpdatedAt: true }) public updatedAt!: string;
}
export const ServicenowCatalogResourceClaimWLDef = toWaterlineModelDef(ServicenowCatalogResourceClaimClass);
