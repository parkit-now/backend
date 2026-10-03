import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DriverService } from './driver.service';
import {
  DriverNearbyParkingDto,
  DriverParkingDetailDto,
} from './dto/driver-parking.dto';
import { NearbyParkingsQueryDto } from './dto/nearby-parkings-query.dto';
import { CreateQuoteDto, QuoteDto } from './dto/quote.dto';

// Cualquier usuario logueado (el conductor no es miembro de ninguna playa):
// sólo JwtAuthGuard, sin TenantMembershipGuard. Todo es de solo lectura.
@ApiTags('Driver')
@Controller('driver')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  @Get('parkings')
  @ApiOperation({
    summary: 'Nearby active parking lots for drivers, ordered by distance',
  })
  @ApiOkResponse({ type: [DriverNearbyParkingDto] })
  findNearby(@Query() query: NearbyParkingsQueryDto) {
    return this.driverService.findNearby(query);
  }

  @Get('parkings/:parkingId')
  @ApiOperation({ summary: 'Public parking lot detail with opening hours' })
  @ApiParam({ name: 'parkingId', format: 'uuid' })
  @ApiOkResponse({ type: DriverParkingDetailDto })
  findOne(@Param('parkingId', ParseUUIDPipe) parkingId: string) {
    return this.driverService.findOne(parkingId);
  }

  @Post('parkings/:parkingId/quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Quote a stay: validates the window (7 days ahead, opening hours) and prices it with the lot reservation rate and pricing engine',
  })
  @ApiParam({ name: 'parkingId', format: 'uuid' })
  @ApiOkResponse({ type: QuoteDto })
  quote(
    @Param('parkingId', ParseUUIDPipe) parkingId: string,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.driverService.quote(parkingId, dto);
  }
}
