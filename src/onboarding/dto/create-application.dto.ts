import { DeclaredEntityDto } from './declared-entity.dto';

/**
 * Onboarding: the applicant creates a draft application declaring ONE entity
 * (parking lot). The payload is the declared-entity data itself. Creates
 * `OnboardingApplication(status=draft, declaredEntity=...)` for the current
 * user.
 */
export class CreateApplicationDto extends DeclaredEntityDto {}
