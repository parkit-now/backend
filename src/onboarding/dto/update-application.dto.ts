import { PartialType } from '@nestjs/swagger';
import { DeclaredEntityDto } from './declared-entity.dto';

/**
 * Editing the application while it is in `draft` or `rejected`. Patches the
 * declared entity; every field is optional (partial update). The provided
 * fields are merged into `OnboardingApplication.declaredEntity`.
 */
export class UpdateApplicationDto extends PartialType(DeclaredEntityDto) {}
