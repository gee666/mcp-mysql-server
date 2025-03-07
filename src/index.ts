#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ListResourcesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { parse as parseUrl } from 'url';
import path from 'path';

// Load environment variables
config();

// Type definitions
interface DatabaseConfig {
  host: string;
  user: string;
  password: string;
  database: string;
}

interface SSLConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

interface ConnectionConfig extends DatabaseConfig {
  ssl?: SSLConfig;
  connectionTimeout?: number;
  connectRetry?: {
    maxAttempts: number;
    delay: number;
  };
}

interface SchemaField {
  name: string;
  type: string;
  length?: number;
  nullable?: boolean;
  default?: string | number | null;
  autoIncrement?: boolean;
  primary?: boolean;
}

interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

interface QueryResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

interface QueryArgs {
  sql: string;
  params?: Array<string | number | boolean | null>;
}

interface ConnectionArgs {
  url?: string;
  workspace?: string;
  host?: string;
  user?: string;
  password?: string;
  database?: string;
}

// Type guard for error objects
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// Helper to get error message
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

class MySQLServer {
  private server: Server;
  private pool: mysql.Pool | null = null;
  private config: ConnectionConfig | null = null;
  private currentWorkspace: string | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'mysql-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        },
      }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandlers();
  }

  private setupErrorHandlers() {
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    await this.server.close();
  }

  private handleDatabaseError(error: unknown): never {
    // Handle MySQL-specific errors
    if (error instanceof Error) {
      const mysqlError = error as any;
      const code = mysqlError.code || '';
      const errno = mysqlError.errno || 0;

      // User input errors (Invalid Request)
      if (code === 'ER_PARSE_ERROR' || code === 'ER_EMPTY_QUERY') {
        throw new McpError(ErrorCode.InvalidParams, `Invalid SQL syntax: ${mysqlError.message}`);
      }

      // Authentication errors (Unauthorized)
      if (code === 'ER_ACCESS_DENIED_ERROR') {
        throw new McpError(ErrorCode.InvalidRequest, `Database authentication failed: Invalid credentials`);
      }

      // Database configuration errors (Internal Error)
      if (code === 'ER_BAD_DB_ERROR') {
        throw new McpError(ErrorCode.InternalError, `Database configuration error: Database does not exist`);
      }

      // Connection errors (Internal Error)
      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
        throw new McpError(ErrorCode.InternalError, `Database connection error: ${code}`);
      }

      // Schema-related errors (Invalid Request)
      if (code === 'ER_NO_SUCH_TABLE') {
        throw new McpError(ErrorCode.InvalidParams, `Table does not exist: ${mysqlError.message}`);
      }

      // Data integrity errors (Invalid Request)
      if (code === 'ER_DUP_ENTRY') {
        throw new McpError(ErrorCode.InvalidParams, `Data integrity error: Duplicate entry`);
      }

      // Log unknown errors for debugging
      console.error('Unhandled MySQL error:', {
        code,
        errno,
        message: mysqlError.message,
        stack: mysqlError.stack
      });
    }

    // Generic error handling as fallback
    const message = getErrorMessage(error);
    throw new McpError(ErrorCode.InternalError, `Unexpected database error: ${message}`);
  }

  private validateSqlInput(sql: string, allowedTypes: string[]) {
    const type = sql.trim().split(' ')[0].toUpperCase();
    if (!allowedTypes.includes(type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid SQL type. Allowed: ${allowedTypes.join(', ')}`
      );
    }
  }

  private async ensureConnection() {
    // If we already have a pool, reuse it
    if (this.pool) {
      return this.pool;
    }

    try {
      // Load config from environment variables
      let config: ConnectionConfig = {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || '',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
        connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10)
      };

      // Check for DATABASE_URL which takes precedence if available
      if (process.env.DATABASE_URL) {
        try {
          config = this.parseConnectionUrl(process.env.DATABASE_URL);
        } catch (error) {
          console.error(`Failed to parse DATABASE_URL: ${getErrorMessage(error)}`);
          // Continue with other environment variables
        }
      }

      // Set default connection retry if not specified
      const connectRetry = {
        maxAttempts: parseInt(process.env.DB_CONNECT_MAX_ATTEMPTS || '3', 10),
        delay: parseInt(process.env.DB_CONNECT_RETRY_DELAY || '1000', 10)
      };

      let lastError = null;

      // Try to connect with retries
      for (let attempt = 1; attempt <= connectRetry.maxAttempts; attempt++) {
        try {
          this.pool = mysql.createPool({
            ...config,
            waitForConnections: true,
            connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            supportBigNumbers: true,
            bigNumberStrings: true,
            connectTimeout: config.connectionTimeout || 10000
          });

          // Test the connection
          const connection = await this.pool.getConnection();
          connection.release();

          // Save config for reference
          this.config = config;

          // Connection successful
          console.error(`Connected to MySQL server at ${config.host}`);
          return this.pool;
        } catch (error) {
          lastError = error;
          this.pool = null;

          if (attempt < connectRetry.maxAttempts) {
            console.error(`Connection attempt ${attempt} failed, retrying in ${connectRetry.delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, connectRetry.delay));
          }
        }
      }

      // If we get here, all connection attempts failed
      throw lastError || new Error('Failed to connect to database');
    } catch (error) {
      this.pool = null;
      this.handleDatabaseError(error);
    }
  }

  private async executeQuery<T>(sql: string, params: any[] = []): Promise<T> {
    // Ensure connection is established before executing query
    await this.ensureConnection();

    try {
      const [result] = await this.pool!.query(sql, params);
      return result as T;
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  private hasDirectConfig(args: ConnectionArgs): boolean {
    return !!(args.host && args.user && args.password && args.database);
  }

  private createDirectConfig(args: ConnectionArgs): ConnectionConfig {
    if (!this.hasDirectConfig(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Missing required connection parameters'
      );
    }

    return {
      host: args.host!,
      user: args.user!,
      password: args.password!,
      database: args.database!
    };
  }

  private async loadConfig(args: ConnectionArgs): Promise<ConnectionConfig> {
    if (args.url) return this.parseConnectionUrl(args.url);
    if (args.workspace) {
      const config = await this.loadWorkspaceConfig(args.workspace);
      if (config) return config;
    }
    if (this.hasDirectConfig(args)) return this.createDirectConfig(args);

    throw new McpError(
      ErrorCode.InvalidParams,
      'No valid configuration provided. Please provide either a URL, workspace path, or connection parameters.'
    );
  }

  private async loadWorkspaceConfig(workspace: string): Promise<ConnectionConfig | null> {
    try {
      // Try loading .env from the workspace
      const envPath = path.join(workspace, '.env');
      const workspaceEnv = require('dotenv').config({ path: envPath });

      if (workspaceEnv.error) {
        return null;
      }

      const { DATABASE_URL, DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = workspaceEnv.parsed;

      if (DATABASE_URL) {
        return this.parseConnectionUrl(DATABASE_URL);
      }

      if (DB_HOST && DB_USER && DB_PASSWORD && DB_NAME) {
        return {
          host: DB_HOST,
          user: DB_USER,
          password: DB_PASSWORD,
          database: DB_NAME
        };
      }

      return null;
    } catch (error) {
      console.error('Error loading workspace config:', error);
      return null;
    }
  }

  private parseConnectionUrl(url: string): ConnectionConfig {
    try {
      // Check if URL contains placeholder values
      if (url.includes('user:pass@host') || url.includes('@host:port/')) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'The connection URL contains placeholder values. Please provide a valid MySQL connection URL in the format: mysql://username:password@hostname:port/database'
        );
      }

      const parsed = parseUrl(url);

      if (!parsed.protocol || (parsed.protocol !== 'mysql:' && parsed.protocol !== 'mysqls:')) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid protocol. URL must start with mysql:// or mysqls://'
        );
      }

      if (!parsed.hostname) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Hostname is required in the connection URL'
        );
      }

      // Extract credentials
      let user = '', password = '';
      if (parsed.auth) {
        const authParts = parsed.auth.split(':');
        user = authParts[0];
        password = authParts[1] || '';
      }

      // Extract database name
      const database = parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';

      if (!database) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Database name must be specified in URL'
        );
      }

      return {
        host: parsed.hostname,
        user,
        password,
        database,
        ssl: parsed.protocol === 'mysqls:' ? { rejectUnauthorized: true } : undefined
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid database URL: ${getErrorMessage(error)}`
      );
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'query',
          description: 'Execute a SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL SELECT query',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'execute',
          description: 'Execute an INSERT, UPDATE, or DELETE query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL query (INSERT, UPDATE, DELETE)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'list_tables',
          description: 'List all tables in the database',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'describe_table',
          description: 'Get table structure',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
            },
            required: ['table'],
          },
        },
        {
          name: 'create_table',
          description: 'Create a new table in the database',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    length: { type: 'number', optional: true },
                    nullable: { type: 'boolean', optional: true },
                    default: {
                      type: ['string', 'number', 'null'],
                      optional: true
                    },
                    autoIncrement: { type: 'boolean', optional: true },
                    primary: { type: 'boolean', optional: true }
                  },
                  required: ['name', 'type']
                }
              },
              indexes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    columns: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    unique: { type: 'boolean', optional: true }
                  },
                  required: ['name', 'columns']
                },
                optional: true
              }
            },
            required: ['table', 'fields']
          }
        },
        {
          name: 'add_column',
          description: 'Add a new column to existing table',
          inputSchema: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              field: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  length: { type: 'number', optional: true },
                  nullable: { type: 'boolean', optional: true },
                  default: {
                    type: ['string', 'number', 'null'],
                    optional: true
                  }
                },
                required: ['name', 'type']
              }
            },
            required: ['table', 'field']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'query':
          return await this.handleQuery(request.params.arguments as unknown as QueryArgs);
        case 'execute':
          return await this.handleExecute(request.params.arguments as unknown as QueryArgs);
        case 'list_tables':
          return await this.handleListTables();
        case 'describe_table':
          return await this.handleDescribeTable(request.params.arguments);
        case 'create_table':
          return await this.handleCreateTable(request.params.arguments);
        case 'add_column':
          return await this.handleAddColumn(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private setupResourceHandlers() {
    // Add handler for resources/list
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: []
      };
    });
  }

  private async handleQuery(args: QueryArgs): Promise<QueryResult> {
    this.validateSqlInput(args.sql, ['SELECT']);
    const rows = await this.executeQuery(args.sql, args.params || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(rows, null, 2)
      }]
    };
  }

  private async handleExecute(args: QueryArgs): Promise<QueryResult> {
    this.validateSqlInput(args.sql, ['INSERT', 'UPDATE', 'DELETE']);
    const result = await this.executeQuery(args.sql, args.params || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  private async handleListTables() {
    const rows = await this.executeQuery('SHOW TABLES');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  }

  private async handleDescribeTable(args: any) {
    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    const rows = await this.executeQuery(
      `SELECT
        COLUMN_NAME as Field,
        COLUMN_TYPE as Type,
        IS_NULLABLE as \`Null\`,
        COLUMN_KEY as \`Key\`,
        COLUMN_DEFAULT as \`Default\`,
        EXTRA as Extra,
        COLUMN_COMMENT as Comment
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
      [this.config!.database, args.table]
    );

    const formattedRows = (rows as any[]).map(row => ({
      ...row,
      Null: row.Null === 'YES' ? 'YES' : 'NO'
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formattedRows, null, 2),
        },
      ],
    };
  }

  private async handleCreateTable(args: any) {
    const fields = args.fields.map((field: SchemaField) => {
      let def = `\`${field.name}\` ${field.type.toUpperCase()}`;
      if (field.length) def += `(${field.length})`;
      if (field.nullable === false) def += ' NOT NULL';
      if (field.default !== undefined) {
        def += ` DEFAULT ${field.default === null ? 'NULL' : `'${field.default}'`}`;
      }
      if (field.autoIncrement) def += ' AUTO_INCREMENT';
      if (field.primary) def += ' PRIMARY KEY';
      return def;
    });

    const indexes = args.indexes?.map((idx: IndexDefinition) => {
      const type = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
      return `${type} \`${idx.name}\` (\`${idx.columns.join('`, `')}\`)`;
    }) || [];

    const sql = `CREATE TABLE \`${args.table}\` (
      ${[...fields, ...indexes].join(',\n      ')}
    )`;

    await this.executeQuery(sql);
    return {
      content: [
        {
          type: 'text',
          text: `Table ${args.table} created successfully`
        }
      ]
    };
  }

  private async handleAddColumn(args: any) {
    if (!args.table || !args.field) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name and field are required');
    }

    let sql = `ALTER TABLE \`${args.table}\` ADD COLUMN \`${args.field.name}\` ${args.field.type.toUpperCase()}`;
    if (args.field.length) sql += `(${args.field.length})`;
    if (args.field.nullable === false) sql += ' NOT NULL';
    if (args.field.default !== undefined) {
      sql += ` DEFAULT ${args.field.default === null ? 'NULL' : `'${args.field.default}'`}`;
    }

    await this.executeQuery(sql);
    return {
      content: [
        {
          type: 'text',
          text: `Column ${args.field.name} added to table ${args.table}`
        }
      ]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MySQL MCP server running on stdio');
  }
}

const server = new MySQLServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});