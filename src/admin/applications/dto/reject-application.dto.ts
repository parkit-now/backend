import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectApplicationDto {
  @ApiProperty({
    description:
      'Reason for rejecting the application. Stored in the application history and surfaced to the owner, who can fix the issues and resubmit.',
    example: 'Missing proof of property ownership for branch #2.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
