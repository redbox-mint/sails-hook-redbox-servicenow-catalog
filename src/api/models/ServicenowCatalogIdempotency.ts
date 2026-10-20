import 'reflect-metadata';
import {
  Attr,
  Entity,
  PrimaryKey,
  toWaterlineModelDef
} from '@researchdatabox/redbox-core';

export type ServicenowCatalogIdempotencyStatus =
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'uncertain';

@Entity('servicenowcatalogidempotency', {
  datastore: 'redboxStorage'
})
export class ServicenowCatalogIdempotencyClass {
  /** A deterministic hash of the complete scope makes create an atomic claim. */
  @PrimaryKey({ type: 'string', columnName: '_id' })
  public id!: string;

  @Attr({ type: 'string', required: true })
  public claimToken!: string;

  @Attr({ type: 'string', required: true })
  public status!: ServicenowCatalogIdempotencyStatus;

  @Attr({ type: 'string', required: true })
  public redboxOid!: string;

  @Attr({ type: 'string', required: true })
  public brandId!: string;

  @Attr({ type: 'string', required: true })
  public catalog!: string;

  @Attr({ type: 'string', required: true })
  public idempotencyKey!: string;

  /** End of the current owner's exclusive claim window. */
  @Attr({ type: 'string', required: true })
  public leaseExpiresAt!: string;

  @Attr({ type: 'string', autoCreatedAt: true })
  public createdAt!: string;

  @Attr({ type: 'string', autoUpdatedAt: true })
  public updatedAt!: string;
}

export const ServicenowCatalogIdempotencyWLDef = toWaterlineModelDef(
  ServicenowCatalogIdempotencyClass
);
