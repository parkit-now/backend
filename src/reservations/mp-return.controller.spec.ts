import type { Response } from 'express';
import type { PrismaService } from '../database/prisma.service';
import { MpReturnController } from './mp-return.controller';
import { ReservationsModule } from './reservations.module';

const RES = '0192f0a0-0000-7000-8000-00000000abcd';

function fakeResponse() {
  const res: Record<string, ReturnType<typeof jest.fn>> = {};
  res.status = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  return res;
}

describe('MpReturnController', () => {
  const prisma = { reservationPayment: { findFirst: jest.fn() } };
  const controller = new MpReturnController(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.reservationPayment.findFirst.mockResolvedValue({
      returnUrl: 'parkit://reservas?x=1',
    });
  });

  it('redirige al returnUrl con reservationId y status, ignorando los params de MP', async () => {
    const res = fakeResponse();
    await controller.handle(RES, 'success', res as unknown as Response);
    expect(prisma.reservationPayment.findFirst).toHaveBeenCalledWith({
      where: { reservationId: RES },
      orderBy: { createdAt: 'desc' },
      select: { returnUrl: true },
    });
    const [status, url] = res.redirect.mock.calls[0] as [number, string];
    expect(status).toBe(302);
    expect(url).toContain('parkit://reservas');
    expect(url).toContain(`reservationId=${RES}`);
    expect(url).toContain('status=approved');
    expect(url).toContain('x=1');
  });

  it.each([
    ['failure', 'rejected'],
    ['pending', 'pending'],
    ['otra-cosa', 'pending'],
    [undefined, 'pending'],
  ])('result=%s mapea a status=%s', async (result, expected) => {
    const res = fakeResponse();
    await controller.handle(RES, result, res as unknown as Response);
    expect(res.redirect.mock.calls[0][1]).toContain(`status=${expected}`);
  });

  it('sin returnUrl responde la página mínima', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue({ returnUrl: null });
    const res = fakeResponse();
    await controller.handle(RES, 'success', res as unknown as Response);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Volvé a la app Parkit');
    expect(html).toContain('Recibimos tu pago');
  });

  it('un returnUrl guardado fuera de la allowlist no se redirige', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue({
      returnUrl: 'https://evil.com/phish',
    });
    const res = fakeResponse();
    await controller.handle(RES, 'success', res as unknown as Response);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.send.mock.calls[0][0]).not.toContain('evil.com');
  });

  it('reserva sin pagos responde la página mínima', async () => {
    prisma.reservationPayment.findFirst.mockResolvedValue(null);
    const res = fakeResponse();
    await controller.handle(RES, 'failure', res as unknown as Response);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each(['no-es-uuid', undefined, ['a', 'b'], '', "' OR 1=1 --"])(
    'el id inválido %j responde 200 sin consultar la base',
    async (id) => {
      const res = fakeResponse();
      await controller.handle(id, 'success', res as unknown as Response);
      expect(prisma.reservationPayment.findFirst).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    },
  );

  it('el módulo lo registra siempre', () => {
    expect(Reflect.getMetadata('controllers', ReservationsModule)).toContain(
      MpReturnController,
    );
  });
});
