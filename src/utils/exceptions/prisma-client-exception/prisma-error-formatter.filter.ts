import { Prisma } from '@prisma/client';

function fmt(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export class PrismaErrorFormatter {
  private exception: Prisma.PrismaClientKnownRequestError;

  constructor(exception: Prisma.PrismaClientKnownRequestError) {
    this.exception = exception;
  }

  private get meta(): Record<string, unknown> {
    return this.exception.meta ?? {};
  }

  getFriendlyMessage(): string {
    const meta = this.meta;
    switch (this.exception.code) {
      case 'P2001': {
        const model = fmt(meta.model_name);
        const arg = fmt(meta.argument_name);
        const value = fmt(meta.argument_value);
        return `The record searched for in the condition (${model}.${arg} = ${value}) does not exist.`;
      }
      case 'P2002': {
        return `This ${fmt(meta.target, 'constraint')} already exists.`;
      }
      case 'P2003': {
        return `Foreign key constraint failed on the field: ${fmt(meta.field_name, 'unknown field')}.`;
      }
      case 'P2004': {
        return `A constraint failed on the database: ${fmt(meta.database_error, 'unknown database error')}.`;
      }
      case 'P2005': {
        return `The value '${fmt(meta.field_value)}' stored in the database for the field '${fmt(meta.field_name)}' is invalid for its type.`;
      }
      case 'P2006': {
        return `The provided value '${fmt(meta.field_value)}' for ${fmt(meta.model_name)} field '${fmt(meta.field_name)}' is not valid.`;
      }
      case 'P2007': {
        return `Data validation error: ${fmt(meta.database_error, 'data validation error')}.`;
      }
      case 'P2008': {
        return `Failed to parse the query: ${fmt(meta.query_parsing_error)} at position ${fmt(meta.query_position)}.`;
      }
      case 'P2009': {
        return `Failed to validate the query: ${fmt(meta.query_validation_error)} at position ${fmt(meta.query_position)}.`;
      }
      case 'P2010': {
        return `Raw query failed. Code: ${fmt(meta.code)}. Message: ${fmt(meta.message)}.`;
      }
      case 'P2011': {
        return `Null constraint violation on the ${fmt(meta.constraint, 'unknown constraint')}.`;
      }
      case 'P2012': {
        return `Missing a required value at ${fmt(meta.path, 'unknown path')}.`;
      }
      case 'P2013': {
        return `Missing the required argument '${fmt(meta.argument_name)}' for field '${fmt(meta.field_name)}' on '${fmt(meta.object_name)}'.`;
      }
      case 'P2014': {
        return `The change violates the required relation '${fmt(meta.relation_name, 'unknown relation')}' between the '${fmt(meta.model_a_name)}' and '${fmt(meta.model_b_name)}' models.`;
      }
      case 'P2015': {
        return `A related record could not be found. ${fmt(meta.details, 'unknown details')}`;
      }
      case 'P2016': {
        return `Query interpretation error. ${fmt(meta.details, 'query interpretation error')}`;
      }
      case 'P2017': {
        return `The records for relation '${fmt(meta.relation_name, 'unknown relation')}' are not connected.`;
      }
      case 'P2018': {
        return `The required connected records were not found. ${fmt(meta.details, 'required connected records not found')}`;
      }
      case 'P2019': {
        return `Input error. ${fmt(meta.details, 'input error')}`;
      }
      case 'P2020': {
        return `Value out of range for the type. ${fmt(meta.details, 'value out of range')}`;
      }
      case 'P2021': {
        return `The table '${fmt(meta.table, 'unknown table')}' does not exist in the current database.`;
      }
      case 'P2022': {
        return `The column '${fmt(meta.column, 'unknown column')}' does not exist in the current database.`;
      }
      case 'P2023': {
        return `Inconsistent column data: ${fmt(meta.message, 'inconsistent column data')}`;
      }
      case 'P2024': {
        return `Timed out fetching a new connection from the connection pool. Timeout: ${fmt(meta.timeout)}, Connection Limit: ${fmt(meta.connection_limit)}.`;
      }
      case 'P2025': {
        const model = fmt(meta.modelName, 'unknown model');
        const cause = fmt(meta.cause, 'record not found');
        return `Record: ${model} not found. ${cause}`;
      }
      case 'P2026': {
        return `The current database provider doesn't support this feature: ${fmt(meta.feature, 'unsupported feature')}.`;
      }
      case 'P2027': {
        return `Multiple errors occurred on the database during query execution: ${fmt(meta.errors, 'multiple errors')}.`;
      }
      case 'P2028': {
        return `Transaction API error: ${fmt(meta.error, 'transaction API error')}`;
      }
      case 'P2029': {
        return `Query parameter limit exceeded: ${fmt(meta.message, 'query parameter limit exceeded')}`;
      }
      case 'P2030': {
        return `Cannot find a fulltext index for the search. Try adding a @@fulltext([Fields...]) to your schema.`;
      }
      case 'P2031': {
        return `Prisma needs MongoDB to be run as a replica set. See details: https://pris.ly/d/mongodb-replica-set`;
      }
      case 'P2033': {
        return `A number in the query does not fit into a 64-bit signed integer. Consider using BigInt for large integers.`;
      }
      case 'P2034': {
        return `Transaction failed due to a write conflict or deadlock. Please retry your transaction.`;
      }
      case 'P2035': {
        return `Assertion violation on the database: ${fmt(meta.database_error, 'assertion violation')}.`;
      }
      case 'P2036': {
        return `Error in external connector (id: ${fmt(meta.id, 'unknown external connector')}).`;
      }
      case 'P2037': {
        return `Too many database connections opened: ${fmt(meta.message, 'too many connections')}.`;
      }
      default: {
        return 'An unexpected error occurred.';
      }
    }
  }

  getFriendlyTitle(): string {
    const titleMap: Record<string, string> = {
      P2001: 'Record not found in condition',
      P2002: 'Unique constraint violation',
      P2003: 'Foreign key constraint violation',
      P2004: 'Database constraint violation',
      P2005: 'Invalid field value in database',
      P2006: 'Invalid field value provided',
      P2007: 'Data validation error',
      P2008: 'Query parsing error',
      P2009: 'Query validation error',
      P2010: 'Raw query execution error',
      P2011: 'Null constraint violation',
      P2012: 'Missing required value',
      P2013: 'Missing required argument',
      P2014: 'Relation constraint violation',
      P2015: 'Related record not found',
      P2016: 'Query interpretation error',
      P2017: 'Relation connection error',
      P2018: 'Required connected records not found',
      P2019: 'Input error',
      P2020: 'Value out of range',
      P2021: 'Table does not exist',
      P2022: 'Column does not exist',
      P2023: 'Inconsistent column data',
      P2024: 'Connection pool timeout',
      P2025: 'Required records not found',
      P2026: 'Unsupported database feature',
      P2027: 'Multiple database errors',
      P2028: 'Transaction API error',
      P2029: 'Query parameter limit exceeded',
      P2030: 'Missing fulltext index',
      P2031: 'MongoDB replica set required',
      P2033: '64-bit integer overflow',
      P2034: 'Transaction conflict or deadlock',
      P2035: 'Assertion violation',
      P2036: 'External connector error',
      P2037: 'Too many database connections',
    };
    return titleMap[this.exception.code] || 'Unexpected database error';
  }
}
