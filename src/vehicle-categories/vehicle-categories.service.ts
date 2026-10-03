import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { VehicleCategoryDto } from './dto/vehicle-category.dto';
import { isVehicleCategory, VEHICLE_CATEGORY_INFO } from './vehicle-categories';

@Injectable()
export class VehicleCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * La lista sale de la tabla `vehicle_categories` (la fuente de verdad: se
   * cambia por migración). Si el deploy del backend se adelanta a la migración
   * o la tabla viene vacía, cae al `const` del código en vez de devolver nada.
   */
  async list(): Promise<VehicleCategoryDto[]> {
    const rows = await this.prisma.vehicleCategory.findMany({
      orderBy: { sortOrder: 'asc' },
    });

    const known = rows.filter((r) => isVehicleCategory(r.code));
    if (known.length === 0) {
      return VEHICLE_CATEGORY_INFO.map((c) => ({ ...c }));
    }
    return known.map((r) => ({
      code: r.code as VehicleCategoryDto['code'],
      label: r.label,
      sortOrder: r.sortOrder,
      reservable: r.reservable,
    }));
  }
}
