import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * ISO-8601 date-time that MUST carry an explicit UTC offset (`Z`, `+HH:MM` or
 * `-HH:MM`). Fractional seconds are optional.
 */
const OFFSET_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Validates an ISO-8601 instant and **rejects a naive one**.
 *
 * `@IsISO8601()` happily accepts `2026-08-07T13:00:00`, and `new Date()` then
 * resolves it against the *server's* local zone — UTC in a production
 * container, something else on a developer laptop. The same request would
 * silently mean two different instants, off by the Argentine offset, and the
 * revenue numbers would be quietly wrong rather than loudly broken.
 *
 * So the contract is explicit: the client states the offset it means.
 * `2026-08-07T13:00:00-03:00` for Argentine wall-clock time.
 *
 * Emits `isOffsetDateTime` as the field-level error code, per the repo's
 * convention of using the constraint name (see AGENTS.md, error contract).
 */
export function IsOffsetDateTime(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isOffsetDateTime',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string' || !OFFSET_DATE_TIME.test(value)) {
            return false;
          }
          // Shape alone is not enough: 2026-02-31T00:00:00Z parses to NaN.
          return !Number.isNaN(Date.parse(value));
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an ISO-8601 date-time with an explicit offset (e.g. 2026-08-07T13:00:00-03:00)`;
        },
      },
    });
  };
}
