import { PartialType } from '@nestjs/swagger';
import { CreateParkingDto } from './create-parking.dto';

/**
 * Admin payload to edit a parking lot. Every field is optional; `status` lets
 * the admin move a lot in/out of `maintenance`. Built with `PartialType` so the
 * validation rules and Swagger metadata stay in sync with `CreateParkingDto`.
 */
export class UpdateParkingDto extends PartialType(CreateParkingDto) {}
