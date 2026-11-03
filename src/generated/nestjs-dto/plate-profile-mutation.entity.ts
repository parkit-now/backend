
import {TenantEntity} from './tenant.entity'


export class PlateProfileMutationEntity {
  id: string ;
tenantId: string ;
tenant?: TenantEntity ;
plate: string ;
}
